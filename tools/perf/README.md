# Deterministic performance harness

This harness starts both a fake OpenAI Responses API and the repository's current
`server/server.js`. It has no package dependencies and never calls a real model.

## Run

```sh
node tools/perf/benchmark.js run \
  --requests 200 \
  --concurrency 24 \
  --items 40 \
  --unique-ratio 0.25 \
  --delay-ms 50 \
  --output /tmp/pit-current.json
```

The report includes p50/p95/p99 latency, throughput, error rate, fake-backend
calls/items, peak backend concurrency, and exact-dedupe/coalescing/cache counts.
It reads structured server data from `/metrics` and cross-checks model calls and
items against the independent fake backend. Use `--json` for machine-readable
stdout.

Set gates in CI or before a release:

```sh
node tools/perf/benchmark.js run \
  --requests 200 --concurrency 24 --items 40 --unique-ratio 0.25 --delay-ms 50 \
  --max-p95-ms 250 --min-throughput-rps 80 --min-backend-savings-pct 70
```

Any request error or failed gate exits with status 1. Invalid usage exits with
status 2.

## Compare

Create the baseline and current JSON with identical load settings, then run:

```sh
node tools/perf/benchmark.js compare \
  /tmp/pit-baseline.json /tmp/pit-current.json \
  --max-p95-regression-pct 10 \
  --max-throughput-regression-pct 10 \
  --max-backend-items-regression-pct 0
```

The default comparison gates are 10% p95 latency, 10% throughput, no increase in
backend items, and no increase in error rate. A failed gate exits with status 1.

## Optional hyperfine outer measurement

The built-in report measures the request workload only. `hyperfine` can also
measure the full process lifecycle, including fake backend and translator startup:

```sh
mkdir -p artifacts/perf
hyperfine --warmup 1 --runs 10 \
  --export-json artifacts/perf/hyperfine.json \
  'node tools/perf/benchmark.js run --requests 100 --concurrency 16 --items 20 --unique-ratio 0.25 --delay-ms 25 --json >/dev/null'
```
