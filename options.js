const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");
const voiceSelect = form.elements.speechVoiceName;
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

init();

async function init() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    statusNode.textContent = "Could not load settings.";
    return;
  }

  populateLanguageOptions(
    normalizeLanguageCode(response.settings.sourceLang, DEFAULT_SOURCE_LANG),
    normalizeTargetLanguage(response.settings.targetLang, response.settings.sourceLang)
  );
  form.speechVoiceSource.value = response.settings.speechVoiceSource || "any";
  form.speechRate.value = response.settings.speechRate || "0.9";
  form.speechPitch.value = response.settings.speechPitch || "1";
  populateVoiceOptions(response.settings.speechVoiceName, form.sourceLang.value);

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {
      populateVoiceOptions(form.elements.speechVoiceName.value, form.sourceLang.value);
    };
  }
}

form.sourceLang.addEventListener("change", () => {
  const sourceLang = normalizeLanguageCode(form.sourceLang.value, DEFAULT_SOURCE_LANG);
  const targetLang = normalizeTargetLanguage(form.targetLang.value, sourceLang);
  populateLanguageOptions(sourceLang, targetLang);
  populateVoiceOptions("", sourceLang);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const sourceLang = normalizeLanguageCode(formData.get("sourceLang"), DEFAULT_SOURCE_LANG);
  const settings = {
    sourceLang,
    targetLang: normalizeTargetLanguage(formData.get("targetLang"), sourceLang),
    speechVoiceName: String(formData.get("speechVoiceName") || "").trim(),
    speechVoiceSource: String(formData.get("speechVoiceSource") || "").trim() || "any",
    speechRate: normalizeSpeechNumber(formData.get("speechRate"), 0.9, 0.65, 1.2),
    speechPitch: normalizeSpeechNumber(formData.get("speechPitch"), 1, 0.8, 1.2)
  };

  const response = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings
  });

  statusNode.textContent = response?.ok
    ? "Settings saved."
    : response?.error || "Could not save settings.";
});

function populateLanguageOptions(sourceLang, targetLang) {
  form.sourceLang.replaceChildren(
    ...LANGUAGE_OPTIONS.map((language) => new Option(language.label, language.code))
  );
  form.sourceLang.value = sourceLang;

  const targetOptions = LANGUAGE_OPTIONS
    .filter((language) => language.code !== sourceLang)
    .map((language) => new Option(language.label, language.code));
  form.targetLang.replaceChildren(...targetOptions);
  form.targetLang.value = normalizeTargetLanguage(targetLang, sourceLang);
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

function populateVoiceOptions(selectedVoiceName, sourceLang = DEFAULT_SOURCE_LANG) {
  const preferred = String(selectedVoiceName || "").trim();
  const currentValue = preferred || String(voiceSelect.value || "").trim();
  const voices = "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
  const languagePrefix = getVoiceLanguagePrefix(sourceLang);
  const matchingVoices = voices
    .filter((voice) => String(voice.lang || "").toLowerCase().startsWith(languagePrefix))
    .sort((left, right) => {
      return `${left.name} ${left.lang}`.localeCompare(`${right.name} ${right.lang}`);
    });

  voiceSelect.innerHTML = "";
  voiceSelect.appendChild(
    new Option("Automatic", "")
  );

  for (const voice of matchingVoices) {
    const sourceLabel = voice.localService ? "system" : "browser";
    voiceSelect.appendChild(new Option(`${voice.name} (${voice.lang}, ${sourceLabel})`, voice.name));
  }

  if (currentValue && !matchingVoices.some((voice) => voice.name === currentValue)) {
    voiceSelect.appendChild(new Option(`${currentValue} (unavailable in this browser)`, currentValue));
  }

  voiceSelect.value = currentValue;
}

function getVoiceLanguagePrefix(sourceLang) {
  if (sourceLang === "zh-CN") {
    return "zh";
  }

  return sourceLang.toLowerCase();
}

function normalizeSpeechNumber(value, fallback, min, max) {
  const number = Number.parseFloat(String(value || "").replace(",", "."));
  if (!Number.isFinite(number)) {
    return String(fallback);
  }

  return String(Math.min(max, Math.max(min, number)));
}
