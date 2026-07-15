const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT, ".output", "chrome-mv3");
const MANIFEST_PATH = path.join(EXTENSION_DIR, "manifest.json");
const CHROME = findChrome();
const ACTIVE_CHROME_PIDS = new Set();
const ACTIVE_TEMP_DIRS = new Set();
let browserSuitePromise;

installBrowserCleanupHandlers();

test("adaptive batching uses a 6-item first batch and 8-item tail batches", async () => {
  const result = await getBrowserSuiteResult("adaptive-batches");
  assert.deepEqual(result.batchSizes, [6, 8, 8, 8, 8, 7]);
});

test("long-page tail reserves one native turn for foreground work", async () => {
  const result = await getBrowserSuiteResult("bounded-tail-concurrency");
  assert.equal(result.batchSizes[0], 6);
  assert.equal(result.batchSizes.at(-1), 2);
  assert.ok(result.batchSizes.slice(1, -1).every((size) => size === 8));
  assert.equal(result.batchSizes.reduce((sum, size) => sum + size, 0), 128);
  assert.equal(result.maxActive, 2);
});

test("first visible batch pipelines the tail without waiting for completion", async () => {
  const result = await getBrowserSuiteResult("pipelined-tail");
  assert.equal(result.tailStartedBeforeFirstResolved, true);
  assert.deepEqual(result.batchSizes, [6, 8, 8, 8, 8, 7]);
});

test("duplicate source text is translated into every DOM owner", async () => {
  const result = await getBrowserSuiteResult("duplicate-fanout");
  assert.equal(result.requestItems, 2);
  assert.equal(result.readySlots, 2);
  assert.deepEqual(result.slotParents, ["duplicate-a", "duplicate-b"]);
  assert.deepEqual(result.translations, [
    "translated:Repeated source paragraph.",
    "translated:Repeated source paragraph."
  ]);
});

test("Hacker News title rows are not mistaken for navigation", async () => {
  const result = await getBrowserSuiteResult("hacker-news-titles");
  assert.equal(result.requestItems, 17);
  assert.equal(result.readySlots, 17);
  assert.equal(result.untranslatedTitles, 0);
});

test("a partial batch failure keeps successful items rendered", async () => {
  const result = await getBrowserSuiteResult("partial-batch-failure");
  assert.equal(result.readySlots, 1);
  assert.equal(result.failedSlots, 1);
  assert.equal(result.successText, "translated:This item should remain translated.");
});

test("semantic elements receive span translations inside their owner", async () => {
  const result = await getBrowserSuiteResult("semantic-inside");
  assert.deepEqual(result, {
    heading: { inside: true, tag: "SPAN" },
    paragraph: { inside: true, tag: "SPAN" },
    quote: { inside: true, tag: "SPAN" },
    summary: { inside: true, tag: "SPAN" }
  });
});

test("bilingual translations keep their source font size", async () => {
  const result = await getBrowserSuiteResult("font-size-inheritance");
  assert.deepEqual(result, {
    heading: { source: "53px", translation: "53px" },
    paragraph: { source: "19px", translation: "19px" }
  });
});

test("replace mode preserves original nodes and clear restores them", async () => {
  const result = await getBrowserSuiteResult("replace-restore");
  assert.equal(result.connectedDuringReplace, true);
  assert.equal(result.hiddenDuringReplace, true);
  assert.equal(result.sameLinkAfterClear, true);
  assert.equal(result.sameTextNodeAfterClear, true);
  assert.equal(result.translationCountAfterClear, 0);
  assert.equal(result.originalTextAfterClear, "Read the durable link before continuing.");
  assert.equal(result.listenerCalls, 1);
});

test("clearing while a response is delayed prevents stale injection", async () => {
  const result = await getBrowserSuiteResult("delayed-cancel");
  assert.equal(result.cancelled, true);
  assert.equal(result.pendingText, "");
  assert.equal(result.pendingAriaLabel, "Translation loading");
  assert.equal(result.pendingSpinnerCount, 1);
  assert.equal(result.readySlots, 0);
  assert.equal(result.pendingSlots, 0);
  assert.equal(result.translatedFlag, "false");
});

test("dynamic backlog drains all 80 discovered blocks", { timeout: 20000 }, async () => {
  const result = await getBrowserSuiteResult("dynamic-80");
  assert.equal(result.readySlots, 80);
  assert.equal(result.batchSizes[0], 6);
  assert.equal(result.batchSizes.at(-1), 2);
  assert.ok(result.batchSizes.slice(1, -1).every((size) => size === 8));
  assert.equal(result.batchSizes.reduce((sum, size) => sum + size, 0), 80);
  assert.equal(result.queueSize, 0);
  assert.equal(result.running, false);
});

test("upward scrolling shows pending slots before the initial batch completes", async () => {
  const result = await getBrowserSuiteResult("upward-pending");
  assert.equal(result.upwardPending, true);
  assert.equal(result.topReady, true);
});

test("pending work deduplicates entries and applies cached translations", async () => {
  const result = await getBrowserSuiteResult("pending-cache");
  assert.equal(result.backendCalls, 1);
  assert.equal(result.readySlots, 2);
  assert.equal(result.pendingQueueSize, 0);
});

test("pending Set prevents the same block from entering a batch twice", async () => {
  const result = await getBrowserSuiteResult("pending-set-dedupe");
  assert.equal(result.queuedEntries, 1);
  assert.equal(result.backendCalls, 1);
  assert.equal(result.readySlots, 1);
});

test("background drains remain capped below the interactive reserve", async () => {
  const result = await getBrowserSuiteResult("pending-overlap");
  assert.deepEqual(result.batchSizes, [1, 1, 1, 1]);
  assert.equal(result.maxActive, 2);
  assert.equal(result.pendingQueueSize, 0);
  assert.equal(result.readySlots, 4);
});

test("small background updates use a bounded trailing merge window", async () => {
  const result = await getBrowserSuiteResult("trailing-background-batch");
  assert.deepEqual(result.batchSizes, [3]);
  assert.ok(result.requestDelayMs >= 750);
  assert.ok(result.requestDelayMs < 1_350);
});

test("character budgets are soft for one oversized item", async () => {
  const result = await getBrowserSuiteResult("character-budget");
  assert.deepEqual(result.normalChars, [600, 600]);
  assert.deepEqual(result.oversizedChars, [1200, 100]);
});

test("new visible pending work is taken before older work at the same priority", async () => {
  const result = await getBrowserSuiteResult("newest-pending-first");
  assert.deepEqual(result.order, ["pending-new", "pending-old"]);
});

test("one pending batch keeps visible reading order", async () => {
  const result = await getBrowserSuiteResult("pending-batch-order");
  assert.deepEqual(result.order, ["pending-top", "pending-middle", "pending-bottom"]);
});

test("floating global auto-translate starts the current page immediately", async () => {
  const result = await getBrowserSuiteResult("floating-auto-translate");
  assert.equal(result.topLevelControl, true);
  assert.equal(result.enabledGlobally, true);
  assert.deepEqual(result.runningState, { mode: "running", badge: "WORKING", label: "Translating" });
  assert.deepEqual(result.completeState, { mode: "translated", badge: "DONE", label: "Translated" });
  assert.equal(result.requestItems, 1);
  assert.equal(result.readySlots, 1);
  assert.equal(result.disabledStopsUpdates, true, JSON.stringify(result));
});

test("auto-translate waits for a client-rendered page body", async () => {
  const result = await getBrowserSuiteResult("auto-translate-late-content");
  assert.equal(result.initialTotal, 0);
  assert.equal(result.readySlots, 1);
});

test("SPA navigation cancels stale responses and translates the new route", async () => {
  const result = await getBrowserSuiteResult("spa-stale-response");
  assert.equal(result.cancelled, true);
  assert.equal(result.newRouteSlots, 1);
  assert.equal(result.newRouteText, "translated:New route content should be translated once.");
  assert.ok(result.batchSizes.length >= 2);
});

test("extension surfaces load shared and split scripts in a valid order", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const main = manifest.content_scripts.find((entry) => entry.world === "MAIN");
  const isolated = manifest.content_scripts.find((entry) => entry.world !== "MAIN");

  assert.deepEqual(main?.js, ["route-patch.js"]);
  assert.deepEqual(isolated?.js.slice(0, 2), ["gloss-config.js", "shared.js"]);
  assert.equal(isolated?.js.at(-1), "content.js");
  isolated.js.forEach((file) => {
    assert.equal(fs.existsSync(path.join(EXTENSION_DIR, file)), true, `${file} is missing`);
  });

  const popupHtml = fs.readFileSync(path.join(EXTENSION_DIR, "popup.html"), "utf8");
  assert.ok(popupHtml.indexOf('src="gloss-config.js"') < popupHtml.indexOf('src="shared.js"'));
  assert.ok(popupHtml.indexOf('src="shared.js"') < popupHtml.indexOf('src="popup.js"'));
  const background = fs.readFileSync(path.join(EXTENSION_DIR, "background.js"), "utf8");
  assert.match(background, /^importScripts\("gloss-config\.js", "shared\.js"\);/);
});

async function getBrowserSuiteResult(caseName) {
  if (!browserSuitePromise) {
    browserSuitePromise = runBrowserSuite();
  }
  const results = await browserSuitePromise;
  assert.ok(Object.hasOwn(results, caseName), `Browser suite did not return ${caseName}`);
  return results[caseName];
}

async function runBrowserSuite() {
  assert.ok(CHROME, "Google Chrome or Chromium is required. Set PIT_CHROME to its executable path.");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pit-content-test-"));
  ACTIVE_TEMP_DIRS.add(tempDir);
  const profileDir = path.join(tempDir, "chrome-profile");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const routeFiles = manifest.content_scripts.find((entry) => entry.world === "MAIN")?.js || [];
  const contentFiles = manifest.content_scripts.find((entry) => entry.world !== "MAIN")?.js || [];
  const routeSources = routeFiles.map(readExtensionScript);
  const contentSources = contentFiles.map(readExtensionScript);
  const html = createHarnessHtml(routeSources, contentSources);
  let chrome = null;
  let server = null;

  try {
    const harness = createHarnessServer(html);
    server = harness.server;
    await listen(server);
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    let stderr = "";
    chrome = spawn(CHROME, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      `--user-data-dir=${profileDir}`,
      endpoint
    ], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    ACTIVE_CHROME_PIDS.add(chrome.pid);
    chrome.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    chrome.once("exit", (code, signal) => {
      ACTIVE_CHROME_PIDS.delete(chrome.pid);
      harness.reject(new Error(`Chrome exited before returning results (${code ?? signal}).\n${stderr}`));
    });

    const result = await withTimeout(harness.result, 30000, "Timed out waiting for Chrome batch results");
    assert.equal(result.ok, true, result.error || "Browser content suite failed");
    return result.value;
  } finally {
    await stopProcessGroup(chrome);
    await closeServer(server);
    fs.rmSync(tempDir, { force: true, recursive: true });
    ACTIVE_TEMP_DIRS.delete(tempDir);
  }
}

function createHarnessServer(html) {
  let settled = false;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const settle = (error, value) => {
    if (settled) {
      return;
    }
    settled = true;
    if (error) {
      rejectResult(error);
    } else {
      resolveResult(value);
    }
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && req.url === "/result") {
        const body = await readBody(req);
        settle(null, JSON.parse(body));
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      settle(error);
      res.writeHead(500);
      res.end();
    }
  });

  return { result, server, reject: (error) => settle(error) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  if (!server?.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("Browser test result is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function stopProcessGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalProcessGroup(child, "SIGTERM");
  await Promise.race([exited, wait(500)]);
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(child, "SIGKILL");
    await Promise.race([exited, wait(1000)]);
  }
  ACTIVE_CHROME_PIDS.delete(child.pid);
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The browser already exited.
    }
  }
}

function installBrowserCleanupHandlers() {
  process.once("exit", cleanupActiveBrowserResources);
  [["SIGINT", 130], ["SIGTERM", 143]].forEach(([signal, exitCode]) => {
    process.once(signal, () => {
      cleanupActiveBrowserResources();
      process.exit(exitCode);
    });
  });
}

function cleanupActiveBrowserResources() {
  ACTIVE_CHROME_PIDS.forEach((pid) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The isolated browser process group already exited.
      }
    }
  });
  ACTIVE_CHROME_PIDS.clear();
  ACTIVE_TEMP_DIRS.forEach((directory) => {
    try {
      fs.rmSync(directory, { force: true, recursive: true });
    } catch {
      // Process exit must not be delayed by temporary-profile cleanup errors.
    }
  });
  ACTIVE_TEMP_DIRS.clear();
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeout));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readExtensionScript(file) {
  return fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8").replace(/<\/script/gi, "<\\/script");
}

function scriptTags(sources) {
  return sources.map((source) => `<script>${source}</script>`).join("\n");
}

function createHarnessHtml(routeSources, contentSources) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>PIT content test</title>
  <style>
    body { width: 900px; margin: 20px; font: 16px/1.5 sans-serif; }
    p, h2, blockquote, summary { min-height: 24px; }
  </style>
</head>
<body>
  ${scriptTags(routeSources)}
  <script>
    window.__pitCalls = [];
    window.__pitDefaultSend = async (message) => ({
      ok: true,
      translations: message.items.map((item) => ({ id: item.id, text: "translated:" + item.text }))
    });
    window.__pitStorage = {
      showFloatingButton: false,
      translateSelection: false,
      autoTranslateAllPages: false
    };
    window.__pitRuntime = {
      listener: null,
      send: window.__pitDefaultSend
    };
    window.chrome = {
      runtime: {
        onMessage: {
          addListener(listener) { window.__pitRuntime.listener = listener; }
        },
        sendMessage(message) {
          window.__pitCalls.push(message);
          return window.__pitRuntime.send(message);
        }
      },
      storage: {
        local: {
          get(defaults, callback) {
            const values = Object.assign({}, defaults, window.__pitStorage);
            if (callback) {
              queueMicrotask(() => callback(values));
              return undefined;
            }
            return Promise.resolve(values);
          },
          set(values) {
            Object.assign(window.__pitStorage, values);
            return Promise.resolve();
          }
        },
        onChanged: { addListener() {} }
      }
    };
  </script>
  ${scriptTags(contentSources)}
  <script>
    const TEST_OPTIONS = {
      batchSize: 40,
      bilingualStyle: "dashed",
      clearPrevious: false,
      endpoint: "http://127.0.0.1:8787",
      minChars: 4,
      mode: "bilingual",
      targetLanguage: "Chinese (Simplified)",
      viewportFirst: false
    };

    function translationCalls() {
      return window.__pitCalls.filter((message) => message.type === "translate-batch");
    }

    function waitFor(predicate, timeoutMs = 4000, label = "browser test condition") {
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          if (predicate()) {
            resolve();
            return;
          }
          if (performance.now() - started >= timeoutMs) {
            reject(new Error("Timed out waiting for " + label));
            return;
          }
          setTimeout(poll, 20);
        };
        poll();
      });
    }

    function setBody(html) {
      clearTranslations();
      document.body.innerHTML = html;
      window.__pitCalls.length = 0;
      window.__pitRuntime.send = window.__pitDefaultSend;
    }

    async function runCase(name) {
      if (name === "adaptive-batches") {
        const paragraphs = Array.from({ length: 45 }, (_, index) =>
          '<p id="batch-' + index + '">Short readable batch paragraph ' + index + '.</p>'
        ).join("");
        setBody("<main>" + paragraphs + "</main>");
        await translatePage(TEST_OPTIONS);
        return { batchSizes: translationCalls().map((call) => call.items.length) };
      }

      if (name === "character-budget") {
        const chars = (length, id) => ({ id, text: "x".repeat(length) });
        const normal = buildTranslationBatches([
          chars(300, "one"), chars(300, "two"), chars(300, "three"), chars(300, "four")
        ], 12, 800);
        const oversized = buildTranslationBatches([
          chars(1200, "large"), chars(100, "small")
        ], 12, 800);
        return {
          normalChars: normal.map((batch) => batch.reduce((sum, item) => sum + item.text.length, 0)),
          oversizedChars: oversized.map((batch) => batch.reduce((sum, item) => sum + item.text.length, 0))
        };
      }

      if (name === "newest-pending-first") {
        setBody(
          '<main><p id="pending-old">Older visible pending content.</p>' +
          '<p id="pending-new">Newer visible pending content.</p></main>'
        );
        const entries = collectTranslationBlocks(document.body, TEST_OPTIONS);
        enqueuePendingTranslations([entries[0]], TEST_OPTIONS, { priority: 1 });
        enqueuePendingTranslations([entries[1]], TEST_OPTIONS, { priority: 1 });
        const jobs = takePendingTranslationJobs(PIT_STATE.translationEpoch).jobs;
        const order = jobs.map((job) => job.entry.element.id);
        jobs.forEach((job) => PIT_STATE.pendingIds.delete(job.entry.id));
        return { order };
      }

      if (name === "pending-batch-order") {
        setBody(
          '<main><p id="pending-top">Top visible pending content.</p>' +
          '<p id="pending-middle">Middle visible pending content.</p>' +
          '<p id="pending-bottom">Bottom visible pending content.</p></main>'
        );
        const entries = collectTranslationBlocks(document.body, TEST_OPTIONS);
        enqueuePendingTranslations(entries, TEST_OPTIONS, { priority: 1 });
        const jobs = takePendingTranslationJobs(PIT_STATE.translationEpoch).jobs;
        const order = jobs.map((job) => job.entry.element.id);
        jobs.forEach((job) => PIT_STATE.pendingIds.delete(job.entry.id));
        return { order };
      }

      if (name === "floating-auto-translate") {
        setBody('<main><p id="auto-owner">Translate this page as soon as auto mode is enabled.</p></main>');
        window.__pitStorage.autoTranslateAllPages = false;
        let releaseTranslation;
        window.__pitRuntime.send = (message) => {
          if (message.type !== "translate-batch") {
            return window.__pitDefaultSend(message);
          }
          return new Promise((resolve) => {
            releaseTranslation = () => resolve({
              ok: true,
              translations: message.items.map((item) => ({ id: item.id, text: "translated:" + item.text }))
            });
          });
        };
        setFloatingVisible(true);
        const input = document.querySelector("#pit-floating [data-setting=autoTranslateAllPages]");
        await waitFor(() => input && !input.disabled, 2000, "the global auto-translate control");
        const topLevelControl = !input.closest(".pit-floating-advanced");
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(() => typeof releaseTranslation === "function", 4000, "the automatic translation request");
        const floating = document.getElementById("pit-floating");
        const runningState = {
          mode: floating.dataset.mode,
          badge: floating.querySelector(".pit-floating-badge").textContent,
          label: floating.querySelector("[data-role=modeLabel]").textContent
        };
        releaseTranslation();
        await waitFor(
          () => document.querySelectorAll("#auto-owner > .pit-translation-ready").length === 1,
          4000,
          "the automatic current-page translation"
        );
        const result = {
          topLevelControl,
          enabledGlobally: window.__pitStorage.autoTranslateAllPages === true,
          runningState,
          completeState: {
            mode: floating.dataset.mode,
            badge: floating.querySelector(".pit-floating-badge").textContent,
            label: floating.querySelector("[data-role=modeLabel]").textContent
          },
          requestItems: translationCalls().reduce((sum, call) => sum + call.items.length, 0),
          readySlots: document.querySelectorAll("#auto-owner > .pit-translation-ready").length
        };
        input.checked = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(
          () => (
            window.__pitStorage.autoTranslateAllPages === false
            && !PIT_STATE.dynamicObserver
          ),
          2000,
          "auto-translate to be disabled"
        );
        const lateParagraph = document.createElement("p");
        lateParagraph.id = "disabled-auto-owner";
        lateParagraph.textContent = "This later content must wait for a manual translation.";
        document.querySelector("main").appendChild(lateParagraph);
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        result.disabledStopsUpdates = !document.querySelector("#disabled-auto-owner > .pit-translation-ready");
        PIT_STATE.autoTranslateEnabled = false;
        setFloatingVisible(false);
        return result;
      }

      if (name === "auto-translate-late-content") {
        setBody('<main id="late-content"></main>');
        const initial = await translatePage({ ...TEST_OPTIONS, autoTranslate: true });
        const paragraph = document.createElement("p");
        paragraph.id = "late-auto-owner";
        paragraph.textContent = "Client-rendered content should be translated when it appears.";
        document.querySelector("#late-content").appendChild(paragraph);
        await waitFor(
          () => document.querySelectorAll("#late-auto-owner > .pit-translation-ready").length === 1,
          4000,
          "the late auto-translated content"
        );
        return {
          initialTotal: initial.total,
          readySlots: document.querySelectorAll("#late-auto-owner > .pit-translation-ready").length
        };
      }

      if (name === "pipelined-tail") {
        const paragraphs = Array.from({ length: 45 }, (_, index) =>
          '<p>Pipeline batch paragraph ' + index + ' remains readable.</p>'
        ).join("");
        setBody("<main>" + paragraphs + "</main>");
        const releases = [];
        window.__pitRuntime.send = (message) => new Promise((resolve) => {
          releases.push(() => resolve({
            ok: true,
            translations: message.items.map((item) => ({ id: item.id, text: "translated:" + item.text }))
          }));
        });
        const translating = translatePage(TEST_OPTIONS);
        await waitFor(() => translationCalls().length === 2, 4000, "the pipelined tail request");
        const tailStartedBeforeFirstResolved = releases.length === 2;
        window.__pitRuntime.send = window.__pitDefaultSend;
        releases.splice(0).forEach((release) => release());
        await translating;
        return {
          batchSizes: translationCalls().map((call) => call.items.length),
          tailStartedBeforeFirstResolved
        };
      }

      if (name === "bounded-tail-concurrency") {
        const paragraphs = Array.from({ length: 128 }, (_, index) =>
          '<p>Concurrent tail paragraph number ' + index + ' is readable.</p>'
        ).join("");
        setBody("<main>" + paragraphs + "</main>");
        let active = 0;
        let maxActive = 0;
        window.__pitRuntime.send = async (message) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 50));
          active -= 1;
          return {
            ok: true,
            translations: message.items.map((item) => ({ id: item.id, text: "translated:" + item.text }))
          };
        };
        await translatePage(TEST_OPTIONS);
        return {
          batchSizes: translationCalls().map((call) => call.items.length),
          maxActive
        };
      }

      if (name === "duplicate-fanout") {
        setBody(
          '<main><p id="duplicate-a">Repeated source paragraph.</p>' +
          '<p id="duplicate-b">Repeated source paragraph.</p></main>'
        );
        await translatePage(TEST_OPTIONS);
        const slots = Array.from(document.querySelectorAll(".pit-translation-ready"));
        return {
          readySlots: slots.length,
          requestItems: translationCalls()[0]?.items.length || 0,
          slotParents: slots.map((slot) => slot.parentElement.id),
          translations: slots.map((slot) => slot.textContent)
        };
      }

      if (name === "hacker-news-titles") {
        const testRule = {
          host: /^127\.0\.0\.1$/,
          selectors: [".titleline"],
          skipSelectors: [".rank", ".subtext", ".pagetop"]
        };
        PIT_SITE_RULES.unshift(testRule);
        try {
          const rows = Array.from({ length: 17 }, (_, index) => (
            '<tr class="athing"><td class="title"><span class="titleline" id="hn-title-' + index + '">' +
            '<a href="https://example.com/story-' + index + '">Short readable story number ' + index + '</a>' +
            '<span class="sitebit comhead"> (<a href="from?site=example.com">example.com</a>)</span>' +
            '</span></td></tr>'
          )).join("");
          setBody('<table><tbody>' + rows + '</tbody></table>');
          await translatePage(TEST_OPTIONS);
          return {
            requestItems: translationCalls().reduce((sum, call) => sum + call.items.length, 0),
            readySlots: document.querySelectorAll(".titleline + .pit-translation-ready").length,
            untranslatedTitles: Array.from(document.querySelectorAll(".titleline"))
              .filter((title) => !title.nextElementSibling?.classList.contains("pit-translation-ready"))
              .length
          };
        } finally {
          PIT_SITE_RULES.shift();
        }
      }

      if (name === "partial-batch-failure") {
        setBody(
          '<main><p id="partial-success">This item should remain translated.</p>' +
          '<p id="partial-failure">This item simulates a missing model result.</p></main>'
        );
        window.__pitRuntime.send = async (message) => {
          const successful = message.items.find((item) => item.text.includes("remain translated"));
          const failed = message.items.find((item) => item !== successful);
          return {
            ok: true,
            translations: [{ id: successful.id, text: "translated:" + successful.text }],
            failedIds: [failed.id],
            error: "batch validation failed"
          };
        };
        await translatePage(TEST_OPTIONS);
        return {
          readySlots: document.querySelectorAll(".pit-translation-ready").length,
          failedSlots: document.querySelectorAll(".pit-translation-failed").length,
          successText: document.querySelector("#partial-success > .pit-translation-ready")?.textContent || ""
        };
      }

      if (name === "semantic-inside") {
        setBody(
          '<main><h2 id="heading">A semantic heading for testing.</h2>' +
          '<p id="paragraph">A semantic paragraph for testing.</p>' +
          '<blockquote id="quote">A semantic quotation for testing.</blockquote>' +
          '<details open><summary id="summary">A semantic summary for testing.</summary></details></main>'
        );
        await translatePage(TEST_OPTIONS);
        const describe = (id) => {
          const owner = document.getElementById(id);
          const slot = owner.querySelector(":scope > .pit-translation-ready");
          return { inside: slot?.parentElement === owner, tag: slot?.tagName || "" };
        };
        return {
          heading: describe("heading"),
          paragraph: describe("paragraph"),
          quote: describe("quote"),
          summary: describe("summary")
        };
      }

      if (name === "font-size-inheritance") {
        setBody(
          '<main><h1 id="font-heading" style="font-size: 53px">A large heading retains its size.</h1>' +
          '<p id="font-paragraph" style="font-size: 19px">A paragraph retains its size too.</p></main>'
        );
        await translatePage(TEST_OPTIONS);
        const describe = (id) => {
          const owner = document.getElementById(id);
          const slot = owner.querySelector(":scope > .pit-translation-ready");
          return {
            source: window.getComputedStyle(owner).fontSize,
            translation: window.getComputedStyle(slot).fontSize
          };
        };
        return {
          heading: describe("font-heading"),
          paragraph: describe("font-paragraph")
        };
      }

      if (name === "replace-restore") {
        setBody('<main><p id="replace-owner">Read the <a id="durable-link" href="#kept">durable link</a> before continuing.</p></main>');
        const owner = document.getElementById("replace-owner");
        const link = document.getElementById("durable-link");
        const firstTextNode = owner.firstChild;
        let listenerCalls = 0;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          listenerCalls += 1;
        });

        await translatePage({ ...TEST_OPTIONS, mode: "replace" });
        const connectedDuringReplace = link.isConnected && document.getElementById("durable-link") === link;
        const hiddenDuringReplace = link.classList.contains("pit-replace-original");
        clearTranslations();
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        return {
          connectedDuringReplace,
          hiddenDuringReplace,
          listenerCalls,
          originalTextAfterClear: owner.textContent.trim(),
          sameLinkAfterClear: document.getElementById("durable-link") === link && link.parentNode === owner,
          sameTextNodeAfterClear: owner.firstChild === firstTextNode,
          translationCountAfterClear: document.querySelectorAll(".pit-translation").length
        };
      }

      if (name === "delayed-cancel") {
        setBody('<main><p id="delayed-owner">A delayed response must never become stale UI.</p></main>');
        let release;
        window.__pitRuntime.send = (message) => new Promise((resolve) => {
          release = () => resolve({
            ok: true,
            translations: message.items.map((item) => ({ id: item.id, text: "late:" + item.text }))
          });
        });

        const pending = translatePage(TEST_OPTIONS);
        await waitFor(
          () => translationCalls().length === 1 && typeof release === "function",
          4000,
          "the delayed cancellation batch"
        );
        const pendingSlot = document.querySelector(".pit-translation-pending");
        const pendingText = pendingSlot?.textContent.trim() || "";
        const pendingAriaLabel = pendingSlot?.getAttribute("aria-label") || "";
        const pendingSpinnerCount = pendingSlot?.querySelectorAll(".pit-translation-spinner").length || 0;
        clearTranslations();
        release();
        const summary = await pending;
        const owner = document.getElementById("delayed-owner");
        return {
          cancelled: summary.cancelled === true,
          pendingText,
          pendingAriaLabel,
          pendingSpinnerCount,
          pendingSlots: document.querySelectorAll(".pit-translation-pending").length,
          readySlots: document.querySelectorAll(".pit-translation-ready").length,
          translatedFlag: owner.dataset.pitTranslated || "false"
        };
      }

      if (name === "dynamic-80") {
        setBody('<main><p id="dynamic-seed">Initial readable paragraph starts the dynamic observer.</p></main>');
        await translatePage(TEST_OPTIONS);
        window.__pitCalls.length = 0;
        const paragraphs = Array.from({ length: 80 }, (_, index) =>
          '<p id="dynamic-' + index + '">Dynamic paragraph number ' + index + ' contains readable text.</p>'
        ).join("");
        const root = document.createElement("section");
        root.id = "dynamic-root";
        root.innerHTML = paragraphs;
        document.querySelector("main").appendChild(root);
        await waitFor(() => root.querySelectorAll(".pit-translation-ready").length === 80, 6000);
        return {
          batchSizes: translationCalls().map((call) => call.items.length),
          queueSize: PIT_STATE.dynamicQueue.size,
          readySlots: root.querySelectorAll(".pit-translation-ready").length,
          running: PIT_STATE.running
        };
      }

      if (name === "upward-pending") {
        const paragraphs = Array.from({ length: 320 }, (_, index) =>
          '<p id="up-' + index + '">Upward pending paragraph ' + index + ' remains readable while the first batch is active.</p>'
        ).join("");
        setBody("<main>" + paragraphs + "</main>");
        window.scrollTo(0, 4200);
        let release;
        let releaseUpward;
        let requestCount = 0;
        window.__pitRuntime.send = (message) => {
          requestCount += 1;
          if (requestCount === 1) {
            return new Promise((resolve) => {
              release = () => resolve({
                ok: true,
                translations: message.items.map((item) => ({ id: item.id, text: "translated:" + item.text }))
              });
            });
          }
          if (message.items.some((item) => item.text.includes("Upward pending paragraph 0 remains readable"))) {
            return new Promise((resolve) => {
              releaseUpward = () => resolve({
                ok: true,
                translations: message.items.map((item) => ({ id: item.id, text: "translated:" + item.text }))
              });
            });
          }
          return window.__pitDefaultSend(message);
        };

        const translating = translatePage({ ...TEST_OPTIONS, viewportFirst: true });
        await waitFor(
          () => translationCalls().length >= 1 && typeof release === "function",
          4000,
          "the initial upward-scroll batch"
        );
        window.scrollTo(0, 0);
        window.dispatchEvent(new Event("scroll"));
        await waitFor(
          () => document.querySelector("#up-0 > .pit-translation-pending"),
          4000,
          "the upward-scroll pending surface"
        );
        const upwardPending = Boolean(document.querySelector("#up-0 > .pit-translation-pending"));
        await waitFor(() => typeof releaseUpward === "function", 4000, "the upward-scroll request");
        releaseUpward();
        release();
        await translating;
        await waitFor(
          () => document.querySelector("#up-0 > .pit-translation-ready"),
          6000,
          "the completed upward-scroll translation"
        );
        return {
          upwardPending,
          topReady: Boolean(document.querySelector("#up-0 > .pit-translation-ready"))
        };
      }

      if (name === "pending-cache") {
        setBody('<main><p id="cache-seed">Cache this exact dynamic sentence once.</p></main>');
        await translatePage(TEST_OPTIONS);
        const duplicate = document.createElement("p");
        duplicate.id = "cache-duplicate";
        duplicate.textContent = "Cache this exact dynamic sentence once.";
        document.querySelector("main").appendChild(duplicate);
        await waitFor(() => document.querySelector("#cache-duplicate > .pit-translation-ready"));
        return {
          backendCalls: translationCalls().length,
          readySlots: document.querySelectorAll(".pit-translation-ready").length,
          pendingQueueSize: PIT_STATE.pendingQueue.size
        };
      }

      if (name === "pending-set-dedupe") {
        setBody('<main><p id="dedupe-owner">This block must enter the pending queue only once.</p></main>');
        await waitFor(() => !PIT_STATE.pendingDraining);
        PIT_STATE.cancelRequested = false;
        const [entry] = collectTranslationBlocks(document.body, TEST_OPTIONS);
        enqueuePendingTranslations([entry], TEST_OPTIONS, { priority: 2 });
        enqueuePendingTranslations([entry], TEST_OPTIONS, { priority: 2 });
        const queuedEntries = PIT_STATE.pendingQueue.size;
        await flushPendingTranslationQueue(PIT_STATE.translationEpoch);
        return {
          queuedEntries,
          backendCalls: translationCalls().length,
          readySlots: document.querySelectorAll("#dedupe-owner > .pit-translation-ready").length
        };
      }

      if (name === "pending-overlap") {
        setBody(
          '<main><p id="overlap-1">First overlapping translation batch.</p>' +
          '<p id="overlap-2">Second overlapping translation batch.</p>' +
          '<p id="overlap-3">Third overlapping translation batch.</p>' +
          '<p id="overlap-4">Fourth overlapping translation batch.</p></main>'
        );
        await waitFor(() => !PIT_STATE.pendingDraining);
        PIT_STATE.cancelRequested = false;
        const entries = collectTranslationBlocks(document.body, TEST_OPTIONS);
        let active = 0;
        let maxActive = 0;
        const releases = [];
        window.__pitRuntime.send = (message) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          return new Promise((resolve) => {
            releases.push(() => {
              active -= 1;
              resolve({
                ok: true,
                translations: message.items.map((item) => ({ id: item.id, text: "translated:" + item.text }))
              });
            });
          });
        };

        const drains = entries.map((entry) => {
          enqueuePendingTranslations([entry], TEST_OPTIONS, { priority: 2 });
          return flushPendingTranslationQueue(PIT_STATE.translationEpoch);
        });
        await waitFor(() => translationCalls().length === 2 && releases.length === 2);
        await new Promise((resolve) => window.setTimeout(resolve, 30));
        const firstRelease = releases.shift();
        firstRelease();
        await waitFor(() => translationCalls().length === 3 && releases.length === 2);
        releases.splice(0).forEach((release) => release());
        await waitFor(() => translationCalls().length === 4 && releases.length === 1);
        releases.splice(0).forEach((release) => release());
        await Promise.all(drains);
        return {
          batchSizes: translationCalls().map((call) => call.items.length),
          maxActive,
          pendingQueueSize: PIT_STATE.pendingQueue.size,
          readySlots: document.querySelectorAll(".pit-translation-ready").length
        };
      }

      if (name === "trailing-background-batch") {
        setBody(
          '<main><p>First dynamic update becomes part of one background batch.</p>' +
          '<p>Second dynamic update becomes part of one background batch.</p>' +
          '<p>Third dynamic update becomes part of one background batch.</p></main>'
        );
        const entries = collectTranslationBlocks(document.body, TEST_OPTIONS);
        let requestStartedAt = 0;
        window.__pitRuntime.send = async (message) => {
          requestStartedAt = performance.now();
          return window.__pitDefaultSend(message);
        };

        PIT_STATE.cancelRequested = false;
        const startedAt = performance.now();
        enqueuePendingTranslations([entries[0]], TEST_OPTIONS, { priority: 1 });
        schedulePendingTranslationDrain();
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        enqueuePendingTranslations([entries[1]], TEST_OPTIONS, { priority: 1 });
        schedulePendingTranslationDrain();
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        enqueuePendingTranslations([entries[2]], TEST_OPTIONS, { priority: 1 });
        schedulePendingTranslationDrain();
        await waitFor(() => translationCalls().length === 1, 2000, "the trailing background batch");
        await waitFor(() => !PIT_STATE.pendingDraining, 2000, "the trailing background completion");
        return {
          batchSizes: translationCalls().map((call) => call.items.length),
          requestDelayMs: Math.round(requestStartedAt - startedAt)
        };
      }

      if (name === "spa-stale-response") {
        setBody('<main><p id="old-route">Old route response must be cancelled.</p></main>');
        let release;
        let requestCount = 0;
        window.__pitRuntime.send = (message) => {
          requestCount += 1;
          if (requestCount === 1) {
            return new Promise((resolve) => {
              release = () => resolve({
                ok: true,
                translations: message.items.map((item) => ({ id: item.id, text: "stale:" + item.text }))
              });
            });
          }
          return window.__pitDefaultSend(message);
        };

        const pending = translatePage(TEST_OPTIONS);
        await waitFor(() => translationCalls().length === 1 && typeof release === "function");
        document.querySelector("main").innerHTML = '<p id="new-route">New route content should be translated once.</p>';
        history.pushState({}, "", "/pit-route-test");
        release();
        const summary = await pending;
        await waitFor(() => document.querySelectorAll("#new-route > .pit-translation-ready").length === 1, 5000);
        const slot = document.querySelector("#new-route > .pit-translation-ready");
        return {
          batchSizes: translationCalls().map((call) => call.items.length),
          cancelled: summary.cancelled === true,
          newRouteSlots: document.querySelectorAll("#new-route > .pit-translation-ready").length,
          newRouteText: slot?.textContent || ""
        };
      }

      throw new Error("Unknown browser test case: " + name);
    }

    function finish(result) {
      stopDynamicTranslationObserver();
      stopLazyTranslationObserver();
      fetch("/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result)
      });
    }

    async function runSuite() {
      const results = {};
      for (const name of [
        "adaptive-batches",
        "character-budget",
        "newest-pending-first",
        "pending-batch-order",
        "floating-auto-translate",
        "auto-translate-late-content",
        "bounded-tail-concurrency",
        "pipelined-tail",
        "duplicate-fanout",
        "hacker-news-titles",
        "partial-batch-failure",
        "semantic-inside",
        "font-size-inheritance",
        "replace-restore",
        "delayed-cancel",
        "dynamic-80",
        "upward-pending",
        "pending-cache",
        "pending-set-dedupe",
        "pending-overlap",
        "trailing-background-batch",
        "spa-stale-response"
      ]) {
        try {
          results[name] = await runCase(name);
        } catch (error) {
          throw new Error("Browser case " + name + " failed: " + (error?.stack || error));
        }
      }
      return results;
    }

    runSuite()
      .then((value) => finish({ ok: true, value }))
      .catch((error) => finish({
        ok: false,
        error: error && error.stack ? error.stack : String(error)
      }));
  </script>
</body>
</html>`;
}

function findChrome() {
  const candidates = [
    process.env.PIT_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      return execFileSync("which", [command], { encoding: "utf8" }).trim();
    } catch {
      // Try the next common executable name.
    }
  }

  return null;
}
