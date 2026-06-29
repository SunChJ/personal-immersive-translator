# Changelog

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
