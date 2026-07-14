#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const ROOT = path.join(__dirname, "..", "..");
const SERVER_PATH = path.join(ROOT, "server", "server.js");
const TOKEN = "pit-perf-token";

const RUN_DEFAULTS = {
  requests: 100,
  concurrency: 16,
  items: 20,
  uniqueRatio: 0.25,
  delayMs: 25,
  textBytes: 80,
  requestTimeoutMs: 10000,
  maxErrorRatePct: 0,
  maxP95Ms: Infinity,
  minThroughputRps: 0,
  minBackendSavingsPct: 0
};

const COMPARE_DEFAULTS = {
  maxP95RegressionPct: 10,
  maxThroughputRegressionPct: 10,
  maxBackendItemsRegressionPct: 0,
  maxErrorRateIncreasePct: 0
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`perf: ${error.message}`);
    process.exitCode = 2;
  });
}

async function main() {
  const [command = "run", ...args] = process.argv.slice(2);

  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }

  if (command === "run") {
    await runCommand(args);
    return;
  }

  if (command === "compare") {
    await compareCommand(args);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function runCommand(args) {
  const raw = parseArgs(args, new Set([
    "requests",
    "concurrency",
    "items",
    "unique-ratio",
    "delay-ms",
    "text-bytes",
    "request-timeout-ms",
    "max-error-rate-pct",
    "max-p95-ms",
    "min-throughput-rps",
    "min-backend-savings-pct",
    "output",
    "json"
  ]), new Set(["json"]));

  if (raw.help) {
    printHelp();
    return;
  }
  if (raw._.length > 0) {
    throw new Error(`run does not accept positional arguments: ${raw._.join(" ")}`);
  }

  const config = {
    requests: numberOption(raw, "requests", RUN_DEFAULTS.requests, { integer: true, min: 1 }),
    concurrency: numberOption(raw, "concurrency", RUN_DEFAULTS.concurrency, { integer: true, min: 1 }),
    items: numberOption(raw, "items", RUN_DEFAULTS.items, { integer: true, min: 1, max: 40 }),
    uniqueRatio: numberOption(raw, "unique-ratio", RUN_DEFAULTS.uniqueRatio, { minExclusive: 0, max: 1 }),
    delayMs: numberOption(raw, "delay-ms", RUN_DEFAULTS.delayMs, { integer: true, min: 0 }),
    textBytes: numberOption(raw, "text-bytes", RUN_DEFAULTS.textBytes, { integer: true, min: 16, max: 20000 }),
    requestTimeoutMs: numberOption(raw, "request-timeout-ms", RUN_DEFAULTS.requestTimeoutMs, { integer: true, min: 1 })
  };
  config.concurrency = Math.min(config.concurrency, config.requests);

  const thresholds = {
    maxErrorRatePct: numberOption(raw, "max-error-rate-pct", RUN_DEFAULTS.maxErrorRatePct, { min: 0, max: 100 }),
    maxP95Ms: numberOption(raw, "max-p95-ms", RUN_DEFAULTS.maxP95Ms, { min: 0, allowInfinity: true }),
    minThroughputRps: numberOption(raw, "min-throughput-rps", RUN_DEFAULTS.minThroughputRps, { min: 0 }),
    minBackendSavingsPct: numberOption(raw, "min-backend-savings-pct", RUN_DEFAULTS.minBackendSavingsPct, { min: 0, max: 100 })
  };

  const result = await runBenchmark(config);
  result.checks = checkRunThresholds(result, thresholds);

  if (raw.output) {
    writeResult(raw.output, result);
  }

  if (raw.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printRunResult(result, raw.output);
  }

  if (result.checks.some((check) => !check.pass)) {
    process.exitCode = 1;
  }
}

async function compareCommand(args) {
  const raw = parseArgs(args, new Set([
    "max-p95-regression-pct",
    "max-throughput-regression-pct",
    "max-backend-items-regression-pct",
    "max-error-rate-increase-pct",
    "allow-config-mismatch",
    "output",
    "json"
  ]), new Set(["json", "allow-config-mismatch"]));

  if (raw.help) {
    printHelp();
    return;
  }

  if (raw._.length !== 2) {
    throw new Error("compare requires BASELINE.json and CURRENT.json");
  }

  const baseline = readResult(raw._[0]);
  const current = readResult(raw._[1]);
  validateComparable(baseline, current, Boolean(raw["allow-config-mismatch"]));

  const limits = {
    maxP95RegressionPct: numberOption(raw, "max-p95-regression-pct", COMPARE_DEFAULTS.maxP95RegressionPct, { min: 0 }),
    maxThroughputRegressionPct: numberOption(raw, "max-throughput-regression-pct", COMPARE_DEFAULTS.maxThroughputRegressionPct, { min: 0 }),
    maxBackendItemsRegressionPct: numberOption(raw, "max-backend-items-regression-pct", COMPARE_DEFAULTS.maxBackendItemsRegressionPct, { min: 0 }),
    maxErrorRateIncreasePct: numberOption(raw, "max-error-rate-increase-pct", COMPARE_DEFAULTS.maxErrorRateIncreasePct, { min: 0 })
  };
  const result = compareResults(baseline, current, limits);

  if (raw.output) {
    writeResult(raw.output, result);
  }

  if (raw.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printComparison(result, raw.output);
  }

  if (result.checks.some((check) => !check.pass)) {
    process.exitCode = 1;
  }
}

async function runBenchmark(config) {
  const fake = createFakeOpenAIServer(config.delayMs);
  let translator;

  try {
    await listen(fake.server, 0);
    const fakePort = fake.server.address().port;
    const translatorPort = await findAvailablePort();
    translator = startTranslator(fakePort, translatorPort);
    await waitForTranslator(translator, translatorPort);

    const workload = createWorkload(config);
    const load = await runLoad(translatorPort, workload.requests, config);
    const serverMetrics = await getServerMetrics(translatorPort);

    await stopChild(translator.child);
    translator = null;

    const sources = serverMetricSources(serverMetrics);
    const result = buildRunResult(config, workload, load, fake.stats, sources, serverMetrics);
    if (load.errors.length > 0) {
      result.errorSamples = load.errors.slice(0, 5);
    }
    return result;
  } finally {
    if (translator) {
      await stopChild(translator.child);
    }
    if (fake.server.listening) {
      await closeServer(fake.server);
    }
  }
}

function createWorkload(config) {
  const totalItems = config.requests * config.items;
  const uniqueTexts = Math.max(1, Math.round(totalItems * config.uniqueRatio));
  const texts = Array.from({ length: uniqueTexts }, (_, index) => makeText(index, config.textBytes));
  const requests = Array.from({ length: config.requests }, (_, requestIndex) => {
    const start = Math.floor(requestIndex * uniqueTexts / config.requests);
    return Array.from({ length: config.items }, (_, itemIndex) => ({
      id: `r${pad(requestIndex)}-i${pad(itemIndex)}`,
      text: texts[(start + itemIndex) % uniqueTexts]
    }));
  });

  return {
    requests,
    totalItems,
    uniqueTexts,
    duplicateItems: totalItems - uniqueTexts,
    realizedUniqueRatio: round(uniqueTexts / totalItems)
  };
}

function makeText(index, bytes) {
  const prefix = `perf-text-${pad(index)} `;
  return `${prefix}${"x".repeat(Math.max(0, bytes - prefix.length))}`;
}

async function runLoad(port, requests, config) {
  const latencies = new Array(requests.length);
  const errors = [];
  let next = 0;
  let succeeded = 0;
  const startedAt = performance.now();

  async function worker() {
    for (;;) {
      const requestIndex = next++;
      if (requestIndex >= requests.length) {
        return;
      }

      const requestStartedAt = performance.now();
      try {
        await postTranslation(port, requests[requestIndex], config.requestTimeoutMs);
        succeeded += 1;
      } catch (error) {
        errors.push({ request: requestIndex, error: error.message });
      } finally {
        latencies[requestIndex] = performance.now() - requestStartedAt;
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  const durationMs = performance.now() - startedAt;

  return {
    durationMs,
    errors,
    latencies,
    succeeded
  };
}

function startTranslator(fakePort, translatorPort) {
  let logs = "";
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(translatorPort),
      TRANSLATOR_BACKEND: "openai",
      OPENAI_API_KEY: "fake-perf-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${fakePort}`,
      OPENAI_TIMEOUT_MS: "30000",
      TRANSLATOR_TOKEN: TOKEN,
      LOG_LEVEL: "info"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const consume = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-20000);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  return { child, getLogs: () => logs };
}

function createFakeOpenAIServer(delayMs) {
  const stats = {
    calls: 0,
    items: 0,
    active: 0,
    peakConcurrency: 0
  };

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/responses") {
      writeJson(res, 404, { error: { message: "Not found" } });
      return;
    }

    stats.active += 1;
    stats.peakConcurrency = Math.max(stats.peakConcurrency, stats.active);
    try {
      const payload = await readJson(req);
      const input = JSON.parse(payload.input?.[1]?.content || "{}");
      const items = Array.isArray(input.items) ? input.items : [];
      stats.calls += 1;
      stats.items += items.length;

      if (delayMs > 0) {
        await wait(delayMs);
      }

      const translations = items.map((item) => ({
        id: item.id,
        index: item.index,
        text: `translated:${item.text}`
      }));
      writeJson(res, 200, {
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ translations }) }] }]
      });
    } catch (error) {
      writeJson(res, 500, { error: { message: error.message } });
    } finally {
      stats.active -= 1;
    }
  });

  return { server, stats };
}

function serverMetricSources(metrics) {
  return {
    source: "metrics",
    exactDedupeItems: metrics.items.input - metrics.items.unique,
    cacheGroups: metrics.sources.cacheHits,
    coalescedGroups: metrics.sources.coalescedHits,
    backendMissGroups: metrics.sources.backendMisses,
    observedRequests: metrics.requests.total,
    observedItems: metrics.items.input
  };
}

function buildRunResult(config, workload, load, backend, sources, serverMetrics) {
  const latency = summarizeLatencies(load.latencies);
  const errors = config.requests - load.succeeded;
  const backendAvoidedItems = workload.totalItems - backend.items;

  return {
    schemaVersion: 1,
    type: "personal-immersive-translator-perf",
    generatedAt: new Date().toISOString(),
    config,
    workload: {
      totalItems: workload.totalItems,
      uniqueTexts: workload.uniqueTexts,
      duplicateItems: workload.duplicateItems,
      realizedUniqueRatio: workload.realizedUniqueRatio
    },
    requests: {
      total: config.requests,
      succeeded: load.succeeded,
      errors,
      errorRatePct: percent(errors, config.requests)
    },
    timing: {
      durationMs: round(load.durationMs),
      throughputRps: round(load.succeeded / (load.durationMs / 1000)),
      itemThroughputPerSecond: round((load.succeeded * config.items) / (load.durationMs / 1000)),
      latencyMs: latency
    },
    backend: {
      calls: backend.calls,
      items: backend.items,
      peakConcurrency: backend.peakConcurrency,
      avoidedCalls: Math.max(0, load.succeeded - backend.calls),
      avoidedItems: backendAvoidedItems,
      itemSavingsPct: percent(backendAvoidedItems, workload.totalItems)
    },
    effects: sources,
    observability: {
      server: serverMetrics ? {
        latencyMs: serverMetrics.latencyMs,
        inFlightSize: serverMetrics.inFlightSize,
        cacheSize: serverMetrics.cacheSize
      } : null,
      crossChecks: {
        requestCountMatches: sources.observedRequests === config.requests,
        itemCountMatches: sources.observedItems === workload.totalItems,
        backendCallsMatch: serverMetrics ? serverMetrics.backendCalls === backend.calls : null,
        backendItemsMatch: sources.backendMissGroups === backend.items
      }
    }
  };
}

function summarizeLatencies(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  }
  return {
    min: round(sorted[0]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1])
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function checkRunThresholds(result, thresholds) {
  return [
    check(
      "error-rate",
      result.requests.errorRatePct <= thresholds.maxErrorRatePct,
      result.requests.errorRatePct,
      `<= ${thresholds.maxErrorRatePct}%`
    ),
    check(
      "p95-latency",
      result.timing.latencyMs.p95 !== null && result.timing.latencyMs.p95 <= thresholds.maxP95Ms,
      result.timing.latencyMs.p95,
      `<= ${formatLimit(thresholds.maxP95Ms)} ms`
    ),
    check(
      "throughput",
      result.timing.throughputRps >= thresholds.minThroughputRps,
      result.timing.throughputRps,
      `>= ${thresholds.minThroughputRps} req/s`
    ),
    check(
      "backend-item-savings",
      result.backend.itemSavingsPct >= thresholds.minBackendSavingsPct,
      result.backend.itemSavingsPct,
      `>= ${thresholds.minBackendSavingsPct}%`
    ),
    check(
      "observability",
      result.effects.observedRequests === result.requests.total,
      result.effects.observedRequests,
      `= ${result.requests.total} requests`
    ),
    check(
      "item-accounting",
      result.observability.crossChecks.itemCountMatches,
      result.effects.observedItems,
      `= ${result.workload.totalItems} input items`
    ),
    check(
      "backend-call-accounting",
      result.observability.crossChecks.backendCallsMatch !== false,
      result.backend.calls,
      "= server metrics backendCalls"
    ),
    check(
      "backend-item-accounting",
      result.observability.crossChecks.backendItemsMatch,
      result.backend.items,
      `= ${result.effects.backendMissGroups} server backend misses`
    ),
    check(
      "in-flight-drained",
      result.observability.server.inFlightSize === 0,
      result.observability.server.inFlightSize,
      "= 0"
    )
  ];
}

function compareResults(baseline, current, limits) {
  const metrics = {
    p50LatencyMs: delta(baseline.timing.latencyMs.p50, current.timing.latencyMs.p50),
    p95LatencyMs: delta(baseline.timing.latencyMs.p95, current.timing.latencyMs.p95),
    p99LatencyMs: delta(baseline.timing.latencyMs.p99, current.timing.latencyMs.p99),
    throughputRps: delta(baseline.timing.throughputRps, current.timing.throughputRps),
    backendCalls: delta(baseline.backend.calls, current.backend.calls),
    backendItems: delta(baseline.backend.items, current.backend.items),
    errorRatePct: {
      baseline: baseline.requests.errorRatePct,
      current: current.requests.errorRatePct,
      percentagePointChange: round(current.requests.errorRatePct - baseline.requests.errorRatePct)
    }
  };

  const checks = [
    check(
      "p95-regression",
      metrics.p95LatencyMs.changePct <= limits.maxP95RegressionPct,
      metrics.p95LatencyMs.changePct,
      `<= ${limits.maxP95RegressionPct}%`
    ),
    check(
      "throughput-regression",
      metrics.throughputRps.changePct >= -limits.maxThroughputRegressionPct,
      metrics.throughputRps.changePct,
      `>= -${limits.maxThroughputRegressionPct}%`
    ),
    check(
      "backend-items-regression",
      metrics.backendItems.changePct <= limits.maxBackendItemsRegressionPct,
      metrics.backendItems.changePct,
      `<= ${limits.maxBackendItemsRegressionPct}%`
    ),
    check(
      "error-rate-increase",
      metrics.errorRatePct.percentagePointChange <= limits.maxErrorRateIncreasePct,
      metrics.errorRatePct.percentagePointChange,
      `<= ${limits.maxErrorRateIncreasePct} percentage points`
    )
  ];

  return {
    schemaVersion: 1,
    type: "personal-immersive-translator-perf-comparison",
    generatedAt: new Date().toISOString(),
    baseline: baseline.generatedAt || null,
    current: current.generatedAt || null,
    config: current.config,
    limits,
    metrics,
    checks,
    pass: checks.every((item) => item.pass)
  };
}

function delta(baseline, current) {
  const change = current - baseline;
  return {
    baseline,
    current,
    change: round(change),
    changePct: baseline === 0 ? (change === 0 ? 0 : Infinity) : round(change / baseline * 100)
  };
}

function check(name, pass, actual, expected) {
  return { name, pass, actual, expected };
}

function validateComparable(baseline, current, allowMismatch) {
  for (const result of [baseline, current]) {
    if (result?.type !== "personal-immersive-translator-perf" || !result.config || !result.timing || !result.backend) {
      throw new Error("compare accepts JSON created by this tool's run command");
    }
  }

  if (allowMismatch) {
    return;
  }

  const keys = ["requests", "concurrency", "items", "uniqueRatio", "delayMs", "textBytes", "requestTimeoutMs"];
  const mismatches = keys.filter((key) => baseline.config[key] !== current.config[key]);
  if (mismatches.length > 0) {
    throw new Error(`benchmark configs differ (${mismatches.join(", ")}); pass --allow-config-mismatch to override`);
  }
}

async function postTranslation(port, items, timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${port}/translate`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      "X-PIT-Token": TOKEN
    },
    body: JSON.stringify({ items, targetLanguage: "Chinese (Simplified)" })
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${payload.error || text.slice(0, 160)}`);
  }

  if (!Array.isArray(payload.translations) || payload.translations.length !== items.length) {
    throw new Error(`expected ${items.length} translations, got ${payload.translations?.length ?? "none"}`);
  }

  for (let index = 0; index < items.length; index += 1) {
    const translation = payload.translations[index];
    if (translation.id !== items[index].id || translation.text !== `translated:${items[index].text}`) {
      throw new Error(`translation mismatch at item ${index}`);
    }
  }
}

async function getServerMetrics(port) {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!response.ok) {
    throw new Error(`metrics endpoint failed with HTTP ${response.status}`);
  }

  const metrics = await response.json();
  if (!metrics.requests || !metrics.items || !metrics.sources || !metrics.latencyMs) {
    throw new Error("metrics endpoint returned an invalid payload");
  }
  return metrics;
}

async function waitForTranslator(translator, port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (translator.child.exitCode !== null || translator.child.signalCode !== null) {
      throw new Error(`translator exited before startup\n${translator.getLogs()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The child may not have bound its port yet.
    }
    await wait(20);
  }
  throw new Error(`translator did not start in time\n${translator.getLogs()}`);
}

function parseArgs(args, allowed, booleans) {
  const result = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }

    const separator = arg.indexOf("=");
    const name = arg.slice(2, separator < 0 ? undefined : separator);
    if (!allowed.has(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    if (booleans.has(name)) {
      if (separator >= 0) {
        throw new Error(`--${name} does not accept a value`);
      }
      result[name] = true;
      continue;
    }

    const value = separator >= 0 ? arg.slice(separator + 1) : args[++index];
    if (value === undefined) {
      throw new Error(`--${name} requires a value`);
    }
    result[name] = value;
  }
  return result;
}

function numberOption(raw, name, fallback, limits = {}) {
  if (raw[name] === undefined) {
    return fallback;
  }
  const value = Number(raw[name]);
  if ((!Number.isFinite(value) && !(limits.allowInfinity && value === Infinity)) ||
      (limits.integer && !Number.isInteger(value)) ||
      (limits.min !== undefined && value < limits.min) ||
      (limits.minExclusive !== undefined && value <= limits.minExclusive) ||
      (limits.max !== undefined && value > limits.max)) {
    throw new Error(`invalid value for --${name}: ${raw[name]}`);
  }
  return value;
}

function readResult(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

function writeResult(file, result) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`);
}

function printRunResult(result, output) {
  const latency = result.timing.latencyMs;
  console.log("Gloss deterministic performance run");
  console.log(`  load       ${result.config.requests} requests x ${result.config.items} items @ concurrency ${result.config.concurrency}`);
  console.log(`  latency    p50 ${latency.p50} ms | p95 ${latency.p95} ms | p99 ${latency.p99} ms`);
  console.log(`  throughput ${result.timing.throughputRps} req/s | ${result.timing.itemThroughputPerSecond} items/s`);
  console.log(`  errors     ${result.requests.errors}/${result.requests.total} (${result.requests.errorRatePct}%)`);
  console.log(`  backend    ${result.backend.calls} calls | ${result.backend.items}/${result.workload.totalItems} items | peak ${result.backend.peakConcurrency}`);
  console.log(`  saved      ${result.backend.avoidedItems} items (${result.backend.itemSavingsPct}%)`);
  console.log(`  sources    exact dedupe ${result.effects.exactDedupeItems} | coalesced ${result.effects.coalescedGroups} | cache ${result.effects.cacheGroups}`);
  printChecks(result.checks);
  if (output) {
    console.log(`  output     ${path.resolve(output)}`);
  }
}

function printComparison(result, output) {
  console.log("PIT performance comparison");
  printDelta("p50 latency", result.metrics.p50LatencyMs, "ms");
  printDelta("p95 latency", result.metrics.p95LatencyMs, "ms");
  printDelta("p99 latency", result.metrics.p99LatencyMs, "ms");
  printDelta("throughput", result.metrics.throughputRps, "req/s");
  printDelta("backend items", result.metrics.backendItems, "items");
  console.log(`  error rate       ${result.metrics.errorRatePct.baseline}% -> ${result.metrics.errorRatePct.current}% (${signed(result.metrics.errorRatePct.percentagePointChange)} pp)`);
  printChecks(result.checks);
  if (output) {
    console.log(`  output           ${path.resolve(output)}`);
  }
}

function printDelta(label, metric, unit) {
  console.log(`  ${label.padEnd(16)} ${metric.baseline} -> ${metric.current} ${unit} (${signed(metric.changePct)}%)`);
}

function printChecks(checks) {
  const failed = checks.filter((item) => !item.pass);
  console.log(`  checks     ${failed.length === 0 ? "PASS" : `FAIL (${failed.map((item) => item.name).join(", ")})`}`);
}

function printHelp() {
  console.log(`Usage:
  node tools/perf/benchmark.js run [options]
  node tools/perf/benchmark.js compare BASELINE.json CURRENT.json [options]

Run options:
  --requests N                    total requests (default ${RUN_DEFAULTS.requests})
  --concurrency N                 parallel requests (default ${RUN_DEFAULTS.concurrency})
  --items N                       items per request, 1..40 (default ${RUN_DEFAULTS.items})
  --unique-ratio N                unique texts, >0..1 (default ${RUN_DEFAULTS.uniqueRatio})
  --delay-ms N                    deterministic fake-model latency (default ${RUN_DEFAULTS.delayMs})
  --text-bytes N                  approximate bytes per text (default ${RUN_DEFAULTS.textBytes})
  --request-timeout-ms N          timeout for each request (default ${RUN_DEFAULTS.requestTimeoutMs})
  --max-error-rate-pct N          fail above this error rate (default 0)
  --max-p95-ms N                  fail above this p95 latency
  --min-throughput-rps N          fail below this throughput
  --min-backend-savings-pct N     fail below this item savings

Compare options:
  --max-p95-regression-pct N      default ${COMPARE_DEFAULTS.maxP95RegressionPct}
  --max-throughput-regression-pct N  default ${COMPARE_DEFAULTS.maxThroughputRegressionPct}
  --max-backend-items-regression-pct N  default ${COMPARE_DEFAULTS.maxBackendItemsRegressionPct}
  --max-error-rate-increase-pct N default ${COMPARE_DEFAULTS.maxErrorRateIncreasePct}
  --allow-config-mismatch         compare runs with different load settings

Common options:
  --output FILE                   write the result JSON to a file
  --json                          print JSON instead of the human summary
  --help                          show this help

The tool starts a local fake OpenAI Responses API and the repository's current
server/server.js. It never sends data to a real model.`);
}

function signed(value) {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return value > 0 ? `+${value}` : String(value);
}

function formatLimit(value) {
  return Number.isFinite(value) ? value : "Infinity";
}

function percent(part, whole) {
  return whole === 0 ? 0 : round(part / whole * 100);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function pad(value) {
  return String(value).padStart(6, "0");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function findAvailablePort() {
  const server = http.createServer();
  await listen(server, 0);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function stopChild(child) {
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

module.exports = {
  compareResults,
  createWorkload,
  summarizeLatencies
};
