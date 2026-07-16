// Text/DOM normalization helpers (createShortId, normalizeText, ensurePitId, etc). Loads before content-state.js because PIT_STATE needs createShortId at eval time.
function normalizeTranslationMap(batch, translations) {
  const map = new Map();

  if (Array.isArray(translations)) {
    translations.forEach((item, index) => {
      if (item && typeof item === "object" && item.id) {
        map.set(item.id, item.text || "");
        return;
      }

      const entry = batch[index];
      if (entry) {
        map.set(entry.id, item?.text || item || "");
      }
    });
  }

  return map;
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeReadableText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

function isMostlyPunctuation(text) {
  const meaningful = text.replace(/[\s\p{P}\p{S}\d]/gu, "");
  return meaningful.length < 2;
}

function applyInheritedTextStyle(sourceElement, translationElement, precomputedStyle) {
  const style = precomputedStyle || window.getComputedStyle(sourceElement);
  translationElement.style.fontFamily = `${style.fontFamily}, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
  translationElement.style.fontSize = style.fontSize;
  translationElement.style.fontWeight = style.fontWeight;
  translationElement.style.fontStyle = style.fontStyle;
  translationElement.style.lineHeight = style.lineHeight;
  translationElement.style.letterSpacing = style.letterSpacing;
  translationElement.style.textAlign = style.textAlign;
  translationElement.style.color = style.color;
}

function ensurePitId(element) {
  if (element.dataset.pitId) {
    return element.dataset.pitId;
  }

  const id = `pit-${PIT_STATE.sessionId}-${String(PIT_STATE.nextBlockId++).padStart(6, "0")}`;
  element.dataset.pitId = id;
  return id;
}

function describeElementPath(element) {
  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 5) {
    parts.unshift(current.tagName.toLowerCase());
    current = current.parentElement;
  }

  return parts.join(">");
}

function createShortId() {
  return Math.random().toString(36).slice(2, 8);
}

function nextAnimationFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function hasGlossExtensionContext() {
  try {
    return Boolean(globalThis.chrome?.runtime?.sendMessage && globalThis.chrome?.storage?.local);
  } catch {
    return false;
  }
}

function disableStaleGlossContext() {
  if (hasGlossExtensionContext()) return false;
  if (typeof PIT_STATE === "undefined" || PIT_STATE.extensionContextInvalidated) return true;

  PIT_STATE.extensionContextInvalidated = true;
  PIT_STATE.translationEpoch += 1;
  PIT_STATE.cancelRequested = true;
  PIT_STATE.selectionRequestId += 1;
  window.clearTimeout(PIT_STATE.dynamicTimer);
  window.clearTimeout(PIT_STATE.pendingTimer);
  window.clearTimeout(PIT_STATE.routeTranslationTimer);
  window.clearTimeout(PIT_STATE.selectionTimer);
  window.clearTimeout(PIT_STATE.floatingStatusTimer);
  window.clearInterval(PIT_STATE.routePollTimer);
  PIT_STATE.routeSettlingTimers.forEach((timer) => window.clearTimeout(timer));
  PIT_STATE.routeSettlingTimers = [];
  PIT_STATE.dynamicObserver?.disconnect();
  PIT_STATE.lazyObserver?.disconnect();
  PIT_STATE.translationStreams.clear();

  const subtitle = PIT_STATE.subtitle;
  if (subtitle) {
    subtitle.enabled = false;
    subtitle.generation += 1;
    subtitle.queueEpoch += 1;
    window.clearInterval(subtitle.scheduler);
    subtitle.video?.removeEventListener("seeked", handleSubtitleSeek);
    subtitle.button?.remove();
    subtitle.nativeLine?.host.remove();
    subtitle.activeRequestIds.clear();
    subtitle.pendingJobs = [];
    subtitle.inFlightCueIds.clear();
    subtitle.queuedCueIds.clear();
  }

  PIT_STATE.floating?.remove();
  PIT_STATE.selectionTooltip?.remove();
  PIT_STATE.floating = null;
  PIT_STATE.selectionTooltip = null;
  return true;
}

function glossContextInvalidatedError() {
  return new Error("Gloss was updated. Refresh this page to reconnect the extension.");
}
