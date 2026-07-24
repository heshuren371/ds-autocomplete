const vscode = require("vscode");
const https = require("https");

// ── Config ───────────────────────────────────────────────────────────

function config() {
  return vscode.workspace.getConfiguration("dsAutocomplete");
}

// ── Status bar ───────────────────────────────────────────────────────

let _statusBar = null;
let _statusTimer = null;
const _availableModels = [
  { label: "DeepSeek V4 Flash", description: "fast · cheap · default", value: "deepseek-v4-flash" },
  { label: "DeepSeek V4 Pro", description: "smart · slower · higher quality", value: "deepseek-v4-pro" },
  { label: "DeepSeek Coder", description: "code-specialized · FIM-native", value: "deepseek-coder" },
];

function initStatusBar() {
  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  _statusBar.command = "dsAutocomplete.switchModel";
  _statusBar.tooltip = "Click to switch model";
  updateStatusBarModel();
  _statusBar.show();
}

function updateStatusBarModel() {
  if (!_statusBar) return;
  const model = config().get("model");
  const entry = _availableModels.find((m) => m.value === model);
  const label = entry ? entry.label.replace("DeepSeek ", "") : model;
  _statusBar.text = `$(hubot) DS ${label}`;
}

function showStatus(text, icon, ms) {
  if (!_statusBar) return;
  _statusBar.text = `${icon || "$(sync~spin)"} ${text}`;
  _statusBar.show();
  if (_statusTimer) clearTimeout(_statusTimer);
  if (ms) {
    _statusTimer = setTimeout(() => updateStatusBarModel(), ms);
  }
}

function flashError(text) {
  showStatus(text, "$(error)", 5000);
}

// ── Stats (persisted locally, no telemetry) ─────────────────────────

let _context = null;
let _stats = { shown: 0, accepted: 0, rejected: 0, cacheHits: 0, requests: 0, retries: 0, tokensUsed: 0 };

function loadStats() {
  const saved = _context?.globalState.get("dsAutocomplete.stats");
  if (saved && typeof saved === "object") Object.assign(_stats, saved);
}

let _statsSaveTimer = null;
function saveStats() {
  if (_statsSaveTimer) clearTimeout(_statsSaveTimer);
  _statsSaveTimer = setTimeout(() => {
    _context?.globalState.update("dsAutocomplete.stats", _stats);
  }, 2000);
}

function statBump(key, n = 1) {
  _stats[key] = (_stats[key] || 0) + n;
  saveStats();
}

// ── Cache (LRU + TTL) ────────────────────────────────────────────────

const CACHE_MAX = 120;
const CACHE_TTL = 5 * 60 * 1000;
const _cache = new Map(); // key -> { text, time }

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function cacheKey(prefix, suffix, model) {
  // Only the tail of the prefix and head of the suffix affect the completion
  return model + "|" + hashStr(prefix.slice(-1500)) + "|" + hashStr(suffix.slice(0, 400));
}

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) {
    _cache.delete(key);
    return null;
  }
  // LRU touch
  _cache.delete(key);
  _cache.set(key, hit);
  statBump("cacheHits");
  return hit.text;
}

function cacheSet(key, text) {
  if (!text) return;
  _cache.set(key, { text, time: Date.now() });
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

// ── Context filter (conservative) ───────────────────────────────────

function shouldSkip(document, position) {
  // 1) Nothing before cursor at all (empty file)
  const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position)).trim();
  if (!before) return true;

  // 2) Cursor inside an unterminated string literal — OPT-IN only (skipInString).
  // Half-typed lines usually carry an open quote (`print("hel`), and FIM models
  // complete string interiors natively. Skipping here silently killed the most
  // wanted completions, so this filter is OFF by default.
  if (config().get("skipInString")) {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const singles = (linePrefix.match(/'/g) || []).length;
    const doubles = (linePrefix.match(/"/g) || []).length;
    const backticks = (linePrefix.match(/`/g) || []).length;
    if (singles % 2 === 1 || doubles % 2 === 1 || backticks % 2 === 1) return true;
  }

  return false;
}

// ── FIM prompt ───────────────────────────────────────────────────────

function buildFIM(document, position) {
  const cfg = config();
  const full = document.getText();
  const offset = document.offsetAt(position);
  const prefix = full.slice(Math.max(0, offset - cfg.get("maxPrefixChars")), offset);
  const suffix = full.slice(offset, offset + cfg.get("maxSuffixChars"));
  return { prompt: "<｜fim▁begin｜>" + prefix, suffix: suffix + "<｜fim▁end｜>" };
}

// ── Response cleaner ─────────────────────────────────────────────────

function cleanCompletion(text, multiLine) {
  let cleaned = text
    .replace(/<｜fim▁end｜>/g, "")
    .replace(/<｜fim▁begin｜>/g, "")
    .replace(/<\|endoftext\|>/g, "")
    .replace(/```[a-z]*\n?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  if (!multiLine) {
    cleaned = cleaned.split("\n")[0].trimEnd();
  }
  return cleaned;
}

// ── API: streaming with early exit + retry ──────────────────────────

let _activeRequest = null;

function requestFIM(prompt, suffix, cancelToken) {
  const cfg = config();
  const key = cfg.get("apiKey");
  if (!key) return Promise.reject(new Error("No API key"));

  const multiLine = cfg.get("multiLine");
  // Smart stop tokens: single-line stops at newline; multi-line stops at blank line
  const stops = multiLine ? ["\n\n", "\n\n\n"] : ["\n"];
  const extraStops = cfg.get("stopTokens") || [];

  const body = JSON.stringify({
    model: cfg.get("model"),
    prompt,
    suffix,
    max_tokens: cfg.get("maxTokens"),
    temperature: cfg.get("temperature"),
    stream: true,
    stop: [...stops, ...extraStops],
  });

  statBump("requests");

  return new Promise((resolve, reject) => {
    if (_activeRequest) {
      _activeRequest.destroy();
      _activeRequest = null;
    }

    let done = false;
    let accumulated = "";
    let buffer = "";

    const finish = (value, isError) => {
      if (done) return;
      done = true;
      _activeRequest = null;
      if (isError) reject(value);
      else resolve(value);
    };

    const req = https.request(
      cfg.get("apiBase"),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "text/event-stream",
        },
        timeout: cfg.get("requestTimeoutMs"),
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (c) => (errData += c));
          res.on("end", () => {
            let msg = `HTTP ${res.statusCode}`;
            try {
              msg = JSON.parse(errData).error?.message || msg;
            } catch {}
            const err = new Error(msg);
            err.statusCode = res.statusCode;
            finish(err, true);
          });
          return;
        }

        res.on("data", (chunk) => {
          if (done) return;
          buffer += chunk.toString();
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = event.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") {
              finish(accumulated, false);
              return;
            }
            try {
              const j = JSON.parse(payload);
              const delta = j.choices?.[0]?.text ?? "";
              if (delta) {
                accumulated += delta;
                // Early exit: we have enough, kill the stream (saves server-side generation)
                if (multiLine && accumulated.endsWith("\n\n")) {
                  req.destroy();
                  finish(accumulated.replace(/\n\n$/, "\n"), false);
                  return;
                }
                if (!multiLine && accumulated.includes("\n")) {
                  req.destroy();
                  finish(accumulated.split("\n")[0], false);
                  return;
                }
              }
            } catch {}
          }
        });
        res.on("end", () => finish(accumulated, false));
        res.on("error", (e) => finish(e, true));
      }
    );

    req.on("error", (e) => finish(e, true));
    req.on("timeout", () => {
      req.destroy();
      finish(new Error("timeout"), true);
    });

    _activeRequest = req;

    if (cancelToken) {
      cancelToken.onCancellationRequested(() => {
        req.destroy();
        finish(null, false);
      });
    }

    req.write(body);
    req.end();
  });
}

async function evaluateFIM(prompt, suffix, cancelToken) {
  const maxRetry = 1;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await requestFIM(prompt, suffix, cancelToken);
    } catch (err) {
      const retryable =
        err.statusCode === 429 ||
        (err.statusCode >= 500 && err.statusCode < 600) ||
        ["ECONNRESET", "ETIMEDOUT", "timeout"].some((m) => String(err.message).includes(m));
      if (attempt < maxRetry && retryable && !(cancelToken && cancelToken.isCancellationRequested)) {
        statBump("retries");
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
  }
}

// ── Word-by-word accept ─────────────────────────────────────────────

let _lastSuggestion = null; // { text, uri, line }
let _pendingRemainder = null; // remainder after partial accept

// ── Provider ─────────────────────────────────────────────────────────

class DeepSeekCompletionProvider {
  constructor() {
    this._debounceTimer = null;
    this._pendingResolve = null;
  }

  async provideInlineCompletionItems(document, position, context, token) {
    const cfg = config();

    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Explicit && !cfg.get("triggerOnExplicit")) {
      return [];
    }

    // Pending remainder from partial accept — serve immediately
    if (_pendingRemainder && _pendingRemainder.uri === document.uri.toString()) {
      const rem = _pendingRemainder;
      _pendingRemainder = null;
      if (rem.text) {
        return [new vscode.InlineCompletionItem(rem.text)];
      }
      return [];
    }

    if (shouldSkip(document, position)) return [];

    // Supersede any pending debounced call — resolve its promise so nothing dangles.
    // EVERY keystroke must reschedule the timer; dropping one without rescheduling
    // means the user's final keystroke never produces a completion.
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (this._pendingResolve) {
      this._pendingResolve([]);
      this._pendingResolve = null;
    }

    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      token.onCancellationRequested(() => {
        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
          this._debounceTimer = null;
        }
        if (this._pendingResolve === resolve) {
          this._pendingResolve = null;
          resolve([]);
        }
      });
      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = null;
        this._pendingResolve = null;
        if (token.isCancellationRequested) {
          resolve([]);
          return;
        }

        const { prompt, suffix } = buildFIM(document, position);
        const model = cfg.get("model");
        const cKey = cacheKey(prompt, suffix, model);

        // Cache hit → instant
        const cached = cacheGet(cKey);
        if (cached) {
          const cleaned = cleanCompletion(cached, cfg.get("multiLine"));
          if (cleaned) {
            statBump("shown");
            _lastSuggestion = { text: cleaned, uri: document.uri.toString(), line: position.line };
            resolve([new vscode.InlineCompletionItem(cleaned)]);
            return;
          }
        }

        showStatus("DS…", "$(sync~spin)");

        try {
          const result = await evaluateFIM(prompt, suffix, token);
          if (token.isCancellationRequested || !result) {
            updateStatusBarModel();
            resolve([]);
            return;
          }

          cacheSet(cKey, result);
          statBump("tokensUsed", Math.ceil(result.length / 4));

          const cleaned = cleanCompletion(result, cfg.get("multiLine"));
          updateStatusBarModel();
          if (!cleaned) {
            resolve([]);
            return;
          }

          statBump("shown");
          _lastSuggestion = { text: cleaned, uri: document.uri.toString(), line: position.line };

          const item = new vscode.InlineCompletionItem(cleaned);
          if (cfg.get("replacePartialWord")) {
            const wordRange = document.getWordRangeAtPosition(position);
            if (wordRange) item.range = wordRange;
          }
          resolve([item]);
        } catch (err) {
          updateStatusBarModel();
          if (err.message !== "canceled") {
            console.error("[DS Autocomplete]", err.message);
            flashError(`DS: ${String(err.message).slice(0, 40)}`);
          }
          resolve([]);
        }
      }, cfg.get("debounceMs"));
    });
  }
}

// ── Acceptance tracking ──────────────────────────────────────────────

function watchAcceptance(context) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!_lastSuggestion) return;
      if (e.document.uri.toString() !== _lastSuggestion.uri) return;
      for (const change of e.contentChanges) {
        if (!change.text) continue;
        // Full accept: inserted text matches the suggestion start
        if (_lastSuggestion.text.startsWith(change.text) && change.text.length > 1) {
          statBump("accepted");
          _lastSuggestion = null;
          return;
        }
      }
    })
  );
}

// ── Activation ───────────────────────────────────────────────────────

function activate(context) {
  _context = context;
  loadStats();
  initStatusBar();

  const provider = new DeepSeekCompletionProvider();
  const langs = config().get("enabledLanguages");
  const selectors = langs.includes("*")
    ? [{ scheme: "file" }, { scheme: "untitled" }]
    : langs.map((l) => ({ language: l }));

  for (const sel of selectors) {
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(sel, provider)
    );
  }

  watchAcceptance(context);

  // Model switcher
  context.subscriptions.push(
    vscode.commands.registerCommand("dsAutocomplete.switchModel", async () => {
      const picked = await vscode.window.showQuickPick(_availableModels, {
        placeHolder: "Select autocomplete model…",
      });
      if (picked) {
        await config().update("model", picked.value, true);
        updateStatusBarModel();
        vscode.window.showInformationMessage(`DS Autocomplete → ${picked.label}`);
      }
    })
  );

  // Word-by-word accept (Ctrl/Cmd+Right)
  context.subscriptions.push(
    vscode.commands.registerCommand("dsAutocomplete.acceptWord", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !_lastSuggestion) {
        await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
        return;
      }
      const full = _lastSuggestion.text;
      const m = full.match(/^\s*\S+/);
      const word = m ? m[0] : full;
      const after = full.slice(word.length);
      const trailingSpace = after.startsWith(" ") ? " " : "";

      await editor.edit((eb) => eb.insert(editor.selection.active, word + trailingSpace));

      const remainder = after.slice(trailingSpace.length);
      if (remainder) {
        _lastSuggestion.text = remainder;
        _pendingRemainder = { text: remainder, uri: _lastSuggestion.uri };
      } else {
        statBump("accepted");
        _lastSuggestion = null;
      }
    })
  );

  // Stats
  context.subscriptions.push(
    vscode.commands.registerCommand("dsAutocomplete.showStats", () => {
      const s = _stats;
      const rate = s.shown > 0 ? Math.round((s.accepted / s.shown) * 100) : 0;
      const cacheRate = s.requests > 0 ? Math.round((s.cacheHits / (s.requests + s.cacheHits)) * 100) : 0;
      vscode.window.showInformationMessage(
        `DS Autocomplete v1.1.2 · ${config().get("model")}\n` +
          `补全 ${s.shown} 次 · 接受 ${s.accepted} (${rate}%) · 缓存命中 ${s.cacheHits} (${cacheRate}%)\n` +
          `API 请求 ${s.requests} 次 · 重试 ${s.retries} 次 · 约 ${s.tokensUsed} tokens`
      );
    })
  );

  console.log(`[DS Autocomplete] v1.1.2 activated — ${langs.join(", ")}`);

  // No API key? Prompt once
  if (!config().get("apiKey")) {
    vscode.window
      .showWarningMessage(
        "DS Autocomplete: 未配置 API key。请先获取 DeepSeek API 密钥。",
        "获取 Key",
        "打开设置"
      )
      .then((choice) => {
        if (choice === "获取 Key") {
          vscode.env.openExternal(vscode.Uri.parse("https://platform.deepseek.com/api_keys"));
        } else if (choice === "打开设置") {
          vscode.commands.executeCommand("workbench.action.openSettings", "dsAutocomplete.apiKey");
        }
      });
  }

  showStatus("DS ready", "$(check)", 3000);
}

function deactivate() {
  if (_statusBar) {
    _statusBar.dispose();
    _statusBar = null;
  }
}

module.exports = { activate, deactivate };
