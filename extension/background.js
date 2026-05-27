chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "translate-batch") {
    return false;
  }

  translateBatch(message)
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
  const response = await fetch(`${endpoint}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      items: message.items,
      texts: message.texts,
      targetLanguage: message.targetLanguage || "中文",
      sourceUrl: message.sourceUrl || ""
    })
  });

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

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "");
}
