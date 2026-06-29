const DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";
const PIT_TOKEN = "pit-local-extension-token-v1";
const HEALTH_TIMEOUT_MS = 5000;
const TRANSLATE_TIMEOUT_MS = 135000;

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
