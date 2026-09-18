const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("DeepSeek defaults apply when no base URL or model is provided", () => {
  const normalized = settings.normalize({
    aiApiKey: "  example-key  ",
  });

  assert.equal(normalized.provider, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.aiApiKey, "example-key");
});

test("custom base URL and model are preserved", () => {
  const normalized = settings.normalize({
    aiBaseUrl: "  https://api.example.com/v1  ",
    aiModel: "  example-model  ",
  });

  assert.equal(normalized.aiBaseUrl, "https://api.example.com/v1");
  assert.equal(normalized.aiModel, "example-model");
});

test("chatCompletionsUrl uses the given base URL or the DeepSeek default", () => {
  assert.equal(
    settings.chatCompletionsUrl(),
    "https://api.deepseek.com/chat/completions",
  );
  assert.equal(
    settings.chatCompletionsUrl("https://api.example.com/v1"),
    "https://api.example.com/v1/chat/completions",
  );
});

test("legacy custom provider clears only the AI key and is idempotent", () => {
  const legacy = { provider: "custom", aiApiKey: "custom-secret" };
  const first = settings.migrateLegacyCustom(legacy);

  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "deepseek");
  assert.equal(first.settings.aiApiKey, "");

  const second = settings.migrateLegacyCustom(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);
});

test("canonical Bilibili URL is built with an optional timestamp", () => {
  assert.equal(
    settings.canonicalBilibiliUrl("BV1xx411c7mD"),
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
  assert.equal(
    settings.canonicalBilibiliUrl("BV1xx411c7mD", 90),
    "https://www.bilibili.com/video/BV1xx411c7mD?t=90",
  );
  assert.throws(
    () => settings.canonicalBilibiliUrl('"><script>'),
    /Invalid Bilibili BV id/,
  );
});
