const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSearchHelper() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__.findLiteralTranscriptMatches;
}

test("transcript search finds every literal match without case sensitivity", () => {
  const findMatches = loadSearchHelper();
  const result = findMatches(
    "Agents can plan. AGENTS can act. Agents can learn.",
    "agents",
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    [
      { start: 0, end: 6 },
      { start: 17, end: 23 },
      { start: 33, end: 39 },
    ],
  );
});

test("transcript search treats punctuation as literal text", () => {
  const findMatches = loadSearchHelper();
  assert.deepEqual(
    JSON.parse(JSON.stringify(findMatches("A.B ACB A.B", "A.B"))),
    [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ],
  );
});

test("transcript search supports Chinese text and ignores blank queries", () => {
  const findMatches = loadSearchHelper();
  assert.deepEqual(
    JSON.parse(JSON.stringify(findMatches("人工智能帮助人，人工智能也需要人。", "人工智能"))),
    [
      { start: 0, end: 4 },
      { start: 8, end: 12 },
    ],
  );
  assert.equal(findMatches("Transcript", "   ").length, 0);
});
