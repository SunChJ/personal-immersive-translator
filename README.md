# Personal Immersive Translator

> A local-first Chrome page translator powered by your logged-in Codex CLI session.

[中文文档](./README.zh-CN.md)

Personal Immersive Translator is a small personal Chrome extension for translating the current web page. It keeps credentials out of the browser by routing translation requests through a local Node.js server. By default, that server keeps a warm Codex app-server process and uses your ChatGPT/Codex login with `gpt-5.3-codex-spark`.

## Features

- Translate the current page from a Chrome extension.
- Choose a common target language or enter any custom language name.
- Floating draggable translate button with quick actions.
- Snap the floating button to the left or right edge of the page.
- Use the same core controls from either the toolbar popup or the floating menu.
- Translate visible content first for faster perceived response.
- Insert translations block-by-block instead of mixing text inline.
- Match translations back to DOM blocks using stable `pitId` anchors.
- Keep a local translation cache for repeated text.
- Use your logged-in Codex CLI session, with optional OpenAI API fallback.

## Architecture

```text
Chrome extension
  -> local server at http://127.0.0.1:8787
    -> persistent Codex app-server
      -> gpt-5.3-codex-spark
```

The extension never stores an API key or ChatGPT token. It only talks to the local server. The local server starts and manages the Codex process on your machine.

## Requirements

- macOS
- Chrome
- Node.js 18+
- GitHub is not required to run the extension
- Codex CLI logged in with ChatGPT:

```bash
codex login
codex login status
```

## Quick Start

Double-click:

```text
Start Translator.command
```

Or run manually:

```bash
cd /Users/samsoncj/develop/codex-playground/personal-immersive-translator
npm run doctor
npm run start:codex
```

Keep the terminal window open while translating.

## Load the Chrome Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension/` folder.
5. Open a normal web page.
6. Use the floating `译` button or the extension popup to translate.

Chrome internal pages such as `chrome://extensions` cannot be translated because Chrome blocks content scripts there.

## Floating Button

The extension injects a small floating translate button on normal web pages.

- Drag it to either edge of the page to snap it there.
- Left-click it to toggle translated/original content.
- Right-click it to open the floating menu with server status, target language, mode, and quick actions.
- If hidden, reopen the extension popup and enable `Advanced -> Show floating button`.

## Configuration

The popup includes common targets such as Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, Italian, Russian, Arabic, Hindi, Vietnamese, Thai, and Indonesian. Choose `Custom...` to enter any other target language or locale, for example `Dutch` or `Brazilian Portuguese`.

The default backend is the persistent Codex app-server mode:

```bash
export TRANSLATOR_BACKEND="codex-app"
export CODEX_MODEL="gpt-5.3-codex-spark"
```

Other supported backends:

```bash
# Slower compatibility mode. Starts codex exec for every batch.
export TRANSLATOR_BACKEND="codex"

# OpenAI API fallback. Requires OPENAI_API_KEY.
export TRANSLATOR_BACKEND="openai"
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-5.4-mini"
```

Disable prewarm if needed:

```bash
export CODEX_PREWARM=0
```

## Useful Commands

```bash
npm run doctor
npm run start:codex
npm run start:api
```

## Notes

ChatGPT subscription access and OpenAI API billing are separate. This project uses the official Codex CLI path for subscription-backed personal use. The API backend is optional and uses separate API billing.
