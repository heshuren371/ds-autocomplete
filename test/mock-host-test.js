// Mock-host regression tests for ds-autocomplete — run: node test/mock-host-test.js
// Mocks the `vscode` and `https` modules to exercise the real provider logic
// without an editor or network. Covers the v1.1.2 half-line completion bugs:
//   T1: half-typed line with an OPEN QUOTE must still trigger (skipInString default off)
//   T2: rapid typing burst coalesces to one request, ghost text returned
//   T3: keystroke landing right after a previous request must NOT be dropped (the reported bug)
//   T4: skipInString=true restores the conservative string filter
//   T5: enabledLanguages=["*"] registers a wildcard document selector

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
    onDidChangeTextDocument: () => ({ dispose() {} }),
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
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
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

  console.log("\nALL 5 TESTS PASSED");
  process.exit(0);
}

run().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
