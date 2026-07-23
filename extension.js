const vscode = require("vscode");
const https = require("https");

// ── Config helpers ────────────────────────────────────────────────────

function config() {
  return vscode.workspace.getConfiguration("dsAutocomplete");
}

// ── Status bar ────────────────────────────────────────────────────────

let _statusBar = null;
let _statusTimer = null;
const _availableModels = [
  { label: "DeepSeek V4 Flash", description: "fast · cheap · default", value: "deepseek-v4-flash" },
  { label: "DeepSeek V4 Pro", description: "smart · slower · higher quality", value: "deepseek-v4-pro" },
  { label: "DeepSeek Coder", description: "code-specialized · FIM-native", value: "deepseek-coder" },
];

function initStatusBar() {
  _statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  _statusBar.command = "dsAutocomplete.switchModel";
  _statusBar.tooltip = "Click to switch model / Show info";
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
    _statusTimer = setTimeout(() => {
      updateStatusBarModel();
    }, ms);
  }
}

function flashError(text) {
  showStatus(text, "$(error)", 5000);
}

// ── API caller (with AbortController-like cancel) ────────────────────

let _activeRequest = null; // { req, cancel }

function evaluateFIM(prompt, suffix, cancelToken) {
  const cfg = config();
  const key = cfg.get("apiKey");
  if (!key) return Promise.reject(new Error("No API key configured"));

  const body = JSON.stringify({
    model: cfg.get("model"),
    prompt: prompt,
    suffix: suffix,
    max_tokens: cfg.get("maxTokens"),
    temperature: cfg.get("temperature"),
    stop: cfg.get("stopTokens") || [],
  });

  return new Promise((resolve, reject) => {
    // Cancel previous in-flight request
    if (_activeRequest) {
      _activeRequest.req.destroy();
      _activeRequest = null;
    }

    const req = https.request(
      cfg.get("apiBase"),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: cfg.get("requestTimeoutMs"),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          _activeRequest = null;
          if (cancelToken && cancelToken.isCancellationRequested) {
            resolve(null);
            return;
          }
          try {
            const r = JSON.parse(data);
            if (r.choices?.[0]?.text != null) {
              resolve(r.choices[0].text);
            } else {
              reject(new Error(r.error?.message || "Empty completion"));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on("error", (err) => {
      _activeRequest = null;
      reject(err);
    });
    req.on("timeout", () => {
      _activeRequest = null;
      req.destroy();
      reject(new Error("Request timeout"));
    });

    _activeRequest = { req, cancel: () => req.destroy() };

    if (cancelToken) {
      cancelToken.onCancellationRequested(() => {
        if (_activeRequest?.req) _activeRequest.req.destroy();
        _activeRequest = null;
      });
    }

    req.write(body);
    req.end();
  });
}

// ── Prompt builder ────────────────────────────────────────────────────

function buildFIM(document, position) {
  const cfg = config();
  const full = document.getText();
  const offset = document.offsetAt(position);

  const prefix = full.slice(
    Math.max(0, offset - cfg.get("maxPrefixChars")),
    offset
  );
  const suffix = full.slice(offset, offset + cfg.get("maxSuffixChars"));

  return {
    prompt: "<｜fim▁begin｜>" + prefix,
    suffix: suffix + "<｜fim▁end｜>",
  };
}

// ── Response cleaner ──────────────────────────────────────────────────

function cleanCompletion(text, multiLine) {
  let cleaned = text
    .replace(/<｜fim▁end｜>/g, "")
    .replace(/<｜fim▁begin｜>/g, "")
    .replace(/<\|endoftext\|>/g, "")
    .replace(/^```[\s\S]*?```$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  if (!multiLine) {
    // Single-line: stop at first newline after trimming trailing blank lines
    cleaned = cleaned.split("\n")[0].trimEnd();
  }

  return cleaned;
}

// ── Language helpers ──────────────────────────────────────────────────

function isMultilineContext(document, position) {
  // Check if there's code on the next line (good suffix for multiline)
  const line = position.line;
  if (line >= document.lineCount - 1) return false;
  const nextLine = document.lineAt(line + 1);
  return nextLine.text.trim().length > 0;
}

// ── InlineCompletionItemProvider ──────────────────────────────────────

class DeepSeekCompletionProvider {
  constructor() {
    this._debounceTimer = null;
    this._lastRequest = 0;
  }

  async provideInlineCompletionItems(document, position, context, token) {
    const cfg = config();

    // Skip on explicit trigger (Ctrl+Space) unless configured
    if (
      context.triggerKind === vscode.InlineCompletionTriggerKind.Explicit &&
      !cfg.get("triggerOnExplicit")
    ) {
      return [];
    }

    // Rate limit: don't fire more than once per debounce window
    const now = Date.now();
    if (now - this._lastRequest < cfg.get("debounceMs")) {
      return [];
    }

    // Debounce
    if (this._debounceTimer) clearTimeout(this._debounceTimer);

    return new Promise((resolve) => {
      this._debounceTimer = setTimeout(async () => {
        this._lastRequest = Date.now();
        this._debounceTimer = null;

        if (token.isCancellationRequested) {
          resolve([]);
          return;
        }

        showStatus("DS thinking…", "$(sync~spin)");

        try {
          const { prompt, suffix } = buildFIM(document, position);
          const result = await evaluateFIM(prompt, suffix, token);

          if (token.isCancellationRequested || !result) {
            showStatus("DS ready", "$(check)", 2000);
            resolve([]);
            return;
          }

          const multiLine =
            cfg.get("multiLine") ||
            (cfg.get("multiLineMode") === "auto" &&
              isMultilineContext(document, position));

          const cleaned = cleanCompletion(result, multiLine);
          if (!cleaned) {
            showStatus("DS ready", "$(check)", 2000);
            resolve([]);
            return;
          }

          showStatus("DS ready", "$(check)", 2000);

          const item = new vscode.InlineCompletionItem(cleaned);
          // Optionally set a range to replace only the partial word
          if (cfg.get("replacePartialWord")) {
            const wordRange = document.getWordRangeAtPosition(position);
            if (wordRange) {
              item.range = wordRange;
            }
          }

          resolve([item]);
        } catch (err) {
          showStatus("DS ready", "$(check)", 2000);
          if (err.message !== "canceled") {
            console.error("[DS Autocomplete]", err.message);
            flashError(`DS: ${err.message.slice(0, 40)}`);
          }
          resolve([]);
        }
      }, cfg.get("debounceMs"));
    });
  }
}

// ── Activation / Deactivation ────────────────────────────────────────

function activate(context) {
  initStatusBar();

  const provider = new DeepSeekCompletionProvider();

  const langs = vscode.workspace
    .getConfiguration("dsAutocomplete")
    .get("enabledLanguages");

  for (const lang of langs) {
    const disp = vscode.languages.registerInlineCompletionItemProvider(
      { language: lang },
      provider
    );
    context.subscriptions.push(disp);
  }

  // Model switcher command
  const switchCmd = vscode.commands.registerCommand(
    "dsAutocomplete.switchModel",
    async () => {
      const picked = await vscode.window.showQuickPick(_availableModels, {
        placeHolder: "Select autocomplete model…",
      });
      if (picked) {
        await config().update("model", picked.value, true);
        updateStatusBarModel();
        vscode.window.showInformationMessage(
          `DS Autocomplete → ${picked.label}`
        );
      }
    }
  );
  context.subscriptions.push(switchCmd);

  // Info command
  const statsCmd = vscode.commands.registerCommand(
    "dsAutocomplete.showStats",
    () => {
      const m = config().get("model");
      vscode.window.showInformationMessage(
        `DS Autocomplete v1.0.0 · ${m}`
      );
    }
  );
  context.subscriptions.push(statsCmd);

  // Log activation
  const activeLangs = langs.join(", ");
  console.log(`[DS Autocomplete] activated — ${activeLangs}`);
  showStatus("DS ready", "$(check)", 3000);
}

function deactivate() {
  if (_statusBar) {
    _statusBar.dispose();
    _statusBar = null;
  }
}

module.exports = { activate, deactivate };
