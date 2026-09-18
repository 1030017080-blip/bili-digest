/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    obsidianUrl: "http://127.0.0.1:27123",
    obsidianApiKey: "",
    obsidianVaultFolder: "",
  });

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalize(input = {}) {
    return {
      provider: DEFAULTS.provider,
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl:
        typeof input.aiBaseUrl === "string"
          ? input.aiBaseUrl.trim() || DEFAULTS.aiBaseUrl
          : DEFAULTS.aiBaseUrl,
      aiModel:
        typeof input.aiModel === "string"
          ? input.aiModel.trim() || DEFAULTS.aiModel
          : DEFAULTS.aiModel,
      obsidianUrl:
        typeof input.obsidianUrl === "string"
          ? input.obsidianUrl.trim() || DEFAULTS.obsidianUrl
          : DEFAULTS.obsidianUrl,
      obsidianApiKey:
        typeof input.obsidianApiKey === "string"
          ? input.obsidianApiKey.trim()
          : "",
      obsidianVaultFolder:
        typeof input.obsidianVaultFolder === "string"
          ? input.obsidianVaultFolder.trim()
          : "",
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl(baseUrl) {
    return `${baseUrl || DEFAULTS.aiBaseUrl}/chat/completions`;
  }

  function canonicalBilibiliUrl(videoId, seconds) {
    const normalized = String(videoId || "").trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(normalized)) {
      throw new Error("Invalid Bilibili BV id.");
    }
    const t = Number.isFinite(Number(seconds)) && Number(seconds) > 0
      ? `?t=${Math.floor(Number(seconds))}`
      : "";
    return `https://www.bilibili.com/video/${normalized}${t}`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    canonicalBilibiliUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
