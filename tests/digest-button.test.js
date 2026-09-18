const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

test("the below-video toolbar is created only on video pages with Bili Digest and note buttons", () => {
  assert.match(
    contentScript,
    /function bocInjectToolbar\(\)[\s\S]*if \(!window\.location\.pathname\.includes\("\/video\/"\)\) return;/,
  );
  // Injection is idempotent: if already present, just reposition.
  assert.match(
    contentScript,
    /if \(document\.getElementById\("boc-actions"\)\)[\s\S]*bocPositionToolbar\(\);[\s\S]*return;/,
  );
  assert.match(contentScript, /bar\.id = "boc-actions";/);
  assert.match(
    contentScript,
    /bocEl\("button", "boc-action-btn", "<span>Bili Digest<\/span>"\)/,
  );
  assert.match(
    contentScript,
    /bocEl\("button", "boc-action-btn boc-note", "<span>记笔记<\/span>"\)/,
  );
});

test("the toolbar stays visible under the player and hides in fullscreen", () => {
  assert.match(
    contentScript,
    /if \(document\.fullscreenElement\)[\s\S]*bar\.style\.display = "none";/,
  );
  assert.match(
    contentScript,
    /const w = Math\.max\(220, Math\.min\(r\.width, 480\)\);/,
  );
  assert.match(contentScript, /bar\.style\.top = r\.bottom \+ 12 \+ "px";/);
  assert.match(
    contentScript,
    /window\.addEventListener\("scroll", bocScheduleToolbarPosition/,
  );
  assert.match(
    contentScript,
    /window\.addEventListener\("resize", bocScheduleToolbarPosition/,
  );
});

test("the n shortcut saves a note only on video pages and off text inputs", () => {
  assert.match(
    contentScript,
    /function handleNoteKeyboardShortcut\(e\)[\s\S]*if \(!window\.location\.pathname\.includes\("\/video\/"\)\) return;/,
  );
  assert.match(contentScript, /e\.key !== "n" && e\.key !== "N"/);
  assert.match(contentScript, /active\.tagName === "INPUT"/);
  assert.match(contentScript, /active\.tagName === "TEXTAREA"/);
  assert.match(contentScript, /active\.isContentEditable/);
  assert.match(contentScript, /saveCurrentNote\(\);/);
});

test("BV changes are polled and rebuild the below-video toolbar", () => {
  assert.match(
    contentScript,
    /setInterval\(\(\) => \{[\s\S]*bocLastBvid[\s\S]*bocRemoveToolbar\(\);[\s\S]*bocInjectToolbar\(\);[\s\S]*\}, 1200\);/,
  );
  assert.match(contentScript, /bocWatchBilibiliNavigation\(\);/);
});

test("message handlers cover video info, time, seek, and note feedback", () => {
  assert.match(contentScript, /message\.action === "getVideoInfo"/);
  assert.match(contentScript, /message\.action === "getCurrentTime"/);
  assert.match(contentScript, /currentTime: video \? Math\.floor\(video\.currentTime\) : 0/);
  assert.match(contentScript, /message\.action === "seekTo"/);
  assert.match(contentScript, /video\.currentTime = seconds;/);
  assert.match(contentScript, /message\.action === "showNoteSavedFeedback"/);
  assert.match(contentScript, /message\.action === "biliFetchTracklist"/);
});

test("the overlay panel is 460px wide and loads the shared side panel iframe", () => {
  assert.match(contentScript, /const BOC_OVERLAY_W = 460;/);
  assert.match(contentScript, /iframe\.className = "boc-overlay-frame";/);
  assert.match(contentScript, /iframe\.src = chrome\.runtime\.getURL\("sidepanel\.html"\);/);
  assert.match(contentScript, /closeBtn\.setAttribute\("aria-label", "关闭 Bili Digest"\);/);
});