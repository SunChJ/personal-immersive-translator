#!/usr/bin/env node

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const DEFAULT_TOKEN = "pit-local-extension-token-v1";

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.reset) {
    await fetchMetrics(options, true);
  }

  do {
    const metrics = await fetchMetrics(options, false);
    const evaluation = evaluateMetrics(metrics);
    if (options.json) {
      console.log(JSON.stringify({ observedAt: new Date().toISOString(), evaluation, ...metrics }, null, 2));
    } else {
      printReport(metrics, evaluation);
    }
    if (evaluation.verdict === "FAIL") {
      process.exitCode = 1;
    }

    if (!options.watchSeconds) {
      break;
    }
    await wait(options.watchSeconds * 1000);
  } while (true);
}

function parseArgs(args) {
  const options = {
    endpoint: process.env.PIT_ENDPOINT || DEFAULT_ENDPOINT,
    token: process.env.TRANSLATOR_TOKEN || DEFAULT_TOKEN,
    json: false,
    reset: false,
    watchSeconds: 0
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--endpoint") {
      options.endpoint = requireValue(args, ++index, arg);
    } else if (arg === "--token") {
      options.token = requireValue(args, ++index, arg);
    } else if (arg === "--watch") {
      options.watchSeconds = positiveNumber(requireValue(args, ++index, arg), arg);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--reset") {
      options.reset = true;
    } else if (["-h", "--help"].includes(arg)) {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.endpoint = options.endpoint.replace(/\/+$/, "");
  return options;
}

async function fetchMetrics(options, reset) {
  const response = await fetch(`${options.endpoint}${reset ? "/metrics/reset" : "/metrics"}`, {
    method: reset ? "POST" : "GET",
    headers: reset ? { "X-PIT-Token": options.token } : undefined,
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Metrics endpoint returned non-JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(body.error || `Metrics endpoint failed with HTTP ${response.status}`);
  }
  return body;
}

function evaluateMetrics(metrics) {
  const requests = metrics.requests || {};
  const items = metrics.items || {};
  const sources = metrics.sources || {};
  const successRate = ratio(requests.succeeded, requests.total);
  const backendSavings = ratio((items.input || 0) - (sources.backendMisses || 0), items.input);
  const sourceTotal = (sources.cacheHits || 0) + (sources.coalescedHits || 0) + (sources.backendMisses || 0);
  const reuseRate = ratio((sources.cacheHits || 0) + (sources.coalescedHits || 0), sourceTotal);
  const verdict = requests.total === 0
    ? "IDLE"
    : requests.failed === 0
      ? "PASS"
      : successRate >= 0.99
        ? "WARN"
        : "FAIL";

  return { backendSavings, reuseRate, successRate, verdict };
}

function printReport(metrics, evaluation) {
  const requests = metrics.requests || {};
  const items = metrics.items || {};
  const sources = metrics.sources || {};
  const latency = metrics.latencyMs || {};

  console.log(`Gloss metrics  ${evaluation.verdict}  uptime ${formatDuration(metrics.uptimeMs)}`);
  console.log(`requests       ${requests.succeeded || 0}/${requests.total || 0} ok (${formatPercent(evaluation.successRate)})`);
  console.log(`latency        p50 ${formatMs(latency.p50)}  p95 ${formatMs(latency.p95)}  p99 ${formatMs(latency.p99)}  latest ${latency.percentileWindowSize ?? latency.samples ?? 0}`);
  console.log(`items          ${items.input || 0} input  ${items.unique || 0} unique`);
  console.log(`reuse          ${formatPercent(evaluation.reuseRate)} cache/coalesced  ${formatPercent(evaluation.backendSavings)} backend work avoided`);
  console.log(`sources        ${sources.cacheHits || 0} cache  ${sources.coalescedHits || 0} coalesced  ${sources.backendMisses || 0} backend`);
  console.log(`runtime        ${metrics.backendCalls || 0} backend calls  ${metrics.inFlightSize || 0} in-flight  ${metrics.cacheSize || 0} cached`);
  if (metrics.codex) {
    console.log(`codex          ${metrics.codex.active || 0}/${metrics.codex.max || 0} active  ${metrics.codex.queued || 0} queued`);
  }
}

function ratio(numerator = 0, denominator = 0) {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}ms` : "-";
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value || 0)) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} requires a positive number.`);
  }
  return number;
}

function requireValue(args, index, flag) {
  if (!args[index]) {
    throw new Error(`${flag} requires a value.`);
  }
  return args[index];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage: node tools/observe.js [options]

Read anonymous runtime metrics from a running translator server.
Exits with status 1 when the observed request health is FAIL.

Options:
  --endpoint URL   Server URL (default: ${DEFAULT_ENDPOINT})
  --watch SECONDS  Refresh continuously
  --reset          Reset counters before reading (token protected)
  --token TOKEN    Reset token (or TRANSLATOR_TOKEN)
  --json           Print machine-readable JSON
  -h, --help       Show help`);
}
