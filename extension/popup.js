const PAIRING_STEPS = [
  "1. Open Gloss from the macOS menu bar.",
  "2. In Gloss Settings, choose Show Extension.",
  "3. Load or reload that App-managed BrowserExtension folder in Chrome.",
  "4. Source builds only: copy and paste the pairing token from Gloss Settings.",
  "5. Allow Chrome Local Network Access if prompted."
].join("\n");

const fields = {
  targetLanguage: document.getElementById("targetLanguage"),
  customTargetLanguage: document.getElementById("customTargetLanguage"),
  endpoint: document.getElementById("endpoint"),
  pairingToken: document.getElementById("pairingToken"),
  mode: document.getElementById("mode"),
  bilingualStyle: document.getElementById("bilingualStyle"),
  clearPrevious: document.getElementById("clearPrevious"),
  viewportFirst: document.getElementById("viewportFirst"),
  showFloatingButton: document.getElementById("showFloatingButton"),
  translateSelection: document.getElementById("translateSelection"),
  translateSubtitles: document.getElementById("translateSubtitles"),
  autoTranslateAllPages: document.getElementById("autoTranslateAllPages"),
  batchSize: document.getElementById("batchSize"),
  batchCharLimit: document.getElementById("batchCharLimit"),
  ttsRate: document.getElementById("ttsRate"),
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
let healthCheckTimer;
let healthCheckInFlight;

init();

async function init() {
  const saved = await chrome.storage.local.get({
    targetLanguage: PIT_DEFAULT_TARGET_LANGUAGE,
    endpoint: PIT_DEFAULT_ENDPOINT,
    pairingToken: PIT_DEFAULT_PAIRING_TOKEN,
    mode: "bilingual",
    bilingualStyle: PIT_DEFAULT_BILINGUAL_STYLE,
    clearPrevious: true,
    viewportFirst: true,
    showFloatingButton: true,
    translateSelection: true,
    autoTranslateAllPages: false,
    translateSubtitles: false,
    batchSize: PIT_DEFAULT_BATCH_ITEMS,
    batchCharLimit: PIT_DEFAULT_BATCH_CHAR_LIMIT,
    ttsRate: PIT_DEFAULT_TTS_RATE
  });

  setTargetLanguage(saved.targetLanguage);
  fields.endpoint.value = saved.endpoint;
  fields.pairingToken.value = PIT_DEFAULT_PAIRING_TOKEN || normalizePairingToken(saved.pairingToken);
  fields.mode.value = saved.mode;
  syncModeButtons();
  fields.bilingualStyle.value = normalizeBilingualStyle(saved.bilingualStyle);
  syncBilingualStyleCards();
  fields.clearPrevious.checked = saved.clearPrevious;
  fields.viewportFirst.checked = saved.viewportFirst;
  fields.showFloatingButton.checked = saved.showFloatingButton;
  fields.translateSelection.checked = saved.translateSelection;
  fields.translateSubtitles.checked = saved.translateSubtitles === true;
  if (PIT_BROWSER_TARGET === "safari") {
    fields.translateSubtitles.closest(".switch-row").hidden = true;
  }
  fields.batchSize.value = normalizeBatchItems(saved.batchSize);
  fields.batchCharLimit.value = normalizeBatchCharLimit(saved.batchCharLimit);
  fields.ttsRate.value = String(normalizeTtsRate(saved.ttsRate));
  updateTranslateSubtitle();
  fields.autoTranslateAllPages.checked = saved.autoTranslateAllPages === true;
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

  [fields.customTargetLanguage, fields.endpoint, fields.pairingToken, fields.mode, fields.bilingualStyle, fields.clearPrevious, fields.viewportFirst, fields.showFloatingButton, fields.translateSelection, fields.translateSubtitles, fields.batchSize, fields.batchCharLimit, fields.ttsRate].forEach((field) => {
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
      if (field === fields.endpoint || field === fields.pairingToken) {
        window.clearTimeout(healthCheckTimer);
        healthCheckTimer = window.setTimeout(checkHealth, 250);
      }
    });
    field.addEventListener("input", () => {
      if (field === fields.customTargetLanguage) {
        updateTranslateSubtitle();
      }
      saveSettings();
    });
  });

  fields.showFloatingButton.addEventListener("change", syncFloatingButton);
  fields.autoTranslateAllPages.addEventListener("change", syncAutoTranslateAllPages);

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

async function syncAutoTranslateAllPages() {
  await saveSettings();
  setStatus(
    fields.autoTranslateAllPages.checked
      ? "Auto-translate enabled for all websites."
      : "Auto-translate disabled."
  );
}

async function checkHealth() {
  if (healthCheckInFlight) {
    return healthCheckInFlight;
  }
  healthCheckInFlight = performHealthCheck().finally(() => {
    healthCheckInFlight = null;
  });
  return healthCheckInFlight;
}

async function performHealthCheck() {
  const endpoint = normalizeEndpoint(fields.endpoint.value);
  const pairingToken = normalizePairingToken(fields.pairingToken.value);
  if (!pairingToken) {
    fields.health.dataset.ok = "false";
    fields.health.textContent = "Pairing";
    fields.serverPanel.dataset.ok = "false";
    fields.serverState.textContent = "Pair with Gloss";
    fields.latency.textContent = "--";
    fields.offlineHelp.hidden = false;
    fields.translate.disabled = true;
    showPairingPanel();
    return;
  }
  try {
    const response = await fetchWithTimeout(`${endpoint}/health`, {
      headers: {
        "X-Gloss-Token": pairingToken,
        "X-PIT-Token": pairingToken
      }
    }, PIT_HEALTH_TIMEOUT_MS);
    const body = await response.json();
    if (!response.ok) {
      const pairingRequired = response.status === 401;
      fields.health.dataset.ok = "false";
      fields.health.textContent = pairingRequired ? "Pairing" : "Error";
      fields.serverPanel.dataset.ok = "false";
      fields.serverState.textContent = pairingRequired ? "Pair with Gloss" : "Gloss error";
      fields.latency.textContent = "--";
      fields.offlineHelp.hidden = !pairingRequired;
      fields.translate.disabled = true;
      if (pairingRequired) {
        showPairingPanel();
      }
      return;
    }
    const ready = body.ok !== false;

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
    fields.serverState.textContent = "Gloss unavailable";
    fields.latency.textContent = "--";
    fields.offlineHelp.hidden = false;
    fields.translate.disabled = true;
  }
}

function showPairingPanel() {
  if (fields.overflow.hidden) {
    fields.overflow.hidden = false;
    fields.kebab.setAttribute("aria-expanded", "true");
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
      options: readPageSettings()
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
    endpoint: normalizeEndpoint(fields.endpoint.value),
    pairingToken: normalizePairingToken(fields.pairingToken.value),
    mode: fields.mode.value,
    bilingualStyle: normalizeBilingualStyle(fields.bilingualStyle.value),
    clearPrevious: fields.clearPrevious.checked,
    viewportFirst: fields.viewportFirst.checked,
    showFloatingButton: fields.showFloatingButton.checked,
    translateSelection: fields.translateSelection.checked,
    translateSubtitles: fields.translateSubtitles.checked,
    autoTranslateAllPages: fields.autoTranslateAllPages.checked,
    batchSize: normalizeBatchItems(fields.batchSize.value),
    batchCharLimit: normalizeBatchCharLimit(fields.batchCharLimit.value),
    ttsRate: normalizeTtsRate(fields.ttsRate.value),
    minChars: 4
  };
}

function readPageSettings() {
  const { pairingToken: _pairingToken, ...settings } = readSettings();
  return settings;
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

    const contentScripts = chrome.runtime.getManifest().content_scripts || [];
    const mainFiles = contentScripts.find((entry) => entry.world === "MAIN")?.js || [];
    const isolatedFiles = contentScripts.find((entry) => entry.world !== "MAIN")?.js || [];
    if (mainFiles.length > 0) {
      await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: mainFiles });
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: isolatedFiles });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function copyStartCommand() {
  await navigator.clipboard.writeText(PAIRING_STEPS);
  setStatus("Pairing steps copied.");
}

function serverLabel(body) {
  if (body.name === "Gloss") {
    return "Gloss · Codex ready";
  }
  if (body.warm === false) {
    return `${prettyModelLabel(body.model, "Codex bridge")} warming`;
  }
  return prettyModelLabel(body.model, "Codex bridge");
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
    return "Gloss is unreachable. Open it and allow Chrome Local Network Access.";
  }
  if (text.includes("pairing") || text.includes("Unauthorized")) {
    return "Pair this extension from Gloss Settings.";
  }
  if (text.includes("Cannot access") || text.includes("chrome://")) {
    return "Chrome does not allow translating this page.";
  }
  if (text.includes("returned") && text.includes("translations")) {
    return "The model returned a mismatched batch. Please try again.";
  }
  return text;
}

function setStatus(text, isError = false) {
  fields.status.textContent = text;
  fields.status.dataset.error = String(isError);
}
