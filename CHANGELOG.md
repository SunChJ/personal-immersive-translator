# Changelog

## 0.2.11 - 2026-07-01

- Fixed scroll-triggered lazy loading not benefiting from the codex-app thread pool: each viewport-entry flush was mutex-guarded one at a time and could dequeue up to 40 items, so batches got slower without gaining any parallelism. Lazy flushes now use their own smaller per-request cap (`PIT_LAZY_BATCH_ITEMS`, 16) and drain the queue with up to `PIT_MAX_CONCURRENT_BATCHES` workers running concurrently, while still holding the same busy flag other flows already rely on.
- Increased the lazy-load prefetch distance (`PIT_LAZY_ROOT_MARGIN`, 600px to 1500px) so blocks start translating further ahead of the viewport, hiding the backend's ~1-4s per-request latency behind normal scrolling instead of it showing up as a visible pop-in delay.

## 0.2.10 - 2026-07-01

- Replaced the codex-app backend's single shared thread with a small pool of independent threads (default 3, `CODEX_APP_THREAD_POOL_SIZE`) so concurrent translation batches actually run in parallel server-side instead of queueing behind one thread; prewarm now warms every thread in the pool.
- Prewarmed the codex-exec fallback backend on server startup and exposed its warm/latency status in `/health`, matching the codex-app backend.
- Made partial translation failures visible instead of silently rendering the original text as if it were translated: the server now tags each result with `ok`, the client routes `ok:false` items to the existing failed/retry UI, and failed results are no longer cached (so retries can actually succeed).

## 0.2.9 - 2026-07-01

- Switched page translation to adaptive batching based on text length: short blocks can batch up to 40 items, while long content is split by character budget to avoid oversized Codex turns.
- Dispatched translation batches with bounded concurrency (up to 3 at once) instead of one at a time, cutting wall-clock time on the codex-exec and OpenAI backends.
- Replaced the 300ms SPA route-change poll with an event-driven watcher: a small main-world script patches `history.pushState`/`replaceState` to dispatch a DOM event that the content script listens for, alongside existing `popstate`/`hashchange` listeners.
- Fixed a bug where `lazyQueuedIds` never released the id of a lazily-queued element that was removed from the DOM before its translation was flushed.
- Cached the `isDenseInteractiveContainer` DOM-scan result per element and reused the already-computed style when rendering translation surfaces, cutting redundant `querySelectorAll`/`getComputedStyle` calls during page scans.
- Deduplicated constants and helpers (`PIT_TOKEN`, target-language/bilingual-style normalization, endpoint/model formatting, etc.) that were previously copy-pasted across `background.js`, `content.js`, and `popup.js` into a shared `shared.js`; fixed a related inconsistency where auto-translate scheduling skipped legacy Chinese-language alias resolution that the popup and floating menu already applied.
- Split the single 3600-line `content.js` into focused files (`content-state`, `content-detect`, `content-render`, `content-observers`, `content-floating`, `content-selection`, `content-styles`, `content-translate`) loaded in sequence, with `content.js` reduced to the message-listener/bootstrap entry point.

## 0.2.8 - 2026-06-30

- Kept the translation state active across SPA route changes: the floating control now stays on (showing an updating state) and re-translates the new route instead of resetting to untranslated.
- Rebranded the extension to "Prism — Immersive Translator" with the triangle prism mark across the popup, floating control, and selection tooltip.
- Added full automatic dark mode (prefers-color-scheme) for every surface, matching the Prism reference design.
- Rebuilt the popup to the Prism reference layout: translate card with detected-language subtitle, target/display/style rows, a collapsible bilingual style picker, a Codex Spark connection footer, and a kebab overflow menu for server endpoint and advanced options.
- Redesigned the floating control as a compact Prism menu (Translate page toggle, Target, Display, and an Open settings section) with an icon-based selection tooltip showing the engine and copy/play actions.
- Added per-site auto-translate settings in the popup and floating control, with background page-load translation for enabled sites.
- Added bilingual style settings for dashed, dotted, wavy, highlight, soft-box, and blur translation rendering.
- Added optional selection translation with an in-page result card, copy action, and browser speech playback.

## 0.2.7 - 2026-06-29

- Prevented replace-mode auto-updates from retriggering themselves after applying translated text.
- Re-ran full page translation after SPA route changes so long pages continue using lazy translation instead of stopping after the dynamic-update cap.

## 0.2.6 - 2026-06-29

- Prevented bilingual translation blocks from intercepting page clicks.
- Skipped translating interactive controls so buttons, links, tabs, menus, and expandable controls remain usable after translation.

## 0.2.5 - 2026-06-29

- Added visible loading placeholders with spinner indicators while translation blocks are pending.
- Added failed translation placeholders with per-block retry actions.
- Fixed dynamically expanded content being skipped when it appears inside an already translated container.

## 0.2.4 - 2026-05-27

- Added paragraph-level anchoring for multi-paragraph X/Twitter post bodies in bilingual mode.
- Reduced reserved translation height for tweet segments so inserted translations stay close to their source paragraphs.

## 0.2.3 - 2026-05-27

- Preserved paragraph breaks for long social posts and multi-paragraph text blocks.
- Rendered translation blocks with newline-aware whitespace so translated paragraphs do not collapse together.

## 0.2.2 - 2026-05-27

- Skipped navigation bars, action links, and dense interactive UI containers during page translation.
- Prevented bilingual translation blocks from being inserted into navbar/menu layouts.

## 0.2.1 - 2026-05-27

- Removed the bottom-right page status toast to reduce reading distraction.
- Kept translation progress and errors in the floating control and popup surfaces.

## 0.2.0 - 2026-05-27

- Added international target language controls with custom language support.
- Aligned the toolbar popup and floating menu around the same core controls.
- Added floating-menu server health and latency display.
- Improved page text discovery for social, article, GitHub, Reddit, and Hacker News style pages.
- Reduced layout shift by reserving stable translation slots before filling translations.
- Added near-viewport lazy translation so long pages translate progressively while scrolling.

## 0.1.0 - 2026-05-27

- Initial local-first Chrome extension.
- Added local Node server bridge for Codex app-server.
- Added floating translate button, popup controls, bilingual/replace modes, and local cache.
