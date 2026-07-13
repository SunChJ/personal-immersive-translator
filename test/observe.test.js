const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const OBSERVE = path.join(__dirname, "..", "tools", "observe.js");

test("observe CLI evaluates metrics without exposing content", async () => {
  const requests = [];
  const metrics = createMetrics();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, token: req.headers["x-pit-token"], url: req.url });
    writeJson(res, 200, metrics);
  });

  try {
    await listen(server);
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const report = await execFileAsync(process.execPath, [OBSERVE, "--endpoint", endpoint]);

    assert.match(report.stdout, /Prism metrics\s+PASS/);
    assert.match(report.stdout, /10\/10 ok \(100\.0%\)/);
    assert.match(report.stdout, /p95 42\.0ms/);
    assert.match(report.stdout, /latest 10/);
    assert.match(report.stdout, /75\.0% backend work avoided/);
    assert.doesNotMatch(report.stdout, /private source text/);

    const json = await execFileAsync(process.execPath, [OBSERVE, "--endpoint", endpoint, "--json"]);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.requests.total, 10);
    assert.ok(parsed.observedAt);

    await execFileAsync(process.execPath, [
      OBSERVE,
      "--endpoint", endpoint,
      "--reset",
      "--token", "test-token",
      "--json"
    ]);
    assert.deepEqual(requests.slice(-2), [
      { method: "POST", token: "test-token", url: "/metrics/reset" },
      { method: "GET", token: undefined, url: "/metrics" }
    ]);

    metrics.requests = { total: 10, succeeded: 9, failed: 1 };
    await assert.rejects(
      execFileAsync(process.execPath, [OBSERVE, "--endpoint", endpoint]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /Prism metrics\s+FAIL/);
        return true;
      }
    );
  } finally {
    await close(server);
  }
});

function createMetrics() {
  return {
    uptimeMs: 12000,
    requests: { total: 10, succeeded: 10, failed: 0 },
    items: { input: 100, unique: 50 },
    sources: { cacheHits: 15, coalescedHits: 10, backendMisses: 25 },
    backendCalls: 4,
    latencyMs: {
      count: 10,
      total: 200,
      average: 20,
      min: 8,
      p50: 18,
      p95: 42,
      p99: 45,
      max: 45,
      samples: 10,
      percentileWindow: "latest",
      percentileWindowSize: 10,
      percentileWindowCapacity: 2048
    },
    inFlightSize: 0,
    cacheSize: 25
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
