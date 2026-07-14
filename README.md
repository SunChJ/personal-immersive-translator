# Gloss Browser Extension

> Immersive page translation powered by the Gloss macOS app and your existing Codex login.

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md)

The Gloss extension adds page, selection, bilingual, and replace-mode translation to Chrome and Safari. Translation runs through the native Gloss app, so the browser never receives a ChatGPT credential and no terminal service needs to stay open.

## Features

- Translate the current page in Chrome or Safari from one WXT codebase.
- Choose a common target language or enter any custom language name.
- Floating draggable translate button with quick actions.
- Snap the floating button to the left or right edge of the page.
- Use the same core controls from either the toolbar popup or the floating menu.
- Translate visible content first for faster perceived response.
- Insert translations block-by-block instead of mixing text inline.
- Match translations back to DOM blocks using stable `pitId` anchors.
- Use a fast first batch and character-budgeted follow-up batches for responsive long-page translation.
- Translate identical full text once and fan the result back out to every DOM position.
- Keep replace mode reversible without destroying original links or inline nodes.
- Keep a local translation cache for repeated text.
- Share Gloss's native translation broker, cache, and logged-in Codex session.

## Architecture

```text
Chrome or Safari extension
  -> authenticated loopback bridge at http://127.0.0.1:8787
    -> Gloss TranslationBroker
      -> Codex app-server
```

Gloss creates a random 256-bit pairing token. Chrome receives it in the App-managed extension copy; Safari obtains it from the signed native extension through a shared App Group. The bridge listens only on `127.0.0.1`, accepts Chrome and Safari extension origins, and never exposes a ChatGPT credential to either browser.

## Requirements

- macOS
- Chrome or Safari
- Gloss
- Node.js 20.12+ for extension builds
- Codex CLI logged in with ChatGPT:

```bash
codex login
codex login status
```

## Quick Start

Build and open Gloss from the repository root:

```bash
cd Gloss
./Scripts/build_app.sh
open dist/Gloss.app
```

The build runs WXT in the `personal-immersive-translator` dependency, bundles the Chrome output, and embeds the Safari extension. Open **Gloss Settings → Browser Extension** afterward.

For extension development:

```bash
cd /path/to/personal-immersive-translator
npm run verify
```

## Load the Chrome Extension

1. In Gloss Settings, click **Show Extension**.
2. Open `chrome://extensions` and enable Developer mode.
3. Click **Load unpacked** and select the revealed `BrowserExtension` folder.
4. Allow Chrome **Local Network Access** if prompted; it is required to reach Gloss on `127.0.0.1`.
5. Use the floating button or extension popup to translate.

For source development, run `npm run build:chrome`, load `.output/chrome-mv3`, and paste the token from Gloss Settings into the extension.

Chrome internal pages such as `chrome://extensions` cannot be translated because Chrome blocks content scripts there.

## Enable the Safari Extension

1. Build and open `Gloss.app`.
2. In Gloss Settings, click **Safari Settings**.
3. Enable **Gloss Extension** in Safari and grant website access when requested.

For extension-only development, run `npm run build:safari` and open `safari/Gloss/Gloss.xcodeproj`. The Xcode project references `.output/safari-mv3`; WXT remains the single source for browser code and manifests.

## Floating Button

The extension injects a small floating translate button on normal web pages.

- Drag it to either edge of the page to snap it there.
- Left-click it to toggle translated/original content.
- Right-click it to open the floating menu with server status, target language, mode, and quick actions.
- If hidden, reopen the extension popup and enable `Advanced -> Show floating button`.

## Translation Settings

The popup includes common targets such as Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, Italian, Russian, Arabic, Hindi, Vietnamese, Thai, and Indonesian. Choose `Custom...` to enter any other target language or locale, for example `Dutch` or `Brazilian Portuguese`.

Gloss owns the backend and model lifecycle. The browser extension only stores page-display preferences, the loopback endpoint, and its per-install pairing token.

## Legacy Node Service

The existing Node service remains available as a development and compatibility harness. It is not required by the Gloss product path:

```bash
export TRANSLATOR_BACKEND="codex-app"
export CODEX_MODEL="gpt-5.3-codex-spark"
```

Other legacy backends:

```bash
# Slower compatibility mode. Starts codex exec for every batch.
export TRANSLATOR_BACKEND="codex"

# OpenAI API fallback. Requires OPENAI_API_KEY.
export TRANSLATOR_BACKEND="openai"
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-5.4-mini"
```

Prewarming initializes the Codex app-server and validates a temporary thread; it does not start a model turn. Disable it if needed:

```bash
export CODEX_PREWARM=0
```

The codex-app backend runs up to three FIFO translation turns concurrently. Every turn gets a fresh temporary thread that is deleted afterward, so pages never share conversation history. Tune the bound if needed:

```bash
export CODEX_APP_MAX_CONCURRENCY=3
```

## Useful Commands

```bash
npm run check:version
npm run doctor
npm run verify
npm run observe
npm run start:codex
npm run start:api
```

## Verification and Performance Observability

The full verification suite uses a deterministic local fake backend and never calls a real model:

```bash
npm run verify
```

It runs version checks, pure unit tests, real-Chrome DOM injection tests, a real loaded-extension/service-worker loopback test, server integration tests, and a concurrent stress smoke test. Run each layer independently with:

```bash
npm run test:unit
npm run test:batch
npm run test:server
npm run test:stress
```

Save two runs with identical settings to evaluate a change:

```bash
npm run perf -- --requests 200 --concurrency 24 --items 40 \
  --unique-ratio 0.25 --delay-ms 50 \
  --output artifacts/perf/baseline.json

# After changing the code, create current.json with the same settings.
npm run perf -- --requests 200 --concurrency 24 --items 40 \
  --unique-ratio 0.25 --delay-ms 50 \
  --output artifacts/perf/current.json

npm run perf:compare -- \
  artifacts/perf/baseline.json artifacts/perf/current.json
```

Reports include p50/p95/p99, throughput, errors, backend calls/items, and exact-dedupe/cache/coalescing savings. Comparison exits non-zero by default when p95 or throughput regresses by more than 10%, backend items increase, or the error rate increases. Generated `artifacts/perf/` files are ignored by Git.

With `hyperfine` installed, measure the complete process lifecycle repeatedly:

```bash
npm run perf:hyperfine
```

The command also saves `artifacts/perf/hyperfine.json`.

Inspect a running translator once, continuously, or after resetting its counters:

```bash
npm run observe
npm run observe -- --watch 2
npm run observe -- --reset
```

A one-shot observation exits non-zero when its verdict is `FAIL`. `GET /metrics` exposes only anonymous counts, cache/coalesced/backend sources, p50/p95/p99 for the latest 2048 requests, and runtime gauges. It never stores source text, translations, or DOM IDs. The token-protected reset does not clear the translation cache.

## Versioning

The project uses semver. Keep `package.json`, `wxt.config.ts`, and `CHANGELOG.md` in sync for every release. WXT generates both manifests. Run `npm run check:version` before pushing a release-oriented change.

## Notes

ChatGPT subscription access and OpenAI API billing are separate. This project uses the official Codex CLI path for subscription-backed personal use. The API backend is optional and uses separate API billing.
