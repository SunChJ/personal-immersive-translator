const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const BUILT_EXTENSION = path.join(ROOT, ".output", "chrome-mv3");
const CHROME = findChrome();
const PAIRING_TOKEN = "gloss-extension-test-token";

test("loaded Chrome extension translates through its real service worker", { timeout: 25_000 }, async (t) => {
  if (!CHROME) {
    t.skip("Google Chrome or Chromium is not installed");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gloss-extension-test-"));
  const extensionDir = path.join(tempDir, "extension");
  const profileDir = path.join(tempDir, "profile");
  let chrome = null;
  let pageServer = null;
  let bridgeServer = null;
  let cdp = null;
  let workerCDP = null;

  try {
    fs.cpSync(BUILT_EXTENSION, extensionDir, { recursive: true });

    let translationRequest = null;
    const bridgeRequests = [];
    bridgeServer = http.createServer(async (req, res) => {
      bridgeRequests.push({
        method: req.method,
        url: req.url,
        origin: req.headers.origin || "",
        token: req.headers["x-gloss-token"] || ""
      });
      addCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (req.headers["x-gloss-token"] !== PAIRING_TOKEN) {
        sendJson(res, { error: "Gloss browser pairing required." }, 401);
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, { ok: true, name: "Gloss", backend: "test" });
        return;
      }
      if (req.method === "POST" && req.url === "/translate") {
        translationRequest = JSON.parse(await readBody(req));
        sendJson(res, {
          translations: translationRequest.items.map((item) => ({
            id: item.id,
            text: `译文：${item.text}`
          }))
        });
        return;
      }
      res.writeHead(404).end();
    });
    await listen(bridgeServer);
    const bridgeEndpoint = `http://127.0.0.1:${bridgeServer.address().port}`;
    configureExtensionCopy(extensionDir, bridgeEndpoint, PAIRING_TOKEN);

    pageServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html><body>
          <h1>Gloss browser acceptance</h1>
          <p>Focused work should stay simple, fast, and reliable.</p>
        </body></html>`);
    });
    await listen(pageServer);
    const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

    const devtools = waitForDevTools();
    chrome = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-component-update",
        "--disable-default-apps",
        // A headless profile cannot answer Chrome's Local Network Access prompt.
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
      ],
      { detached: true, stdio: ["ignore", "ignore", "pipe"] }
    );
    chrome.stderr.on("data", devtools.onData);
    chrome.once("exit", (code, signal) => {
      devtools.reject(new Error(`Chrome exited before DevTools was ready (${code ?? signal})`));
    });

    const browserWebSocketUrl = await devtools.promise;
    const targetsUrl = new URL("/json/list", browserWebSocketUrl);
    targetsUrl.protocol = "http:";
    const target = await waitFor(async () => {
      const targets = await fetch(targetsUrl).then((response) => response.json());
      return targets.find((candidate) => candidate.type === "page" && candidate.url === pageUrl);
    });

    cdp = await CDPClient.connect(target.webSocketDebuggerUrl);
    await cdp.call("Runtime.enable");
    await waitFor(async () => {
      return cdp.evaluate("Boolean(document.querySelector('#pit-floating .pit-fab'))");
    });

    const workerTarget = await waitFor(async () => {
      const targets = await fetch(targetsUrl).then((response) => response.json());
      return targets.find((candidate) => (
        candidate.type === "service_worker"
        && candidate.url.endsWith("/background.js")
      ));
    });
    workerCDP = await CDPClient.connect(workerTarget.webSocketDebuggerUrl);
    await workerCDP.call("Runtime.enable");
    await waitFor(() => workerCDP.evaluate("typeof checkHealth === 'function'"));
    assert.equal(await workerCDP.evaluate("PIT_DEFAULT_ENDPOINT"), bridgeEndpoint);
    assert.equal(await workerCDP.evaluate("PIT_DEFAULT_PAIRING_TOKEN"), PAIRING_TOKEN);
    const workerPermissions = await workerCDP.evaluate(`Promise.all([
      chrome.permissions.getAll(),
      chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })
    ]).then(([all, contains]) => ({ all, contains }))`);
    assert.equal(workerPermissions.contains, true, JSON.stringify(workerPermissions));
    const health = await workerCDP.evaluate(`checkHealth({ endpoint: PIT_DEFAULT_ENDPOINT })
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error: String(error) }))`);
    assert.equal(health.ok, true, `${health.error}; permissions=${JSON.stringify(workerPermissions)}`);

    await cdp.evaluate("document.querySelector('#pit-floating .pit-fab').click(); true");
    let rendered;
    try {
      rendered = await waitFor(async () => {
        return cdp.evaluate(`Array.from(document.querySelectorAll('.pit-translation'))
          .map((element) => element.textContent)
          .filter(Boolean)`);
      }, (value) => (
        Array.isArray(value)
        && value.length >= 2
        && value.every((text) => text.startsWith("译文："))
      ));
    } catch (error) {
      const pageState = await cdp.evaluate(`({
        badge: document.querySelector('.pit-floating-badge')?.textContent || '',
        status: document.querySelector('.pit-floating-status')?.textContent || '',
        translations: Array.from(document.querySelectorAll('.pit-translation'))
          .map((element) => element.textContent)
      })`);
      const targetState = await fetch(targetsUrl)
        .then((response) => response.json())
        .then((targets) => targets.map(({ type, url }) => ({ type, url })));
      throw new Error(
        `${error.message}; page=${JSON.stringify(pageState)}; bridge=${JSON.stringify(bridgeRequests)}; targets=${JSON.stringify(targetState)}`
      );
    }

    assert.ok(translationRequest?.items?.length >= 2);
    assert.equal(translationRequest.targetLanguage, "Chinese (Simplified)");
    assert.ok(rendered.every((text) => text.startsWith("译文：")));
    assert.ok(
      bridgeRequests
        .filter((request) => request.method !== "OPTIONS")
        .every((request) => request.token === PAIRING_TOKEN),
      JSON.stringify(bridgeRequests)
    );
  } finally {
    cdp?.close();
    workerCDP?.close();
    await stopProcessGroup(chrome);
    await closeServer(pageServer);
    await closeServer(bridgeServer);
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message));
      } else {
        request.resolve(message.result);
      }
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
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || "Chrome evaluation failed"
      );
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

function configureExtensionCopy(extensionDir, endpoint, pairingToken) {
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = ["http://127.0.0.1/*"];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const sharedPath = path.join(extensionDir, "shared.js");
  const shared = fs.readFileSync(sharedPath, "utf8");
  const configured = shared.replace(
    'const PIT_DEFAULT_ENDPOINT = "http://127.0.0.1:8787";',
    `const PIT_DEFAULT_ENDPOINT = ${JSON.stringify(endpoint)};`
  );
  assert.notEqual(configured, shared, "Default endpoint marker was not found");
  fs.writeFileSync(sharedPath, configured);

  const configPath = path.join(extensionDir, "gloss-config.js");
  fs.writeFileSync(
    configPath,
    `globalThis.GLOSS_PAIRING_TOKEN = ${JSON.stringify(pairingToken)};\n`
  );
}

function waitForDevTools() {
  let resolvePromise;
  let rejectPromise;
  let stderr = "";
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: rejectPromise,
    onData(chunk) {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        resolvePromise(match[1]);
      }
    }
  };
}

async function waitFor(read, accept = Boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("Timed out waiting for Chrome state");
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
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function addCorsHeaders(request, response) {
  const origin = request.headers.origin || "*";
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Gloss-Token, X-PIT-Token");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function stopProcessGroup(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function findChrome() {
  const candidates = [
    process.env.PIT_CHROME,
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...cachedChromeForTesting(path.join(os.homedir(), "Library", "Caches", "ms-playwright")),
    ...cachedChromeForTesting(path.join(os.homedir(), ".cache", "puppeteer", "chrome"))
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function cachedChromeForTesting(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
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
