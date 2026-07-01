// Shared constants and pure helpers used by background.js, content.js, and popup.js.
// Loaded as a plain classic script before the other extension scripts so top-level
// `const`/`function` declarations land in the shared execution context of each surface
// (content script isolated world, popup document, background service worker).

const PIT_TOKEN = "pit-local-extension-token-v1";
const PIT_DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const PIT_DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";
const PIT_DEFAULT_BILINGUAL_STYLE = "dashed";
const PIT_BILINGUAL_STYLES = new Set(["dashed", "dotted", "wavy", "highlight", "soft-box", "blur"]);
const PIT_LEGACY_TARGET_LANGUAGE_ALIASES = new Map([
  ["中文", "Chinese (Simplified)"],
  ["简体中文", "Chinese (Simplified)"],
  ["繁体中文", "Chinese (Traditional)"],
  ["英文", "English"],
  ["英语", "English"],
  ["日文", "Japanese"],
  ["日语", "Japanese"],
  ["韩文", "Korean"],
  ["韩语", "Korean"]
]);
const PIT_MAX_BATCH_ITEMS = 40;
const PIT_DEFAULT_BATCH_CHAR_LIMIT = 9000;
const PIT_HEALTH_TIMEOUT_MS = 5000;

function normalizeTargetLanguage(value) {
  const language = String(value || "").trim();
  if (!language) {
    return PIT_DEFAULT_TARGET_LANGUAGE;
  }
  return PIT_LEGACY_TARGET_LANGUAGE_ALIASES.get(language) || language;
}

function normalizeBilingualStyle(value) {
  return PIT_BILINGUAL_STYLES.has(value) ? value : PIT_DEFAULT_BILINGUAL_STYLE;
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || "").trim().replace(/\/+$/, "") || PIT_DEFAULT_ENDPOINT;
}

function prettyModelLabel(model, fallback = "Codex Spark 5.3") {
  const raw = String(model || "").trim();
  if (!raw) {
    return fallback;
  }
  const spark = raw.match(/(\d+(?:\.\d+)?)[-_ ]?codex[-_ ]?spark|codex[-_ ]?spark[-_ ]?(\d+(?:\.\d+)?)/i);
  if (spark) {
    const version = spark[1] || spark[2];
    return version ? `Codex Spark ${version}` : "Codex Spark";
  }
  return raw;
}

function hostFromUrl(url) {
  try {
    const parsed = new URL(url || "");
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Local proxy request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
