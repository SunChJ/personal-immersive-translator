const START_COMMAND = [
  "cd /Users/samsoncj/develop/codex-playground/personal-immersive-translator",
  "export TRANSLATOR_BACKEND=codex-app",
  "export CODEX_MODEL=gpt-5.3-codex-spark",
  "npm start"
].join("\n");

const fields = {
  targetLanguage: document.getElementById("targetLanguage"),
  endpoint: document.getElementById("endpoint"),
  mode: document.getElementById("mode"),
  clearPrevious: document.getElementById("clearPrevious"),
  viewportFirst: document.getElementById("viewportFirst"),
  showFloatingButton: document.getElementById("showFloatingButton"),
  translate: document.getElementById("translate"),
  clear: document.getElementById("clear"),
  recheck: document.getElementById("recheck"),
  copyCommand: document.getElementById("copyCommand"),
  status: document.getElementById("status"),
  health: document.getElementById("health"),
  latency: document.getElementById("latency"),
  offlineHelp: document.getElementById("offlineHelp"),
  serverState: document.getElementById("serverState")
};

init();

async function init() {
  const saved = await chrome.storage.local.get({
    targetLanguage: "中文",
    endpoint: "http://127.0.0.1:8787",
    mode: "bilingual",
    clearPrevious: true,
    viewportFirst: true,
    showFloatingButton: true
  });

  fields.targetLanguage.value = saved.targetLanguage;
  fields.endpoint.value = saved.endpoint;
  fields.mode.value = saved.mode;
  fields.clearPrevious.checked = saved.clearPrevious;
  fields.viewportFirst.checked = saved.viewportFirst;
  fields.showFloatingButton.checked = saved.showFloatingButton;

  fields.translate.addEventListener("click", translateCurrentTab);
  fields.clear.addEventListener("click", clearCurrentTab);
  fields.recheck.addEventListener("click", checkHealth);
  fields.copyCommand.addEventListener("click", copyStartCommand);

  [fields.targetLanguage, fields.endpoint, fields.mode, fields.clearPrevious, fields.viewportFirst, fields.showFloatingButton].forEach((field) => {
    field.addEventListener("change", saveSettings);
    field.addEventListener("input", saveSettings);
  });

  fields.showFloatingButton.addEventListener("change", syncFloatingButton);

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

async function checkHealth() {
  const endpoint = normalizeEndpoint(fields.endpoint.value);
  try {
    const response = await fetch(`${endpoint}/health`);
    const body = await response.json();
    const ready = response.ok && body.ok !== false;

    fields.health.dataset.ok = String(ready);
    fields.health.textContent = ready ? "Ready" : "Error";
    fields.serverState.textContent = serverLabel(body);
    fields.latency.textContent = body.lastLatencyMs ? `${body.lastLatencyMs}ms` : body.warm === false ? "warming" : "--";
    fields.offlineHelp.hidden = true;
    fields.translate.disabled = !ready;
  } catch {
    fields.health.dataset.ok = "false";
    fields.health.textContent = "Offline";
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
    targetLanguage: fields.targetLanguage.value.trim() || "中文",
    endpoint: normalizeEndpoint(fields.endpoint.value.trim() || "http://127.0.0.1:8787"),
    mode: fields.mode.value,
    clearPrevious: fields.clearPrevious.checked,
    viewportFirst: fields.viewportFirst.checked,
    showFloatingButton: fields.showFloatingButton.checked,
    batchSize: 24,
    minChars: 4
  };
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
  const backend = body.backend || "proxy";
  const model = body.model || "model";
  if (body.warm === false) {
    return `${backend} warming`;
  }
  return `${backend} / ${model}`;
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

function setStatus(text, isError = false) {
  fields.status.textContent = text;
  fields.status.dataset.error = String(isError);
}
