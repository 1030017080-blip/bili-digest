/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Bilibili hides its <video> inside a shadow DOM. Simple document.querySelector
// misses it, so search the whole tree recursively for the primary visible video.
function locateVideo() {
  const walk = (root) => {
    const q = root.querySelectorAll("video");
    let best = null;
    for (const v of q) {
      const r = v.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!v.duration && !v.currentTime) continue;
      if (!best || (r.width * r.height) > (best.width * best.height)) best = v;
    }
    if (best) return best;
    const roots = Array.from(root.querySelectorAll("*"))
      .map((el) => el.shadowRoot)
      .filter(Boolean);
    for (const sr of roots) {
      const found = walk(sr);
      if (found) return found;
    }
    return null;
  };
  return walk(document);
}
function biliVideoIdFromUrl() {
  const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
  return m ? m[1] : "";
}
function biliPlatformUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteKeyboardListenerAdded = false;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // 注册全局 "n" 快捷键，保存当前时间点笔记
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // 视频下方工具栏：打开 Bili Digest 面板 / 记笔记
  bocInjectToolbar();
}


// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[Bili Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    const info = extractVideoInfo();
    debugLog("[Bili Digest Content] Returning video info:", info);
    sendResponse(info);
    return false;
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    const video = locateVideo();
    sendResponse({
      // P0-1: 用 found 区分"找不到视频"与"播放到第 0 秒"，供面板跟随滚动判断是否跳过本轮。
      found: Boolean(video),
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[Bili Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "biliFetchTracklist") {
    // 用页面自身的 B站会话重新拉取字幕轨道列表（覆盖需要登录的 AI 字幕）。
    biliFetchTracklist(message)
      .then((res) => sendResponse(res || { success: false, error: "empty" }))
      .catch((err) => sendResponse({ success: false, error: (err && err.message) || String(err) }));
    return true; // async
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[Bili Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});



/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/video/")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[Bili Digest] Saving note");

  const video = locateVideo();
  if (!video) {
    console.error("[Bili Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = biliVideoIdFromUrl();

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">保存中...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">已保存</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">失败</span>';
      }
      console.error("[Bili Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">失败</span>';
    }
    console.error("[Bili Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">笔记已保存</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">复制链接</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "已复制";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // Video title
  const titleElement = document.querySelector("h1.video-title");
  if (!titleElement?.textContent?.trim()) {
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.getAttribute) titleElement.setAttribute("data-og", og.getAttribute("content") || "");
  }

  // Chapter UP name
  const channelElement = document.querySelector(".up-name");

  // Video duration from the located video element
  const videoElement = locateVideo();

  // Description
  const descriptionElement = document.querySelector(
    ".basic-desc-info, .desc-info-text, .video-desc",
  );

  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogDesc = document.querySelector('meta[name="description"]');
  const title = titleElement?.textContent?.trim() ||
    ogTitle?.getAttribute?.("content")?.trim() || document.title;
  return {
    title,
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() ||
      ogDesc?.getAttribute?.("content")?.trim() || "",
  };
}

/**
 * Uses the page's own Bilibili session to fetch the subtitle track list.
 * Background requests may carry no login cookie, but the content script runs
 * on www.bilibili.com and shares the page session — so AI/ASR subtitles that
 * require login can still be resolved here.
 */
async function biliFetchTracklist({ bvid, aid, cid }) {
  const mk = (url) =>
    fetch(url, { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null);

  const urls = [];
  if (aid) {
    urls.push(
      `https://api.bilibili.com/x/player/wbi/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}&bvid=${encodeURIComponent(bvid)}`,
    );
  }
  urls.push(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}${aid ? `&aid=${encodeURIComponent(aid)}` : ""}`,
  );

  for (const url of urls) {
    const p = await mk(url);
    if (!p) continue;
    if (p.code !== 0) continue;
    const d = p.data || {};
    return {
      success: true,
      tracks: Array.isArray(d?.subtitle?.subtitles) ? d.subtitle.subtitles : [],
      needLogin: Boolean(d.need_login_subtitle),
      loginMid: Number(d.login_mid || 0) || 0,
    };
  }
  return { success: false, error: "无法从页面会话获取字幕列表" };
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================


// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = locateVideo();
  if (!video) {
    console.error("[Bili Digest Content] No video element found for seek");
    return;
  }

  debugLog("[Bili Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  if (video.paused) {
    video.play().catch(() => {});
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  // Bilibili 播放器在 SPA 导航时重挂载，这里重建下方工具栏并清理残留提示气泡。
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  bocRemoveToolbar();
  bocInjectToolbar();
  if (!window.location.pathname.includes("/video/")) {
    bocCloseOverlay(true);
  }
});

// B站 SPA 换集检测：B站 不触发 YouTube 的 yt-navigate-finish，因此用轻量轮询
// 识别地址栏 BV 号变化，变化时重建下方工具栏并在离开视频页时关闭已开面板。
{
  const bocNavMatch0 = window.location.pathname.match(/\/video\/(BV[\w]+)/);
  let bocLastBvid = bocNavMatch0 ? bocNavMatch0[1] : "";
  let bocNavWatchTimer = null;

  function bocWatchBilibiliNavigation() {
    if (bocNavWatchTimer) return;
    bocNavWatchTimer = setInterval(() => {
      const m = window.location.pathname.match(/\/video\/(BV[\w]+)/);
      const bvid = m ? m[1] : "";
      if (bvid === bocLastBvid) return;
      bocLastBvid = bvid;

      if (!bvid) {
        // 已离开 /video/ 页面：关闭覆盖式面板。
        bocCloseOverlay(true);
        return;
      }
      // 换到新的 BV：重建下方工具栏（面板由用户再次点开）。
      bocRemoveToolbar();
      bocInjectToolbar();
    }, 1200);
  }
  bocWatchBilibiliNavigation();
}


// ============================================================
// EMBEDDED PANEL + BELOW-VIDEO TOOLBAR
// ============================================================
// The digest UI is an in-page panel that floats over Bilibili's right
// recommendation rail (instead of a narrow browser side panel), so it can be
// wide and easy to operate. It loads the existing sidepanel.html in an iframe,
// reusing all the panel logic and styling unchanged.

function bocEl(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
}

// ------------------------------------------------------------------
// In-page overlay panel: covers the Bilibili right recommendation rail.
// Left/page layout is untouched — only a fixed overlay is layered on top,
// so the rest of the page does not shrink. Loads sidepanel.html in an iframe.
// ------------------------------------------------------------------
let bocOverlayOpen = false;
let bocOverlayCloseTimer = null;
const BOC_OVERLAY_W = 460;

function bocToggleOverlay() {
  const existing = document.getElementById("boc-overlay");
  if (existing) {
    bocCloseOverlay();
  } else {
    bocOpenOverlay();
  }
}

function bocOpenOverlay() {
  if (!window.location.pathname.includes("/video/")) return;
  const existing = document.getElementById("boc-overlay");
  if (existing) return;
  if (bocOverlayCloseTimer) {
    clearTimeout(bocOverlayCloseTimer);
    bocOverlayCloseTimer = null;
  }

  const overlay = bocEl("div", "boc-overlay");
  overlay.id = "boc-overlay";

  const header = bocEl("div", "boc-overlay-header");
  const title = bocEl("span", "boc-overlay-title", "<span>Bili Digest</span>");
  const closeBtn = bocEl("button", "boc-overlay-close", "&times;");
  closeBtn.setAttribute("aria-label", "关闭 Bili Digest");
  closeBtn.addEventListener("click", () => bocCloseOverlay());
  header.appendChild(title);
  header.appendChild(closeBtn);

  const iframe = document.createElement("iframe");
  iframe.className = "boc-overlay-frame";
  iframe.src = chrome.runtime.getURL("sidepanel.html");
  iframe.setAttribute("allow", "clipboard-write");

  overlay.appendChild(header);
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.add("open");
  });

  bocOverlayOpen = true;

  // Ask the panel (inside the iframe) to load the current video, and hand it the
  // video metadata we can already read from this page. The iframe can't reliably
  // resolve the tab via chrome.tabs, so passing the title/UP here is what lets the
  // header show the video info (addresses "video info missing in overlay panel").
  const info = (() => {
    try { return extractVideoInfo(); } catch (_e) { return {}; }
  })();
  chrome.runtime.sendMessage({
    action: "startDigestFromButton",
    videoId: biliVideoIdFromUrl(),
    videoUrl: location.href,
    videoTitle: info.title || "",
    channelName: info.channelName || "",
  }).catch?.(() => {});
}

function bocCloseOverlay(instant) {
  const overlay = document.getElementById("boc-overlay");
  if (!overlay) {
    bocOverlayOpen = false;
    return;
  }
  overlay.classList.remove("open");
  bocOverlayOpen = false;
  if (bocOverlayCloseTimer) clearTimeout(bocOverlayCloseTimer);
  const delay = instant ? 0 : 260;
  bocOverlayCloseTimer = setTimeout(() => {
    overlay.remove();
    bocOverlayCloseTimer = null;
  }, delay);
}

// Toolbar visibility should not fight the overlay close on fullscreen.
function bocCloseOverlayIfOpen() {
  if (bocOverlayOpen) bocCloseOverlay();
}

// ------------------------------------------------------------------
// Below-video toolbar: persistent "记录笔记" and "Bili Digest(打开面板)"
// Sits just under the video player, left-aligned, recomputed on scroll/resize.
// ------------------------------------------------------------------
let bocToolbarThrottle = 0;


// Save a note at the current playback position directly (no panel needed).
function bocSaveToolbarNote(btn) {
  const video = locateVideo();
  if (!video) return;
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const info = extractVideoInfo();
  const bvid = biliVideoIdFromUrl();
  const original = btn ? btn.innerHTML : "";
  if (btn) {
    btn.innerHTML = '<span>保存中...</span>';
    btn.disabled = true;
  }
  chrome.runtime.sendMessage({
    action: "saveNote",
    videoId: bvid,
    timestamp: currentTime,
    videoTitle: info.title,
    channelName: info.channelName,
  }).then((result) => {
    if (btn) {
      btn.innerHTML = result && result.success ? '<span>已保存</span>' : '<span>失败</span>';
      window.setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1400);
    }
    if (result && result.success && result.note) showNoteSavedToast(result.note);
  }).catch((err) => {
    if (btn) { btn.innerHTML = '<span>失败</span>'; btn.disabled = false; }
    console.error("[Bili Digest] Toolbar saveNote error:", err);
  });
}

function bocInjectToolbar() {
  if (!window.location.pathname.includes("/video/")) return;
  if (document.getElementById("boc-actions")) {
    bocPositionToolbar();
    return;
  }

  const bar = bocEl("div", "boc-actions");
  bar.id = "boc-actions";
  const openBtn = bocEl("button", "boc-action-btn", "<span>Bili Digest</span>");
  openBtn.addEventListener("click", () => {
    bocToggleOverlay();
  });
  const split = bocEl("span", "boc-action-sep");
  const noteBtn = bocEl("button", "boc-action-btn boc-note", "<span>记笔记</span>");
  noteBtn.setAttribute("title", "保存带时间戳的笔记到 Bili Digest");
  noteBtn.addEventListener("click", () => {
    bocSaveToolbarNote(noteBtn);
  });
  bar.appendChild(openBtn);
  bar.appendChild(split);
  bar.appendChild(noteBtn);
  document.body.appendChild(bar);

  bocPositionToolbar();
  bocWatchPlayerResize();

  // Visual Viewport-based repositioning; safe during fullscreen too.
  window.addEventListener("scroll", bocScheduleToolbarPosition, { passive: true });
  window.addEventListener("resize", bocScheduleToolbarPosition);
  document.addEventListener("fullscreenchange", bocScheduleToolbarPosition);
}

function bocRemoveToolbar() {
  const bar = document.getElementById("boc-actions");
  if (bar) bar.remove();
}

function bocScheduleToolbarPosition() {
  const now = Date.now();
  if (now - bocToolbarThrottle < 80) return;
  bocToolbarThrottle = now;
  bocPositionToolbar();
}

let bocPlayerResizeObserver = null;

// Keep the toolbar width in sync with the player without a scroll handler.
function bocWatchPlayerResize() {
  if (bocPlayerResizeObserver) return;
  const host = document.querySelector(
    "#bilibili-player, .bpx-player-primary-area, .bpx-player-video-area",
  ) || locateVideo();
  if (!host || typeof ResizeObserver === "undefined") return;
  try {
    bocPlayerResizeObserver = new ResizeObserver(() => {
      bocPositionToolbar();
    });
    bocPlayerResizeObserver.observe(host);
  } catch (_err) {
    bocPlayerResizeObserver = null;
  }
}

function bocPositionToolbar() {
  const bar = document.getElementById("boc-actions");
  if (!bar) return;

  // Hide while the player is in fullscreen so the bar never overlaps the
  // native fullscreen controls; it reappears when we exit fullscreen.
  if (document.fullscreenElement) {
    bar.style.display = "none";
    return;
  }

  const host = document.querySelector(
    "#bilibili-player, .bpx-player-primary-area, .bpx-player-video-area",
  ) || locateVideo();
  if (!host) {
    bar.style.display = "none";
    return;
  }
  const r = host.getBoundingClientRect();
  const w = Math.max(220, Math.min(r.width, 480));
  // Position just below the player within the viewport (still viewport-fixed
  // so it tracks as the player scrolls, but is never laid over page content).
  bar.style.left = r.left + "px";
  bar.style.top = r.bottom + 12 + "px";
  bar.style.width = w + "px";
  bar.style.display = "flex";
}


// Run init when DOM is ready。
// 注意：必须放在文件末尾执行，保证上面所有的 let/const 顶层声明已完成初始化，
// 否则在页面已加载（readyState != loading）时 init() 会在同步执行时触发
// "Cannot access 'xxx' before initialization" 的 TDZ 错误，并连带跳过
// 上面的 chrome.runtime.onMessage 监听器注册，导致 seek / 跟随等失效。
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
