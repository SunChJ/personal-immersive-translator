importScripts("shared.js");

const TRANSLATE_TIMEOUT_MS = 135000;
const AUTO_TRANSLATE_DELAY_MS = 700;

const autoTranslateTimers = new Map();
const autoTranslateUrls = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["translate-batch", "check-health"].includes(message.type)) {
    return false;
  }

  const task = message.type === "translate-batch" ? translateBatch(message) : checkHealth(message);
  task
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    clearAutoTranslateTimer(tabId);
    autoTranslateUrls.delete(tabId);
    return;
  }

  if (changeInfo.status !== "complete") {
    return;
  }

  scheduleAutoTranslate(tabId, tab.url || "");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearAutoTranslateTimer(tabId);
  autoTranslateUrls.delete(tabId);
});

async function translateBatch(message) {
  const endpoint = normalizeEndpoint(message.endpoint);
  const response = await fetchWithTimeout(`${endpoint}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PIT-Token": PIT_TOKEN
    },
    body: JSON.stringify({
      items: message.items,
      texts: message.texts,
      targetLanguage: message.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE,
      sourceUrl: message.sourceUrl || ""
    })
  }, TRANSLATE_TIMEOUT_MS);

  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`Local proxy returned non-JSON response: ${bodyText.slice(0, 180)}`);
  }

  if (!response.ok) {
    throw new Error(body.error || `Local proxy failed with HTTP ${response.status}`);
  }

  if (!Array.isArray(body.translations)) {
    throw new Error("Local proxy response did not contain a translations array.");
  }

  return { translations: body.translations };
}

async function checkHealth(message) {
  const endpoint = normalizeEndpoint(message.endpoint);
  const response = await fetchWithTimeout(`${endpoint}/health`, {
    headers: {
      "X-PIT-Token": PIT_TOKEN
    }
  }, PIT_HEALTH_TIMEOUT_MS);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Local proxy failed with HTTP ${response.status}`);
  }
  return { health: body };
}

async function scheduleAutoTranslate(tabId, url) {
  const host = hostFromUrl(url);
  if (!host) {
    return;
  }

  const settings = await chrome.storage.local.get(defaultTranslationSettings());
  if (!settings.autoTranslateSites?.[host]) {
    return;
  }

  if (autoTranslateUrls.get(tabId) === url) {
    return;
  }

  clearAutoTranslateTimer(tabId);
  const timer = setTimeout(async () => {
    autoTranslateTimers.delete(tabId);
    try {
      await sendAutoTranslateMessage(tabId, url, settings);
      autoTranslateUrls.set(tabId, url);
    } catch {
      // Restricted pages and sleeping content scripts should not surface noisy errors.
    }
  }, AUTO_TRANSLATE_DELAY_MS);
  autoTranslateTimers.set(tabId, timer);
}

async function sendAutoTranslateMessage(tabId, url, settings) {
  const options = {
    targetLanguage: normalizeTargetLanguage(settings.targetLanguage),
    endpoint: normalizeEndpoint(settings.endpoint),
    mode: settings.mode || "bilingual",
    bilingualStyle: normalizeBilingualStyle(settings.bilingualStyle),
    clearPrevious: settings.clearPrevious !== false,
    viewportFirst: settings.viewportFirst !== false,
    showFloatingButton: settings.showFloatingButton !== false,
    translateSelection: settings.translateSelection !== false,
    batchSize: PIT_MAX_BATCH_ITEMS,
    batchCharLimit: PIT_DEFAULT_BATCH_CHAR_LIMIT,
    minChars: 4
  };

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "start-page-translation",
        options
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Auto translation failed.");
      }
      return response;
    } catch (error) {
      lastError = error;
      await wait(400 + attempt * 400);
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.url !== url) {
        throw new Error("Tab navigated before auto translation started.");
      }
    }
  }

  throw lastError;
}

function clearAutoTranslateTimer(tabId) {
  const timer = autoTranslateTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    autoTranslateTimers.delete(tabId);
  }
}

function defaultTranslationSettings() {
  return {
    targetLanguage: PIT_DEFAULT_TARGET_LANGUAGE,
    endpoint: PIT_DEFAULT_ENDPOINT,
    mode: "bilingual",
    bilingualStyle: PIT_DEFAULT_BILINGUAL_STYLE,
    clearPrevious: true,
    viewportFirst: true,
    showFloatingButton: true,
    translateSelection: true,
    autoTranslateSites: {}
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
