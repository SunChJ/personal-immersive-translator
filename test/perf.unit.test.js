const assert = require("node:assert/strict");
const test = require("node:test");

const {
  compareResults,
  createWorkload,
  summarizeLatencies
} = require("../tools/perf/benchmark.js");

test("performance workload is deterministic and honors the unique ratio", () => {
  const workload = createWorkload({
    requests: 4,
    items: 4,
    uniqueRatio: 0.25,
    textBytes: 32
  });

  assert.equal(workload.totalItems, 16);
  assert.equal(workload.uniqueTexts, 4);
  assert.equal(workload.duplicateItems, 12);
  assert.equal(workload.realizedUniqueRatio, 0.25);
  assert.equal(new Set(workload.requests.flat().map((item) => item.id)).size, 16);
  assert.equal(new Set(workload.requests.flat().map((item) => item.text)).size, 4);
});

test("latency summary and regression gates use stable percentile boundaries", () => {
  assert.deepEqual(summarizeLatencies([100, 1, 4, 2, 3]), {
    min: 1,
    mean: 22,
    p50: 3,
    p95: 100,
    p99: 100,
    max: 100
  });

  const baseline = result({ p50: 10, p95: 20, p99: 30, throughput: 100, backendItems: 200 });
  const atLimit = result({ p50: 11, p95: 22, p99: 33, throughput: 90, backendItems: 200 });
  const limits = {
    maxP95RegressionPct: 10,
    maxThroughputRegressionPct: 10,
    maxBackendItemsRegressionPct: 0,
    maxErrorRateIncreasePct: 0
  };

  assert.equal(compareResults(baseline, atLimit, limits).pass, true);

  const regressed = result({ p50: 12, p95: 24, p99: 36, throughput: 80, backendItems: 220 });
  const comparison = compareResults(baseline, regressed, limits);
  assert.equal(comparison.pass, false);
  assert.deepEqual(
    comparison.checks.filter((check) => !check.pass).map((check) => check.name),
    ["p95-regression", "throughput-regression", "backend-items-regression"]
  );
});

function result({ p50, p95, p99, throughput, backendItems }) {
  return {
    generatedAt: "2026-07-09T00:00:00.000Z",
    config: {},
    requests: { errorRatePct: 0 },
    timing: {
      throughputRps: throughput,
      latencyMs: { p50, p95, p99 }
    },
    backend: { calls: 10, items: backendItems }
  };
}
