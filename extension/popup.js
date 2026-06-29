const START_COMMAND = [
  "# Run from the personal-immersive-translator repository folder.",
  "# You can also double-click: Start Translator.command",
  "export TRANSLATOR_BACKEND=codex-app",
  "export CODEX_MODEL=gpt-5.3-codex-spark",
  "npm start"
].join("\n");

const DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";
const DEFAULT_BILINGUAL_STYLE = "dashed";
const PIT_TOKEN = "pit-local-extension-token-v1";
const HEALTH_TIMEOUT_MS = 5000;
const BILINGUAL_STYLES = new Set(["dashed", "dotted", "wavy", "highlight", "soft-box", "blur"]);
const LEGACY_TARGET_LANGUAGE_ALIASES = new Map([
  ["中文", "Chinese (Simplified)"],
  ["简体中文", "Chinese (Simplified)"],
  ["繁体中文", "Chinese (Traditional)"],
  ["英文", "English"],
  ["英语", "English"],
  ["日文", "Japanese"],
  ["日语", "Japanese"],
  ["韩文", "Korean"],
  ["韩语", "Korean"]
]);

const fields = {
  targetLanguage: document.getElementById("targetLanguage"),
  customTargetLanguage: document.getElementById("customTargetLanguage"),
  endpoint: document.getElementById("endpoint"),
  mode: document.getElementById("mode"),
  bilingualStyle: document.getElementById("bilingualStyle"),
  clearPrevious: document.getElementById("clearPrevious"),
  viewportFirst: document.getElementById("viewportFirst"),
  showFloatingButton: document.getElementById("showFloatingButton"),
  translateSelection: document.getElementById("translateSelection"),
  autoTranslateSite: document.getElementById("autoTranslateSite"),
  translate: document.getElementById("translate"),
  clear: document.getElementById("clear"),
  recheck: document.getElementById("recheck"),
  copyCommand: document.getElementById("copyCommand"),
  status: document.getElementById("status"),
  health: document.getElementById("health"),
  latency: document.getElementById("latency"),
  offlineHelp: document.getElementById("offlineHelp"),
  serverState: document.getElementById("serverState"),
  serverPanel: document.getElementById("serverPanel"),
  translateSubtitle: document.getElementById("translateSubtitle"),
  kebab: document.getElementById("kebab"),
  overflow: document.getElementById("overflow"),
  styleToggle: document.getElementById("styleToggle"),
  stylePicker: document.getElementById("stylePicker"),
  styleLabel: document.getElementById("styleLabel")
};

const BILINGUAL_STYLE_LABELS = {
  dashed: "Dashed underline",
  dotted: "Dotted underline",
  wavy: "Wavy underline",
  highlight: "Highlight",
  "soft-box": "Soft box",
  blur: "Blur"
};

const styleCards = Array.from(document.querySelectorAll(".style-card[data-style]"));
const modeButtons = Array.from(document.querySelectorAll(".segmented [data-mode]"));
let currentSiteHost = "";

init();

async function init() {
  const saved = await chrome.storage.local.get({
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    endpoint: "http://127.0.0.1:8787",
    mode: "bilingual",
    bilingualStyle: DEFAULT_BILINGUAL_STYLE,
    clearPrevious: true,
    viewportFirst: true,
    showFloatingButton: true,
    translateSelection: true,
    autoTranslateSites: {}
  });

  setTargetLanguage(saved.targetLanguage);
  fields.endpoint.value = saved.endpoint;
  fields.mode.value = saved.mode;
  syncModeButtons();
  fields.bilingualStyle.value = normalizeBilingualStyle(saved.bilingualStyle);
  syncBilingualStyleCards();
  fields.clearPrevious.checked = saved.clearPrevious;
  fields.viewportFirst.checked = saved.viewportFirst;
  fields.showFloatingButton.checked = saved.showFloatingButton;
  fields.translateSelection.checked = saved.translateSelection;
  updateTranslateSubtitle();
  await hydrateSiteAutoTranslate(saved.autoTranslateSites);
  await chrome.storage.local.set(readSettings());

  fields.translate.addEventListener("click", translateCurrentTab);
  fields.clear.addEventListener("click", clearCurrentTab);
  fields.recheck.addEventListener("click", checkHealth);
  fields.copyCommand.addEventListener("click", copyStartCommand);

  fields.targetLanguage.addEventListener("change", () => {
    updateCustomLanguageVisibility();
    updateTranslateSubtitle();
    saveSettings();
  });

  fields.kebab.addEventListener("click", () => {
    const open = fields.overflow.hidden;
    fields.overflow.hidden = !open;
    fields.kebab.setAttribute("aria-expanded", String(open));
  });

  fields.styleToggle.addEventListener("click", () => {
    const open = fields.stylePicker.hidden;
    fields.stylePicker.hidden = !open;
    fields.styleToggle.setAttribute("aria-expanded", String(open));
  });

  styleCards.forEach((card) => {
    card.addEventListener("click", async () => {
      fields.bilingualStyle.value = normalizeBilingualStyle(card.dataset.style);
      syncBilingualStyleCards();
      await saveSettings();
    });
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      fields.mode.value = button.dataset.mode === "replace" ? "replace" : "bilingual";
      syncModeButtons();
      await saveSettings();
    });
  });

  [fields.customTargetLanguage, fields.endpoint, fields.mode, fields.bilingualStyle, fields.clearPrevious, fields.viewportFirst, fields.showFloatingButton, fields.translateSelection].forEach((field) => {
    field.addEventListener("change", () => {
      if (field === fields.bilingualStyle) {
        syncBilingualStyleCards();
      }
      if (field === fields.mode) {
        syncModeButtons();
      }
      if (field === fields.customTargetLanguage) {
        updateTranslateSubtitle();
      }
      saveSettings();
    });
    field.addEventListener("input", () => {
      if (field === fields.customTargetLanguage) {
        updateTranslateSubtitle();
      }
      saveSettings();
    });
  });

  fields.showFloatingButton.addEventListener("change", syncFloatingButton);
  fields.autoTranslateSite.addEventListener("change", syncAutoTranslateSite);

  await checkHealth();
  window.setInterval(checkHealth, 3000);
}

async function saveSettings() {
  await chrome.storage.local.set(readSettings());
}

async function syncFloatingButton() {
  await saveSettings();
  try {
    const tab = await getActiveTab();
    await sendToPage(tab.id, {
      type: "set-floating-visibility",
      visible: fields.showFloatingButton.checked
    });
  } catch {
    // Some Chrome pages do not allow content scripts; storage still keeps the setting.
  }
}

async function hydrateSiteAutoTranslate(autoTranslateSites) {
  try {
    const tab = await getActiveTab();
    currentSiteHost = hostFromTabUrl(tab.url);
  } catch {
    currentSiteHost = "";
  }

  fields.autoTranslateSite.checked = Boolean(currentSiteHost && autoTranslateSites?.[currentSiteHost]);
  fields.autoTranslateSite.disabled = !currentSiteHost;
}

async function syncAutoTranslateSite() {
  if (!currentSiteHost) {
    fields.autoTranslateSite.checked = false;
    return;
  }

  const { autoTranslateSites = {} } = await chrome.storage.local.get({ autoTranslateSites: {} });
  const nextSites = { ...autoTranslateSites };
  if (fields.autoTranslateSite.checked) {
    nextSites[currentSiteHost] = true;
    setStatus(`Auto-translate enabled for ${currentSiteHost}.`);
  } else {
    delete nextSites[currentSiteHost];
    setStatus(`Auto-translate disabled for ${currentSiteHost}.`);
  }

  await chrome.storage.local.set({ autoTranslateSites: nextSites });
}

async function checkHealth() {
  const endpoint = normalizeEndpoint(fields.endpoint.value);
  try {
    const response = await fetchWithTimeout(`${endpoint}/health`, {
      headers: {
        "X-PIT-Token": PIT_TOKEN
      }
    }, HEALTH_TIMEOUT_MS);
    const body = await response.json();
    const ready = response.ok && body.ok !== false;

    fields.health.dataset.ok = String(ready);
    fields.health.textContent = ready ? "Connected" : "Error";
    fields.serverPanel.dataset.ok = String(ready);
    fields.serverState.textContent = serverLabel(body);
    fields.latency.textContent = body.lastLatencyMs ? `${body.lastLatencyMs}ms` : body.warm === false ? "warming" : "--";
    fields.offlineHelp.hidden = true;
    fields.translate.disabled = !ready;
  } catch {
    fields.health.dataset.ok = "false";
    fields.health.textContent = "Offline";
    fields.serverPanel.dataset.ok = "false";
    fields.serverState.textContent = "Not running";
    fields.latency.textContent = "--";
    fields.offlineHelp.hidden = false;
    fields.translate.disabled = true;
  }
}

async function translateCurrentTab() {
  setStatus("Starting...");
  fields.translate.disabled = true;

  try {
    await saveSettings();
    const tab = await getActiveTab();
    const response = await sendToPage(tab.id, {
      type: "start-page-translation",
      options: readSettings()
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Translation failed.");
    }

    const translated = response.summary?.translated || 0;
    setStatus(`Translated ${translated} text blocks.`);
  } catch (error) {
    setStatus(friendlyError(error), true);
  } finally {
    fields.translate.disabled = false;
    checkHealth();
  }
}

async function clearCurrentTab() {
  setStatus("Clearing...");
  try {
    const tab = await getActiveTab();
    await sendToPage(tab.id, { type: "clear-page-translation" });
    setStatus("Cleared.");
  } catch (error) {
    setStatus(friendlyError(error), true);
  }
}

function readSettings() {
  return {
    targetLanguage: readTargetLanguage(),
    endpoint: normalizeEndpoint(fields.endpoint.value.trim() || "http://127.0.0.1:8787"),
    mode: fields.mode.value,
    bilingualStyle: normalizeBilingualStyle(fields.bilingualStyle.value),
    clearPrevious: fields.clearPrevious.checked,
    viewportFirst: fields.viewportFirst.checked,
    showFloatingButton: fields.showFloatingButton.checked,
    translateSelection: fields.translateSelection.checked,
    batchSize: 24,
    minChars: 4
  };
}

function setTargetLanguage(value) {
  const normalized = normalizeTargetLanguage(value);
  const option = Array.from(fields.targetLanguage.options).find((item) => item.value === normalized);

  if (option) {
    fields.targetLanguage.value = normalized;
    fields.customTargetLanguage.value = "";
  } else {
    fields.targetLanguage.value = "__custom__";
    fields.customTargetLanguage.value = normalized;
  }

  updateCustomLanguageVisibility();
}

function readTargetLanguage() {
  if (fields.targetLanguage.value === "__custom__") {
    return normalizeTargetLanguage(fields.customTargetLanguage.value);
  }

  return normalizeTargetLanguage(fields.targetLanguage.value);
}

function normalizeTargetLanguage(value) {
  const language = String(value || "").trim();
  if (!language) {
    return DEFAULT_TARGET_LANGUAGE;
  }

  return LEGACY_TARGET_LANGUAGE_ALIASES.get(language) || language;
}

function normalizeBilingualStyle(value) {
  return BILINGUAL_STYLES.has(value) ? value : DEFAULT_BILINGUAL_STYLE;
}

function syncBilingualStyleCards() {
  const value = normalizeBilingualStyle(fields.bilingualStyle.value);
  styleCards.forEach((card) => {
    const active = card.dataset.style === value;
    card.dataset.active = String(active);
    card.setAttribute("aria-pressed", String(active));
  });
  if (fields.styleLabel) {
    fields.styleLabel.textContent = BILINGUAL_STYLE_LABELS[value] || "Dashed underline";
  }
}

function syncModeButtons() {
  const value = fields.mode.value === "replace" ? "replace" : "bilingual";
  modeButtons.forEach((button) => {
    const active = button.dataset.mode === value;
    button.dataset.active = String(active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function updateCustomLanguageVisibility() {
  const custom = fields.targetLanguage.value === "__custom__";
  fields.customTargetLanguage.hidden = !custom;
  if (custom && !fields.customTargetLanguage.value.trim()) {
    fields.customTargetLanguage.value = "";
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

async function sendToPage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (!messageText.includes("Receiving end does not exist")) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function copyStartCommand() {
  await navigator.clipboard.writeText(START_COMMAND);
  setStatus("Start command copied.");
}

function serverLabel(body) {
  if (body.warm === false) {
    return `${prettyModel(body.model)} warming`;
  }
  return prettyModel(body.model);
}

function prettyModel(model) {
  const raw = String(model || "").trim();
  if (!raw) {
    return "Codex bridge";
  }
  const spark = raw.match(/(\d+(?:\.\d+)?)[-_ ]?codex[-_ ]?spark|codex[-_ ]?spark[-_ ]?(\d+(?:\.\d+)?)/i);
  if (spark) {
    const version = spark[1] || spark[2];
    return version ? `Codex Spark ${version}` : "Codex Spark";
  }
  return raw;
}

function updateTranslateSubtitle() {
  if (!fields.translateSubtitle) {
    return;
  }
  fields.translateSubtitle.textContent = `English detected → ${targetLanguageLabel()}`;
}

function targetLanguageLabel() {
  if (fields.targetLanguage.value === "__custom__") {
    return fields.customTargetLanguage.value.trim() || "Custom";
  }
  const option = fields.targetLanguage.selectedOptions[0];
  return option ? option.textContent.trim() : readTargetLanguage();
}

function friendlyError(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("Failed to fetch") || text.includes("Proxy offline")) {
    return "Local server is not running.";
  }
  if (text.includes("Cannot access") || text.includes("chrome://")) {
    return "Chrome does not allow translating this page.";
  }
  if (text.includes("returned") && text.includes("translations")) {
    return "The model returned a mismatched batch. Please try again.";
  }
  return text;
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "");
}

function hostFromTabUrl(url) {
  try {
    const parsed = new URL(url || "");
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function setStatus(text, isError = false) {
  fields.status.textContent = text;
  fields.status.dataset.error = String(isError);
}
