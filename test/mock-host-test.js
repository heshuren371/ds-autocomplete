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
    this.uri = { toString: () => "file:///test." + lang };
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
  lineAt(line) { return { text: this.text.split("\n")[line] }; }
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
    constructor(text) { this.insertText = text; }
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

  console.log("\nALL 12 TESTS PASSED");
  process.exit(0);
}

run().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
