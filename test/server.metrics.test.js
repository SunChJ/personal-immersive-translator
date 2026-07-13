const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const TRANSLATOR_TOKEN = "pit-local-extension-token-v1";

test("reports bounded, text-free translation metrics and protects reset", { timeout: 10000 }, async () => {
  const fake = createFakeResponsesServer();
  let translator = null;

  try {
    await listen(fake.server, 0);
    const translatorPort = await findAvailablePort();
    translator = startTranslator(fake.server.address().port, translatorPort);
    await waitForTranslator(translatorPort, translator);

    const initial = await requestJson(translatorPort, "/metrics");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.requests, { total: 0, succeeded: 0, failed: 0 });
    assert.deepEqual(initial.body.items, { input: 0, unique: 0 });
    assert.deepEqual(initial.body.sources, { cacheHits: 0, coalescedHits: 0, backendMisses: 0 });
    assert.deepEqual(initial.body.latencyMs, {
      count: 0,
      total: 0,
      average: null,
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      samples: 0,
      percentileWindow: "latest",
      percentileWindowSize: 0,
      percentileWindowCapacity: 2048
    });

    const unauthorized = await requestJson(translatorPort, "/translate", {
      method: "POST",
      body: { items: [{ id: "unauthorized", text: "must not affect metrics" }] }
    });
    assert.equal(unauthorized.status, 403);
    const afterUnauthorized = await requestJson(translatorPort, "/metrics");
    assert.deepEqual(afterUnauthorized.body.requests, { total: 0, succeeded: 0, failed: 0 });

    const duplicateText = "metrics-secret-duplicate-source";
    const concurrentText = "metrics-secret-concurrent-source";
    const failureText = "metrics-secret-failure-source";

    const duplicate = await postTranslation(translatorPort, [
      { id: "duplicate-a", text: duplicateText },
      { id: "duplicate-b", text: duplicateText }
    ]);
    assert.equal(duplicate.status, 200);

    const cached = await postTranslation(translatorPort, [
      { id: "cached", text: duplicateText }
    ]);
    assert.equal(cached.status, 200);

    const concurrentFirst = postTranslation(translatorPort, [
      { id: "concurrent-a", text: concurrentText }
    ]);
    await waitForCallCount(fake.calls, 2);
    const concurrentSecond = postTranslation(translatorPort, [
      { id: "concurrent-b", text: concurrentText }
    ]);
    const concurrent = await Promise.all([concurrentFirst, concurrentSecond]);
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);

    const failed = await postTranslation(translatorPort, [
      { id: "planned-failure", text: failureText }
    ]);
    assert.equal(failed.status, 500);

    const observed = await requestJson(translatorPort, "/metrics");
    assert.equal(observed.status, 200);
    assert.ok(observed.body.uptimeMs >= 0);
    assert.deepEqual(observed.body.requests, { total: 5, succeeded: 4, failed: 1 });
    assert.deepEqual(observed.body.items, { input: 6, unique: 5 });
    assert.deepEqual(observed.body.sources, { cacheHits: 1, coalescedHits: 1, backendMisses: 3 });
    assert.equal(observed.body.backendCalls, 3);
    assert.equal(observed.body.inFlightSize, 0);
    assert.equal(observed.body.cacheSize, 2);

    const latency = observed.body.latencyMs;
    assert.equal(latency.count, 5);
    assert.equal(latency.samples, 5);
    assert.equal(latency.percentileWindow, "latest");
    assert.equal(latency.percentileWindowSize, 5);
    assert.equal(latency.percentileWindowCapacity, 2048);
    assert.ok(latency.total >= latency.max);
    assert.ok(latency.average >= latency.min && latency.average <= latency.max);
    assert.ok(latency.min <= latency.p50);
    assert.ok(latency.p50 <= latency.p95);
    assert.ok(latency.p95 <= latency.p99);
    assert.ok(latency.p99 <= latency.max);

    const serialized = JSON.stringify(observed.body);
    assert.doesNotMatch(serialized, /metrics-secret/);
    assert.doesNotMatch(serialized, /duplicate-a|concurrent-a|planned-failure/);

    const deniedReset = await requestJson(translatorPort, "/metrics/reset", {
      method: "POST",
      token: "wrong-token"
    });
    assert.equal(deniedReset.status, 403);
    const afterDeniedReset = await requestJson(translatorPort, "/metrics");
    assert.deepEqual(afterDeniedReset.body.requests, observed.body.requests);

    const reset = await requestJson(translatorPort, "/metrics/reset", {
      method: "POST",
      token: TRANSLATOR_TOKEN
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body.requests, { total: 0, succeeded: 0, failed: 0 });
    assert.deepEqual(reset.body.items, { input: 0, unique: 0 });
    assert.deepEqual(reset.body.sources, { cacheHits: 0, coalescedHits: 0, backendMisses: 0 });
    assert.equal(reset.body.backendCalls, 0);
    assert.equal(reset.body.latencyMs.count, 0);
    assert.equal(reset.body.cacheSize, 2);
  } finally {
    if (translator) {
      await stopTranslator(translator.child);
    }
    if (fake.server.listening) {
      await closeServer(fake.server);
    }
  }
});

function createFakeResponsesServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      const payload = await readJson(req);
      const input = JSON.parse(payload.input[1].content);
      const texts = input.items.map((item) => item.text);
      calls.push(texts);

      if (texts.includes("metrics-secret-concurrent-source")) {
        await wait(120);
      }

      if (texts.includes("metrics-secret-failure-source")) {
        writeJson(res, 503, { error: { message: "Planned metrics test failure" } });
        return;
      }

      writeJson(res, 200, {
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              translations: input.items.map((item) => ({
                id: item.id,
                index: item.index,
                text: `translated:${item.text}`
              }))
            })
          }]
        }]
      });
    } catch (error) {
      writeJson(res, 500, { error: { message: error.message } });
    }
  });

  return { calls, server };
}

function startTranslator(fakePort, translatorPort) {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(translatorPort),
      TRANSLATOR_BACKEND: "openai",
      OPENAI_API_KEY: "test-only-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${fakePort}`,
      OPENAI_TIMEOUT_MS: "2000",
      LOG_LEVEL: "error"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  const collectLogs = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-12000);
  };
  child.stdout.on("data", collectLogs);
  child.stderr.on("data", collectLogs);

  return { child, getLogs: () => logs };
}

async function waitForTranslator(port, translator) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (translator.child.exitCode !== null || translator.child.signalCode !== null) {
      throw new Error(`Translator exited before startup.\n${translator.getLogs()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The child may not have bound the port yet.
    }
    await wait(20);
  }
  throw new Error(`Translator did not start in time.\n${translator.getLogs()}`);
}

function postTranslation(port, items) {
  return requestJson(port, "/translate", {
    method: "POST",
    token: TRANSLATOR_TOKEN,
    body: { items, targetLanguage: "Chinese (Simplified)" }
  });
}

async function requestJson(port, pathname, options = {}) {
  const headers = {};
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  if (options.token) {
    headers["X-PIT-Token"] = options.token;
  }

  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function waitForCallCount(calls, expected) {
  const deadline = Date.now() + 2000;
  while (calls.length < expected && Date.now() < deadline) {
    await wait(5);
  }
  assert.equal(calls.length, expected, `Expected ${expected} fake model calls, got ${calls.length}`);
}

async function findAvailablePort() {
  const server = http.createServer();
  await listen(server, 0);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeIdleConnections?.();
    server.close((error) => error ? reject(error) : resolve());
  });
}

function stopTranslator(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    "Connection": "close",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
