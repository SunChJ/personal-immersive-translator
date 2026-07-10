// Entry point: registers the message listener and boots page UI. Must load last —
// every function it calls is defined in the content-*.js files loaded before it.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "clear-page-translation") {
    clearTranslations();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "set-floating-visibility") {
    setFloatingVisible(Boolean(message.visible));
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== "start-page-translation") {
    return false;
  }

  translatePage(message.options || {})
    .then((summary) => sendResponse({ ok: true, summary }))
    .catch((error) => {
      setFloatingStatus("Failed");
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

initFloatingControl();
initSelectionTranslation();

