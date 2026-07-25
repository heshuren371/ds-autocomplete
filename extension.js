const vscode = require("vscode");
const https = require("https");

// ══════════════════════════════════════════════════════════════════════
// dsAutocomplete — DeepSeek 代码自动补全
//
// 设计原则: 不浪费 token | 幽灵文跟随打字 | 双模式补全 | 状态自愈
//
// 数据流: 打字 → debounce(200ms) → buildFIM → requestFIM → cleanCompletion
//        → postProcess(去重/缩进) → 幽灵文 → Tab/Cmd+Right 接受
// ══════════════════════════════════════════════════════════════════════

function config() {
  return vscode.workspace.getConfiguration("dsAutocomplete");
}

// ══════════════════════════════════════════════════════════════════════
// 调试日志 — 输出到 "DS Autocomplete" 面板
// 只有设置开 debug 才输出；自带 2 秒去重防止刷屏
// ══════════════════════════════════════════════════════════════════════

let _output = null;
let _lastDbgMsg = "";
let _lastDbgTime = 0;
function outputChannel() {
  if (!_output) _output = vscode.window.createOutputChannel("DS Autocomplete");
  return _output;
}
let _debugEnabled = false; // cached copy, updated on config change
function dbg(msg) {
  if (!_debugEnabled) return;
  const now = Date.now();
  if (msg === _lastDbgMsg && now - _lastDbgTime < 2000) return;
  _lastDbgMsg = msg;
  _lastDbgTime = now;
  const t = new Date().toISOString().slice(11, 23);
  outputChannel().appendLine(`[${t}] ${msg}`);
}

// ══════════════════════════════════════════════════════════════════════
// 状态栏 — 右下角显示模型名，点击切换；语言禁用时显示 ⊘
// ══════════════════════════════════════════════════════════════════════

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

  // Check if the current language is disabled
  const editor = vscode.window.activeTextEditor;
  const lang = (editor && editor.document) ? editor.document.languageId : "";
  const disabled = (config().get("disabledLanguages") || []).includes(lang);
  const langIcon = disabled ? "$(circle-slash)" : "$(symbol-text)";

  _statusBar.text = `${langIcon} DS ${label}`;
  _statusBar.tooltip = disabled
    ? `DeepSeek: ${label} (disabled for ${lang} — check dsAutocomplete.disabledLanguages)`
    : `DeepSeek: ${label} · ${lang}`;
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

// ══════════════════════════════════════════════════════════════════════
// 补全统计 — 本地持久化，不上传
// shown/accepted/rejected/cacheHits/requests/tokensUsed
// ══════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════
// 补全缓存 — 相同上下文 5 分钟内秒回，key = 模型+prefix尾+suffix头
// ══════════════════════════════════════════════════════════════════════

const CACHE_MAX = 120;
const CACHE_TTL = 5 * 60 * 1000;
const _cache = new Map(); // key -> { text, time }

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function cacheKey(prefix, suffix, model) {
  // 缓存 key: prefix 末尾 1500 + suffix 开头 400
  return model + "|" + hashStr(prefix.slice(-1500)) + "|" + hashStr(suffix.slice(0, 400));
}

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) {
    _cache.delete(key);
    return null;
  }
  // LRU 访问更新
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

// ══════════════════════════════════════════════════════════════════════
// 上下文过滤 — 不该补全的场景返回 true 跳过
// 场景1: 空文件光标在开头（无上下文可猜）
// 场景2: 光标在字符串内且引号为奇数（默认关闭，FIM 模型自己能处理）
// ══════════════════════════════════════════════════════════════════════

function shouldSkip(document, position) {
  // 场景1: 空文件光标在开头
  const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position)).trim();
  if (!before) return true;

  // 场景2: 光标在字符串内（默认关闭）
  // 开着会杀掉 print("hello 这类最需要的补全
  // 所以默认关闭

  if (config().get("skipInString")) {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const singles = (linePrefix.match(RE_SINGLE_QUOTE) || []).length;
    const doubles = (linePrefix.match(RE_DOUBLE_QUOTE) || []).length;
    const backticks = (linePrefix.match(RE_BACKTICK) || []).length;
    if (singles % 2 === 1 || doubles % 2 === 1 || backticks % 2 === 1) return true;
  }

  return false;
}

// ══════════════════════════════════════════════════════════════════════
// 正则编译到模块顶层 — JS 正则每次用都重新编译，这里编译一次复用
// ══════════════════════════════════════════════════════════════════════

const RE_FIM_END = /<｜fim▁end｜>/g;
const RE_FIM_BEGIN = /<｜fim▁begin｜>/g;
const RE_EOF = /<\|endoftext\|>/g;
const RE_MARKDOWN_FENCE = /```[a-z]*\n?/g;
const RE_MULTIBLANK = /\n{3,}/g;
const RE_FUNC_START = /^(def |class |async def |@)/;
const RE_SINGLE_QUOTE = /'/g;
const RE_DOUBLE_QUOTE = /"/g;
const RE_BACKTICK = /`/g;
const RE_EARLY_BOUNDARY = /[)\]}'"\s,;]$/;
const RE_DOUBLENEWLINE_END = /\n\n$/;
const RE_WHITESPACE_WORD = /^\s*\S+/;

// ══════════════════════════════════════════════════════════════════════
// imports 缓存 — getText() 便宜，扫 imports 贵。按 (uri,version) 缓存
// ══════════════════════════════════════════════════════════════════════
// getText() 便宜，扫 imports 贵


let _importCache = { uri: "", version: -1, imports: "" };

function getCachedImports(document) {
  const uri = document.uri.toString();
  if (_importCache.uri === uri && _importCache.version === document.version) {
    return _importCache.imports;
  }
  _importCache.uri = uri;
  _importCache.version = document.version;
  _importCache.imports = extractImportsFast(document.getText());
  return _importCache.imports;
}

function extractImportsFast(text) {
  const lines = text.split("\n");
  const imports = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i].trim();
    if (line.startsWith("import ") || line.startsWith("from ")) {
      imports.push(line);
    } else if (imports.length > 0 && line.length === 0) {
      continue;
    } else if (imports.length > 0 && !line.startsWith("#")) {
      break;
    }
  }
  return imports.length > 0 ? imports.join("\n") + "\n\n" : "";
}

// ══════════════════════════════════════════════════════════════════════
// 注释转代码 — Copilot 同款 Next Edit Suggestion
// 光标在注释后 → 模型把注释当指令执行，生成实现代码（走 chat API）
// ══════════════════════════════════════════════════════════════════════
// 注释后自动切 chat API
// 模型把注释当指令执行

function isCommentBlock(document, position) {
  const cfg = config();
  if (!cfg.get("commentToCode")) return false;
  if (!cfg.get("multiLine")) return false;

  const line = document.lineAt(position.line).text;
  const trimmed = line.slice(0, position.character).trim();

  // 注释后空行 → 触发
  if (trimmed.length === 0) {
    if (position.line > 0) {
      const prev = document.lineAt(position.line - 1).text.trim();
      if (prev.startsWith("#") || prev.startsWith('"""') || prev.startsWith("'''")) {
        return true;
      }
    }
    if (position.line === 0) return false;
    // 注释块后第一行第一列
    return false;
  }

  // 注释行上 → 生成下一行
  if (trimmed.startsWith("#")) return true;

  // 注释行下一行开头
  if (position.line > 0 && position.character === 0) {
    const prev = document.lineAt(position.line - 1).text.trim();
    if (prev.startsWith("#")) return true;
  }

  return false;
}

// ══════════════════════════════════════════════════════════════════════
// FIM 提示词构造 — prefix(上文) + suffix(下文) + header(文件路径+imports)
// prefix 从函数/类开头截断（不是从中间随机字符开始）
// ══════════════════════════════════════════════════════════════════════
// 对齐 PyCharm/Cursor/Copilot 的上下文策略

//   - 文件路径标注
//   - import 语句（模型知道可用模块）
//   - 从函数/类开头截断

const path = require("path");

function buildContextHeader(document) {
  const filename = document.uri.fsPath
    ? path.basename(document.uri.fsPath)
    : document.uri.toString().split("/").pop();
  return `# ${filename}\n`;
}

function extractImports(document) {
  const lines = document.getText().split("\n");
  const imports = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i].trim();
    if (line.startsWith("import ") || line.startsWith("from ")) {
      imports.push(line);
    } else if (imports.length > 0 && line.length === 0) {
      continue; // blank lines within import section
    } else if (imports.length > 0 && !line.startsWith("#")) {
      break; // first non-import, non-comment line ends the section
    }
  }
  return imports.length > 0 ? imports.join("\n") + "\n\n" : "";
}

function findPrefixBoundary(text, offset, maxChars) {
  const rawStart = Math.max(0, offset - maxChars);
  // Try to align to the start of the current function or class
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RE_FUNC_START.test(lines[i].trim())) {
      const pos = before.lastIndexOf(lines[i]);
      if (pos >= rawStart) return pos;
      return rawStart;
    }
  }
  return rawStart;
}

function buildFIM(document, position) {
  const cfg = config();
  const full = document.getText();
  const offset = document.offsetAt(position);

  const header = buildContextHeader(document);
  const imports = getCachedImports(document);
  const overhead = header.length + imports.length;

  // Single-line: only need current-line context (token efficiency)
  const multiLine = cfg.get("multiLine");
  const maxPrefix = multiLine
    ? cfg.get("maxPrefixChars")
    : Math.min(cfg.get("maxPrefixChars"), 800);
  const maxSuffix = multiLine
    ? cfg.get("maxSuffixChars")
    : Math.min(cfg.get("maxSuffixChars"), 200);

  const prefixStart = findPrefixBoundary(full, offset, maxPrefix - overhead);
  const rawPrefix = full.slice(prefixStart, offset);
  const prefix = (header + imports + rawPrefix).slice(-maxPrefix);
  const suffix = full.slice(offset, offset + maxSuffix);

  return { prompt: prefix, suffix: suffix };
}

// ══════════════════════════════════════════════════════════════════════
// 补全结果清洗 — 去 FIM token/markdown/多余空行
// ══════════════════════════════════════════════════════════════════════

function cleanCompletion(text, multiLine) {
  let cleaned = text
    .replace(RE_FIM_END, "")
    .replace(RE_FIM_BEGIN, "")
    .replace(RE_EOF, "")
    .replace(RE_MARKDOWN_FENCE, "")
    .replace(RE_MULTIBLANK, "\n\n")
    .trimEnd();
  if (!multiLine) {
    cleaned = cleaned.split("\n")[0].trimEnd();
  }
  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════
// 后处理 — 去重(模型把下文重抄) + 缩进对齐(模型不知道你在几层)
// ══════════════════════════════════════════════════════════════════════

function postProcessCompletion(cleaned, document, position) {
  if (!cleaned) return cleaned;

  // 1. Dedup — trim prefix that already appears right after cursor
  const suffix = document.getText(
    new vscode.Range(position, new vscode.Position(document.lineCount, 0))
  );
  if (suffix) {
    // Google each prefix length from longest to shortest
    for (let len = Math.min(cleaned.length, suffix.length, 40); len >= 2; len--) {
      if (suffix.startsWith(cleaned.slice(0, len))) {
        cleaned = cleaned.slice(len);
        break;
      }
    }
    if (!cleaned) return "";
  }

  // 2. Fix indentation — match cursor's line indentation level
  if (cleaned.includes("\n")) {
    const cursorLine = document.lineAt(position.line).text;
    const cursorIndent = cursorLine.match(/^(\s*)/)[1];
    const charIdx = position.character;

    // If cursor is inside indentation or at column 0 of indented line,
    // align the completion's first non-empty line
    if (charIdx <= cursorIndent.length) {
      const lines = cleaned.split("\n");
      // Find the typical indent level from surrounding code
      const docLines = document.getText().split("\n");
      let baseIndent = "    "; // fallback
      for (let i = Math.max(0, position.line - 5); i < position.line; i++) {
        const m = docLines[i].match(/^(\s+)\S/);
        if (m) { baseIndent = m[1]; break; }
      }
      // Rebase multi-line completions to match document indentation
      const firstNonEmpty = lines.findIndex(l => l.trim().length > 0);
      if (firstNonEmpty >= 0) {
        const modelIndent = lines[firstNonEmpty].match(/^(\s*)/)[1];
        const targetIndent = cursorIndent + baseIndent;
        for (let i = firstNonEmpty; i < lines.length; i++) {
          if (lines[i].trim().length === 0) continue;
          const rel = lines[i].length - lines[i].trimStart().length;
          const relIndent = lines[i].slice(0, Math.min(rel, lines[i].length - lines[i].trimStart().length));
          // Relative indent level (model-generated) + base target indent
          const level = Math.round((relIndent.length - modelIndent.length) / baseIndent.length);
          const newIndent = targetIndent + baseIndent.repeat(Math.max(0, level + (i > firstNonEmpty ? 0 : -1)));
          lines[i] = newIndent + lines[i].trimStart();
        }
        cleaned = lines.join("\n");
      }
    }
  }

  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════
// DeepSeek FIM API — SSE 流式 + 早停(5-8 token) + 429/5xx 重试
// ══════════════════════════════════════════════════════════════════════

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
    let tokenCount = 0;

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
                tokenCount++;

                // Early resolve — show ghost text as soon as we have
                // enough to be useful. Copilot/Cursor prioritize speed
                // over completion completeness. 5 tokens for single-line,
                // 8 for multi-line.
                const minTokens = multiLine ? 8 : 5;
                if (tokenCount >= minTokens && accumulated.trim().length > 0) {
                  const trimmed = accumulated.trim();
                  // Resolve at a word boundary for cleaner partial results
                  const boundary = RE_EARLY_BOUNDARY;
                  if (boundary.test(trimmed) || trimmed.endsWith(":") || trimmed.endsWith(" ")) {
                    req.destroy();
                    finish(trimmed, false);
                    return;
                  }
                }

                // Early exit: we have enough, kill the stream (saves server-side generation)
                if (multiLine && accumulated.endsWith("\n\n")) {
                  req.destroy();
                  finish(accumulated.replace(RE_DOUBLENEWLINE_END, "\n"), false);
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

// ══════════════════════════════════════════════════════════════════════
// Chat API — 注释转代码专用。FIM=文本填空，Chat=指令执行
// ══════════════════════════════════════════════════════════════════════
// When the cursor follows a comment block, switch from FIM to chat/completions.
// 模型把注释当指令执行

function requestCommentToCode(document, position, cancelToken) {
  const cfg = config();
  const key = cfg.get("apiKey");
  if (!key) return Promise.reject(new Error("No API key"));

  const full = document.getText();
  const offset = document.offsetAt(position);

  // Collect the comment block above the cursor as instructions
  const lines = full.slice(0, offset).split("\n");
  let commentStart = lines.length - 1;
  while (commentStart >= 0 && lines[commentStart].trim().startsWith("#")) {
    commentStart--;
  }
  commentStart++; // back to first comment line
  const instruction = lines.slice(commentStart).join("\n").trim();
  const preceding = lines.slice(0, commentStart).join("\n");

  const systemMsg = "你是一个代码生成器。根据注释描述的任务，直接输出实现代码。不要输出 markdown 代码块标记，不要解释——只要代码。";
  const userMsg = `文件上下文:\n${preceding}\n\n任务（根据注释）:\n${instruction}\n\n实现代码:`;

  const body = JSON.stringify({
    model: cfg.get("model"),
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    stream: true,
    max_tokens: cfg.get("multiLine") ? 800 : 400,
    temperature: 0,
    stop: ["\n\n\n"],
  });

  statBump("requests");

  return new Promise((resolve, reject) => {
    let done = false;
    let accumulated = "";
    let buffer = "";

    const finish = (value, isError) => {
      if (done) return;
      done = true;
      if (isError) reject(value);
      else resolve(value);
    };

    const chatBase = cfg.get("apiBase").replace("/beta/completions", "");

    const req = https.request(
      chatBase,
      {
        method: "POST",
        path: "/v1/chat/completions",
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
            try { msg = JSON.parse(errData).error?.message || msg; } catch {}
            finish(new Error(msg), true);
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
            if (payload === "[DONE]") { finish(accumulated, false); return; }
            try {
              const j = JSON.parse(payload);
              const delta = j.choices?.[0]?.delta?.content ?? "";
              accumulated += delta;
              // Stop at a natural break
              if (accumulated.includes("\n\n\n")) {
                finish(accumulated.replace(/\n\n\n.*$/s, ""), false);
                return;
              }
            } catch {}
          }
        });
        res.on("end", () => finish(accumulated, false));
        res.on("error", (e) => finish(e, true));
      }
    );
    req.on("error", (e) => finish(e, true));
    req.on("timeout", () => { req.destroy(); finish(new Error("timeout"), true); });
    if (cancelToken) {
      cancelToken.onCancellationRequested(() => { req.destroy(); finish(null, false); });
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

// ══════════════════════════════════════════════════════════════════════
// 请求生命周期 — UUID 追踪 shown→accepted/rejected/ignored
// ══════════════════════════════════════════════════════════════════════
// Each suggestion gets a UUID; tracked through show→accept/reject/ignore.
// Used for quality telemetry — understanding WHY a suggestion didn't get used.
let _requestUuid = 0;
let _currentRequest = null; // { id, text, uri, line, character, shownAt }

function startRequest(suggestionText, document, position) {
  _requestUuid++;
  _currentRequest = {
    id: _requestUuid,
    text: suggestionText,
    uri: document.uri.toString(),
    line: position.line,
    character: position.character,
    shownAt: Date.now(),
    status: "shown",
  };
  statBump("shown");
  if (_currentRequest.id % 50 === 0) dbg(`stats panel → Shown:${_stats.shown} Accepted:${_stats.accepted} Rejected:${_stats.rejected} Cache:${_stats.cacheHits}`);
}

function endRequest(status) {
  if (!_currentRequest) return;
  _currentRequest.status = status;
  _currentRequest.durationMs = Date.now() - _currentRequest.shownAt;
  statBump(status);
  _currentRequest = null;
}

// ── Word-by-word accept ─────────────────────────────────────────────

let _lastSuggestion = null; // { text, uri, line, character }
let _pendingRemainder = null; // remainder after partial accept

// ══════════════════════════════════════════════════════════════════════
// 幽灵文接受追踪 — 光标移到幽灵文末尾+文本匹配=接受，移开=拒绝
// ══════════════════════════════════════════════════════════════════════
// 补全展示时记录幽灵文结束位置
// 光标移到末尾 → 接受
// 光标移开 → 拒绝
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

// ══════════════════════════════════════════════════════════════════════
// 建议历史 — 幽灵文的后悔药。widget/IME/竞态清掉的状态，从历史恢复
// ══════════════════════════════════════════════════════════════════════
// _lastSuggestion 被 widget/IME/竞态清掉时
// 从历史恢复幽灵文

// TTL 15 秒，startsWith 防错配

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

// ══════════════════════════════════════════════════════════════════════
// 补全提供者 — 核心入口
// 优先级: selectedCompletionInfo→_pendingRemainder→_lastSuggestion
//        →历史恢复→debounce→API
// ══════════════════════════════════════════════════════════════════════

function makeCompletionItem(text, range) {
  // Tabby pattern: attach a command that fires when the user accepts
  // (Tab). More reliable than cursor-position heuristics.
  return new vscode.InlineCompletionItem(text, range, {
    title: "",
    command: "dsAutocomplete.onAccept",
    arguments: [],
  });
}

class DeepSeekCompletionProvider {
  constructor() {
    this._debounceTimer = null;
    this._pendingResolve = null;
  }

  async provideInlineCompletionItems(document, position, context, token) {
    const cfg = config();

    // Skip when text is selected (Tabby pattern) — prevents interference
    // with multi-cursor, selection edits, or highlight-then-type workflows.
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.selection && !editor.selection.isEmpty &&
        editor.document && editor.document.uri &&
        editor.document.uri.toString() === document.uri.toString()) {
      return [];
    }

    // Explicit language disable (per-language control, Copilot pattern)
    const disabled = cfg.get("disabledLanguages") || [];
    if (disabled.includes(document.languageId)) {
      return [];
    }

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
        startRequest(rem.text, document, position);
        setGhostAnchor(document, rem.text, position);
        return [makeCompletionItem(rem.text)];
      }
      return [];
    }

    // ── VSCode-native ghost-text tracking (Continue's approach) ──
    // 幽灵文可见时 VSCode 传权威状态
    // text=完整补全，range=锚点→光标
    // 权威状态，零竞态

    // Continue completionProvider.ts:187-205
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
        endRequest("accepted");
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
            startRequest(remainder, document, position);
            setGhostAnchor(document, remainder, position);
            return [makeCompletionItem(remainder)];
          }
          // Perfect match — entire suggestion consumed
          endRequest("accepted");
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
    // _lastSuggestion 被 widget/IME 清掉
    // 从历史恢复

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
              startRequest(recRem, document, position);
              setGhostAnchor(document, recRem, position);
              return [makeCompletionItem(recRem)];
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
      endRequest("ignored");
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

        // Comment-to-code mode: cursor follows a comment → use chat API
        if (isCommentBlock(document, position)) {
          dbg("comment-to-code mode → using chat API");
          try {
            const result = await requestCommentToCode(document, position, token);
            if (token.isCancellationRequested || !result) { resolve([]); return; }
            const cleaned = cleanCompletion(result, true);
            const final = postProcessCompletion(cleaned, document, position);
            if (!final) { resolve([]); return; }
            startRequest(final, document, position);
            dbg(`state SET (chat) → ${final.length}c`);
            _lastSuggestion = {
              text: final, uri: document.uri.toString(),
              line: position.line, character: position.character,
            };
            rememberSuggestion(_lastSuggestion);
            setGhostAnchor(document, final, position);

            const item = makeCompletionItem(final);
            resolve([item]);
            return;
          } catch (err) {
            dbg(`comment-to-code failed: ${err.message}, falling back to FIM`);
            // Fall through to FIM below
          }
        }
        const model = cfg.get("model");
        const cKey = cacheKey(prompt, suffix, model);

        // Cache hit → instant
        const cached = cacheGet(cKey);
        if (cached) {
          const cleaned = cleanCompletion(cached, cfg.get("multiLine"));
          const final = postProcessCompletion(cleaned, document, position);
          if (final) {
            startRequest(final, document, position);
            const itext = final.length > 30 ? final.slice(0, 30) + "…" : final;
            dbg(`state SET (cache) → ${final.length}c @${position.line}:${position.character} [${itext}]`);
            _lastSuggestion = {
              text: final,
              uri: document.uri.toString(),
              line: position.line,
              character: position.character,
            };
            rememberSuggestion(_lastSuggestion);
            setGhostAnchor(document, final, position);
            resolve([makeCompletionItem(final)]);
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
          const final = postProcessCompletion(cleaned, document, position);
          updateStatusBarModel();
          if (!final) {
            resolve([]);
            return;
          }

          startRequest(final, document, position);
          const itext = final.length > 30 ? final.slice(0, 30) + "…" : final;
          dbg(`state SET (API) → ${final.length}c @${position.line}:${position.character} [${itext}]`);
          _lastSuggestion = {
            text: final,
            uri: document.uri.toString(),
            line: position.line,
            character: position.character,
          };
          rememberSuggestion(_lastSuggestion);
          setGhostAnchor(document, final, position);

          const item = makeCompletionItem(final);
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

// ══════════════════════════════════════════════════════════════════════
// 接受追踪 — 监听文档变化，检测 Tab 全接受（change.text 完全匹配）
// ══════════════════════════════════════════════════════════════════════

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
        // Tab 全接受: VSCode 把幽灵文全部插入
        if (change.text === _lastSuggestion.text) {
          endRequest("accepted");
          dbg("state CLEAR ≡ Tab full-accept (watchAcceptance)");
          _lastSuggestion = null;
          return;
        }
        // 不要在非匹配编辑时清状态（和 provider 竞态）
        // provider 的即时收缩是单一事实来源




      }
    })
  );
}

// ══════════════════════════════════════════════════════════════════════
// 扩展激活入口 — VSCode 启动时调用，初始化所有组件
// ══════════════════════════════════════════════════════════════════════

function activate(context) {
  _context = context;
  loadStats();
  initStatusBar();
  outputChannel(); // eager: channel must exist in the Output dropdown immediately
  dbg("v1.6.3 activated, debug logging on");
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dsAutocomplete.debug")) {
        _debugEnabled = config().get("debug");
        if (_debugEnabled) {
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

  context.subscriptions.push(
    vscode.commands.registerCommand("dsAutocomplete.onAccept", async () => {
      endRequest("accepted");
      _lastSuggestion = null;
      _ghostAnchor = null;
      dbg("ghost accepted (Tab via command callback — Tabby pattern)");
    })
  );

  watchAcceptance(context);

  // 切换编辑器时更新状态栏语言指示
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBarModel())
  );

  // 空括号自动触发: 用户打了 () 后光标在中间
  // VSCode 不重新触发 → 手动检测并触发
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // ── Ghost text acceptance detection (Continue/Copilot pattern) ──
      // 光标移动 → 检查是否在幽灵文末尾
      // 末尾+文本匹配 → 接受
      // 不在末尾 → 拒绝
      const editor = e.textEditor;
      const pos = editor.selection.active;
      if (checkGhostAccepted(editor.document, pos)) {
        endRequest("accepted");
        dbg("ghost accepted (cursor at ghost end + text match)");
        _lastSuggestion = null;
        // 继续执行空括号触发
        return;
      }
      // Cursor moved elsewhere while ghost was showing → rejection
      if (_ghostAnchor && _ghostAnchor.uri === editor.document.uri.toString()) {
        endRequest("rejected");
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
      const m = full.match(RE_WHITESPACE_WORD);
      const word = m ? m[0] : full;
      const after = full.slice(word.length);
      const trailingSpace = after.startsWith(" ") ? " " : "";

      await editor.edit((eb) => eb.insert(editor.selection.active, word + trailingSpace));

      // _lastSuggestion 可能在 edit 期间被异步清掉

      if (!_lastSuggestion) return;

      const remainder = after.slice(trailingSpace.length);
      if (remainder) {
        _lastSuggestion.text = remainder;
        _lastSuggestion.line = editor.selection.active.line;
        _lastSuggestion.character = editor.selection.active.character;
        _pendingRemainder = { text: remainder, uri: _lastSuggestion.uri };
      } else {
        endRequest("accepted");
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

      if (!_lastSuggestion) return;

      if (remainder) {
        _lastSuggestion.text = remainder;
        _lastSuggestion.line = editor.selection.active.line;
        _lastSuggestion.character = editor.selection.active.character;
        _pendingRemainder = { text: remainder, uri: _lastSuggestion.uri };
      } else {
        endRequest("accepted");
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
        `DS Autocomplete v1.6.3 · ${config().get("model")}\n` +
          `补全 ${s.shown} 次 · 接受 ${s.accepted} (${rate}%) · 缓存命中 ${s.cacheHits} (${cacheRate}%)\n` +
          `API 请求 ${s.requests} 次 · 重试 ${s.retries} 次 · 约 ${s.tokensUsed} tokens`
      );
    })
  );

  console.log(`[DS Autocomplete] v1.6.3 activated — ${langs.join(", ")}`);

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
