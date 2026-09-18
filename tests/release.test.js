const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("manifest uses Bilibili-scoped permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(manifest.name, "Bili Digest");
  assert.equal(packageJson.name, "bili-digest");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.options_ui.page, "options.html");
  assert.ok(!manifest.permissions.includes("activeTab"));
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);

  assert.ok(manifest.host_permissions.includes("https://www.bilibili.com/*"));
  assert.ok(manifest.host_permissions.includes("https://api.bilibili.com/*"));
  assert.ok(manifest.host_permissions.some((h) => h.includes("hdslb.com")));
  assert.ok(manifest.host_permissions.includes("https://api.deepseek.com/*"));

  const contentScript = manifest.content_scripts[0];
  assert.deepEqual(contentScript.matches, ["https://www.bilibili.com/*"]);
  assert.ok(contentScript.js.includes("content.js"));
});

test("release copy documents the Bilibili extension scope", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));
  const optionsPage = read("options.html");

  const publishedDocs = [
    readme,
    chineseReadme,
    read("PRIVACY.md"),
    read("SECURITY.md"),
  ].join("\n");

  assert.match(readme, /^# Bili Digest$/m);
  assert.match(chineseReadme, /^# Bili Digest$/m);
  assert.doesNotMatch(publishedDocs, /\b(?:YouTube|Youtube)\b/i);
  assert.doesNotMatch(publishedDocs, /Supadata|supadata/i);
  assert.doesNotMatch(publishedDocs, /\bYT Digest\b/);
  assert.doesNotMatch(manifest.description, /\bYouTube\b/i);
  assert.doesNotMatch(packageJson.description, /\bYouTube\b/i);
  assert.doesNotMatch(packageJson.description, /—/);

  assert.match(readme, /看 B站视频时抓完整字幕、记带时间戳的笔记/);
  assert.match(readme, /高级设置（可选）/);
  assert.match(readme, /platform\.deepseek\.com\/api_keys/);
  assert.match(manifest.description, /B站视频/);
  assert.match(packageJson.description, /Bilibili videos/);

  assert.match(optionsPage, /platform\.deepseek\.com\/api_keys/);
  assert.match(optionsPage, /id="aiBaseUrl"/);
  assert.match(optionsPage, /id="aiModel"/);
  assert.match(optionsPage, /placeholder="deepseek-v4-flash"/);
  assert.doesNotMatch(optionsPage, /id="provider"/);
  assert.doesNotMatch(optionsPage, /id="copyCustomizationPromptBtn"/);
  assert.doesNotMatch(optionsPage, /customization-card/);
  assert.doesNotMatch(optionsPage, /id="customizationPrompt"/);

  assert.match(read("scripts/package-extension.sh"), /bili-digest-v\$version\.zip/);
});

test("product UI contains no unintended emoji or pictographs", () => {
  const stripBgmPlaceholders = (source) => source.replace(/[♪♫♩♬🎵🎶]/g, "");
  const productHtml = [read("sidepanel.html"), read("options.html")].join("\n");
  const productJs = ["sidepanel.js", "content.js", "options.js"]
    .map((file) => stripBgmPlaceholders(read(file)))
    .join("\n");

  const emoji = String.raw`\p{Extended_Pictographic}|[✓✕⧉▶]`;
  assert.doesNotMatch(productHtml, new RegExp(emoji, "u"));
  assert.doesNotMatch(productJs, new RegExp(emoji, "u"));
  assert.doesNotMatch(productHtml, /&#(?:9655|9888);/);
});

test("selection actions use two equal edge-to-edge hover areas", () => {
  const css = read("sidepanel.css");

  assert.match(
    css,
    /\.explain-tooltip\s*\{[^}]*padding:\s*0;[^}]*overflow:\s*hidden;/,
  );
  assert.match(
    css,
    /\.explain-btn,\s*\.selection-note-btn\s*\{[^}]*flex:\s*1 1 50%;[^}]*border-radius:\s*0;/,
  );
  assert.match(
    css,
    /\.explain-tooltip\s*\{[^}]*animation:\s*selectionToolbarIn/,
  );
  assert.match(
    css,
    /@keyframes selectionToolbarIn\s*\{[\s\S]*transform:\s*translate\(-50%, 4px\);[\s\S]*transform:\s*translate\(-50%, 0\);/,
  );
});

test("note delete is an accessible SVG action at the end of the action row", () => {
  const js = read("sidepanel.js");
  const css = read("sidepanel.css");

  assert.match(
    js,
    /<div class="note-actions">[\s\S]*class="[^"]*note-play[^"]*"[\s\S]*class="note-delete"[\s\S]*aria-label="删除笔记"[\s\S]*<svg viewBox="0 0 24 24" aria-hidden="true">/,
  );
  assert.doesNotMatch(js, /class="note-delete"[^>]*>Delete<\/button>/);
  assert.match(
    css,
    /\.note-delete\s*\{[^}]*place-items:\s*center;[^}]*margin-left:\s*auto;/,
  );
  assert.match(css, /\.note-delete:focus-visible\s*\{[^}]*outline:/);
});

test("notes filters preserve selected contrast and expose pressed state", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /id="notesFilterThis"[\s\S]*?aria-pressed="true"[\s\S]*?>[\s\S]*?本视频/,
  );
  assert.match(
    html,
    /id="notesFilterAll"[\s\S]*?aria-pressed="false"[\s\S]*?>[\s\S]*?全部笔记/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn\.active:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-hover\);[^}]*color:\s*white;/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn:hover:not\(:disabled\)\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-secondary\);/,
  );
  assert.match(css, /\.notes-filter \.enhance-btn:focus-visible\s*\{[^}]*outline:/);
  assert.match(js, /setNotesFilter\(false\)/);
  assert.match(js, /setNotesFilter\(true\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(!showAll\)\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(showAll\)\)/);
});

test("runtime has no source-file credential dependency or retired model", () => {
  const runtime = [
    "background.js",
    "content.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /\bCONFIG\./);
  assert.doesNotMatch(runtime, /importScripts\(["']config\.js/);
  assert.doesNotMatch(runtime, /\bdeepseek-chat\b/);
  assert.match(runtime, /deepseek-v4-flash/);
});

test("background reconciles side-panel state after navigation commits", () => {
  const background = read("background.js");

  assert.match(
    background,
    /function getNavigationUrl\(changeInfo, tab\)[\s\S]*changeInfo\.status !== "loading"[\s\S]*changeInfo\.status !== "complete"[\s\S]*tab\.pendingUrl \|\| tab\.url/,
  );
  assert.match(
    background,
    /chrome\.tabs\.onUpdated\.addListener\(\(tabId, changeInfo, tab\)[\s\S]*getNavigationUrl\(changeInfo, tab\)[\s\S]*updatePanelForTab\(tabId, url, tab\.windowId\)/,
  );
  assert.match(
    background,
    /function closePanelForTab\(tabId, windowId\)[\s\S]*chrome\.sidePanel\.close\(\{ tabId \}\)[\s\S]*chrome\.sidePanel\.close\(\{ windowId \}\)/,
  );
  assert.match(
    background,
    /await closePanelForTab\(tabId, windowId\);[\s\S]*setOptions\(\{ tabId, enabled: false \}\)/,
  );
});

test("retired Remix and reader files are absent", () => {
  for (const file of [
    "reader.html",
    "reader.js",
    "remix-prompts.js",
    "config.example.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test("published prompt files contain runtime sections", () => {
  const expectedSections = {
    "prompts/analysis.md": ["System prompt", "User prompt"],
    "prompts/explain.md": ["System prompt", "User prompt"],
    "prompts/note-cleanup.md": ["System prompt", "User prompt"],
    "prompts/translation.md": [
      "Shared base rules",
      "Chinese rules",
      "Transcript batch translation",
    ],
  };

  for (const [file, sections] of Object.entries(expectedSections)) {
    const markdown = read(file);
    for (const section of sections) {
      assert.match(markdown, new RegExp(`^## ${section}$`, "m"));
    }
  }
});