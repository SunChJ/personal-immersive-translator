// Text/DOM normalization helpers (createShortId, normalizeText, ensurePitId, etc). Loads before content-state.js because PIT_STATE needs createShortId at eval time.
function normalizeTranslationMap(batch, translations) {
  const map = new Map();

  if (Array.isArray(translations)) {
    translations.forEach((item, index) => {
      if (item && typeof item === "object" && item.id) {
        map.set(item.id, { text: item.text || "", ok: item.ok !== false });
        return;
      }

      const entry = batch[index];
      if (entry) {
        map.set(entry.id, { text: item?.text || item || "", ok: true });
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
  translationElement.style.fontSize = readableTranslationFontSize(sourceElement, style);
  translationElement.style.fontWeight = style.fontWeight;
  translationElement.style.fontStyle = style.fontStyle;
  translationElement.style.lineHeight = style.lineHeight;
  translationElement.style.letterSpacing = style.letterSpacing;
  translationElement.style.textAlign = style.textAlign;
  translationElement.style.color = style.color;
}

function readableTranslationFontSize(sourceElement, style) {
  const sourceSize = Number.parseFloat(style.fontSize);
  if (!Number.isFinite(sourceSize)) {
    return style.fontSize;
  }

  if (sourceElement.matches("h1, h2, h3, h4, h5, h6")) {
    return `${Math.max(18, Math.min(sourceSize * 0.72, 34))}px`;
  }

  return style.fontSize;
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

