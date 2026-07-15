#!/usr/bin/env node
// Runs a small, real browser-to-Gloss measurement. It uses the signed-in local
// Gloss app, so require an explicit acknowledgement before consuming a turn.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const CONFIRMATION = "--confirm-live-usage";
const BLOCK_COUNT = readPositiveInteger(process.env.GLOSS_LIVE_BLOCKS, 41);
const CHROME = findChrome();
const MANAGED_EXTENSION = process.env.GLOSS_BROWSER_EXTENSION_DIR || path.join(
  os.homedir(), "Library", "Application Support", "Gloss", "BrowserExtension"
);
const LOG_FILE = path.join(os.homedir(), "Library", "Logs", "Gloss", "gloss.log");

if (!process.argv.includes(CONFIRMATION)) {
  console.error(`Usage: node tools/measure-gloss-live.js ${CONFIRMATION}`);
  console.error(`Runs a real ${BLOCK_COUNT}-block browser translation through the local Gloss app.`);
  process.exit(2);
}

if (!CHROME) {
  fail("Google Chrome or Chromium was not found.");
}
if (!fs.existsSync(path.join(MANAGED_EXTENSION, "manifest.json"))) {
  fail(`Gloss managed browser extension was not found: ${MANAGED_EXTENSION}`);
}
if (!fs.existsSync(path.join(MANAGED_EXTENSION, "gloss-config.js"))) {
  fail(`Gloss browser pairing configuration was not found: ${MANAGED_EXTENSION}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gloss-live-measure-"));
  const extensionDir = path.join(tempDir, "extension");
  const profileDir = path.join(tempDir, "profile");
  const logOffset = fileSize(LOG_FILE);
  let chrome;
  let pageServer;
  let pageCDP;
  let workerCDP;
  let stage = "setup";
  const runID = Date.now().toString(36);

  try {
    fs.cpSync(MANAGED_EXTENSION, extensionDir, { recursive: true });
    pageServer = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body><main>${sampleBlocks(runID)}</main></body></html>`);
    });
    await listen(pageServer);
    const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

    const devtools = waitForDevTools();
    chrome = spawn(CHROME, [
      "--headless=new",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-features=LocalNetworkAccessChecks",
      "--disable-gpu",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--user-data-dir=${profileDir}`,
      pageUrl
    ], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    chrome.stderr.on("data", devtools.onData);
    chrome.once("exit", (code, signal) => {
      devtools.reject(new Error(`Chrome exited before DevTools was ready (${code ?? signal})`));
    });

    stage = "waiting for Chrome DevTools";
    const browserWebSocket = await devtools.promise;
    const targetsURL = new URL("/json/list", browserWebSocket);
    targetsURL.protocol = "http:";
    stage = "waiting for the measurement tab";
    const pageTarget = await waitFor(async () => {
      const targets = await fetch(targetsURL).then((response) => response.json());
      return targets.find((target) => target.type === "page" && target.url === pageUrl);
    });
    pageCDP = await CDPClient.connect(pageTarget.webSocketDebuggerUrl);
    await pageCDP.call("Runtime.enable");
    stage = "waiting for the content script";
    await waitFor(() => pageCDP.evaluate("Boolean(document.querySelector('#pit-floating .pit-fab'))"));

    stage = "waiting for the extension worker";
    const workerTarget = await waitFor(async () => {
      const targets = await fetch(targetsURL).then((response) => response.json());
      return targets.find((target) => target.type === "service_worker" && target.url.endsWith("/background.js"));
    });
    workerCDP = await CDPClient.connect(workerTarget.webSocketDebuggerUrl);
    await workerCDP.call("Runtime.enable");
    stage = "checking the local Gloss bridge";
    const health = await workerCDP.evaluate(`checkHealth({ endpoint: PIT_DEFAULT_ENDPOINT })
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error: String(error) }))`);
    if (!health.ok) {
      throw new Error(`Gloss health check failed: ${health.error}`);
    }

    stage = "translating the measurement page";
    const startedAt = Date.now();
    const pageResponse = await workerCDP.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${pageUrl}*`)} });
      const tab = tabs.find((candidate) => candidate.url === ${JSON.stringify(pageUrl)});
      if (!tab) throw new Error("Measurement tab was not found.");
      return await chrome.tabs.sendMessage(tab.id, {
        type: "start-page-translation",
        options: {
          targetLanguage: "Chinese (Simplified)",
          mode: "bilingual",
          bilingualStyle: "dashed",
          clearPrevious: true,
          viewportFirst: false,
          showFloatingButton: true,
          translateSelection: true,
          batchSize: 40,
          batchCharLimit: 4000,
          minChars: 4
        }
      });
    })()`);
    if (!pageResponse?.ok) {
      throw new Error(`Gloss page translation failed: ${pageResponse?.error || "unknown error"}`);
    }
    stage = "waiting for rendered translations";
    const rendered = await waitFor(
      () => pageCDP.evaluate(`({
        ready: document.querySelectorAll(".pit-translation-ready").length,
        failed: document.querySelectorAll(".pit-translation-failed").length,
        status: document.querySelector(".pit-floating-status")?.textContent || ""
      })`),
      (value) => value?.ready >= BLOCK_COUNT || value?.failed > 0,
      90_000
    );
    if (rendered.failed > 0) {
      throw new Error(`Gloss reported a failed translation: ${rendered.status}`);
    }
    await wait(250);
    const measurement = measureLog(readAppendedLog(LOG_FILE, logOffset));
    const result = {
      blocks: BLOCK_COUNT,
      rendered: rendered.ready,
      wallMs: Date.now() - startedAt,
      batches: measurement.starts,
      completions: measurement.completions
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pageCDP?.close();
    workerCDP?.close();
    await stopProcessGroup(chrome);
    await closeServer(pageServer);
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function sampleBlocks(runID) {
  return Array.from({ length: BLOCK_COUNT }, (_value, index) => (
    `<p>Gloss scheduling measurement ${runID}, sentence ${index + 1}.</p>`
  )).join("\n");
}

function measureLog(log) {
  const events = log.split("\n").map((line) => parseEvent(line)).filter(Boolean);
  const starts = events.filter((event) => event.component === "bridge" && event.event === "translation_start");
  const firstStart = starts[0]?.time;
  return {
    starts: starts.map((event) => ({
      items: Number(event.values.items || 0),
      priority: event.values.priority || "unknown",
      offsetMs: firstStart ? event.time - firstStart : 0
    })),
    completions: events
      .filter((event) => event.component === "codex" && event.event === "translation_complete")
      .map((event) => ({
        items: Number(event.values.items || 0),
        priority: event.values.priority || "unknown",
        durationMs: Number(event.values.duration_ms || 0),
        queueWaitMs: Number(event.values.queue_wait_ms || 0),
        turnWaitMs: Number(event.values.turn_wait_ms || 0),
        turnDispatchMs: Number(event.values.turn_dispatch_ms || 0),
        modelWaitMs: Number(event.values.model_wait_ms || 0),
        firstDeltaWaitMs: Number(event.values.first_delta_wait_ms || 0),
        outputStreamMs: Number(event.values.output_stream_ms || 0),
        messageFinalizeMs: Number(event.values.message_finalize_ms || 0),
        turnFinalizeMs: Number(event.values.turn_finalize_ms || 0),
        parseMs: Number(event.values.parse_ms || 0),
        rollbackMs: Number(event.values.rollback_ms || 0)
      }))
  };
}

function parseEvent(line) {
  const match = line.match(/^(\S+) \[([^\]]+)\] ([^ ]+)(?: (.*))?$/);
  if (!match) return null;
  const time = Date.parse(match[1]);
  if (!Number.isFinite(time)) return null;
  const values = Object.fromEntries(Array.from(match[4]?.matchAll(/([a-z_]+)=([^ ]+)/g) || [], (part) => [part[1], part[2]]));
  return { time, component: match[2], event: match[3], values };
}

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CDPClient(socket);
  }

  call(method, params = {}) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Chrome evaluation failed");
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

function waitForDevTools() {
  let resolvePromise;
  let rejectPromise;
  let stderr = "";
  return {
    promise: new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    reject: rejectPromise,
    onData(chunk) {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolvePromise(match[1]);
    }
  };
}

async function waitFor(read, accept = Boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError || new Error("Timed out waiting for Chrome state.");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(resolve);
  });
}

async function stopProcessGroup(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), wait(1500)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Chrome already exited.
    }
  }
}

function readAppendedLog(file, offset) {
  if (!fs.existsSync(file)) return "";
  const handle = fs.openSync(file, "r");
  try {
    const length = fs.fstatSync(handle).size - offset;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, offset);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : fallback;
}

function findChrome() {
  const candidates = [
    process.env.PIT_CHROME,
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...cachedChromeForTesting(path.join(os.homedir(), "Library", "Caches", "ms-playwright")),
    ...cachedChromeForTesting(path.join(os.homedir(), ".cache", "puppeteer")),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function cachedChromeForTesting(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(
      root,
      entry.name,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    ))
    .reverse();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
