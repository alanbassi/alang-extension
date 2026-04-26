const state = {
  entries: [],
  settings: null,
  query: "",
  activeTabId: null,
  tabActive: false,
  canToggleTab: false
};
const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "Mandarin Chinese" },
  { code: "hi", label: "Hindi" },
  { code: "es", label: "Spanish" },
  { code: "ar", label: "Arabic" },
  { code: "pt", label: "Portuguese" },
  { code: "ja", label: "Japanese" },
  { code: "fr", label: "French" },
  { code: "it", label: "Italian" }
];
const DEFAULT_SOURCE_LANG = "en";
const DEFAULT_TARGET_LANG = "es";
const DEFAULT_TRANSLATION_COLOR = "#19b22a";
const DEFAULT_HIGHLIGHT_COLOR = "yellow";
const TRANSLATION_COLOR_OPTIONS = [
  { value: "#19b22a", label: "Green" },
  { value: "#2563eb", label: "Blue" },
  { value: "#7c3aed", label: "Purple" },
  { value: "#db2777", label: "Pink" },
  { value: "#dc2626", label: "Red" },
  { value: "#ea580c", label: "Orange" },
  { value: "#ca8a04", label: "Gold" },
  { value: "#059669", label: "Emerald" },
  { value: "#0891b2", label: "Cyan" },
  { value: "#111827", label: "Ink" }
];
const HIGHLIGHT_COLOR_OPTIONS = [
  { value: "yellow", label: "Yellow", swatch: "rgba(255, 236, 128, 0.62)" },
  { value: "green", label: "Green", swatch: "rgba(187, 247, 208, 0.68)" },
  { value: "blue", label: "Blue", swatch: "rgba(191, 219, 254, 0.7)" },
  { value: "pink", label: "Pink", swatch: "rgba(251, 207, 232, 0.72)" },
  { value: "purple", label: "Purple", swatch: "rgba(221, 214, 254, 0.72)" }
];

const elements = {
  entryCount: document.getElementById("entry-count"),
  langPair: document.getElementById("lang-pair"),
  sourceLang: document.getElementById("source-lang"),
  targetLang: document.getElementById("target-lang"),
  translationColorOptions: document.getElementById("translation-color-options"),
  highlightColorOptions: document.getElementById("highlight-color-options"),
  activationState: document.getElementById("activation-state"),
  activationCopy: document.getElementById("activation-copy"),
  toggleActive: document.getElementById("toggle-active"),
  entryList: document.getElementById("entry-list"),
  searchInput: document.getElementById("search-input"),
  exportJson: document.getElementById("export-json"),
  exportCsv: document.getElementById("export-csv"),
  clearAll: document.getElementById("clear-all"),
  footerActions: document.querySelector(".footer-actions"),
  openOptions: document.getElementById("open-options"),
  template: document.getElementById("entry-template")
};

init();

async function init() {
  bindEvents();
  await Promise.all([loadSettings(), loadEntries(), loadTabState()]);
  await syncActiveTabUi();
  render();
}

function bindEvents() {
  elements.searchInput.addEventListener("input", (event) => {
    state.query = sanitizeText(event.target.value).toLowerCase();
    renderEntries();
  });

  elements.sourceLang.addEventListener("change", async () => {
    const sourceLang = normalizeLanguageCode(elements.sourceLang.value, DEFAULT_SOURCE_LANG);
    const targetLang = normalizeTargetLanguage(elements.targetLang.value, sourceLang);
    populateLanguageControls(sourceLang, targetLang);
    await saveLanguageSettings(sourceLang, targetLang);
  });

  elements.targetLang.addEventListener("change", async () => {
    const sourceLang = normalizeLanguageCode(elements.sourceLang.value, DEFAULT_SOURCE_LANG);
    const targetLang = normalizeTargetLanguage(elements.targetLang.value, sourceLang);
    populateLanguageControls(sourceLang, targetLang);
    await saveLanguageSettings(sourceLang, targetLang);
  });

  elements.translationColorOptions.addEventListener("click", async (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-color]")
      : null;
    if (!button) {
      return;
    }

    await saveTranslationColor(button.dataset.color);
  });

  elements.highlightColorOptions.addEventListener("click", async (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-highlight-color]")
      : null;
    if (!button) {
      return;
    }

    await saveHighlightColor(button.dataset.highlightColor);
  });

  elements.exportJson.addEventListener("click", () => {
    downloadFile("alang-extension-vocabulary.json", JSON.stringify(state.entries, null, 2), "application/json");
  });

  elements.exportCsv.addEventListener("click", () => {
    downloadFile("alang-extension-vocabulary.csv", toCsv(state.entries), "text/csv;charset=utf-8");
  });

  elements.clearAll.addEventListener("click", async () => {
    const confirmed = window.confirm("Delete all saved vocabulary?");
    if (!confirmed) {
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: "CLEAR_ENTRIES" });
    if (response?.ok) {
      state.entries = [];
      render();
    }
  });

  elements.openOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  elements.toggleActive.addEventListener("click", async () => {
    if (!state.canToggleTab || !state.activeTabId) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "TOGGLE_TAB_STATUS",
      tabId: state.activeTabId
    });

    if (!response?.ok) {
      return;
    }

    state.tabActive = Boolean(response.active);
    renderActivationState();

    await syncActiveTabUi();
  });
}

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  state.settings = response?.ok ? response.settings : null;
}

async function loadEntries() {
  const response = await chrome.runtime.sendMessage({ type: "GET_ENTRIES" });
  state.entries = response?.ok ? response.entries : [];
}

async function loadTabState() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  state.activeTabId = tab?.id || null;
  state.canToggleTab = Boolean(tab?.id) && !String(tab?.url || "").startsWith("chrome");

  if (!state.activeTabId || !state.canToggleTab) {
    state.tabActive = false;
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "GET_TAB_STATUS",
    tabId: state.activeTabId
  });
  state.tabActive = Boolean(response?.ok && response.active);
}

async function syncActiveTabUi() {
  if (!state.activeTabId || !state.canToggleTab) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(state.activeTabId, {
      type: "READLINGO_SET_ACTIVE",
      active: state.tabActive
    });
  } catch (error) {
    // Ignore tabs that are not ready to receive messages yet.
  }
}

function render() {
  const total = state.entries.length;
  const sourceLang = normalizeLanguageCode(state.settings?.sourceLang, DEFAULT_SOURCE_LANG);
  const targetLang = normalizeTargetLanguage(state.settings?.targetLang, sourceLang);

  elements.entryCount.textContent = String(total);
  elements.langPair.textContent = `${sourceLang} -> ${targetLang}`;
  populateLanguageControls(sourceLang, targetLang);
  renderTranslationColorOptions(normalizeTranslationColor(state.settings?.translationColor));
  renderHighlightColorOptions(normalizeHighlightColor(state.settings?.highlightColor));

  elements.footerActions.hidden = total === 0;

  renderActivationState();
  renderEntries();
}

function populateLanguageControls(sourceLang, targetLang) {
  elements.sourceLang.replaceChildren(
    ...LANGUAGE_OPTIONS.map((language) => new Option(language.label, language.code))
  );
  elements.sourceLang.value = sourceLang;

  const targetOptions = LANGUAGE_OPTIONS
    .filter((language) => language.code !== sourceLang)
    .map((language) => new Option(language.label, language.code));
  elements.targetLang.replaceChildren(...targetOptions);
  elements.targetLang.value = normalizeTargetLanguage(targetLang, sourceLang);
}

async function saveLanguageSettings(sourceLang, targetLang) {
  const nextSettings = {
    ...(state.settings || {}),
    sourceLang,
    targetLang
  };
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: nextSettings
  });

  if (response?.ok) {
    state.settings = response.settings;
    const savedSource = normalizeLanguageCode(state.settings.sourceLang, DEFAULT_SOURCE_LANG);
    const savedTarget = normalizeTargetLanguage(state.settings.targetLang, savedSource);
    elements.langPair.textContent = `${savedSource} -> ${savedTarget}`;
    populateLanguageControls(savedSource, savedTarget);
  }
}

async function saveTranslationColor(color) {
  const translationColor = normalizeTranslationColor(color);
  const nextSettings = {
    ...(state.settings || {}),
    translationColor
  };
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: nextSettings
  });

  if (response?.ok) {
    state.settings = response.settings;
    const savedColor = normalizeTranslationColor(state.settings.translationColor);
    renderTranslationColorOptions(savedColor);
    await syncTranslationColorUi(savedColor);
  }
}

async function syncTranslationColorUi(translationColor) {
  if (!state.activeTabId || !state.canToggleTab) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(state.activeTabId, {
      type: "READLINGO_SET_TRANSLATION_COLOR",
      color: translationColor
    });
  } catch (error) {
    // Ignore tabs that are not ready to receive messages yet.
  }
}

async function saveHighlightColor(color) {
  const highlightColor = normalizeHighlightColor(color);
  const nextSettings = {
    ...(state.settings || {}),
    highlightColor
  };
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: nextSettings
  });

  if (response?.ok) {
    state.settings = response.settings;
    const savedColor = normalizeHighlightColor(state.settings.highlightColor);
    renderHighlightColorOptions(savedColor);
    await syncHighlightColorUi(savedColor);
  }
}

async function syncHighlightColorUi(highlightColor) {
  if (!state.activeTabId || !state.canToggleTab) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(state.activeTabId, {
      type: "READLINGO_SET_HIGHLIGHT_COLOR",
      color: highlightColor
    });
  } catch (error) {
    // Ignore tabs that are not ready to receive messages yet.
  }
}

function renderTranslationColorOptions(selectedColor = DEFAULT_TRANSLATION_COLOR) {
  elements.translationColorOptions.replaceChildren(
    ...TRANSLATION_COLOR_OPTIONS.map((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "color-swatch";
      button.dataset.color = color.value;
      button.title = color.label;
      button.setAttribute("aria-label", color.label);
      button.style.setProperty("--swatch-color", color.value);
      button.classList.toggle("is-selected", color.value === selectedColor);
      return button;
    })
  );
}

function renderHighlightColorOptions(selectedColor = DEFAULT_HIGHLIGHT_COLOR) {
  elements.highlightColorOptions.replaceChildren(
    ...HIGHLIGHT_COLOR_OPTIONS.map((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "color-swatch";
      button.dataset.highlightColor = color.value;
      button.title = color.label;
      button.setAttribute("aria-label", color.label);
      button.style.setProperty("--swatch-color", color.swatch);
      button.classList.toggle("is-selected", color.value === selectedColor);
      return button;
    })
  );
}

function normalizeTranslationColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TRANSLATION_COLOR_OPTIONS.some((color) => color.value === normalized)
    ? normalized
    : DEFAULT_TRANSLATION_COLOR;
}

function normalizeHighlightColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return HIGHLIGHT_COLOR_OPTIONS.some((color) => color.value === normalized)
    ? normalized
    : DEFAULT_HIGHLIGHT_COLOR;
}

function normalizeLanguageCode(value, fallback) {
  const normalized = String(value || "").trim();
  return LANGUAGE_OPTIONS.some((language) => language.code === normalized) ? normalized : fallback;
}

function normalizeTargetLanguage(value, sourceLang) {
  const normalized = normalizeLanguageCode(value, DEFAULT_TARGET_LANG);
  if (normalized !== sourceLang) {
    return normalized;
  }

  return LANGUAGE_OPTIONS.find((language) => language.code !== sourceLang)?.code || DEFAULT_TARGET_LANG;
}

function renderActivationState() {
  if (!state.canToggleTab) {
    elements.activationState.textContent = "Unavailable";
    elements.activationCopy.textContent = "Open a regular web page to enable ALang Extension on this tab.";
    elements.toggleActive.disabled = true;
    elements.toggleActive.textContent = "Unavailable";
    return;
  }

  elements.activationState.textContent = state.tabActive ? "On" : "Off";
  elements.activationCopy.textContent = state.tabActive
    ? "Click or select words on this tab to translate."
    : "Enable ALang Extension manually when you want to use it on this tab.";
  elements.toggleActive.disabled = false;
  elements.toggleActive.textContent = state.tabActive ? "Disable on this tab" : "Enable on this tab";
}

function renderEntries() {
  const query = state.query;
  const entries = state.entries.filter((entry) => {
    if (!query) {
      return true;
    }

    return [entry.text, entry.translation, entry.pageTitle, entry.pageUrl, entry.context]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  elements.entryList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = state.entries.length === 0
      ? "No saved items yet. Select text on any site and click Save."
      : "No items match your search.";
    elements.entryList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    elements.entryList.appendChild(buildEntryNode(entry));
  }
}

function buildEntryNode(entry) {
  const fragment = elements.template.content.cloneNode(true);
  const root = fragment.querySelector(".entry-card");
  const text = fragment.querySelector(".entry-text");
  const translation = fragment.querySelector(".entry-translation");
  const context = fragment.querySelector(".entry-context");
  const link = fragment.querySelector(".entry-link");
  const date = fragment.querySelector(".entry-date");
  const deleteButton = fragment.querySelector(".entry-delete");

  text.textContent = entry.text;
  translation.textContent = entry.translation;
  context.textContent = entry.context || "No saved context.";

  if (entry.pageUrl) {
    link.href = entry.pageUrl;
    link.textContent = entry.pageTitle || entry.pageUrl;
  } else {
    link.remove();
  }

  date.textContent = `Updated ${new Date(entry.updatedAt).toLocaleString("en")}`;
  deleteButton.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "DELETE_ENTRY",
      id: entry.id
    });

    if (!response?.ok) {
      return;
    }

    state.entries = state.entries.filter((item) => item.id !== entry.id);
    render();
  });

  return root;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toCsv(entries) {
  const rows = [["text", "translation", "context", "pageTitle", "pageUrl", "updatedAt"]];

  for (const entry of entries) {
    rows.push([
      entry.text,
      entry.translation,
      entry.context || "",
      entry.pageTitle || "",
      entry.pageUrl || "",
      entry.updatedAt || ""
    ]);
  }

  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
}

function escapeCsv(value) {
  const cell = String(value || "");
  return `"${cell.replace(/"/g, '""')}"`;
}

function sanitizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
