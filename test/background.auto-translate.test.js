const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BACKGROUND_PATH = path.join(__dirname, "..", "extension", "background.js");
const AUTO_TRANSLATE_SETTINGS = {
  autoTranslateAllPages: true,
  targetLanguage: "Chinese (Simplified)",
  endpoint: "http://127.0.0.1:8787",
  mode: "bilingual",
  bilingualStyle: "dashed",
  clearPrevious: true,
  viewportFirst: true,
  showFloatingButton: true,
  translateSelection: true
};

test("global auto-translate keeps one job per navigation and drops a stale refresh retry", async () => {
  const runtime = createBackgroundRuntime();
  const url = "https://example.com/article";

  runtime.updated(1, { status: "loading" }, { url });
  runtime.updated(1, { status: "complete" }, { url });
  await flushTasks();
  await runtime.runNextTimer();
  assert.equal(runtime.sentMessages.length, 1);
  assert.equal(runtime.sentMessages[0].message.options.autoTranslate, true);

  runtime.updated(1, { status: "complete" }, { url });
  assert.equal(runtime.timerCount(), 0, "a running job must not be scheduled again");

  runtime.updated(1, { status: "loading" }, { url });
  runtime.updated(1, { status: "complete" }, { url });
  await flushTasks();
  runtime.rejectSend(0, new Error("old document unloaded"));
  await flushTasks();

  await runtime.runNextTimer();
  assert.equal(runtime.sentMessages.length, 2, "only the new navigation may reach the page");
  runtime.resolveSend(1, { ok: true });

  await runtime.runAllTimers();
  assert.equal(runtime.sentMessages.length, 2, "the stale navigation must not retry into the refreshed page");
});

test("global auto-translate schedules every website but skips browser pages", async () => {
  const runtime = createBackgroundRuntime();
  const firstUrl = "https://example.com/article";
  const secondUrl = "https://another.example/guide";

  runtime.updated(1, { status: "complete" }, { url: firstUrl });
  runtime.updated(2, { status: "complete" }, { url: secondUrl });
  runtime.updated(3, { status: "complete" }, { url: "chrome://settings" });
  await flushTasks();

  assert.equal(runtime.timerCount(), 2);
  await runtime.runNextTimer();
  await runtime.runNextTimer();
  assert.deepEqual(
    runtime.sentMessages.map(({ tabId }) => tabId).sort(),
    [1, 2]
  );
});

test("global auto-translate stays off when only a legacy site preference exists", async () => {
  const runtime = createBackgroundRuntime({
    ...AUTO_TRANSLATE_SETTINGS,
    autoTranslateAllPages: false,
    autoTranslateSites: { "example.com": true }
  });

  runtime.updated(1, { status: "complete" }, { url: "https://example.com/article" });
  await flushTasks();
  assert.equal(runtime.timerCount(), 0);
});

test("cancelling a translation aborts the active fetch and forwards the request id", async () => {
  const runtime = createBackgroundRuntime();
  const translating = runtime.message({
    type: "translate-batch",
    requestId: "browser-request-1",
    endpoint: AUTO_TRANSLATE_SETTINGS.endpoint,
    targetLanguage: AUTO_TRANSLATE_SETTINGS.targetLanguage,
    priority: "background",
    items: [{ id: "one", text: "Long local translation" }]
  });
  await flushTasks();

  const cancellation = await runtime.message({
    type: "cancel-translation",
    requestIds: ["browser-request-1"],
    endpoint: AUTO_TRANSLATE_SETTINGS.endpoint
  });
  const translation = await translating;

  assert.equal(cancellation.ok, true);
  assert.equal(cancellation.cancelled, 1);
  assert.equal(cancellation.forwarded, true, JSON.stringify(cancellation));
  assert.equal(translation.ok, false);
  assert.match(translation.error, /cancelled/i);
  assert.deepEqual(runtime.forwardedCancels, [["browser-request-1"]]);
});

function createBackgroundRuntime(settings = AUTO_TRANSLATE_SETTINGS) {
  const listeners = {};
  const timers = new Map();
  const sentMessages = [];
  const pendingSends = [];
  const forwardedCancels = [];
  let nextTimerId = 1;

  const context = vm.createContext({
    console,
    Promise,
    AbortController,
    DOMException,
    TextDecoder,
    URL,
    clearTimeout(id) {
      timers.delete(id);
    },
    importScripts() {},
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    fetch(_url, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
    chrome: {
      runtime: {
        onMessage: eventListener("runtimeMessage")
      },
      storage: {
        local: {
          get: async () => settings
        }
      },
      tabs: {
        get: async () => ({ url: "https://example.com/article" }),
        onRemoved: eventListener("removed"),
        onUpdated: eventListener("updated"),
        sendMessage(tabId, message) {
          sentMessages.push({ tabId, message });
          return new Promise((resolve, reject) => pendingSends.push({ resolve, reject }));
        }
      }
    },
    normalizeBilingualStyle(value) {
      return value;
    },
    normalizeEndpoint(value) {
      return value;
    },
    normalizePairingToken(value) {
      return String(value || "").trim();
    },
    normalizeTargetLanguage(value) {
      return value;
    },
    normalizeTranslationPriority(value) {
      return value;
    },
    fetchWithTimeout: async (_url, options) => {
      forwardedCancels.push(JSON.parse(options.body).requestIds);
      return { ok: true };
    },
    hostFromUrl(value) {
      return new URL(value).hostname;
    },
    PIT_DEFAULT_BATCH_CHAR_LIMIT: 10000,
    PIT_DEFAULT_BILINGUAL_STYLE: "dashed",
    PIT_DEFAULT_ENDPOINT: "http://127.0.0.1:8787",
    PIT_DEFAULT_PAIRING_TOKEN: "test-token",
    PIT_DEFAULT_TARGET_LANGUAGE: "Chinese (Simplified)",
    PIT_BROWSER_TARGET: "chrome",
    PIT_HEALTH_TIMEOUT_MS: 5000,
    PIT_MAX_BATCH_ITEMS: 40,
    PIT_TOKEN: "test-token"
  });

  function eventListener(name) {
    return {
      addListener(listener) {
        listeners[name] = listener;
      }
    };
  }

  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, "utf8"), context, { filename: BACKGROUND_PATH });

  return {
    forwardedCancels,
    sentMessages,
    message(message) {
      return new Promise((resolve) => {
        const handled = listeners.runtimeMessage(message, { tab: { id: 1 } }, resolve);
        assert.equal(handled, true);
      });
    },
    updated: listeners.updated,
    rejectSend(index, error) {
      pendingSends[index].reject(error);
    },
    resolveSend(index, response) {
      pendingSends[index].resolve(response);
    },
    timerCount() {
      return timers.size;
    },
    async runNextTimer() {
      const [id, callback] = timers.entries().next().value || [];
      assert.notEqual(id, undefined, "expected a pending timer");
      timers.delete(id);
      callback();
      await flushTasks();
    },
    async runAllTimers() {
      while (timers.size > 0) {
        await this.runNextTimer();
      }
      await flushTasks();
    }
  };
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}
