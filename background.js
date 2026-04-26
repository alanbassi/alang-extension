const STORAGE_KEYS = {
  entries: "entries",
  settings: "settings"
};
const SESSION_KEYS = {
  enabledTabs: "enabledTabs"
};
const SETTINGS_VERSION = 8;
const SUPPORTED_LANGUAGE_CODES = new Set([
  "en",
  "zh-CN",
  "hi",
  "es",
  "ar",
  "pt",
  "ja",
  "fr",
  "it"
]);

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  sourceLang: "en",
  targetLang: "es",
  provider: "google",
  speechVoiceName: "",
  speechVoiceSource: "any",
  speechRate: "0.9",
  speechPitch: "1",
  translationColor: "#19b22a",
  highlightColor: "yellow"
};
const SUPPORTED_TRANSLATION_COLORS = new Set([
  "#19b22a",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#059669",
  "#0891b2",
  "#111827"
]);
const SUPPORTED_HIGHLIGHT_COLORS = new Set([
  "yellow",
  "green",
  "blue",
  "pink",
  "purple"
]);

const ALLOWED_SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await chrome.action.setBadgeBackgroundColor({ color: "#1c7c54" });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "alang-save-selection",
      title: 'Save to ALang Extension: "%s"',
      contexts: ["selection"]
    });
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removeTabEnabled(tabId);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "alang-save-selection" || !info.selectionText) {
    return;
  }

  try {
    if (!tab?.id || !(await isTabEnabled(tab.id))) {
      return;
    }

    const translationResult = await translateText(info.selectionText);
    await saveEntry({
      text: info.selectionText,
      translation: translationResult.translation,
      sourceLang: translationResult.sourceLang,
      targetLang: translationResult.targetLang,
      pageUrl: info.pageUrl || "",
      pageTitle: "",
      context: ""
    });
  } catch (error) {
    console.error("ALang Extension context menu error:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    saveSettings(message.settings)
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TRANSLATE") {
    translateText(message.text, message.context || "")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_TAB_STATUS") {
    resolveTabId(message.tabId, sender)
      .then(async (tabId) => {
        if (!tabId) {
          sendResponse({ ok: true, active: false });
          return;
        }

        sendResponse({ ok: true, active: await isTabEnabled(tabId) });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TOGGLE_TAB_STATUS") {
    resolveTabId(message.tabId, sender)
      .then(async (tabId) => {
        if (!tabId) {
          throw new Error("No available tab to activate.");
        }

        const nextActive = !(await isTabEnabled(tabId));
        await setTabEnabled(tabId, nextActive);
        if (nextActive) {
          try {
            await injectContentScript(tabId);
          } catch (error) {
            await setTabEnabled(tabId, false);
            throw error;
          }
        }

        await notifyTabActiveState(tabId, nextActive);
        sendResponse({ ok: true, active: nextActive });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SAVE_ENTRY") {
    saveEntry(message.entry)
      .then((entry) => sendResponse({ ok: true, entry }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_ENTRIES") {
    getEntries()
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DELETE_ENTRY") {
    deleteEntry(message.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CLEAR_ENTRIES") {
    clearEntries()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function ensureDefaults() {
  const settings = await getSettings();
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const storedSettings = result[STORAGE_KEYS.settings] || {};
  const settings = sanitizeSettings(storedSettings);

  if (shouldRewriteSettings(storedSettings, settings)) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  }

  return settings;
}

async function saveSettings(settings) {
  const merged = sanitizeSettings({ ...(await getSettings()), ...(settings || {}) });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });
  return merged;
}

function sanitizeSettings(settings) {
  const sanitized = { ...DEFAULT_SETTINGS };

  for (const [key, value] of Object.entries(settings || {})) {
    if (ALLOWED_SETTING_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }

  sanitized.sourceLang = normalizeConfiguredLanguage(sanitized.sourceLang, DEFAULT_SETTINGS.sourceLang);
  sanitized.targetLang = normalizeConfiguredLanguage(sanitized.targetLang, DEFAULT_SETTINGS.targetLang);

  if (sanitized.sourceLang === sanitized.targetLang) {
    sanitized.targetLang = getFallbackTargetLanguage(sanitized.sourceLang);
  }

  sanitized.translationColor = normalizeTranslationColor(sanitized.translationColor);
  sanitized.highlightColor = normalizeHighlightColor(sanitized.highlightColor);
  sanitized.provider = "google";
  sanitized.settingsVersion = SETTINGS_VERSION;
  return sanitized;
}

function normalizeTranslationColor(value) {
  const normalized = sanitizeText(value).toLowerCase();
  return SUPPORTED_TRANSLATION_COLORS.has(normalized)
    ? normalized
    : DEFAULT_SETTINGS.translationColor;
}

function normalizeHighlightColor(value) {
  const normalized = sanitizeText(value).toLowerCase();
  return SUPPORTED_HIGHLIGHT_COLORS.has(normalized)
    ? normalized
    : DEFAULT_SETTINGS.highlightColor;
}

function normalizeConfiguredLanguage(value, fallback) {
  const normalized = normalizeLanguageCode(value);
  return SUPPORTED_LANGUAGE_CODES.has(normalized) ? normalized : fallback;
}

function normalizeLanguageCode(value) {
  const normalized = sanitizeText(value);
  const lower = normalized.toLowerCase();

  if (lower === "zh" || lower === "zh-cn" || lower === "cmn" || lower === "mandarin") {
    return "zh-CN";
  }

  if (lower === "pt-br" || lower === "pt-pt" || lower === "portuguese") {
    return "pt";
  }

  return lower;
}

function getFallbackTargetLanguage(sourceLang) {
  return Array.from(SUPPORTED_LANGUAGE_CODES).find((code) => code !== sourceLang) || "es";
}

function shouldRewriteSettings(storedSettings, sanitizedSettings) {
  const storedKeys = Object.keys(storedSettings || {});
  if (storedKeys.some((key) => !ALLOWED_SETTING_KEYS.has(key))) {
    return true;
  }

  return storedKeys.some((key) => storedSettings[key] !== sanitizedSettings[key]);
}

async function getEntries() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.entries);
  const entries = result[STORAGE_KEYS.entries];
  return Array.isArray(entries) ? entries : [];
}

async function saveEntry(entry) {
  const sanitizedText = sanitizeText(entry?.text);
  const sanitizedTranslation = sanitizeText(entry?.translation);

  if (!sanitizedText) {
    throw new Error("No selected text to save.");
  }

  if (!sanitizedTranslation) {
    throw new Error("No translation available to save.");
  }

  const settings = await getSettings();
  const entries = await getEntries();
  const now = new Date().toISOString();
  const sourceLang = entry?.sourceLang || settings.sourceLang;
  const targetLang = entry?.targetLang || settings.targetLang;

  const existingIndex = entries.findIndex((item) => {
    return (
      item.text.toLowerCase() === sanitizedText.toLowerCase() &&
      item.sourceLang === sourceLang &&
      item.targetLang === targetLang
    );
  });

  const baseEntry = {
    id: existingIndex >= 0 ? entries[existingIndex].id : crypto.randomUUID(),
    text: sanitizedText,
    translation: sanitizedTranslation,
    sourceLang,
    targetLang,
    context: sanitizeText(entry?.context || ""),
    pageUrl: entry?.pageUrl || "",
    pageTitle: entry?.pageTitle || "",
    createdAt: existingIndex >= 0 ? entries[existingIndex].createdAt : now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1);
  }

  entries.unshift(baseEntry);
  await chrome.storage.local.set({ [STORAGE_KEYS.entries]: entries });
  return baseEntry;
}

async function deleteEntry(id) {
  const entries = await getEntries();
  const nextEntries = entries.filter((entry) => entry.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.entries]: nextEntries });
}

async function clearEntries() {
  await chrome.storage.local.set({ [STORAGE_KEYS.entries]: [] });
}

async function getEnabledTabsMap() {
  const result = await chrome.storage.session.get(SESSION_KEYS.enabledTabs);
  const map = result[SESSION_KEYS.enabledTabs];
  return map && typeof map === "object" ? map : {};
}

async function isTabEnabled(tabId) {
  const map = await getEnabledTabsMap();
  return Boolean(map[String(tabId)]);
}

async function setTabEnabled(tabId, active) {
  const map = await getEnabledTabsMap();
  if (active) {
    map[String(tabId)] = true;
  } else {
    delete map[String(tabId)];
  }

  await chrome.storage.session.set({ [SESSION_KEYS.enabledTabs]: map });
  await chrome.action.setBadgeText({
    tabId,
    text: active ? "ON" : ""
  });
}

async function removeTabEnabled(tabId) {
  const map = await getEnabledTabsMap();
  if (!(String(tabId) in map)) {
    return;
  }

  delete map[String(tabId)];
  await chrome.storage.session.set({ [SESSION_KEYS.enabledTabs]: map });
}

async function injectContentScript(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function notifyTabActiveState(tabId, active) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "READLINGO_SET_ACTIVE",
      active
    });
  } catch (error) {
    // Ignore tabs where the content script is unavailable.
  }
}

async function resolveTabId(explicitTabId, sender) {
  if (typeof explicitTabId === "number") {
    return explicitTabId;
  }

  if (typeof sender?.tab?.id === "number") {
    return sender.tab.id;
  }

  return null;
}

async function translateText(text) {
  const query = sanitizeText(text);

  if (!query) {
    throw new Error("Select a word or phrase to translate.");
  }

  const settings = await getSettings();
  return translateWithGoogle(query, settings);
}

async function translateWithGoogle(text, settings) {
  const sourceLang = normalizeGoogleLanguage(settings.sourceLang);
  const targetLang = normalizeGoogleLanguage(settings.targetLang);
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=" +
    encodeURIComponent(sourceLang) +
    "&tl=" +
    encodeURIComponent(targetLang) +
    "&q=" +
    encodeURIComponent(text);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("Could not reach Google Translate.");
  }

  const data = await response.json();
  const translatedText = sanitizeText(
    Array.isArray(data?.[0])
      ? data[0].map((part) => part?.[0] || "").join("")
      : ""
  );

  if (!translatedText) {
    throw new Error("Could not get a translation from Google Translate.");
  }

  return {
    translation: translatedText,
    provider: "google",
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang
  };
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGoogleLanguage(lang) {
  const value = normalizeLanguageCode(lang);
  if (!value) {
    return "en";
  }

  return value;
}
