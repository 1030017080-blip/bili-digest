/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[Bili Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "未配置 DeepSeek API 密钥，请打开 Bili Digest 设置。",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings.aiBaseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  if (!(tab.url || "").match(/^https:\/\/(www\.)?bilibili\.com\/video\//)) {
    void updatePanelForTab(tab.id, tab.url, tab.windowId);
    return;
  }

  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make Bili Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
async function closePanelForTab(tabId, windowId) {
  // Chrome 141 added an explicit close API. On older supported versions,
  // disabling the tab-specific panel below remains the compatibility path.
  if (typeof chrome.sidePanel.close !== "function") return;

  try {
    // This closes the tab-specific panel used by Bili Digest.
    await chrome.sidePanel.close({ tabId });
    return;
  } catch (error) {
    // Chrome 145+ rejects tabId when the visible instance is global. Close
    // that instance by window instead.
  }

  if (Number.isInteger(windowId)) {
    await chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

async function updatePanelForTab(tabId, url, windowId) {
  const isBilibili = (url || "").match(/^https:\/\/(www\.)?bilibili\.com\/video\//);
  if (!isBilibili) {
    // Close the visible instance first. Then disable this tab so Chrome cannot
    // reopen the global default panel as navigation settles.
    await closePanelForTab(tabId, windowId);
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  // setOptions can reject if the tab just closed. Ignore that harmlessly.
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(() => {});
}

/**
 * Gets the best URL from a tab update that can change panel availability.
 * Chrome can apply tab-specific side-panel state before a navigation commits,
 * then reset it during the commit. Handling loading and complete gives the
 * first non-YouTube navigation a reliable second reconciliation.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// A tab started or completed navigation. Reconcile at both stages because
// Chrome can replace per-tab side-panel options while the page commits.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return; // Ignore title and favicon-only updates.
  void updatePanelForTab(tabId, url, tab.windowId);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePanelForTab(tabId, tab.url || tab.pendingUrl, windowId);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId, message.pageIndex, message.subtitleTrackLan, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "fetchSubtitleTracks") {
    handleFetchSubtitleTracks(message.videoId, message.pageIndex, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp, or save exact selected transcript
    // text when the side panel supplies it.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "exportTranscriptToObsidian") {
    handleExportTranscriptToObsidian(message)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "exportNoteToObsidian") {
    handleExportNoteToObsidian(message)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message, code: err.code }),
      );
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[Bili Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[Bili Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[Bili Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[Bili Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // P0-4: 面板/内容脚本发来的消息，sender.tab 即当前 B站 页面。优先直接命中它，
        // 避免多标签页时转发到错误页面。
        let tabs = null;
        if (
          sender &&
          sender.tab &&
          sender.tab.id &&
          sender.tab.url?.includes("bilibili.com")
        ) {
          tabs = [sender.tab];
          debugLog("[Bili Digest BG] Using sender tab:", sender.tab.id, sender.tab.url);
        }

        // 无可用来源标签页时，才按 active 窗口多策略查找 B站 标签页。
        if (!tabs) {
          tabs = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true,
          });
        }
        debugLog("[Bili Digest BG] Resolved tabs:", tabs.length, tabs[0]?.url);

        // If no bilibili tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("bilibili.com")) {
          tabs = await chrome.tabs.query({
            url: "https://www.bilibili.com/video/*",
            active: true,
          });
          debugLog("[Bili Digest BG] Active Bilibili tabs:", tabs.length);
        }

        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
          debugLog("[Bili Digest BG] Any Bilibili tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[Bili Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          debugLog("[Bili Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[Bili Digest BG] No Bilibili tab found");
          sendResponse({ success: false, error: "找不到 Bilibili 标签页" });
        }
      } catch (err) {
        console.error("[Bili Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

// ============================================================
// TRANSCRIPT FETCHING — Bilibili native subtitles
// ============================================================

/**
 * Bilibili API fetch with the cookie/referer headers the extension needs.
 * host_permissions on api.bilibili.com / *.hdslb.com let the MV3 service
 * worker carry the user's bilibili cookies (credentials: "include").
 */
async function biliFetchJson(url) {
  // Bilibili subtitle/CDN URLs are typically protocol-relative
  // ("//aisubtitle.hdslb.com/...") or "http://". In the MV3 worker those
  // resolve against the extension origin and fail with "Failed to fetch".
  // Normalize to https so we always hit the real CDN.
  url = String(url || "").replace(/^(?:https?:)?\/\//i, "https://");
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: "https://www.bilibili.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`Bilibili request failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch Bilibili video meta: aid, title, UP name, description, pages (p / cid / duration).
 */
async function fetchBilibiliVideoMeta(bvid) {
  let meta = null;
  try {
    const payload = await biliFetchJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    );
    if (payload.code === 0 && payload.data) meta = payload.data;
  } catch (e) { meta = null; }

  if (!meta) {
    // view is often rate-limited / wind-controlled for extension requests.
    // Fall back to /x/player/pagelist (no signer, rarely wind-controlled) for
    // cid/pages/duration so the subtitle flow can still proceed.
    const pl = await biliFetchJson(
      `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`,
    );
    if (pl.code !== 0) {
      throw new Error(pl.message || "无法获取视频信息");
    }
    const pages = (Array.isArray(pl.data) ? pl.data : []).map((p) => ({
      cid: String(p.cid || ""),
      page: Number(p.page || 0) || 0,
      duration: Number(p.duration || 0) || 0,
    }));
    return {
      aid: "",
      title: "",
      author: "",
      description: "",
      defaultCid: pages[0]?.cid || "",
      defaultDuration: Number(pages[0]?.duration || 0) || 0,
      pages,
    };
  }

  return {
    aid: meta.aid ? String(meta.aid) : "",
    title: String(meta.title || ""),
    author: String(meta.owner?.name || ""),
    description: String(meta.desc || ""),
    defaultCid: meta.cid ? String(meta.cid) : "",
    defaultDuration: Number(meta.duration || 0) || 0,
    pages: Array.isArray(meta.pages) ? meta.pages.map((p) => ({
      cid: String(p.cid || ""),
      page: Number(p.page || 0) || 0,
      duration: Number(p.duration || 0) || 0,
    })) : [],
  };
}

/**
 * Resolve the effective page / cid / duration for a #p= request.
 */
function resolveBilibiliPage(meta, pageIndex) {
  const pages = meta.pages || [];
  const idx = Number.isFinite(Number(pageIndex)) && Number(pageIndex) > 0
    ? Number(pageIndex)
    : 1;
  const p = pages[Number(idx) - 1] || pages[idx] || null;
  return {
    page: p ? p.page : 1,
    cid: p?.cid || meta.defaultCid || "",
    duration: p?.duration > 0 ? p.duration : meta.defaultDuration,
  };
}

/**
 * Fetch subtitle track list via the primary + fallback endpoint.
 */
async function fetchBilibiliSubtitleTracks({ bvid, aid, cid }) {
  const endpoints = [];
  if (aid) {
    endpoints.push(
      `https://api.bilibili.com/x/player/wbi/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}&bvid=${encodeURIComponent(bvid)}`,
    );
  }
  endpoints.push(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}${aid ? `&aid=${encodeURIComponent(aid)}` : ""}`,
  );

  let lastError = null;
  let needLogin = false;
  let loginMid = 0;
  for (const url of endpoints) {
    try {
      const payload = await biliFetchJson(url);
      if (payload.code !== 0) {
        lastError = new Error(payload.message || "无法获取字幕列表");
        continue;
      }
      const d = payload.data || {};
      // AI/ASR 字幕往往是登录用户才可见的轨道：need_login_subtitle 为真时，
      // 即使请求成功也可能一条轨道都不回传。
      needLogin = Boolean(d.need_login_subtitle);
      loginMid = Number(d.login_mid || 0) || 0;
      const subtitles = d?.subtitle?.subtitles || [];
      if (Array.isArray(subtitles) && subtitles.length > 0) {
        return { tracks: subtitles, needLogin, loginMid };
      }
      lastError = new Error("没有任何字幕轨道");
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError && !needLogin) throw lastError;
  return { tracks: [], needLogin, loginMid };
}

/**
 * Pick the best subtitle track: prefer zh / zh-cn, demote ai- tracks to last.
 */
function isBgmPlaceholder(text) {
  const flat = String(text || "")
    .replace(/[♪♫♩♬🎵🎶()（）\[\]【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return true;
  const noiseWord =
    /^(音乐|音乐声|歌曲|背景音乐|背景音|纯音乐|music|theme|ost|mus)$/i;
  return flat
    .split(" ")
    .filter(Boolean)
    .every((word) => noiseWord.test(word));
}

function placeholderRatio(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 1;
  const noisy = entries.filter((e) => isBgmPlaceholder(e?.text || "")).length;
  return noisy / entries.length;
}

function pickBilibiliSubtitleTrack(tracks, forcedLan) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const normalized = tracks
    .map((t) => ({
      lan: String(t.lan || ""),
      lanDoc: String(t.lan_doc || ""),
      url: String(t.subtitle_url || ""),
    }))
    .filter((t) => t.url && !/say something/.test(t.lan));
  // 用户在面板上手动指定了某条轨道时，精确命中该轨道（按 lan 前后缀匹配）。
  if (forcedLan) {
    const forced = normalized.find((t) => t.lan === forcedLan || t.lan.startsWith(forcedLan));
    if (forced) return forced;
  }
  const byLan = (lan) => normalized.filter((t) => t.lan.startsWith(lan));
  const prefer =
    byLan("zh-cn").concat(byLan("zh")).concat(byLan("zh-Hans")).concat(normalized.filter((t) => !t.lan.startsWith("ai-")));
  return prefer.length > 0 ? prefer[0] : normalized[0] || null;
}

/**
 * Heuristic: does the given subtitle text look like Chinese? Samples the first
 * ~100 CJK-capable chars and reports the CJK hit ratio.
 */
function looksLikeChinese(entries) {
  const joined = (entries || [])
    .slice(0, 20)
    .map((e) => String(e?.text || ""))
    .join("");
  const sample = joined.slice(0, 100);
  if (!sample.length) return false;
  let cjk = 0;
  for (const ch of sample) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk++;
  }
  return cjk / sample.length > 0.3;
}

/**
 * Detect the dominant language of a subtitle track. Prefer the track's native
 * language code, fall back to a CJK heuristic on the subtitle body.
 * @returns {string} "zh" | "en" | "ja" | "other"
 */
function detectTranscriptLanguage(track, entries) {
  const lan = String(track?.lan || "").toLowerCase();
  if (/^zh/i.test(lan)) return "zh";
  if (/^en/i.test(lan)) return "en";
  if (/^ja/i.test(lan)) return "ja";
  if (/^ko/i.test(lan)) return "ko";
  if (/^ai-zh/i.test(lan)) return "zh";
  if (lan && lan !== "ai-generated" && lan !== "ai-zh") return lan.split("-")[0] || "other";
  return looksLikeChinese(entries) ? "zh" : "other";
}

/**
 * Fetch the subtitle body JSON from hdslb and map it to transcript entries.
 */
async function fetchBilibiliSubtitleBody(url) {
  const payload = await biliFetchJson(url);
  // 兼容 body 直接挂载与嵌套在 data.body 两种结构，并做分片拼接。
  let body = Array.isArray(payload?.body) ? payload.body : null;
  if (!body && Array.isArray(payload?.data?.body)) body = payload.data.body;
  const chunks = Array.isArray(body) ? body : [];
  const entries = [];
  for (const line of chunks) {
    const text = String(line?.content || line?.text || "").trim();
    if (!text) continue;
    const from = Number(line?.from) || 0;
    const to = Number(line?.to) || from;
    entries.push({
      text,
      start: Math.floor(from),
      duration: Math.max(0, Math.ceil(to - from)),
    });
  }
  // 按起始时间排序，避免分片乱序导致字幕回跳。
  entries.sort((a, b) => a.start - b.start);
  return entries;
}

/**
 * Fetches the transcript for a Bilibili video using the native subtitle APIs.
 * No API key is required for subtitles.
 *
 * @param {string} bvid - Bilibili BV id (e.g. "BV1Zd8k6fEir")
 * @param {string} pageIndex - Optional #p= part index (1-based)
 * @returns {Object} - { success, transcript, transcriptText, transcriptTextTimestamped, language, videoTitle, channelName, videoDescription, chapters }
 */
/**
 * 只返回某视频可选的字幕轨道列表（供面板的「字幕轨道」下拉选择）。
 */
async function handleFetchSubtitleTracks(bvid, pageIndex, sender) {
  try {
    const meta = await fetchBilibiliVideoMeta(bvid);
    const { cid } = resolveBilibiliPage(meta, pageIndex);
    if (!cid) return { success: false, error: "NO_CID", message: "无法解析该分P的 cid。" };
    const trackInfo = await fetchBilibiliSubtitleTracks({ bvid, aid: meta.aid, cid });
    if (trackInfo.tracks.length === 0 && sender && sender.tab && sender.tab.id) {
      try {
        const pageRes = await chrome.tabs.sendMessage(sender.tab.id, {
          action: "biliFetchTracklist", bvid, aid: meta.aid, cid,
        });
        if (pageRes && pageRes.success && Array.isArray(pageRes.tracks) && pageRes.tracks.length > 0) {
          trackInfo.tracks = pageRes.tracks;
          trackInfo.needLogin = !!pageRes.needLogin;
        }
      } catch (_e) { /* 轨道列表兜底为可选，忽略失败 */ }
    }
    return {
      success: trackInfo.tracks.length > 0,
      needLogin: trackInfo.needLogin,
      selectedLan: (pickBilibiliSubtitleTrack(trackInfo.tracks, null) || {}).lan || "",
      tracks: trackInfo.tracks.map((t) => ({
        lan: String(t.lan || ""),
        lanDoc: String(t.lan_doc || ""),
        url: String(t.subtitle_url || ""),
      })),
    };
  } catch (error) {
    console.error("Bilibili subtitle tracks error:", error);
    return { success: false, error: error.message };
  }
}

async function handleFetchTranscript(bvid, pageIndex, forcedLan, sender) {
  try {
    const meta = await fetchBilibiliVideoMeta(bvid);
    const { cid, duration } = resolveBilibiliPage(meta, pageIndex);
    if (!cid) {
      return { success: false, error: "NO_CID", message: "无法解析该分P的 cid。" };
    }

    // 标题/UP主 兜底：view 接口常被风控，扩展请求拿不到 title/author 时，
    // 直接从可见的 B站页面 DOM 读取（页面一定有标题）。
    if ((!meta.title || !meta.author) && sender && sender.tab && sender.tab.id) {
      try {
        const gi = await chrome.tabs.sendMessage(sender.tab.id, { action: "getVideoInfo" });
        if (gi) {
          if (!meta.title && gi.title) meta.title = gi.title;
          if (!meta.author && gi.channelName) meta.author = gi.channelName;
          if (!meta.description && gi.description) meta.description = gi.description;
        }
      } catch (_e) { /* 标题兜底为可选，忽略失败 */ }
    }

    let trackInfo = await fetchBilibiliSubtitleTracks({ bvid, aid: meta.aid, cid });

    // 登录态兜底：AI/ASR 字幕多为登录可见轨道，后台请求若没带上 B站 cookie
    // （login_mid==0）就会得到空列表。此时改由 content script 用页面自身会话
    // 重新拉取轨道列表，覆盖“必须 cookie 的字幕”。
    if (trackInfo.tracks.length === 0 && sender && sender.tab && sender.tab.id) {
      try {
        const pageRes = await chrome.tabs.sendMessage(sender.tab.id, {
          action: "biliFetchTracklist",
          bvid,
          aid: meta.aid,
          cid,
        });
        if (pageRes && pageRes.success && Array.isArray(pageRes.tracks) && pageRes.tracks.length > 0) {
          trackInfo = {
            tracks: pageRes.tracks,
            needLogin: !!pageRes.needLogin,
            loginMid: Number(pageRes.loginMid) || 0,
          };
        }
      } catch (_e) { /* 页面兜底为可选，忽略失败 */ }
    }

    let track = pickBilibiliSubtitleTrack(trackInfo.tracks, forcedLan);
    if (!track) {
      if (trackInfo.needLogin) {
        return {
          success: false,
          error: "LOGIN_REQUIRED",
          message: "该视频的 AI 字幕需登录 B站后获取（请先在 Chrome 登录 B站并刷新视频页）。",
        };
      }
      return { success: false, error: "NO_TRANSCRIPT", message: "本视频无可用字幕轨道。" };
    }

    let entries = await fetchBilibiliSubtitleBody(track.url);

    // 内容感知纠错：优先轨若拿到几乎全是音乐/占位字幕（B 站 AI 轨会在纯 BGM
    // 段插入「♪ 音乐 ♪」），就再试其它候选轨，挑真实对话占比最高的那条，
    // 避免明明有对话轨却显示成背景音乐字幕。用户手动指定 forcedLan 时不干预。
    if (forcedLan == null && entries.length > 0 && placeholderRatio(entries) >= 0.5) {
      let best = { track, entries, ratio: placeholderRatio(entries) };
      for (const cand of trackInfo.tracks) {
        if (cand === track || !cand.url) continue;
        try {
          const candEntries = await fetchBilibiliSubtitleBody(cand.url);
          const ratio = candEntries.length ? placeholderRatio(candEntries) : 1;
          if (ratio < best.ratio) best = { track: cand, entries: candEntries, ratio };
        } catch (_e) { /* 单轨失败则跳过 */ }
      }
      track = best.track;
      entries = best.entries;
    }

    let transcriptTextPlain = "";
    let transcriptTextTimestamped = "";
    for (const e of entries) {
      transcriptTextPlain += e.text + " ";
      const mm = Math.floor(e.start / 60);
      const ss = e.start % 60;
      transcriptTextTimestamped += `[${mm}:${String(ss).padStart(2, "0")}] ${e.text}
`;
    }

    if (entries.length === 0) {
      return { success: false, error: "EMPTY_TRANSCRIPT", message: "字幕内容为空。" };
    }

    // Native chapter (view_points) if present
    let chapters = [];
    try {
      const vp = await biliFetchJson(
        `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}${meta.aid ? `&aid=${encodeURIComponent(meta.aid)}` : ""}`,
      );
      const pts = Array.isArray(vp?.data?.view_points) ? vp.data.view_points : [];
      chapters = pts.map((c) => ({
        title: String(c?.content || c?.title || "").trim(),
        timestampSeconds: Math.floor(Number(c?.from ?? c?.start) || 0),
      })).filter((c) => c.title && Number.isFinite(c.timestampSeconds));
    } catch (e) { /* chapters optional */ }

    const language = detectTranscriptLanguage(track, entries);

    return {
      success: true,
      transcript: entries,
      transcriptText: transcriptTextPlain.trim(),
      transcriptTextTimestamped: transcriptTextTimestamped.trim(),
      language,
      videoTitle: meta.title,
      channelName: meta.author,
      videoDescription: meta.description,
      videoDuration: duration,
      chapters,
      availableTracks: trackInfo.tracks.map((t) => ({
        lan: String(t.lan || ""),
        lanDoc: String(t.lan_doc || ""),
      })),
      selectedTrackLan: track.lan,
    };
  } catch (error) {
    console.error("Bilibili transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
      message: error.message,
    };
  }
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "未配置 DeepSeek API 密钥，请打开 Bili Digest 设置。",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[Bili Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "DeepSeek rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at a timestamp. Exact selected text is stored directly.
 * Other note requests find the relevant transcript line and clean it up.
 */

// ============================================================
// OBSIDIAN (Local REST API) EXPORT
// ============================================================

/**
 * Normalize a relative vault path: strip leading/trailing slashes and block
 * directory traversal so exports stay inside the configured folder.
 */
function normalizeObsidianPath(relPath) {
  const cleaned = String(relPath || "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const safe = cleaned
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  return safe;
}

/**
 * Build the REST URL targeting the Obsidian vault path for a filename.
 * Returns "" when the Remote REST API endpoint cannot be determined.
 */
function buildObsidianVaultUrl(settings, folder, filename) {
  const base = String(settings.obsidianUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  // Encode each path segment separately so the "/" folder separators survive
  // URL-encoding. Whole-path encoding turns "A/B" into "A%2FB", which the
  // Obsidian Local REST API does not recognise as a folder hierarchy.
  const folderSegments = normalizeObsidianPath(folder)
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const fileName = encodeURIComponent(String(filename || "note"));
  // A prefix is required by the plugin; derive it from the vault folder to
  // avoid writing outside the configured directory.
  const prefix = folderSegments ? folderSegments + "/" : "";
  return `${base}/vault/${prefix}${fileName}.md?overwrite=true`;
}

function renderObsidianFrontmatter(opts) {
  const createdAt = new Date().toISOString();
  const updatedAt = createdAt;
  const esc = (v) => String(v ?? "").replace(/"/g, '"');
  const page = Number(opts.page) > 0 ? Number(opts.page) : 1;
  const duration = Number(opts.duration) || 0;
  const lines = [
    "---",
    `title: "${esc(opts.videoTitle)}"`,
    `channel: "${esc(opts.channelName)}"`,
    `url: "${esc(opts.videoUrl)}"`,
    `videoId: "${esc(opts.videoId)}"`,
    `page: ${page}`,
    `language: "${esc(opts.language)}"`,
  ];
  if (duration > 0) lines.push(`duration: ${Math.round(duration)}`);
  lines.push("tags:");
  lines.push("  - bilibili");
  lines.push("  - 视频字幕");
  lines.push("  - 视频笔记");
  lines.push(`created: "${createdAt}"`);
  lines.push(`updated: "${updatedAt}"`);
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

function fmtTs(seconds) {
  const start = Number(seconds) || 0;
  const h = Math.floor(start / 3600);
  const m = Math.floor((start % 3600) / 60);
  const s = Math.floor(start % 60);
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

/**
 * Serialize a Bilibili transcript result into an Obsidian-friendly markdown body.
 * Builds a full document: metadata + link + chapters + timestamped subtitles +
 * saved notes. Links carry #t=NNN so each line jumps back to the video moment.
 */

function groupTranscriptByChapters(timestamped, chapters) {
  const segs = Array.isArray(timestamped) ? timestamped.filter((s) => s && s.text) : [];
  const chs = (Array.isArray(chapters) ? chapters : [])
    .map((c) => ({ title: String(c.title || "").trim(), start: Math.floor(Number(c.timestampSeconds) || 0) }))
    .filter((c) => c.title && c.start >= 0)
    .sort((a, b) => a.start - b.start);
  const buckets = chs.map((c) => ({ title: c.title, start: c.start, segments: [] }));
  if (!buckets.length) return [{ title: "", start: 0, segments: segs }];
  if (segs.some((s) => s.start < buckets[0].start)) {
    buckets.unshift({ title: "开始", start: 0, segments: [] });
  }
  for (const seg of segs) {
    let target = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (seg.start >= buckets[i].start) target = i; else break;
    }
    buckets[target].segments.push(seg);
  }
  return buckets;
}

function transcriptContextForNote(sec, segs) {
  let ctx = "";
  for (const s of segs) {
    if (s.start <= sec) ctx = s.text; else break;
  }
  return ctx;
}

function renderObsidianBody(opts) {
  const out = [];
  let baseUrl = String(opts.videoUrl || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const videoId = String(opts.videoId || "").trim();
  const page = Number(opts.page) > 0 ? Number(opts.page) : 1;
  // 多分P：跳转链接需带 p 参数定位分P，再拼 t 做秒级跳转。
  const linkBase = page > 1 ? baseUrl + "?p=" + page : baseUrl;
  const jump = (sec) => {
    const n = Math.floor(Number(sec) || 0);
    if (!linkBase) return fmtTs(n);
    return `[${fmtTs(n)}](${linkBase}${linkBase.includes("?") ? "&" : "?"}t=${n})`;
  };

  // ---- embedded player（支持分P） ----
  if (videoId) {
    out.push(`<iframe width="100%" height="420" src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(videoId)}&page=${page}" scrolling="no" border="0" allowfullscreen="true" style="border-radius:8px"></iframe>`);
    out.push("");
  }
  out.push(`**视频链接：** [${String(opts.videoTitle || videoId || "点击观看")}](${baseUrl}${page > 1 ? `?p=${page}` : ""})`);
  out.push("");

  // ---- overview (AI 总览，可选) ----
  const analysis = opts.analysis || null;
  if (analysis) {
    out.push("## 总览");
    const summary = String(analysis.summary || analysis.overview || "").trim();
    if (summary) out.push(summary);
    const ovChapters = Array.isArray(analysis.chapters) ? analysis.chapters : [];
    if (ovChapters.length) {
      out.push("### 章节要点");
      ovChapters.forEach((ch, i) => {
        const title = String(ch.title || `章节 ${i + 1}`).trim();
        const sum = String(ch.summary || "").trim();
        out.push(sum ? `- **${title}**：${sum}` : `- **${title}**`);
      });
    }
    const quotes = Array.isArray(analysis.keyQuotes) ? analysis.keyQuotes : [];
    if (quotes.length) {
      out.push("### 关键引言");
      for (const q of quotes) {
        const text = String(q.quote || "").trim();
        if (text) out.push(`> ${text}`);
      }
    }
    out.push("");
  }

  // ---- 章节导航（native view_points） ----
  const chapters = Array.isArray(opts.chapters) ? opts.chapters : [];
  if (chapters.length) {
    out.push("## 章节导航");
    for (const c of chapters) {
      out.push(`- ${jump(c.timestampSeconds)} ${String(c.title || "").trim()}`);
    }
    out.push("");
  }

  // ---- 完整字幕：按章节折叠分组，时间戳加粗可跳转 ----
  out.push("## 完整字幕");
  const timestamped = Array.isArray(opts.timestamped)
    ? opts.timestamped.map((s) => ({
        start: Math.floor(Number(s.start) || 0),
        text: String(s.text ?? s.hint ?? s.content ?? "").trim(),
      }))
    : [];
  const segs = timestamped.filter((s) => s.text);
  const buckets = groupTranscriptByChapters(segs, chapters);
  const renderSegs = (list) => list.forEach((s) => out.push(`- **[${fmtTs(s.start)}]** ${s.text}`));

  if (buckets.length > 1) {
    buckets.forEach((b) => {
      if (b.segments.length) {
        out.push("<details open>");
        out.push(`<summary><strong>${b.start ? fmtTs(b.start) + " · " : ""}${b.title || "字幕"}</strong></summary>`);
        out.push("");
        renderSegs(b.segments);
        out.push("</details>");
        out.push("");
      }
    });
  } else if (segs.length) {
    renderSegs(segs);
  } else if (typeof opts.transcriptText === "string" && opts.transcriptText.trim()) {
    out.push(opts.transcriptText.trim());
  }
  out.push("");

  // ---- 笔记：附带上一条字幕原文作上下文，便于 AI 复习定位 ----
  const notes = Array.isArray(opts.notes) ? opts.notes : [];
  if (notes.length) {
    out.push("## 笔记");
    for (const n of notes) {
      const sec = Math.max(0, Math.floor(Number(n.timestampSeconds) || 0));
      const body = String(n.rawText != null ? n.rawText : n.text || "").trim();
      out.push(`- ${jump(sec)} ${body}`);
      const ctx = transcriptContextForNote(sec, segs);
      if (ctx) out.push(`  > ${ctx}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Write a markdown document into the Obsidian vault via the Local REST API.
 */
async function writeMarkdownToObsidian({ settings, videoId, videoTitle, channelName, videoUrl, language, timestamped, transcriptText, chapters, notes, analysis, filename, page, duration }) {
  if (!settings.obsidianUrl || !settings.obsidianApiKey) {
    const error = new Error(
      "未配置 Obsidian Local REST API。请在 Bili Digest 设置中填写地址与 API Key。",
    );
    error.code = "NO_OBSIDIAN_CONFIG";
    throw error;
  }
  const safeFolder = normalizeObsidianPath(settings.obsidianVaultFolder);
  const safeName = String(filename || `${videoId || "note"}-${Date.now()}`)
    .replace(/[^A-Za-z0-9._\-一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const url = buildObsidianVaultUrl(settings, safeFolder, safeName);
  if (!url) {
    const error = new Error("Obsidian 地址无效（obsidianUrl 为空）。");
    error.code = "NO_OBSIDIAN_CONFIG";
    throw error;
  }

  const markdown =
    renderObsidianFrontmatter({ videoTitle, channelName, videoUrl, videoId, language, page, duration }) +
    "\n" +
    renderObsidianBody({ timestamped, transcriptText, chapters, notes, videoUrl, videoId, analysis, page, duration }) +
    "\n";

  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        Authorization: `Bearer ${settings.obsidianApiKey}`,
      },
      body: markdown,
    });
  } catch (err) {
    throw new Error(`无法连接 Obsidian（${err.message}）。请确认 Local REST API 插件已启用。`);
  }

  if (!response.ok) {
    throw new Error(`Obsidian 写入失败（HTTP ${response.status}）。请检查 API Key 与 vault 路径。`);
  }

  return { success: true, path: `/${normalizeObsidianPath(safeFolder + "/" + safeName)}.md`, url };
}

/**
 * Export the current video's transcript to Obsidian.
 */
async function handleExportTranscriptToObsidian(message) {
  const settings = await getSettings();
  const builtUrl = `https://www.bilibili.com/video/${message.videoId || ""}`;
  const result = await writeMarkdownToObsidian({
    settings,
    videoId: message.videoId,
    videoTitle: message.videoTitle,
    channelName: message.channelName,
    videoUrl: builtUrl,
    language: message.language,
    timestamped: message.timestamped,
    transcriptText: message.transcriptText,
    chapters: message.chapters,
    notes: message.notes,
    analysis: message.analysis,
    page: message.page,
    duration: message.duration,
    filename: message.filename || `${message.videoTitle || message.videoId || "digest"}`,
  });
  return result;
}

/**
 * Export a single saved note to Obsidian.
 */

async function handleExportNoteToObsidian(message) {
  const settings = await getSettings();
  const videoUrl = `https://www.bilibili.com/video/${message.videoId || ""}`;
  const note = message.note || {};
  const markdown =
    renderObsidianFrontmatter({
      videoTitle: note.videoTitle || message.videoTitle || "",
      channelName: note.channelName || message.channelName || "",
      videoUrl: note.timestampedUrl || videoUrl,
      videoId: note.videoId || message.videoId || "",
      language: message.language || "",
    }) +
    "\n" +
    `- **${note.timestamp || ""}** ${String(note.rawText != null ? note.rawText : note.text || "").trim()}\n` +
    "\n";

  const safeFolder = normalizeObsidianPath(settings.obsidianVaultFolder);
  const base = String(settings.obsidianUrl || "").trim().replace(/\/+$/, "");
  if (!base || !settings.obsidianApiKey) {
    const error = new Error("未配置 Obsidian Local REST API。");
    error.code = "NO_OBSIDIAN_CONFIG";
    throw error;
  }
  const filename = `${note.videoId || "note"}-${note.timestamp || Date.now()}`;
  const safeName = String(filename).replace(/[^A-Za-z0-9._\-一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
  const url = buildObsidianVaultUrl(settings, safeFolder, safeName);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown; charset=utf-8", Authorization: `Bearer ${settings.obsidianApiKey}` },
    body: markdown,
  });
  if (!response.ok) {
    throw new Error(`Obsidian 写入失败（HTTP ${response.status}）。`);
  }
  return { success: true, path: `/${normalizeObsidianPath(safeFolder + "/" + safeName)}.md` };
}

async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalBilibiliUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactSelectedText =
      typeof selectedText === "string"
        ? selectedText.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";

    // A selected transcript note is already the exact text the user wants.
    // Save it directly without a transcript fetch or an AI cleanup request.
    if (exactSelectedText) {
      const minutes = Math.floor(safeTimestamp / 60);
      const seconds = safeTimestamp % 60;
      const note = {
        id: `note_${Date.now()}`,
        videoId,
        videoTitle:
          typeof videoTitle === "string"
            ? videoTitle.slice(0, 500)
            : "Untitled Video",
        channelName:
          typeof channelName === "string" ? channelName.slice(0, 300) : "",
        timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
        timestampSeconds: safeTimestamp,
        timestampedUrl: YTD_SETTINGS.canonicalBilibiliUrl(videoId, safeTimestamp),
        text: exactSelectedText,
        rawText: exactSelectedText,
        createdAt: Date.now(),
      };

      await saveNoteToStorage(note);
      chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
      return { success: true, note };
    }

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[Bili Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[Bili Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = YTD_SETTINGS.canonicalBilibiliUrl(videoId, safeTimestamp);

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[Bili Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[Bili Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[Bili Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[Bili Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "未配置 DeepSeek API 密钥。",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[Bili Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "未配置 DeepSeek API 密钥" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[Bili Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleSaveNote,
  handleTranslateContent,
  closePanelForTab,
  updatePanelForTab,
};
