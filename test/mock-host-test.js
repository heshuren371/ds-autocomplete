// Mock-host regression tests for ds-autocomplete — run: node test/mock-host-test.js
// Mocks the `vscode` and `https` modules to exercise the real provider logic
// without an editor or network. Covers the v1.1.2 half-line completion bugs:
//   T1: half-typed line with an OPEN QUOTE must still trigger (skipInString default off)
//   T2: rapid typing burst coalesces to one request, ghost text returned
//   T3: keystroke landing right after a previous request must NOT be dropped (the reported bug)
//   T4: skipInString=true restores the conservative string filter
//   T5: enabledLanguages=["*"] registers a wildcard document selector
//   T6: acceptLine inserts first line + newline, remainder re-served (Cmd+Down)
//   T7: acceptWord inserts one word + trailing space, remainder stashed (Cmd+Right)

const assert = require("assert");
const Module = require("module");
const EventEmitter = require("events");
const path = require("path");

// ── settings (mirror package.json defaults, short debounce for tests) ──
const settings = {
  apiKey: "test-key",
  model: "deepseek-v4-flash",
  apiBase: "https://api.deepseek.com/beta/completions",
  maxTokens: 80,
  temperature: 0,
  debounceMs: 60,
  requestTimeoutMs: 5000,
  multiLine: true,
  multiLineMode: "always",
  replacePartialWord: true,
  triggerOnExplicit: false,
  skipInString: false,
  maxPrefixChars: 3000,
  maxSuffixChars: 1500,
  stopTokens: [],
  enabledLanguages: ["python"],
};

// ── fake vscode primitives ──
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
}
class FakeDocument {
  constructor(text, lang = "python") {
    this.text = text;
    this.languageId = lang;
    const id = FakeDocument._nextId++;
    this.uri = { toString: () => `file:///test_${id}.${lang}` };
    this.version = 0;
  }
  getText(range) {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  offsetAt(pos) {
    const lines = this.text.split("\n");
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
    return off + pos.character;
  }
  positionAt(offset) {
    const lines = this.text.split("\n");
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      if (offset <= off + lines[i].length) return new Position(i, offset - off);
      off += lines[i].length + 1;
    }
    return new Position(lines.length - 1, lines[lines.length - 1].length);
  }
  lineAt(line) {
    const lines = this.text.split("\n");
    return { text: lines[line] !== undefined ? lines[line] : "" };
  }
  getWordRangeAtPosition(pos) {
    const line = this.lineAt(pos.line).text;
    let s = pos.character, e = pos.character;
    const isW = /\w/;
    while (s > 0 && isW.test(line[s - 1])) s--;
    while (e < line.length && isW.test(line[e])) e++;
    if (s === e) return undefined;
    return new Range(new Position(pos.line, s), new Position(pos.line, e));
  }
}
FakeDocument._nextId = 1;

// ── captured state ──
let capturedProvider = null;
let registeredSelectors = [];
let lastRequestBody = null;
let requestCount = 0;
let sseResponseText = ' world")';
let cursorTriggerCount = 0;
let selectionListeners = [];
let docListeners = [];
let insertedTexts = [];
const commandHandlers = {};

const mockVscode = {
  Position,
  Range,
  InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
  InlineCompletionItem: class {
    constructor(text, range, command) { this.insertText = text; this.range = range; this.command = command; }
  },
  StatusBarAlignment: { Right: 2 },
  workspace: {
    getConfiguration: () => ({ get: (k) => settings[k], update: async () => {} }),
    onDidChangeTextDocument: (fn) => { docListeners.push(fn); return { dispose() {} }; },
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  languages: {
    registerInlineCompletionItemProvider: (sel, provider) => {
      capturedProvider = provider;
      registeredSelectors.push(sel);
      return { dispose() {} };
    },
  },
  window: {
    createStatusBarItem: () => ({
      show() {}, dispose() {},
      set text(v) {}, set command(v) {}, set tooltip(v) {},
    }),
    showQuickPick: async () => null,
    showInformationMessage: async () => null,
    showWarningMessage: async () => null,
    activeTextEditor: null,
    onDidChangeTextEditorSelection: (fn) => { selectionListeners.push(fn); return { dispose() {} }; },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  },
  commands: {
    registerCommand: (id, fn) => { commandHandlers[id] = fn; return { dispose() {} }; },
    executeCommand: async (cmd) => { if (cmd === "editor.action.inlineSuggest.trigger") cursorTriggerCount++; },
  },
  env: { openExternal: async () => true },
  Uri: { parse: (s) => ({ toString: () => s }) },
};

// ── fake https: SSE streaming responder ──
const mockHttps = {
  request: (url, opts, cb) => {
    requestCount++;
    const req = new EventEmitter();
    req.write = (body) => { lastRequestBody = JSON.parse(body); };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        const c1 = `data: ${JSON.stringify({ choices: [{ text: sseResponseText.slice(0, 3) }] })}\n\n`;
        const c2 = `data: ${JSON.stringify({ choices: [{ text: sseResponseText.slice(3) }] })}\n\ndata: [DONE]\n\n`;
        res.emit("data", Buffer.from(c1));
        res.emit("data", Buffer.from(c2));
      });
    };
    req.destroy = () => {};
    return req;
  },
};

// ── module require hook ──
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") return mockVscode;
  if (id === "https") return mockHttps;
  return origRequire.apply(this, arguments);
};

const ext = origRequire.call(module, path.resolve(__dirname, "..", "extension.js"));

// ── helpers ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cancelToken() {
  return { isCancellationRequested: false, onCancellationRequested(fn) { this._fn = fn; } };
}
function makeCtx() {
  return { subscriptions: [], globalState: { get: () => undefined, update: async () => {} } };
}
const auto = { triggerKind: 0 };

async function run() {
  ext.activate(makeCtx());
  assert(capturedProvider, "provider was registered");

  // ── T1: half-typed line with an OPEN QUOTE must still trigger ──
  requestCount = 0;
  let doc = new FakeDocument('import os\nprint("hel');
  let items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 10), auto, cancelToken());
  assert.strictEqual(requestCount, 1,
    `open-quote half-line should fire 1 API request, got ${requestCount}`);
  assert(items.length === 1 && String(items[0].insertText).includes("world"),
    "open-quote half-line returns ghost text");
  console.log("✓ T1 open-quote half-line triggers completion:", JSON.stringify(items[0].insertText));

  // ── T2: rapid typing burst coalesces, final context wins ──
  requestCount = 0;
  lastRequestBody = null;
  doc = new FakeDocument("def add(a,b):\n    return a ");
  let lastPromise = null;
  for (let i = 1; i <= 4; i++) {
    lastPromise = capturedProvider.provideInlineCompletionItems(
      doc, new Position(1, 10 + i), auto, cancelToken());
    await sleep(10); // faster than debounceMs=60
  }
  items = await lastPromise;
  assert.strictEqual(requestCount, 1,
    `typing burst should coalesce to 1 request, got ${requestCount}`);
  assert(items.length === 1, "burst ends with ghost text");
  assert(lastRequestBody.prompt.endsWith("return a "),
    "request used the final keystroke position");
  console.log("✓ T2 burst coalesced to one request; ghost text:", JSON.stringify(items[0].insertText));

  // ── T3 (the reported bug): keystroke right after a completed request must NOT be dropped ──
  requestCount = 0;
  doc = new FakeDocument("x = 1\ny = x +");
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 8), auto, cancelToken());
  assert(items.length === 1, "first completion shown");
  assert.strictEqual(requestCount, 1, "first request fired");

  // User types one more char IMMEDIATELY (inside the old throttle window) and stops.
  const doc2 = new FakeDocument("x = 1\ny = x + 1");
  const p2 = capturedProvider.provideInlineCompletionItems(
    doc2, new Position(1, 12), auto, cancelToken());
  const raced = await Promise.race([
    p2.then((v) => ({ v })),
    sleep(settings.debounceMs * 6).then(() => null),
  ]);
  assert(raced !== null,
    "PROMISE NEVER RESOLVED — ghost text lost after rapid keystroke (the reported bug)");
  assert.strictEqual(requestCount, 2,
    `keystroke right after previous request must still fire a request, got ${requestCount}`);
  assert(raced.v.length === 1, "ghost text shown for the follow-up keystroke");
  console.log("✓ T3 keystroke immediately after a request still triggers completion");

  // ── T4: skipInString=true restores the conservative filter ──
  settings.skipInString = true;
  requestCount = 0;
  doc = new FakeDocument('import os\nname = "he');
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 10), auto, cancelToken());
  assert.deepStrictEqual(items, [], "skipInString=true skips inside open string");
  assert.strictEqual(requestCount, 0, "no API call when skipped");
  settings.skipInString = false;
  console.log("✓ T4 skipInString=true restores conservative string filter");

  // ── T5: enabledLanguages=["*"] registers wildcard selectors ──
  registeredSelectors = [];
  settings.enabledLanguages = ["*"];
  ext.activate(makeCtx());
  assert(
    registeredSelectors.some((s) => s.scheme === "file") &&
    registeredSelectors.some((s) => s.scheme === "untitled"),
    `wildcard should register scheme selectors, got ${JSON.stringify(registeredSelectors)}`);
  settings.enabledLanguages = ["python"];
  console.log("✓ T5 enabledLanguages=['*'] registers file+untitled wildcard selectors");

  // ── T6: acceptLine (Cmd+Down) — first line + newline inserted, remainder re-served ──
  mockVscode.window.activeTextEditor = {
    selection: { active: new Position(0, 5) },
    edit: async (fn) => { fn({ insert: (pos, text) => insertedTexts.push(text) }); return true; },
  };
  sseResponseText = "+ 2 * 3\nprint(y)";
  requestCount = 0;
  doc = new FakeDocument("y = x");
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(0, 5), auto, cancelToken());
  assert(String(items[0].insertText).includes("\n"),
    `multi-line completion expected, got ${JSON.stringify(items[0].insertText)}`);
  insertedTexts = [];
  await commandHandlers["dsAutocomplete.acceptLine"]();
  assert.deepStrictEqual(insertedTexts, ["+ 2 * 3\n"],
    `acceptLine must insert first line + newline, got ${JSON.stringify(insertedTexts)}`);
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 0), auto, cancelToken());
  assert.strictEqual(String(items[0].insertText), "print(y)",
    "remainder must be re-served as ghost text after acceptLine");
  console.log('✓ T6 acceptLine inserted "+ 2 * 3\\n", remainder "print(y)" re-served');

  // ── T7: acceptWord (Cmd+Right) — one word + trailing space, remainder stashed ──
  sseResponseText = "result_value extra_stuff";
  requestCount = 0;
  doc = new FakeDocument("total = compute");
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(0, 15), auto, cancelToken());
  assert(items.length === 1, "completion shown for acceptWord");
  insertedTexts = [];
  await commandHandlers["dsAutocomplete.acceptWord"]();
  assert.deepStrictEqual(insertedTexts, ["result_value "],
    `acceptWord must insert one word + trailing space, got ${JSON.stringify(insertedTexts)}`);
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(0, 27), auto, cancelToken());
  assert.strictEqual(String(items[0].insertText), "extra_stuff",
    "remainder must be re-served as ghost text after acceptWord");
  console.log('✓ T7 acceptWord inserted "result_value ", remainder "extra_stuff" re-served');

  // ── T8: replacePartialWord=false → item has NO range (native shrink-on-type compat) ──
  // VSCode's built-in "shrink ghost text when user types matching chars" only works
  // when the InlineCompletionItem carries no range. A ranged item gets dismissed on
  // every keystroke — the "ghost text vanishes while typing along" bug.
  sseResponseText = "ha + 1";
  settings.replacePartialWord = false;
  requestCount = 0;
  doc = new FakeDocument("alpha = 1\nbeta = alp");
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 10), auto, cancelToken());
  assert(items.length === 1, "completion shown with replacePartialWord=false");
  assert(!items[0].range,
    "item.range must be UNSET so VSCode native shrink-on-type keeps the ghost text");
  console.log("✓ T8 replacePartialWord=false yields range-free item (native shrink compatible)");

  // ── T9: same-position re-query re-serves the current suggestion (typedLen===0) ──
  // VSCode sometimes re-queries the provider without any text change (suggest widget
  // toggled, explicit refresh). The stale-clear logic must NOT nuke _lastSuggestion
  // there — otherwise the next keystroke loses the instant-remainder path.
  sseResponseText = "hello world";
  requestCount = 0;
  doc = new FakeDocument("x = 1\ny = ");
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 4), auto, cancelToken());
  assert(items.length === 1, "T9 setup: ghost text shown");
  assert.strictEqual(requestCount, 1, "T9 setup: one API call");
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 4), auto, cancelToken());
  assert(items.length === 1 && String(items[0].insertText).includes("hello"),
    "same-position re-query must re-serve the suggestion, not clear it");
  assert.strictEqual(requestCount, 1, "same-position re-query must not hit the API again");
  console.log("✓ T9 same-position re-query re-serves suggestion (no API call, no clear)");

  // ── T10: document-change event arriving AFTER provider shrink must not clear state ──
  // Real bug (debug log 2026-07-24): keystroke → provider's instant-remainder shrinks
  // _lastSuggestion.text FIRST → the same edit's onDidChangeTextDocument arrives LATE
  // → old startsWith check compared the typed char against the ALREADY-SHRUNK text,
  //   misfired, and cleared state → ghost text vanished on every keystroke.
  sseResponseText = "sum = a + b";
  requestCount = 0;
  doc = new FakeDocument("total = 0\nresult = ");
  items = await capturedProvider.provideInlineCompletionItems(
    doc, new Position(1, 9), auto, cancelToken());
  assert(items.length === 1, "T10 setup: ghost shown");
  // User types "s": provider shrinks FIRST (instant-remainder)
  const docT10 = new FakeDocument("total = 0\nresult = s");
  docT10.uri = doc.uri; // same doc, modified in place
  items = await capturedProvider.provideInlineCompletionItems(
    docT10, new Position(1, 10), auto, cancelToken());
  assert(items.length === 1 && items[0].insertText === "um = a + b",
    "T10: instant-remainder shrank suggestion");
  // The SAME edit's document event arrives LATE (out-of-order, exactly as in the log)
  for (const fn of docListeners) {
    fn({ document: { uri: { toString: () => docT10.uri.toString() } },
         contentChanges: [{ text: "s" }] });
  }
  // State must SURVIVE: same-position re-query re-serves without a new API call
  items = await capturedProvider.provideInlineCompletionItems(
    docT10, new Position(1, 10), auto, cancelToken());
  assert(items.length === 1 && items[0].insertText === "um = a + b",
    "T10: late document event must NOT clear _lastSuggestion (race regression)");
  assert.strictEqual(requestCount, 1, "T10: no new API call after the race");
  console.log("✓ T10 late document-change event does not clear state (race fixed)");

  // ── T11: VSCode-native selectedCompletionInfo path (Continue's approach) ──
  // When ghost text is visible, VSCode provides selectedCompletionInfo with
  // full text + range. Our provider uses this AUTHORITATIVE source instead of
  // our module-level _lastSuggestion. See: continuedev/continue
  sseResponseText = "print(value)";
  requestCount = 0;
  const docT11 = new FakeDocument("def f():\n  ");
  let items11 = await capturedProvider.provideInlineCompletionItems(
    docT11, new Position(1, 2),
    auto,
    cancelToken());
  assert(items11.length === 1 && items11[0].insertText === "print(value)", "T11 setup");
  assert.strictEqual(requestCount, 1, "T11 setup: one API call");
  // User types "p" — VSCode calls with selectedCompletionInfo
  const docT11b = new FakeDocument("def f():\n  p");
  items11 = await capturedProvider.provideInlineCompletionItems(
    docT11b, new Position(1, 3),
    { triggerKind: 0,
      selectedCompletionInfo: { text: "print(value)", range: new Range(new Position(1, 2), new Position(1, 3)) } },
    cancelToken());
  assert(items11 === null || items11 === undefined,
    "T11: selectedCompletionInfo match returns null — VSCode shrinks ghost itself");
  assert.strictEqual(requestCount, 1, "T11: no new API call — VSCode path is instant");
  console.log("✓ T11 VSCode-native selectedCompletionInfo returns null for VSCode to shrink");

  // ── T12: ghost text acceptance detection ──
  // Simulate Tab-accept: cursor moves to ghost end, document has the text
  sseResponseText = "hello";
  requestCount = 0;
  doc = new FakeDocument("x\ny");
  let items12 = await capturedProvider.provideInlineCompletionItems(doc, new Position(1, 0), auto, cancelToken());
  assert(items12.length === 1 && items12[0].insertText === "hello", "T12 setup");
  assert.strictEqual(requestCount, 1, "T12 setup: one API call");
  // Simulate Tab accept: document now has "hello", cursor at ghost end
  const docAccepted = new FakeDocument("x\nyhello");
  for (const fn of selectionListeners) {
    fn({ textEditor: { document: docAccepted, selection: { active: new Position(1, 5) } } });
  }
  // After acceptance, provider re-called → state cleared → new API request
  items12 = await capturedProvider.provideInlineCompletionItems(docAccepted, new Position(1, 5), auto, cancelToken());
  assert.strictEqual(requestCount, 2, "T12: after ghost acceptance, new API call issued (not instant remainder)");
  console.log("✓ T12 ghost text acceptance detection — cursor at ghost end + text match = accepted");

  // ── T13: P0 作用域链 + P1 符号大纲写进 prompt 头部 ──
  // 光标在 class > def 内部时，prompt 必须包含作用域链和符号列表，
  // 模型才知道 self/参数名、不瞎编函数名
  sseResponseText = "pass";
  requestCount = 0;
  const docT13 = new FakeDocument(
    "import os\n\n" +
    "class Student:\n" +
    "    def __init__(self, name):\n" +
    "        self.name = name\n" +
    "\n" +
    "    def add_score(self, s):\n" +
    "        \n" +
    "\n" +
    "def helper(x):\n" +
    "    return x"
  );
  await capturedProvider.provideInlineCompletionItems(docT13, new Position(7, 8), auto, cancelToken());
  const prompt13 = (lastRequestBody && lastRequestBody.prompt) || "";
  assert(prompt13.includes("# 作用域: class Student: > def add_score(self, s):"),
    `T13: prompt 缺作用域链, got:\n${prompt13.slice(0, 300)}`);
  assert(prompt13.includes("# 符号:") && prompt13.includes("class Student") && prompt13.includes("def helper(x)"),
    `T13: prompt 缺符号大纲, got:\n${prompt13.slice(0, 300)}`);
  assert(prompt13.includes("import os"), "T13: imports 保留");
  console.log("✓ T13 作用域链+符号大纲注入 prompt 头部");

  // ── T14: P2a 复读循环截断 + P2b 末行括号不平衡丢弃 ──
  sseResponseText = "total = 0\ntotal += 1\ntotal += 1\ntotal += 1\ntotal += 1";
  requestCount = 0;
  const docT14 = new FakeDocument("def calc():\n    ");
  let items14 = await capturedProvider.provideInlineCompletionItems(docT14, new Position(1, 4), auto, cancelToken());
  const text14 = String(items14[0].insertText);
  const occur14 = (text14.match(/total \+= 1/g) || []).length;
  assert(occur14 <= 2, `T14: 复读循环必须截断到 ≤2 次, got ${occur14}: ${JSON.stringify(text14)}`);

  sseResponseText = "result = compute(\n    x + y";
  const docT14b = new FakeDocument("def f():\n    ");
  items14 = await capturedProvider.provideInlineCompletionItems(docT14b, new Position(1, 4), auto, cancelToken());
  const text14b = items14.length ? String(items14[0].insertText) : "";
  assert((text14b.match(/\(/g) || []).length <= (text14b.match(/\)/g) || []).length,
    `T14: 括号不平衡必须丢到配平或丢弃, got ${JSON.stringify(text14b)}`);

  // 反向用例：跨行闭合的括号必须保留（防过度截断）
  sseResponseText = "data = [\n    1,\n    2,\n]";
  const docT14c = new FakeDocument("def g():\n    ");
  items14 = await capturedProvider.provideInlineCompletionItems(docT14c, new Position(1, 4), auto, cancelToken());
  assert(items14.length === 1 && String(items14[0].insertText).includes("]"),
    `T14: 跨行闭合括号必须保留, got ${JSON.stringify(items14[0]?.insertText)}`);
  console.log("✓ T14 复读截断 + 括号配平(截断丢弃/跨行闭合保留)");

  // ── T15: P3 最近编辑注入 prompt ──
  // 用户在别处改过的代码是"下一步改什么"的最强信号，必须出现在头部
  // 同时验证：光标处编辑排除(已在prefix) + 同文件远处编辑保留 + 跨文件注入
  function recentSection(prompt) {
    const m = prompt.match(/# 最近编辑:\n((?:#   .*\n?)+)/);
    return m ? m[1] : "";
  }
  requestCount = 0;
  sseResponseText = "pass";
  const docT15 = new FakeDocument("x = 1\ny = 2\nz = ");
  const otherDoc = new FakeDocument("import db\nconn = db.connect(host)\n");
  for (const fn of docListeners) {
    fn({ document: otherDoc, contentChanges: [{ text: "db.connect(host)", range: { start: new Position(1, 7), end: new Position(1, 18) } }] });
  }
  await capturedProvider.provideInlineCompletionItems(docT15, new Position(2, 5), auto, cancelToken());
  const sec15 = recentSection((lastRequestBody && lastRequestBody.prompt) || "");
  assert(sec15.includes("db.connect(host)"), `T15: 跨文件最近编辑必须注入, got section: ${sec15 || "(empty)"}`);

  const docT15b = new FakeDocument("aaa\nbbb\nccc\n");
  for (const fn of docListeners) {
    fn({ document: docT15b, contentChanges: [{ text: "x", range: { start: new Position(0, 0), end: new Position(0, 0) } }] });
    fn({ document: docT15b, contentChanges: [{ text: "x", range: { start: new Position(2, 3), end: new Position(2, 3) } }] });
  }
  await capturedProvider.provideInlineCompletionItems(docT15b, new Position(2, 4), auto, cancelToken());
  const sec15b = recentSection((lastRequestBody && lastRequestBody.prompt) || "");
  assert(sec15b.includes("aaa"), `T15: 同文件远处编辑必须保留, got: ${sec15b}`);
  assert(!sec15b.includes("ccc"), `T15: 光标处编辑必须排除(已在prefix), got: ${sec15b}`);
  console.log("✓ T15 最近编辑注入(跨文件+远处保留+光标处排除)");

  // ── T16: 思考强度两档 — med 默认关思考, max 开思考+提 max_tokens ──
  // 实测官方 API(2026-07): 不传 thinking = 默认开思考, reasoning 计入 max_tokens
  // med 必须显式 disabled, 否则 comment-to-code 为看不见的推理烧钱+白等
  sseResponseText = "x = 1";
  requestCount = 0;
  settings.commentToCode = true; // mock 默认缺此项, 不开永远走 FIM
  settings.chatThinking = undefined; // 默认 med
  const docT16 = new FakeDocument("x = 1\n# 计算翻倍\n");
  await capturedProvider.provideInlineCompletionItems(docT16, new Position(2, 0), auto, cancelToken());
  assert(lastRequestBody && lastRequestBody.thinking && lastRequestBody.thinking.type === "disabled",
    `T16: med 档必须显式关思考, got thinking=${JSON.stringify(lastRequestBody?.thinking)}`);
  assert.strictEqual(lastRequestBody.max_tokens, 8000, `T16: med 档 max_tokens 提到 8000, got ${lastRequestBody.max_tokens}`);

  settings.chatThinking = "max";
  const docT16b = new FakeDocument("x = 1\n# 计算平方\n");
  await capturedProvider.provideInlineCompletionItems(docT16b, new Position(2, 0), auto, cancelToken());
  assert(lastRequestBody.thinking.type === "enabled",
    `T16: max 档必须开思考, got ${JSON.stringify(lastRequestBody.thinking)}`);
  assert.strictEqual(lastRequestBody.max_tokens, 16000,
    `T16: max 档 max_tokens 必须 16000 补偿 reasoning, got ${lastRequestBody.max_tokens}`);

  // chatMaxTokens 覆盖档: 用户要 40000 就给 40000
  settings.chatMaxTokens = 40000;
  const docT16c = new FakeDocument("x = 1\n# 计算立方\n");
  await capturedProvider.provideInlineCompletionItems(docT16c, new Position(2, 0), auto, cancelToken());
  assert.strictEqual(lastRequestBody.max_tokens, 40000,
    `T16: chatMaxTokens=40000 覆盖必须生效, got ${lastRequestBody.max_tokens}`);
  delete settings.chatMaxTokens;
  delete settings.chatThinking;
  console.log("✓ T16 思考强度两档(med=disabled+8000, max=enabled+16000, 覆盖=40000)");

  // ── T17: 前缀去重 — 重复已写代码必须裁, 改正用户代码必须留 ──
  // 用户原话: "前面写2行代码了,内联又写了一遍; 写错了可以改,但写对了别重复"
  settings.commentToCode = false; // 走 FIM 路径
  // 场景1: 2行正确代码被原样重复 → 只剩新行
  sseResponseText = "total = 0\ntotal += 1\nprint(total)";
  const docT17 = new FakeDocument("total = 0\ntotal += 1\n");
  let items17 = await capturedProvider.provideInlineCompletionItems(docT17, new Position(2, 0), auto, cancelToken());
  assert.strictEqual(String(items17[0].insertText), "print(total)",
    `T17: 整行重复必须裁掉, got ${JSON.stringify(items17[0]?.insertText)}`);

  // 场景2: 模型输出不同代码(改正) → 不能裁
  sseResponseText = "total = 1\nprint(total)";
  const docT17b = new FakeDocument("total = 0\n");
  items17 = await capturedProvider.provideInlineCompletionItems(docT17b, new Position(1, 0), auto, cancelToken());
  assert(String(items17[0].insertText).includes("total = 1"),
    `T17: 模型改正用户代码必须保留, got ${JSON.stringify(items17[0]?.insertText)}`);

  // 场景3: 行内重叠(光标在 "pri" 后, 模型重复完整词) → 裁重叠
  settings.replacePartialWord = false;
  sseResponseText = "print(total)";
  const docT17c = new FakeDocument("pri");
  items17 = await capturedProvider.provideInlineCompletionItems(docT17c, new Position(0, 3), auto, cancelToken());
  assert.strictEqual(String(items17[0].insertText), "nt(total)",
    `T17: 行内前缀重叠必须裁掉, got ${JSON.stringify(items17[0]?.insertText)}`);
  settings.replacePartialWord = true; // 恢复 mock 默认
  console.log("✓ T17 前缀去重(整行重复裁/改正保留/行内重叠裁)");

  // ── T18: Cmd+Right 竞态 — edit 期间光标事件不得清掉 remainder ──
  // 真实 VSCode 在 editor.edit() 期间【同步】派发 onDidChangeTextEditorSelection。
  // 光标落在幽灵文中间 → 旧代码走"拒绝"分支清空 _lastSuggestion
  // → v1.6.2 的 null guard 提前 return → remainder 丢失 → 下次补全是全新 API 结果
  // (用户报告: "cmd+right 有时候补全的不是幽灵文")。修复后旗子放行, remainder 必在。
  sseResponseText = "total = compute(x)";
  requestCount = 0;
  const docT18 = new FakeDocument("y = ");
  let items18 = await capturedProvider.provideInlineCompletionItems(docT18, new Position(0, 4), auto, cancelToken());
  assert(String(items18[0].insertText).includes("total"), "T18 setup: 幽灵文已展示");

  // 模拟真实 VSCode: edit 期间同步派发光标事件(光标停幽灵文中间=拒绝分支触发条件)
  mockVscode.window.activeTextEditor = {
    selection: { active: new Position(0, 4) },
    edit: async (fn) => {
      fn({ insert: (pos, text) => {
        insertedTexts.push(text);
        const newPos = new Position(0, 4 + text.length);
        mockVscode.window.activeTextEditor.selection = { active: newPos, isEmpty: true };
        for (const fnSel of selectionListeners) {
          fnSel({ textEditor: { document: docT18, selection: { active: newPos } } });
        }
      }});
      return true;
    },
  };
  insertedTexts = [];
  await commandHandlers["dsAutocomplete.acceptWord"]();
  assert.deepStrictEqual(insertedTexts, ["total "], `T18: 插入第一个词, got ${JSON.stringify(insertedTexts)}`);

  // remainder 必须作为幽灵文续上, 且不得发新 API 请求
  const reqBefore18 = requestCount;
  items18 = await capturedProvider.provideInlineCompletionItems(docT18, new Position(0, 10), auto, cancelToken());
  assert.strictEqual(String(items18[0].insertText), "= compute(x)",
    `T18: Cmd+Right 后必须续上原幽灵文 remainder, got ${JSON.stringify(items18[0]?.insertText)}`);
  assert.strictEqual(requestCount, reqBefore18, "T18: remainder 必须即时给出, 不得发新 API 请求");
  console.log("✓ T18 Cmd+Right 竞态(edit期间光标事件不得清掉remainder)");

  // ── T19: 连锁补全 — Tab 接受后自动触发下一段(Cursor/Zed 同款) ──
  settings.chainedTab = true;
  cursorTriggerCount = 0;
  await commandHandlers["dsAutocomplete.onAccept"]();
  await new Promise((r) => setTimeout(r, 120)); // 触发在 50ms 的 setTimeout 里
  assert(cursorTriggerCount >= 1,
    `T19: 接受后必须自动触发下一段补全, got cursorTriggerCount=${cursorTriggerCount}`);
  console.log("✓ T19 连锁补全(Tab接受后自动触发下一段)");

  // ── T20: 改正模式 — 模型改正最近编辑的行 → range 覆盖旧行(NES/Zeta) ──
  // 用户原话: "如果我前面写错了可以给我改正"。旧行为: 改正版插到错行下面, 错行还在。
  // 安全门: 被改行必须在 P3 最近编辑缓冲, 防止"长得像的新行"被误判成改正。
  settings.commentToCode = false;
  sseResponseText = "total = 1\nprint(total)";
  const docT20 = new FakeDocument("total = 0\n");
  // 用户刚写了 "total = 0" → 进最近编辑缓冲
  for (const fn of docListeners) {
    fn({ document: docT20, contentChanges: [{ text: "total = 0", range: { start: new Position(0, 0), end: new Position(0, 9) } }] });
  }
  const items20 = await capturedProvider.provideInlineCompletionItems(docT20, new Position(1, 0), auto, cancelToken());
  const item20 = items20[0];
  assert(item20 && item20.range, "T20: 改正模式必须带 range 覆盖旧行");
  assert.strictEqual(item20.range.start.line, 0, `T20: range 必须从旧行起, got line=${item20.range.start.line}`);
  assert.strictEqual(String(item20.insertText), "total = 1\nprint(total)",
    `T20: 改正内容原样保留, got ${JSON.stringify(item20.insertText)}`);

  // 对照: 同样的模型输出, 但该行不在最近编辑缓冲 → 普通插入(无 range)
  const docT20b = new FakeDocument("total = 0\n"); // 无编辑事件
  const items20b = await capturedProvider.provideInlineCompletionItems(docT20b, new Position(1, 0), auto, cancelToken());
  assert(items20b[0] && !items20b[0].range, "T20: 非最近编辑行不得触发改正模式(防误删)");
  console.log("✓ T20 改正模式(最近编辑行触发range替换/非最近编辑普通插入)");

  // ── T21: 注释前缀对齐 — 模型改正/重复前输出解释注释, 对齐不得被打飞 ──
  // 用户实测: "内联会给我一行注释解释为什么写错了"——注释 vs 代码相似度≈0,
  // 旧对齐直接失效, 改正退化成追加。修复: 前导注释跳过对齐但保留在文本里。
  settings.commentToCode = false;
  // 场景1: 注释+改正 → 注释保留, range 覆盖错行
  sseResponseText = "# 应该是 1 不是 0\ntotal = 1\nprint(total)";
  const docT21 = new FakeDocument("total = 0\n");
  for (const fn of docListeners) {
    fn({ document: docT21, contentChanges: [{ text: "total = 0", range: { start: new Position(0, 0), end: new Position(0, 9) } }] });
  }
  const items21 = await capturedProvider.provideInlineCompletionItems(docT21, new Position(1, 0), auto, cancelToken());
  assert(items21[0] && items21[0].range && items21[0].range.start.line === 0,
    `T21: 注释前缀的改正也必须触发range替换, got range=${JSON.stringify(items21[0]?.range)}`);
  assert(String(items21[0].insertText).startsWith("# 应该是 1"),
    `T21: 解释注释必须保留, got ${JSON.stringify(items21[0].insertText)}`);

  // 场景2: 注释+整行重复 → 注释保留, 重复行裁掉
  sseResponseText = "# 下面打印结果\ntotal = 0\nprint(total)";
  const docT21b = new FakeDocument("total = 0\n");
  const items21b = await capturedProvider.provideInlineCompletionItems(docT21b, new Position(1, 0), auto, cancelToken());
  assert.strictEqual(String(items21b[0].insertText), "# 下面打印结果\nprint(total)",
    `T21: 注释前缀的重复必须裁且注释保留, got ${JSON.stringify(items21b[0].insertText)}`);
  console.log("✓ T21 注释前缀对齐(改正触发range/重复裁剪,注释都保留)");

  console.log("\nALL 21 TESTS PASSED");
  process.exit(0);
}

run().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
