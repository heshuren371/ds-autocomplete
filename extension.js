const vscode = require("vscode");
const https = require("https");

// ── Config ───────────────────────────────────────────────────────────

function config() {
  return vscode.workspace.getConfiguration("dsAutocomplete");
}

// ── Debug log (Output channel: "DS Autocomplete") ───────────────────

let _output = null;
let _lastDbgMsg = "";
let _lastDbgTime = 0;
function outputChannel() {
  if (!_output) _output = vscode.window.createOutputChannel("DS Autocomplete");
  return _output;
}
function dbg(msg) {
  if (!config().get("debug")) return;
  const now = Date.now();
  if (msg === _lastDbgMsg && now - _lastDbgTime < 2000) return;
  _lastDbgMsg = msg;
  _lastDbgTime = now;
  const t = new Date().toISOString().slice(11, 23);
  outputChannel().appendLine(`[${t}] ${msg}`);
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
  return { prompt: prefix, suffix: suffix };
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
  // Smart stop tokens: single-line stops at newline; multi-line stops at
  // 3-blank-line boundary (PEP 8: two blank lines between top-level defs).
  // Using \n\n was too aggressive — it cut off return statements that
  // follow a blank separator line within a function body.
  const stops = multiLine ? ["\n\n\n"] : ["\n"];
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

let _lastSuggestion = null; // { text, uri, line, character }
let _pendingRemainder = null; // remainder after partial accept

// ── Ghost text acceptance tracker (Continue/Copilot pattern) ─────────
// When ghost text is shown, record the expected end position.
// On cursor movement to that position → acceptance (Tab or typed-all).
// On cursor movement elsewhere → rejection (counter for quality tracking).
let _ghostAnchor = null; // { uri, text, startLine, startCharacter, endLine, endCharacter }

function setGhostAnchor(document, text, startPosition) {
  if (!text) { _ghostAnchor = null; return; }
  const lines = text.split("\n");
  _ghostAnchor = {
    uri: document.uri.toString(),
    text,
    startLine: startPosition.line,
    startCharacter: startPosition.character,
    endLine: startPosition.line + lines.length - 1,
    endCharacter: lines.length === 1
      ? startPosition.character + text.length
      : lines[lines.length - 1].length,
  };
}

function checkGhostAccepted(document, newPosition) {
  if (!_ghostAnchor) return false;
  if (_ghostAnchor.uri !== document.uri.toString()) return false;
  if (newPosition.line !== _ghostAnchor.endLine ||
      newPosition.character !== _ghostAnchor.endCharacter) return false;
  try {
    const range = new vscode.Range(
      new vscode.Position(_ghostAnchor.startLine, _ghostAnchor.startCharacter),
      new vscode.Position(_ghostAnchor.endLine, _ghostAnchor.endCharacter)
    );
    if (document.getText(range) === _ghostAnchor.text) {
      _ghostAnchor = null;
      return true;
    }
  } catch {}
  return false;
}

// ── Suggestion history (survives widget flicker, IME, races) ────────
// When _lastSuggestion is cleared by suggest widget, IME commit,
// or any external event, the next provider call can recover the ghost
// text from this history — recalculating what should show based on the
// original suggestion + current cursor position. TTL and startsWith
// guard against serving stale/wrong completions.
let _suggestionHistory = []; // [{text, uri, line, character, ts}]
const HISTORY_MAX = 8;
const HISTORY_TTL = 15000; // 15s — survives widget flicker + IME pause

function rememberSuggestion(sug) {
  _suggestionHistory.push({
    text: sug.text, uri: sug.uri,
    line: sug.line, character: sug.character,
    ts: Date.now()
  });
  const cutoff = Date.now() - HISTORY_TTL;
  _suggestionHistory = _suggestionHistory.filter(s => s.ts > cutoff);
  if (_suggestionHistory.length > HISTORY_MAX) _suggestionHistory.shift();
}

function recoverSuggestion(uri, pos) {
  for (let i = _suggestionHistory.length - 1; i >= 0; i--) {
    const s = _suggestionHistory[i];
    if (Date.now() - s.ts > HISTORY_TTL) continue;
    if (s.uri !== uri || s.line !== pos.line || s.character > pos.character) continue;
    return { text:s.text, uri:s.uri, line:s.line, character:s.character };
  }
  return null;
}
let _cursorTriggerTimer = null;

// ── Provider ─────────────────────────────────────────────────────────

class DeepSeekCompletionProvider {
  constructor() {
    this._debounceTimer = null;
    this._pendingResolve = null;
  }

  async provideInlineCompletionItems(document, position, context, token) {
    const cfg = config();
    const kind = context.triggerKind === vscode.InlineCompletionTriggerKind.Explicit ? "Explicit" : "Auto";
    dbg(`call ${kind} @${position.line}:${position.character} lastSug=${_lastSuggestion ? _lastSuggestion.text.length + "c" : "null"}`);

    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Explicit && !cfg.get("triggerOnExplicit")) {
      return [];
    }

    // Pending remainder from partial accept — serve immediately
    if (_pendingRemainder && _pendingRemainder.uri === document.uri.toString()) {
      const rem = _pendingRemainder;
      _pendingRemainder = null;
      if (rem.text) {
        setGhostAnchor(document, rem.text, position);
        return [new vscode.InlineCompletionItem(rem.text)];
      }
      return [];
    }

    // ── VSCode-native ghost-text tracking (Continue's approach) ──
    // When ghost text is visible, VSCode provides selectedCompletionInfo with
    // the full completion text and the Range from the original position to
    // the current cursor. This is the AUTHORITATIVE source — no race with
    // our module-level _lastSuggestion. See: continuedev/continue —
    // extensions/vscode/src/autocomplete/completionProvider.ts:187-205
    if (context.selectedCompletionInfo) {
      const { text, range } = context.selectedCompletionInfo;
      const typed = document.getText(range);
      if (text.startsWith(typed)) {
        const remainder = text.slice(typed.length);
        if (remainder) {
          // VSCode auto-shrinks ghost text when we return null — no need
          // to return a new item (which would trigger a model update and
          // potentially cause a re-query loop). Continue does the same.
          dbg(`instant-remainder(vscode) typed=${JSON.stringify(typed)} → return null (VSCode shrinks)`);
          return null;
        }
        statBump("accepted");
        dbg("instant-remainder(vscode) fully consumed");
        return [];
      }
      // Typed text diverged from ghost → let VSCode dismiss, fall through
      dbg("instant-remainder(vscode) mismatch, falling through");
    }

    // ── Instant remainder: user is typing along with the current suggestion ──
    // If the typed characters match the start of _lastSuggestion, serve the
    // remainder instantly — no debounce, no API call. This eliminates the
    // flicker/vanishing ghost text when you type what the model predicted.
    if (_lastSuggestion && _lastSuggestion.uri === document.uri.toString()) {
      const anchorOff = document.offsetAt(
        new vscode.Position(_lastSuggestion.line, _lastSuggestion.character)
      );
      const cursorOff = document.offsetAt(position);
      const typedLen = cursorOff - anchorOff;
      // typedLen === 0: VSCode re-queried at the SAME position (widget toggled,
      // explicit refresh…). Re-serve the current suggestion — never clear it.
      if (typedLen >= 0 && typedLen <= _lastSuggestion.text.length) {
        const typed = document.getText(
          new vscode.Range(document.positionAt(anchorOff), position)
        );
        if (_lastSuggestion.text.startsWith(typed)) {
          const remainder = _lastSuggestion.text.slice(typed.length);
          if (remainder) {
            dbg(`instant-remainder typed=${JSON.stringify(typed)} rem=${remainder.length}c`);
            _lastSuggestion.text = remainder;
            _lastSuggestion.line = position.line;
            _lastSuggestion.character = position.character;
            rememberSuggestion(_lastSuggestion);
            const itext = remainder.length > 30 ? remainder.slice(0, 30) + "…" : remainder;
            dbg(`instant-remainder SHRANK state→${remainder.length}c @${position.line}:${position.character} [${itext}]`);
            // Reset debounce timer — we're serving instantly, no need for API
            if (this._debounceTimer) clearTimeout(this._debounceTimer);
            if (this._pendingResolve) {
              this._pendingResolve([]);
              this._pendingResolve = null;
            }
            setGhostAnchor(document, remainder, position);
            return [new vscode.InlineCompletionItem(remainder)];
          }
          // Perfect match — entire suggestion consumed
          statBump("accepted");
          dbg("state CLEAR ≡ perfect-match (whole suggestion consumed)");
          _lastSuggestion = null;
          return [];
        }
      }
      // Typed something that doesn't match, or cursor moved elsewhere → stale
      dbg(`state CLEAR ≡ stale typedLen=${typedLen}`);
      _lastSuggestion = null;
    }

    // ── Recovery from suggestion history ──
    // _lastSuggestion may have been cleared by suggest widget pop, IME commit,
    // or any race. Try to recover from recent suggestions — the original
    // anchor position lets us recalculate what the ghost text "should" be.
    if (!_lastSuggestion) {
      const rec = recoverSuggestion(document.uri.toString(), position);
      if (rec) {
        const recAnchorOff = document.offsetAt(new vscode.Position(rec.line, rec.character));
        const recCursorOff = document.offsetAt(position);
        const recLen = recCursorOff - recAnchorOff;
        if (recLen >= 0 && recLen <= rec.text.length) {
          const recTyped = document.getText(new vscode.Range(document.positionAt(recAnchorOff), position));
          if (rec.text.startsWith(recTyped)) {
            const recRem = rec.text.slice(recTyped.length);
            if (recRem) {
              dbg(`history RECOVER typed=${JSON.stringify(recTyped)} rem=${recRem.length}c`);
              _lastSuggestion = {
                text: recRem, uri: rec.uri,
                line: position.line, character: position.character
              };
              rememberSuggestion(_lastSuggestion);
              setGhostAnchor(document, recRem, position);
              return [new vscode.InlineCompletionItem(recRem)];
            }
          }
        }
      }
    }

    if (shouldSkip(document, position)) {
      dbg("shouldSkip → []");
      return [];
    }

    // Supersede any pending debounced call — resolve its promise so nothing dangles.
    // EVERY keystroke must reschedule the timer; dropping one without rescheduling
    // means the user's final keystroke never produces a completion.
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (this._pendingResolve) {
      dbg("debounce supersede → prev resolved []");
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
            const itext = cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
            dbg(`state SET (cache) → ${cleaned.length}c @${position.line}:${position.character} [${itext}]`);
            _lastSuggestion = {
              text: cleaned,
              uri: document.uri.toString(),
              line: position.line,
              character: position.character,
            };
            rememberSuggestion(_lastSuggestion);
            setGhostAnchor(document, cleaned, position);
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
          const itext = cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
          dbg(`state SET (API) → ${cleaned.length}c @${position.line}:${position.character} [${itext}]`);
          _lastSuggestion = {
            text: cleaned,
            uri: document.uri.toString(),
            line: position.line,
            character: position.character,
          };
          rememberSuggestion(_lastSuggestion);
          setGhostAnchor(document, cleaned, position);

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
      const cur = _lastSuggestion ? `${_lastSuggestion.text.length}c@${_lastSuggestion.line}:${_lastSuggestion.character}` : "null";
      const chg = e.contentChanges.length ? e.contentChanges.map(c => c.text.length + "c").join(",") : "zero";
      dbg(`watchAcceptance ENTRY state=${cur} changes=[${chg}]`);
      if (!_lastSuggestion) return;
      if (e.document.uri.toString() !== _lastSuggestion.uri) {
        dbg("state CLEAR ≡ uri-mismatch (watchAcceptance)");
        _lastSuggestion = null;
        return;
      }
      for (const change of e.contentChanges) {
        if (!change.text || !_lastSuggestion) continue;
        // Full accept (Tab): VSCode inserts the entire suggestion at once
        if (change.text === _lastSuggestion.text) {
          statBump("accepted");
          dbg("state CLEAR ≡ Tab full-accept (watchAcceptance)");
          _lastSuggestion = null;
          return;
        }
        // DO NOT clear on non-matching edits here. This listener races with the
        // provider's instant-remainder: when the document event arrives AFTER the
        // provider already shrank _lastSuggestion.text past this edit, startsWith
        // misfires and nukes valid state (the "ghost text vanishes on every
        // keystroke" bug — debug log 2026-07-24). The provider's own stale check
        // (typed text from anchor→cursor vs suggestion) is the single source of truth.
      }
    })
  );
}

// ── Activation ───────────────────────────────────────────────────────

function activate(context) {
  _context = context;
  loadStats();
  initStatusBar();
  outputChannel(); // eager: channel must exist in the Output dropdown immediately
  dbg("v1.5.0 activated, debug logging on");
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dsAutocomplete.debug")) {
        if (config().get("debug")) {
          dbg("debug logging ENABLED via settings change");
        } else {
          outputChannel().appendLine("[debug] logging DISABLED via settings change");
        }
      }
    })
  );

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

  // Auto-trigger: cursor inside empty parens — user typed `print()` then
  // arrowed in; no-text-change = no normal trigger. Detect and fire.
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // ── Ghost text acceptance detection (Continue/Copilot pattern) ──
      // Cursor moved — check if it landed at the expected ghost-text end
      // position. If yes and the document confirms the text was inserted,
      // it was an acceptance (Tab or typed-all-chars).
      const editor = e.textEditor;
      const pos = editor.selection.active;
      if (checkGhostAccepted(editor.document, pos)) {
        statBump("accepted");
        dbg("ghost accepted (cursor at ghost end + text match)");
        _lastSuggestion = null;
        // Fall through to the rest of the handler (empty-paren trigger below)
        return;
      }
      // Cursor moved elsewhere while ghost was showing → rejection
      if (_ghostAnchor && _ghostAnchor.uri === editor.document.uri.toString()) {
        statBump("rejected");
        dbg("ghost rejected (cursor moved away from ghost end)");
        _ghostAnchor = null;
        _lastSuggestion = null;
      }

      // ── Empty-paren auto-trigger ──
      if (!config().get("triggerOnExplicit")) return;
      const doc = editor.document;
      const line = doc.lineAt(pos.line).text;
      const before = line.slice(0, pos.character);
      const after = line.slice(pos.character);
      const openParen = before.lastIndexOf("(");
      if (openParen === -1) return;
      const closeParen = after.indexOf(")");
      if (closeParen === -1) return;
      const between = before.slice(openParen + 1) + after.slice(0, closeParen);
      if (between.trim().length === 0) {
        if (_cursorTriggerTimer) clearTimeout(_cursorTriggerTimer);
        _cursorTriggerTimer = setTimeout(() => {
          vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        }, 200);
      }
    })
  );

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
        _lastSuggestion.line = editor.selection.active.line;
        _lastSuggestion.character = editor.selection.active.character;
        _pendingRemainder = { text: remainder, uri: _lastSuggestion.uri };
      } else {
        statBump("accepted");
        dbg("state CLEAR ≡ partial-accept consumed all");
        _lastSuggestion = null;
      }
    })
  );

  // Line-by-line accept (Cmd+Down)
  context.subscriptions.push(
    vscode.commands.registerCommand("dsAutocomplete.acceptLine", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !_lastSuggestion) {
        await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
        return;
      }
      const full = _lastSuggestion.text;
      const nl = full.indexOf("\n");
      // First line INCLUDING its line break — cursor lands on the next line,
      // where the remainder renders as fresh ghost text.
      const unit = nl === -1 ? full : full.slice(0, nl + 1);
      const remainder = nl === -1 ? "" : full.slice(nl + 1);

      await editor.edit((eb) => eb.insert(editor.selection.active, unit));

      if (remainder) {
        _lastSuggestion.text = remainder;
        _lastSuggestion.line = editor.selection.active.line;
        _lastSuggestion.character = editor.selection.active.character;
        _pendingRemainder = { text: remainder, uri: _lastSuggestion.uri };
      } else {
        statBump("accepted");
        dbg("state CLEAR ≡ partial-accept consumed all");
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
        `DS Autocomplete v1.5.0 · ${config().get("model")}\n` +
          `补全 ${s.shown} 次 · 接受 ${s.accepted} (${rate}%) · 缓存命中 ${s.cacheHits} (${cacheRate}%)\n` +
          `API 请求 ${s.requests} 次 · 重试 ${s.retries} 次 · 约 ${s.tokensUsed} tokens`
      );
    })
  );

  console.log(`[DS Autocomplete] v1.5.0 activated — ${langs.join(", ")}`);

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
