# Changelog

## Unreleased

- Added Safari YouTube subtitle parity through Safari's native Main World content-script support, including caption-track discovery, POT-aware timed-text fetching, the player control, and the popup setting.
- Added YouTube timed-text permissions to Safari and kept the shared Chrome/Safari subtitle runtime as the single implementation.

## 0.5.4 - 2026-07-16

- Added media-style subtitle pre-roll and rebuffer gates: playback briefly waits while the current cue and a six-second translated cushion are prepared, then reveals the native bilingual caption atomically. Seeking flushes stale work and repeats the same guarded refill instead of showing the original line first.
- Reattached translations with a caption-scoped mutation observer before YouTube can paint a newly rebuilt original-only cue, replacing the previous 250 ms polling delay.
- Expanded preheating from a fixed 45-second window to a 60-second base window that scales with playback speed, with a 25-second low-water refill threshold.
- Kept subtitle translation alive across transient tail-batch failures with bounded exponential retries, and continuously rescheduled refill work while playback is waiting for its translated cushion.
- Silenced stale subtitle controls after an extension reload by detecting the missing runtime ID and absorbing context-invalidated storage and messaging rejections.
- Included the subtitle content script in the packaged Safari extension and now verify every manifest content script is present in the Xcode resource phase.

## 0.5.3 - 2026-07-15

- Restored YouTube subtitle translation with POT-aware timed-text discovery, same-page session fetching, and a credentialed background fallback.
- Kept captured POT URLs across player refreshes and retried subtitle requests after enabling native captions.
- Embedded each translation as a new line inside YouTube's native caption window so it follows caption positioning and fullscreen changes.
- Reduced the translated caption size and widened its available line width to keep bilingual playback compact and readable.
- Added a progress-aware subtitle buffer: nearby cues use a visible-priority lane, the next 45 seconds preheat in the background, and seeking cancels stale work before refilling around the new position.
- Made content controls shut down cleanly when Chrome invalidates an old extension context after reload, avoiding frozen controls and `chrome.storage` promise errors until the page is refreshed.
- Updated Gloss-managed browser extension files in place so Chrome does not lose the unpacked extension during upgrades.

## 0.5.1 - 2026-07-15

- Synchronized the Gloss app, Chrome extension, and Safari extension release version.
- Added the product version beside Gloss in the macOS menu-bar panel header.

## 0.5.0 - 2026-07-15

- Added Chrome YouTube subtitle translation with a separate time-window queue, playback-aware prefetching, streamed results, and a bilingual Shadow DOM overlay.
- Upgraded selection text-to-speech with system voice matching, configurable speed, long-text chunking, and single-playback stop controls.
- Exposed request item and character budgets while preserving the fast-first batch and provider-aware concurrency limits.
- Forwarded translation profile and content kind through the browser bridge so subtitle, selection, and webpage requests keep distinct prompts and cache contexts.

## 0.4.1 - 2026-07-15

- Replaced per-site auto-translation with one global setting that automatically translates every supported website after it loads.
- Made the floating control show distinct ready, working, automatic, and completed states, with clearer status text and visual feedback.
- Kept bilingual translations at the original element's computed font size, including headings.

## 0.4.0 - 2026-07-14

- Added WXT as the shared Chrome and Safari build layer while preserving the existing extension runtime.
- Added browser-specific Manifest V3 outputs as the stable dependency consumed by Gloss packaging.
- Added a Safari Web Extension target with native App Group pairing and a polling fallback for SPA navigation.
- Added browser icons, target-specific manifest coverage, and automated Chrome/Safari build verification.

## 0.3.4 - 2026-07-14

- Let newly visible and dynamic translation batches start without waiting for an earlier queue drain to finish.
- Bounded all browser-to-Gloss translation requests to three concurrent batches, matching the three prewarmed Codex threads.

## 0.3.3 - 2026-07-14

- Updated the bundled page translation runtime from PIT 0.2.12 to 0.2.15.
- Adopted the unified deduplicated pending queue, per-page result cache, refresh deduplication, and simplified pending indicator.
- Preserved Gloss automatic pairing, per-install authentication, and App-managed extension installation.

## 0.3.2 - 2026-07-14

- Fixed upgrades from the original extension losing all bridge access because no pairing token existed in Chrome storage.
- Made Gloss inject its per-install random token into the App-managed extension copy, preserving authenticated loopback access without manual copy and paste.
- Kept manual pairing available for developers who load the repository's source extension directly.

## 0.3.1 - 2026-07-13

- Fixed Chrome loopback access by using valid host-permission match patterns for `127.0.0.1` and `localhost`.
- Removed a duplicate hard-coded endpoint so every extension surface uses the shared Gloss bridge address.
- Added a real loaded-extension test covering the content script, Manifest V3 service worker, loopback bridge, and translated DOM output.
- Improved setup guidance for the bundled extension and Chrome's Local Network Access permission.

## 0.3.0 - 2026-07-13

- Renamed the product to Gloss and aligned the browser extension with the new macOS app.
- Replaced the shared fixed local-service token with a per-install token in Gloss's private app storage.
- Added pairing controls and Gloss-specific connection status while preserving the existing page translation runtime.

## 0.2.15 - 2026-07-12

- Added one deduplicated pending queue for initial scans, viewport lazy loading, dynamic updates, and retries. Visible deferred content now shows its spinner immediately and is prioritized after the active batch completes.
- Added a bounded per-page translation result cache so later matching blocks render locally without another backend request, while preserving every DOM owner for duplicate text.

## 0.2.14 - 2026-07-12

- Prevented duplicate auto-translation after a page refresh by keeping exactly one scheduled or running auto-translation job per tab navigation and invalidating stale retries.

## 0.2.13 - 2026-07-12

- Simplified pending page-translation placeholders to show only the spinner, while retaining an accessible loading label.

## 0.2.12 - 2026-07-09

- Merged the `prism-ui-redesign` modular content runtime, shared helpers, event-driven SPA route patch, adaptive batching, and ahead-of-viewport lazy prefetch.
- Preserved every DOM translation target while deduplicating exact full-text requests in the local server, including concurrent in-flight requests across tabs.
- Combined an 8-item fast-first batch with character budgets and up to three concurrent tail batches, while keeping lazy and dynamic queues bounded without dropping content.
- Bounded Codex app-server work to three FIFO turns by default; every turn still uses a fresh isolated temporary thread that is interrupted on failure and deleted after use.
- Reworked bilingual injection around owner-linked `span` slots and made replace mode fully reversible so original links, nodes, formatting, and handlers survive clearing.
- Fixed duplicate paragraphs, lazy multi-paragraph social posts, large dynamic insertions, stale responses after clear or SPA navigation, and late-mounted route content.
- Added strict model-output validation, cross-request coalescing, bounded text-free runtime metrics, and authenticated metrics reset.
- Added real-Chrome batch/SPA coverage plus deterministic HTTP and fake-Codex stress tools with JSON baselines, regression gates, and Hyperfine output.

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
