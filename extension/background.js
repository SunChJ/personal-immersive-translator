importScripts("gloss-config.js", "shared.js");

const TRANSLATE_TIMEOUT_MS = 135000;
const AUTO_TRANSLATE_DELAY_MS = 700;

const autoTranslateTimers = new Map();
const autoTranslateJobs = new Map();
const autoTranslateGenerations = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["translate-batch", "check-health"].includes(message.type)) {
    return false;
  }

  const task = message.type === "translate-batch" ? translateBatch(message, sender) : checkHealth(message);
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
    invalidateAutoTranslate(tabId);
    return;
  }

  if (changeInfo.status !== "complete") {
    return;
  }

  scheduleAutoTranslate(tabId, tab.url || "");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  invalidateAutoTranslate(tabId);
  autoTranslateGenerations.delete(tabId);
});

async function translateBatch(message, sender = {}) {
  const endpoint = normalizeEndpoint(message.endpoint);
  const pairingToken = await readPairingToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  const startedAt = Date.now();
  let firstRendered = false;
  const translations = [];

  try {
    const response = await fetch(`${endpoint}/translate/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(pairingToken)
      },
      body: JSON.stringify({
        items: message.items,
        texts: message.texts,
        targetLanguage: message.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE,
        priority: normalizeTranslationPriority(message.priority),
        sourceUrl: message.sourceUrl || "",
        requestId: message.requestId || ""
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const bodyText = await response.text();
      let body = {};
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        throw new Error(`Local proxy returned non-JSON response: ${bodyText.slice(0, 180)}`);
      }
      throw new Error(body.error || `Local proxy failed with HTTP ${response.status}`);
    }

    await readTranslationStream(response, async (event) => {
      if (event.type === "error") {
        throw new Error(event.error || "Translation stream failed.");
      }
      if (event.type !== "translation" || !event.id || typeof event.text !== "string") {
        return;
      }

      const translation = { id: event.id, text: event.text };
      translations.push(translation);
      const rendered = await sendTranslationProgress(sender, message.requestId, translation);
      if (rendered && !firstRendered) {
        firstRendered = true;
        await reportRenderMetric(
          endpoint,
          pairingToken,
          message.requestId,
          Date.now() - startedAt
        );
      }
    });
    return { translations };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Local proxy request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readTranslationStream(response, onEvent) {
  if (!response.body?.getReader) {
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (line.trim()) await onEvent(JSON.parse(line));
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) await onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) await onEvent(JSON.parse(buffer));
}

async function sendTranslationProgress(sender, requestId, translation) {
  if (!requestId || !Number.isInteger(sender?.tab?.id) || !chrome.tabs?.sendMessage) {
    return false;
  }
  try {
    const options = Number.isInteger(sender.frameId) ? { frameId: sender.frameId } : undefined;
    const response = options
      ? await chrome.tabs.sendMessage(sender.tab.id, {
        type: "translation-progress",
        requestId,
        translation
      }, options)
      : await chrome.tabs.sendMessage(sender.tab.id, {
        type: "translation-progress",
        requestId,
        translation
      });
    return response?.rendered === true;
  } catch {
    return false;
  }
}

async function reportRenderMetric(endpoint, pairingToken, requestId, durationMs) {
  if (!requestId) return;
  try {
    await fetchWithTimeout(`${endpoint}/metrics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(pairingToken)
      },
      body: JSON.stringify({
        event: "item_rendered",
        requestId,
        durationMs
      })
    }, PIT_HEALTH_TIMEOUT_MS);
  } catch {
    // Metrics must never delay or fail translation.
  }
}

async function checkHealth(message) {
  const endpoint = normalizeEndpoint(message.endpoint);
  const pairingToken = await readPairingToken();
  const response = await fetchWithTimeout(`${endpoint}/health`, {
    headers: authHeaders(pairingToken)
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

  const generation = autoTranslateGenerations.get(tabId) || 0;
  const existingJob = autoTranslateJobs.get(tabId);
  if (existingJob?.url === url && existingJob.generation === generation) {
    return;
  }

  clearAutoTranslateTimer(tabId);
  const job = { generation, url };
  autoTranslateJobs.set(tabId, job);
  const timer = setTimeout(async () => {
    autoTranslateTimers.delete(tabId);
    if (!isCurrentAutoTranslateJob(tabId, job)) {
      return;
    }

    try {
      await sendAutoTranslateMessage(tabId, url, settings, job);
    } catch {
      if (isCurrentAutoTranslateJob(tabId, job)) {
        autoTranslateJobs.delete(tabId);
      }
      // Restricted pages and sleeping content scripts should not surface noisy errors.
    }
  }, AUTO_TRANSLATE_DELAY_MS);
  autoTranslateTimers.set(tabId, timer);
}

async function sendAutoTranslateMessage(tabId, url, settings, job) {
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
    if (!isCurrentAutoTranslateJob(tabId, job)) {
      throw new Error("Auto translation was superseded by navigation.");
    }

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
      if (!isCurrentAutoTranslateJob(tabId, job)) {
        throw new Error("Auto translation was superseded by navigation.");
      }
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

function invalidateAutoTranslate(tabId) {
  clearAutoTranslateTimer(tabId);
  autoTranslateJobs.delete(tabId);
  autoTranslateGenerations.set(tabId, (autoTranslateGenerations.get(tabId) || 0) + 1);
}

function isCurrentAutoTranslateJob(tabId, job) {
  return autoTranslateJobs.get(tabId) === job;
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

async function readPairingToken() {
  if (PIT_DEFAULT_PAIRING_TOKEN) {
    return PIT_DEFAULT_PAIRING_TOKEN;
  }
  const settings = await chrome.storage.local.get({
    pairingToken: PIT_DEFAULT_PAIRING_TOKEN
  });
  const storedToken = normalizePairingToken(settings.pairingToken);
  if (storedToken || PIT_BROWSER_TARGET !== "safari" || !chrome.runtime.sendNativeMessage) {
    return storedToken;
  }

  try {
    const response = await chrome.runtime.sendNativeMessage("com.samsoncj.gloss", {
      type: "pairing-token"
    });
    const nativeToken = normalizePairingToken(response?.pairingToken);
    if (nativeToken) {
      await chrome.storage.local.set({ pairingToken: nativeToken });
    }
    return nativeToken;
  } catch {
    return "";
  }
}

function authHeaders(pairingToken) {
  if (!pairingToken) {
    return {};
  }
  return {
    "X-Gloss-Token": pairingToken,
    "X-PIT-Token": pairingToken
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
