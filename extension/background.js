const DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";
const DEFAULT_BILINGUAL_STYLE = "dashed";
const PIT_TOKEN = "pit-local-extension-token-v1";
const HEALTH_TIMEOUT_MS = 5000;
const TRANSLATE_TIMEOUT_MS = 135000;
const AUTO_TRANSLATE_DELAY_MS = 700;
const BILINGUAL_STYLES = new Set(["dashed", "dotted", "wavy", "highlight", "soft-box", "blur"]);

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
  const endpoint = normalizeEndpoint(message.endpoint || "http://127.0.0.1:8787");
  const response = await fetchWithTimeout(`${endpoint}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PIT-Token": PIT_TOKEN
    },
    body: JSON.stringify({
      items: message.items,
      texts: message.texts,
      targetLanguage: message.targetLanguage || DEFAULT_TARGET_LANGUAGE,
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
  const endpoint = normalizeEndpoint(message.endpoint || "http://127.0.0.1:8787");
  const response = await fetchWithTimeout(`${endpoint}/health`, {
    headers: {
      "X-PIT-Token": PIT_TOKEN
    }
  }, HEALTH_TIMEOUT_MS);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Local proxy failed with HTTP ${response.status}`);
  }
  return { health: body };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Local proxy request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "");
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
    endpoint: normalizeEndpoint(settings.endpoint || "http://127.0.0.1:8787"),
    mode: settings.mode || "bilingual",
    bilingualStyle: normalizeBilingualStyle(settings.bilingualStyle),
    clearPrevious: settings.clearPrevious !== false,
    viewportFirst: settings.viewportFirst !== false,
    showFloatingButton: settings.showFloatingButton !== false,
    translateSelection: settings.translateSelection !== false,
    batchSize: 24,
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
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    endpoint: "http://127.0.0.1:8787",
    mode: "bilingual",
    bilingualStyle: DEFAULT_BILINGUAL_STYLE,
    clearPrevious: true,
    viewportFirst: true,
    showFloatingButton: true,
    translateSelection: true,
    autoTranslateSites: {}
  };
}

function normalizeTargetLanguage(value) {
  const language = String(value || "").trim();
  return language || DEFAULT_TARGET_LANGUAGE;
}

function normalizeBilingualStyle(value) {
  return BILINGUAL_STYLES.has(value) ? value : DEFAULT_BILINGUAL_STYLE;
}

function hostFromUrl(url) {
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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
