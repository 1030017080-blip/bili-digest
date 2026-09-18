const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function createLocalStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("Settings copy covers English and Simplified Chinese", () => {
  assert.equal(options.translate("en", "pageTitle"), "Bili Digest Settings");
  assert.equal(options.translate("zh-CN", "pageTitle"), "Bili Digest 设置");
  assert.equal(options.translate("en", "saveSettings"), "Save settings");
  assert.equal(options.translate("zh-CN", "saveSettings"), "保存设置");
  assert.equal(
    options.translate("zh-CN", "clearedDigests", { count: 2 }),
    "已清除 2 条缓存摘要。",
  );

  assert.deepEqual(
    Object.keys(options.COPY.en).sort(),
    Object.keys(options.COPY["zh-CN"]).sort(),
  );

  const html = read("options.html");
  const referencedKeys = [
    ...html.matchAll(/data-i18n(?:-html|-aria-label)?="([^"]+)"/g),
  ].map((match) => match[1]);
  for (const key of referencedKeys) {
    assert.ok(options.COPY.en[key], `Missing English copy for ${key}`);
    assert.ok(options.COPY["zh-CN"][key], `Missing Chinese copy for ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(options.COPY), /—/);
  assert.doesNotMatch(html, /—/);
});

test("language preference persists through extension-compatible storage", async () => {
  const storedValues = {};
  const chromeApi = {
    storage: {
      local: {
        async get(key) {
          return Object.hasOwn(storedValues, key)
            ? { [key]: storedValues[key] }
            : {};
        },
        async set(items) {
          Object.assign(storedValues, items);
        },
        async remove() {},
        async clear() {},
      },
    },
  };
  const storage = options.createStorageAdapter(chromeApi);

  await options.persistPreferredLanguage(storage, "zh-CN");

  assert.equal(storedValues[options.LANGUAGE_STORAGE_KEY], "zh-CN");
  assert.equal(await options.readPreferredLanguage(storage), "zh-CN");
});

test("non-extension preview safely persists language in localStorage", async () => {
  const localStorage = createLocalStorage();
  const firstSession = options.createStorageAdapter(null, localStorage);

  await options.persistPreferredLanguage(firstSession, "zh-CN");

  const reopenedSession = options.createStorageAdapter(null, localStorage);
  assert.equal(await options.readPreferredLanguage(reopenedSession), "zh-CN");
  assert.equal(options.normalizeLanguage("unsupported"), "zh-CN");
});

test("language controls expose a labelled group and one pressed button", () => {
  const html = read("options.html");
  assert.match(
    html,
    /class="language-switch"[\s\S]*role="group"[\s\S]*aria-label="Interface language"/,
  );
  assert.match(
    html,
    /data-language="zh-CN"[\s\S]*aria-pressed="true"[\s\S]*中文/,
  );
  assert.match(
    html,
    /data-language="en"[\s\S]*aria-pressed="false"[\s\S]*English/,
  );

  const buttons = ["en", "zh-CN"].map((language) => ({
    dataset: { language },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  }));
  options.updateLanguageButtonState(buttons, "zh-CN");

  assert.equal(buttons[0].attributes["aria-pressed"], "false");
  assert.equal(buttons[1].attributes["aria-pressed"], "true");
});

test("advanced provider fields expose an OpenAI-compatible endpoint and model", () => {
  const html = read("options.html");
  assert.match(html, /id="aiBaseUrl"/);
  assert.match(html, /id="aiModel"/);
  assert.match(html, /placeholder="https:\/\/api\.deepseek\.com"/);
  assert.match(html, /placeholder="deepseek-v4-flash"/);
  assert.match(html, /data-i18n="aiBaseUrlLabel"/);
  assert.match(html, /data-i18n="aiModelLabel"/);
});

test("advanced provider labels translate for English and Simplified Chinese", () => {
  assert.equal(options.translate("en", "advancedTitle"), "Advanced (optional)");
  assert.equal(options.translate("zh-CN", "advancedTitle"), "高级设置（可选）");
  assert.equal(options.translate("en", "aiBaseUrlLabel"), "API base URL");
  assert.equal(options.translate("zh-CN", "aiBaseUrlLabel"), "API 地址");
  assert.equal(options.translate("zh-CN", "aiModelLabel"), "模型");
});

test("the removed local-remix card and its editor are absent", () => {
  const html = read("options.html");
  const script = read("options.js");
  assert.doesNotMatch(html, /id="customizationPrompt"/);
  assert.doesNotMatch(html, /class="prompt-reminder"/);
  assert.doesNotMatch(html, /customization-card/);
  assert.doesNotMatch(script, /createPromptDrafts|switchPromptDraft|copyPromptValue/);
});
