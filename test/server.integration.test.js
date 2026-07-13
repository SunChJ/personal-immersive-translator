const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const TRANSLATOR_TOKEN = "pit-local-extension-token-v1";

test("deduplicates, coalesces, caches, and retries translations", { timeout: 15000 }, async () => {
  const fake = createFakeResponsesServer();
  let translator = null;

  try {
    await listen(fake.server, 0);
    const fakePort = fake.server.address().port;
    const translatorPort = await findAvailablePort();
    translator = startTranslator({ fakePort, translatorPort });
    await waitForTranslator(translatorPort, translator);

    const duplicate = await postTranslation(translatorPort, [
      { id: "duplicate-1", text: "same full paragraph" },
      { id: "duplicate-2", text: "same full paragraph" }
    ]);

    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body.translations, [
      { id: "duplicate-1", text: "translated:same full paragraph" },
      { id: "duplicate-2", text: "translated:same full paragraph" }
    ]);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].texts, ["same full paragraph"]);

    const cached = await postTranslation(translatorPort, [
      { id: "cached", text: "same full paragraph" }
    ]);

    assert.equal(cached.status, 200);
    assert.deepEqual(cached.body.translations, [
      { id: "cached", text: "translated:same full paragraph" }
    ]);
    assert.equal(fake.calls.length, 1);

    const concurrentFirst = postTranslation(translatorPort, [
      { id: "concurrent-1", text: "shared concurrent paragraph" }
    ]);
    await waitForCallCount(fake.calls, 2);
    const concurrentSecond = postTranslation(translatorPort, [
      { id: "concurrent-2", text: "shared concurrent paragraph" }
    ]);
    const concurrent = await Promise.all([concurrentFirst, concurrentSecond]);

    assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
    assert.deepEqual(concurrent.map((response) => response.body.translations), [
      [{ id: "concurrent-1", text: "translated:shared concurrent paragraph" }],
      [{ id: "concurrent-2", text: "translated:shared concurrent paragraph" }]
    ]);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls[1].texts, ["shared concurrent paragraph"]);

    const failedFirst = postTranslation(translatorPort, [
      { id: "failed-1", text: "retry after failure" }
    ]);
    await waitForCallCount(fake.calls, 3);
    const failedSecond = postTranslation(translatorPort, [
      { id: "failed-2", text: "retry after failure" }
    ]);
    const failed = await Promise.all([failedFirst, failedSecond]);

    assert.deepEqual(failed.map((response) => response.status), [500, 500]);
    assert.equal(fake.calls.length, 3);

    const retried = await postTranslation(translatorPort, [
      { id: "retried", text: "retry after failure" }
    ]);

    assert.equal(retried.status, 200);
    assert.deepEqual(retried.body.translations, [
      { id: "retried", text: "translated:retry after failure" }
    ]);
    assert.equal(fake.calls.length, 4);
    assert.deepEqual(fake.calls[3].texts, ["retry after failure"]);

    const missing = await postTranslation(translatorPort, [
      { id: "missing", text: "missing model result" }
    ]);
    assert.equal(missing.status, 500);
    assert.equal(fake.calls.length, 5);

    const missingRetried = await postTranslation(translatorPort, [
      { id: "missing-retried", text: "missing model result" }
    ]);
    assert.equal(missingRetried.status, 200);
    assert.deepEqual(missingRetried.body.translations, [
      { id: "missing-retried", text: "translated:missing model result" }
    ]);
    assert.equal(fake.calls.length, 6);

    const mixed = await postTranslation(translatorPort, [
      { id: "mixed-1", text: "mixed model result" },
      { id: "mixed-2", text: "mixed companion result" }
    ]);
    assert.equal(mixed.status, 500);
    assert.equal(fake.calls.length, 7);

    const mixedRetried = await postTranslation(translatorPort, [
      { id: "mixed-retry-1", text: "mixed model result" },
      { id: "mixed-retry-2", text: "mixed companion result" }
    ]);
    assert.equal(mixedRetried.status, 200);
    assert.deepEqual(mixedRetried.body.translations, [
      { id: "mixed-retry-1", text: "translated:mixed model result" },
      { id: "mixed-retry-2", text: "translated:mixed companion result" }
    ]);
    assert.equal(fake.calls.length, 8);

    const tooLong = await postTranslation(translatorPort, [
      { id: "too-long", text: "x".repeat(20001) }
    ]);
    assert.equal(tooLong.status, 500);
    assert.equal(fake.calls.length, 8);

    const wrongIndex = await postTranslation(translatorPort, [
      { id: "wrong-index", text: "wrong model index" }
    ]);
    assert.equal(wrongIndex.status, 500);
    assert.match(wrongIndex.body.error, /index/);
    assert.equal(fake.calls.length, 9);

    const indexRetried = await postTranslation(translatorPort, [
      { id: "index-retried", text: "wrong model index" }
    ]);
    assert.equal(indexRetried.status, 200);
    assert.equal(fake.calls.length, 10);

    const unidentified = await postTranslation(translatorPort, [
      { id: "unidentified", text: "unidentified model result" }
    ]);
    assert.equal(unidentified.status, 500);
    assert.match(unidentified.body.error, /valid id/);
    assert.equal(fake.calls.length, 11);

    const unidentifiedRetried = await postTranslation(translatorPort, [
      { id: "unidentified-retried", text: "unidentified model result" }
    ]);
    assert.equal(unidentifiedRetried.status, 200);
    assert.equal(fake.calls.length, 12);

    const unknown = await postTranslation(translatorPort, [
      { id: "unknown", text: "unknown model result" }
    ]);
    assert.equal(unknown.status, 500);
    assert.match(unknown.body.error, /unknown id/);
    assert.equal(fake.calls.length, 13);

    const unknownRetried = await postTranslation(translatorPort, [
      { id: "unknown-retried", text: "unknown model result" }
    ]);
    assert.equal(unknownRetried.status, 200);
    assert.equal(fake.calls.length, 14);

    const duplicateId = await postTranslation(translatorPort, [
      { id: "duplicate-id-1", text: "duplicate model result" },
      { id: "duplicate-id-2", text: "duplicate companion result" }
    ]);
    assert.equal(duplicateId.status, 500);
    assert.match(duplicateId.body.error, /duplicate id/);
    assert.equal(fake.calls.length, 15);

    const duplicateIdRetried = await postTranslation(translatorPort, [
      { id: "duplicate-id-retry-1", text: "duplicate model result" },
      { id: "duplicate-id-retry-2", text: "duplicate companion result" }
    ]);
    assert.equal(duplicateIdRetried.status, 200);
    assert.equal(fake.calls.length, 16);
  } finally {
    if (translator) {
      await stopTranslator(translator.child);
    }
    if (fake.server.listening) {
      await closeServer(fake.server);
    }
  }
});

test("registers Codex turns, rejects interrupted output, and bounds isolated concurrency", { timeout: 10000 }, async () => {
  const translatorPort = await findAvailablePort();
  const translator = startFakeCodexTranslator(translatorPort);

  try {
    await waitForTranslator(translatorPort, translator);

    const translated = await postTranslation(translatorPort, [
      { id: "codex-race", text: "coalesced notification response" }
    ]);
    assert.equal(translated.status, 200);
    assert.deepEqual(translated.body.translations, [
      { id: "codex-race", text: "translated:coalesced notification response" }
    ]);

    const interrupted = await postTranslation(translatorPort, [
      { id: "codex-interrupted", text: "interrupt this turn" }
    ]);
    assert.equal(interrupted.status, 500);
    assert.match(interrupted.body.error, /interrupted/);

    const concurrent = Array.from({ length: 10 }, (_, index) => postTranslation(translatorPort, [
      { id: `bounded-${index}`, text: `bounded concurrency ${index}` }
    ]));
    const during = await waitForCodexQueue(translatorPort, 7);
    assert.deepEqual(during.codex, {
      active: 3,
      queued: 7,
      max: 3,
      cleanupPending: 0,
      cleanupFailures: 0
    });

    const completed = await Promise.all(concurrent);
    assert.deepEqual(completed.map((response) => response.status), Array(10).fill(200));
    const after = await readMetrics(translatorPort);
    assert.deepEqual(after.codex, {
      active: 0,
      queued: 0,
      max: 3,
      cleanupPending: 0,
      cleanupFailures: 0
    });

    const lifecycle = readFakeCodexStats(translator.statsFile);
    const startedThreads = lifecycle.filter((entry) => entry.method === "thread/start");
    const startedTurns = lifecycle.filter((entry) => entry.method === "turn/start");
    const deletedThreads = lifecycle.filter((entry) => entry.method === "thread/delete");
    const interruptedTurns = lifecycle.filter((entry) => entry.method === "turn/interrupt");
    assert.equal(startedThreads.length, 12);
    assert.equal(startedTurns.length, 12);
    assert.equal(deletedThreads.length, 12);
    assert.equal(interruptedTurns.length, 1);
    assert.equal(new Set(startedTurns.map((entry) => entry.threadId)).size, 12);
    assert.deepEqual(
      new Set(deletedThreads.map((entry) => entry.threadId)),
      new Set(startedTurns.map((entry) => entry.threadId))
    );
  } finally {
    await stopTranslator(translator.child);
    fs.rmSync(translator.statsFile, { force: true });
  }
});

function createFakeResponsesServer() {
  const calls = [];
  const failOnce = new Set(["retry after failure"]);
  const mixOnce = new Set(["mixed model result"]);
  const omitOnce = new Set(["missing model result"]);
  const wrongIndexOnce = new Set(["wrong model index"]);
  const unidentifiedOnce = new Set(["unidentified model result"]);
  const unknownOnce = new Set(["unknown model result"]);
  const duplicateOnce = new Set(["duplicate model result"]);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/responses") {
        writeJson(res, 404, { error: { message: "Not found" } });
        return;
      }

      const payload = await readJson(req);
      const input = JSON.parse(payload.input[1].content);
      const texts = input.items.map((item) => item.text);
      calls.push({ texts });

      await wait(120);

      const plannedFailure = texts.find((text) => failOnce.has(text));
      if (plannedFailure) {
        failOnce.delete(plannedFailure);
        writeJson(res, 500, { error: { message: "Planned fake failure" } });
        return;
      }

      let translations = input.items.map((item) => ({
        id: item.id,
        index: item.index,
        text: `translated:${item.text}`
      }));
      const plannedOmission = texts.find((text) => omitOnce.has(text));
      if (plannedOmission) {
        omitOnce.delete(plannedOmission);
        translations = [];
      }
      const plannedMix = texts.find((text) => mixOnce.has(text));
      if (plannedMix) {
        mixOnce.delete(plannedMix);
        delete translations[translations.length - 1].id;
      }
      const plannedWrongIndex = texts.find((text) => wrongIndexOnce.has(text));
      if (plannedWrongIndex) {
        wrongIndexOnce.delete(plannedWrongIndex);
        translations[0].index += 1;
      }
      const plannedUnidentified = texts.find((text) => unidentifiedOnce.has(text));
      if (plannedUnidentified) {
        unidentifiedOnce.delete(plannedUnidentified);
        delete translations[0].id;
      }
      const plannedUnknown = texts.find((text) => unknownOnce.has(text));
      if (plannedUnknown) {
        unknownOnce.delete(plannedUnknown);
        translations[0].id = "unrecognized-id";
      }
      const plannedDuplicate = texts.find((text) => duplicateOnce.has(text));
      if (plannedDuplicate) {
        duplicateOnce.delete(plannedDuplicate);
        translations[1].id = translations[0].id;
      }
      writeJson(res, 200, {
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ translations })
              }
            ]
          }
        ]
      });
    } catch (error) {
      writeJson(res, 500, { error: { message: error.message } });
    }
  });

  return { calls, server };
}

function startTranslator({ fakePort, translatorPort }) {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(translatorPort),
      TRANSLATOR_BACKEND: "openai",
      OPENAI_API_KEY: "test-only-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${fakePort}`,
      LOG_LEVEL: "info"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  const collectLogs = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-12000);
  };
  child.stdout.on("data", collectLogs);
  child.stderr.on("data", collectLogs);

  return {
    child,
    getLogs: () => logs
  };
}

function startFakeCodexTranslator(translatorPort) {
  const statsFile = path.join(os.tmpdir(), `pit-fake-codex-${process.pid}-${Date.now()}.jsonl`);
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(translatorPort),
      TRANSLATOR_BACKEND: "codex-app",
      CODEX_BIN: path.join(__dirname, "fake-codex-app-server.js"),
      CODEX_APP_MAX_CONCURRENCY: "3",
      CODEX_PREWARM: "0",
      PIT_FAKE_CODEX_STATS_FILE: statsFile,
      LOG_LEVEL: "info"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  const collectLogs = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-12000);
  };
  child.stdout.on("data", collectLogs);
  child.stderr.on("data", collectLogs);

  return {
    child,
    statsFile,
    getLogs: () => logs
  };
}

function readFakeCodexStats(statsFile) {
  return fs.readFileSync(statsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

async function postTranslation(port, items) {
  const response = await fetch(`http://127.0.0.1:${port}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PIT-Token": TRANSLATOR_TOKEN
    },
    body: JSON.stringify({
      items,
      targetLanguage: "Chinese (Simplified)"
    })
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text ? JSON.parse(text) : {}
  };
}

async function readMetrics(port) {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForCodexQueue(port, minimumQueued) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const metrics = await readMetrics(port);
    if (metrics.codex?.active === 3 && metrics.codex.queued >= minimumQueued) {
      return metrics;
    }
    await wait(10);
  }
  throw new Error(`Codex queue did not reach ${minimumQueued}.`);
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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
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
