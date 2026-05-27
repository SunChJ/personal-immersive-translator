const PIT_STATE = {
  running: false,
  cancelRequested: false,
  dynamicObserver: null,
  dynamicTimer: null,
  floating: null,
  floatingStatusTimer: null,
  translated: false,
  nextBlockId: 1,
  sessionId: createShortId(),
  overlay: null
};

const PIT_DIRECT_TEXT_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "figcaption",
  "caption",
  "dt",
  "dd",
  "summary",
  "td",
  "th"
].join(",");

const PIT_FORCE_TEXT_SELECTOR = [
  "[data-testid='tweetText']",
  "[role='heading']",
  "[dir='auto']",
  "[lang][dir]"
].join(",");

const PIT_SKIP_TAGS = new Set([
  "area",
  "audio",
  "button",
  "canvas",
  "code",
  "datalist",
  "embed",
  "head",
  "hr",
  "iframe",
  "img",
  "input",
  "kbd",
  "link",
  "map",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "picture",
  "pre",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "time",
  "track",
  "video"
]);

const PIT_BLOCK_DISPLAYS = new Set([
  "block",
  "flow-root",
  "flex",
  "grid",
  "list-item",
  "table",
  "table-caption",
  "table-cell"
]);

const PIT_INLINE_DISPLAYS = new Set([
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "contents"
]);

const PIT_SITE_RULES = [
  {
    host: /(^|\.)news\.ycombinator\.com$/i,
    selectors: [
      ".titleline",
      ".toptext",
      ".commtext"
    ],
    skipSelectors: [".rank", ".votelinks", ".age", ".score", ".subtext", ".pagetop", ".yclinks"]
  },
  {
    host: /(^|\.)x\.com$|(^|\.)twitter\.com$/i,
    selectors: [
      "article [data-testid='tweetText']",
      "article [lang][dir='auto']",
      "article [role='heading']",
      "main [data-testid='tweetText']"
    ],
    skipSelectors: [
      "[aria-label*='keyboard' i]",
      "[data-testid='sidebarColumn']",
      "[role='navigation']",
      "[role='search']"
    ]
  },
  {
    host: /(^|\.)github\.com$/i,
    selectors: [
      ".markdown-body h1",
      ".markdown-body h2",
      ".markdown-body h3",
      ".markdown-body p",
      ".markdown-body li",
      ".markdown-body blockquote",
      ".comment-body p",
      ".comment-body li"
    ],
    skipSelectors: ["pre", "code", ".blob-wrapper", ".highlight"]
  },
  {
    host: /(^|\.)reddit\.com$/i,
    selectors: [
      "shreddit-post [slot='text-body']",
      "shreddit-comment [slot='comment']",
      "[data-testid='post-container'] h1",
      "[data-testid='post-container'] p"
    ],
    skipSelectors: ["nav", "header", "footer", "[aria-label*='advertise' i]"]
  }
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "clear-page-translation") {
    clearTranslations();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "set-floating-visibility") {
    setFloatingVisible(Boolean(message.visible));
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== "start-page-translation") {
    return false;
  }

  translatePage(message.options || {})
    .then((summary) => sendResponse({ ok: true, summary }))
    .catch((error) => {
      updateOverlay(error instanceof Error ? error.message : String(error), true);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

initFloatingControl();

async function translatePage(options) {
  if (PIT_STATE.running) {
    PIT_STATE.cancelRequested = true;
    throw new Error("A translation is already running. Click again after it stops.");
  }

  PIT_STATE.running = true;
  PIT_STATE.cancelRequested = false;
  injectStyles();
  showOverlay();

  try {
    if (options.clearPrevious) {
      clearTranslations();
    }

    stopDynamicTranslationObserver();

    const blocks = collectTranslationBlocks(document.body, {
      minChars: Number(options.minChars || 4)
    });
    const orderedBlocks = prioritizeBlocks(blocks, options.viewportFirst !== false);

    if (orderedBlocks.length === 0) {
      updateOverlay("No translatable visible text found.", true);
      return { translated: 0, total: 0 };
    }

    const translated = await translateBlocks(orderedBlocks, options);

    updateOverlay(`Done. Translated ${translated} text blocks.`, true);
    PIT_STATE.translated = translated > 0;
    updateFloatingState();
    setFloatingStatus(`Done: ${translated}`);
    if (translated > 0) {
      startDynamicTranslationObserver(options);
    }
    return { translated, total: orderedBlocks.length };
  } finally {
    PIT_STATE.running = false;
  }
}

async function translateBlocks(orderedBlocks, options, overlayPrefix = "Translating") {
  const batchSize = clamp(Number(options.batchSize || 24), 1, 40);
  let translated = 0;

  for (let offset = 0; offset < orderedBlocks.length; offset += batchSize) {
    if (PIT_STATE.cancelRequested) {
      updateOverlay(`Stopped after ${translated}/${orderedBlocks.length}.`, true);
      return translated;
    }

    const batch = orderedBlocks.slice(offset, offset + batchSize);
    updateOverlay(`${overlayPrefix} ${offset + 1}-${Math.min(offset + batch.length, orderedBlocks.length)} / ${orderedBlocks.length}...`);

    const response = await chrome.runtime.sendMessage({
      type: "translate-batch",
      items: batch.map((entry, index) => ({
        id: entry.id,
        index,
        kind: entry.kind || "paragraph",
        tag: entry.element.tagName.toLowerCase(),
        path: describeElementPath(entry.element),
        text: entry.text
      })),
      targetLanguage: options.targetLanguage || "中文",
      endpoint: options.endpoint || "http://127.0.0.1:8787",
      sourceUrl: location.href
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "Translation request failed.");
    }

    applyTranslations(batch, response.translations, options.mode || "bilingual");
    translated += batch.length;
  }

  return translated;
}

function collectTranslationBlocks(root, options) {
  const seen = new Set();
  const blocks = [];
  const textFingerprints = new Set();
  const minChars = Number(options.minChars || 4);

  collectSiteRuleBlocks(root, { seen, blocks, textFingerprints, minChars });

  root.querySelectorAll(PIT_DIRECT_TEXT_SELECTOR).forEach((element) => {
    pushTranslationBlock(element, {
      seen,
      blocks,
      textFingerprints,
      minChars,
      kind: "semantic",
      allowChildBlocks: false
    });
  });

  walkParagraphCandidates(root, (element) => {
    pushTranslationBlock(element, {
      seen,
      blocks,
      textFingerprints,
      minChars,
      kind: "walked",
      allowChildBlocks: false
    });
  });

  return blocks.sort((a, b) => {
    if (a.element === b.element) {
      return 0;
    }
    return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  });
}

function collectSiteRuleBlocks(root, context) {
  const rule = PIT_SITE_RULES.find((item) => item.host.test(location.hostname));
  if (!rule) {
    return;
  }

  root.querySelectorAll(rule.selectors.join(",")).forEach((element) => {
    if (rule.skipSelectors.some((selector) => element.closest(selector))) {
      return;
    }

    pushTranslationBlock(element, {
      ...context,
      kind: "site",
      allowChildBlocks: true
    });
  });
}

function walkParagraphCandidates(root, visit) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!(node instanceof HTMLElement)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (isHardSkipElement(node)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let element = walker.currentNode;
  while (element) {
    if (isParagraphCandidate(element)) {
      visit(element);
    }
    element = walker.nextNode();
  }
}

function isParagraphCandidate(element) {
  if (!(element instanceof HTMLElement) || element.matches(PIT_DIRECT_TEXT_SELECTOR)) {
    return false;
  }

  if (element.matches(PIT_FORCE_TEXT_SELECTOR)) {
    return true;
  }

  const display = window.getComputedStyle(element).display;
  if (!PIT_BLOCK_DISPLAYS.has(display)) {
    return false;
  }

  if (hasParagraphLikeChild(element)) {
    return false;
  }

  return hasDirectReadableText(element);
}

function pushTranslationBlock(element, context) {
  if (
    context.seen.has(element) ||
    shouldSkipElement(element) ||
    hasExistingTranslation(element) ||
    !isVisible(element) ||
    isAssistiveOnlyElement(element)
  ) {
    return false;
  }

  if (!context.allowChildBlocks && shouldPreferChildBlocks(element)) {
    return false;
  }

  if (hasCollectedAncestor(element, context.seen) || hasCollectedDescendant(element, context.seen)) {
    return false;
  }

  const text = extractReadableText(element);
  if (text.length < context.minChars || isMostlyPunctuation(text) || isLikelyChromeText(element, text)) {
    return false;
  }

  if (isBoilerplateText(text)) {
    return false;
  }

  const fingerprint = createTextFingerprint(text);
  if (context.textFingerprints.has(fingerprint)) {
    return false;
  }

  context.seen.add(element);
  context.textFingerprints.add(fingerprint);
  element.dataset.pitBlockKind = context.kind;
  context.blocks.push({ element, id: ensurePitId(element), text, kind: context.kind });
  return true;
}

function prioritizeBlocks(blocks, viewportFirst) {
  if (!viewportFirst) {
    return blocks;
  }

  return blocks
    .map((entry, index) => ({
      ...entry,
      index,
      rect: entry.element.getBoundingClientRect()
    }))
    .sort((a, b) => {
      const aVisible = isInViewport(a.rect);
      const bVisible = isInViewport(b.rect);
      if (aVisible !== bVisible) {
        return aVisible ? -1 : 1;
      }
      return a.rect.top - b.rect.top || a.index - b.index;
    });
}

function shouldSkipElement(element) {
  if (isHardSkipElement(element)) {
    return true;
  }

  return Boolean(
    element.closest(
      [
        "[contenteditable='true']",
        "[contenteditable='']",
        "[data-pit-skip]",
        "[data-pit-translated='true']",
        "[translate='no']",
        ".notranslate",
        ".pit-translation",
        "#pit-floating",
        "#pit-status"
      ].join(",")
    )
  );
}

function isHardSkipElement(element) {
  const tagName = element.tagName?.toLowerCase();
  return Boolean(tagName && PIT_SKIP_TAGS.has(tagName));
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isAssistiveOnlyElement(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const className = typeof element.className === "string" ? element.className : "";

  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }

  if (/\b(sr-only|visually-hidden|screen-reader|a11y|offscreen)\b/i.test(className)) {
    return true;
  }

  if (rect.width <= 2 && rect.height <= 2) {
    return true;
  }

  if (style.clip !== "auto" || style.clipPath !== "none") {
    return true;
  }

  if (style.position === "absolute" && style.overflow === "hidden" && (Number.parseFloat(style.width) <= 2 || Number.parseFloat(style.height) <= 2)) {
    return true;
  }

  return false;
}

function isInViewport(rect) {
  return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth;
}

function hasExistingTranslation(node) {
  if (node.dataset?.pitTranslated === "true") {
    return true;
  }

  const sibling = node.nextElementSibling;
  return Boolean(sibling?.classList?.contains("pit-translation") || node.querySelector?.(":scope > .pit-translation"));
}

function shouldPreferChildBlocks(element) {
  if (element.matches("[data-testid='tweetText'], .titleline, .commtext")) {
    return false;
  }

  if (element.matches("blockquote, dd, li, [role='article'], section, article, main, div, td, th")) {
    return hasParagraphLikeChild(element);
  }

  return false;
}

function hasParagraphLikeChild(element) {
  return Boolean(
    element.querySelector(
      [
        PIT_DIRECT_TEXT_SELECTOR,
        "[data-testid='tweetText']",
        "[dir='auto'][lang]",
        "[role='heading']"
      ].join(",")
    )
  );
}

function hasDirectReadableText(element) {
  let text = "";

  element.childNodes.forEach((child) => {
    text += extractInlineReadableText(child, element);
  });

  return normalizeText(text).length >= 4;
}

function extractInlineReadableText(node, rootElement) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return "";
  }

  if (node !== rootElement && shouldSkipElement(node)) {
    return "";
  }

  if (node.tagName.toLowerCase() === "br") {
    return "\n";
  }

  if (node !== rootElement) {
    const display = window.getComputedStyle(node).display;
    if (PIT_BLOCK_DISPLAYS.has(display) && !PIT_INLINE_DISPLAYS.has(display)) {
      return "";
    }
  }

  let text = "";
  node.childNodes.forEach((child) => {
    text += extractInlineReadableText(child, rootElement);
  });
  return text;
}

function extractReadableText(element) {
  const text = extractReadableTextFromNode(element, element);
  return normalizeText(text);
}

function extractReadableTextFromNode(node, rootElement) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return "";
  }

  if (node !== rootElement && (shouldSkipElement(node) || !isVisible(node) || isAssistiveOnlyElement(node))) {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === "br") {
    return "\n";
  }

  let text = "";
  node.childNodes.forEach((child) => {
    text += extractReadableTextFromNode(child, rootElement);
    if (child.nodeType === Node.ELEMENT_NODE && child instanceof HTMLElement) {
      const display = window.getComputedStyle(child).display;
      if (PIT_BLOCK_DISPLAYS.has(display)) {
        text += "\n";
      }
    }
  });

  return text;
}

function hasCollectedAncestor(element, seen) {
  let current = element.parentElement;
  while (current) {
    if (seen.has(current)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function hasCollectedDescendant(element, seen) {
  for (const collected of seen) {
    if (element !== collected && element.contains(collected)) {
      return true;
    }
  }
  return false;
}

function isLikelyChromeText(element, text) {
  const siteRule = PIT_SITE_RULES.find((rule) => rule.host.test(location.hostname));
  if (siteRule?.skipSelectors.some((selector) => element.closest(selector))) {
    return true;
  }

  if (/^news\.ycombinator\.com$/i.test(location.hostname) && element.querySelector?.(".pagetop, .subtext, .yclinks")) {
    return true;
  }

  if (element.closest("nav, aside, header, footer, menu, [role='navigation'], [role='search'], [role='banner'], [role='contentinfo'], [aria-label='Timeline: Trending now']")) {
    return text.length < 80;
  }

  const lowered = text.toLowerCase();
  return [
    "search",
    "relevant people",
    "what’s happening",
    "what's happening",
    "show more",
    "terms of service",
    "privacy policy",
    "cookie policy"
  ].includes(lowered) || lowered.includes("keyboard shortcuts") || lowered.includes("press question mark");
}

function isBoilerplateText(text) {
  const normalized = text.toLowerCase();
  if (/^[\d\s:./,\-+%]+$/.test(normalized)) {
    return true;
  }

  return [
    "reply",
    "retweet",
    "like",
    "share",
    "follow",
    "subscribe",
    "sign in",
    "log in",
    "more",
    "close",
    "open menu"
  ].includes(normalized);
}

function createTextFingerprint(text) {
  return normalizeText(text).toLowerCase().slice(0, 240);
}

function applyTranslations(batch, translations, mode) {
  const translationsById = normalizeTranslationMap(batch, translations);

  batch.forEach((entry) => {
    const translation = String(translationsById.get(entry.id) || "").trim();
    if (!translation || !entry.element.parentNode) {
      return;
    }

    if (mode === "replace") {
      entry.element.dataset.pitTranslated = "true";
      entry.element.textContent = translation;
      return;
    }

    const translationBlock = document.createElement("div");
    translationBlock.className = "pit-translation";
    translationBlock.dataset.pitSkip = "true";
    translationBlock.textContent = translation;
    applyInheritedTextStyle(entry.element, translationBlock);
    entry.element.dataset.pitTranslated = "true";

    const listParent = entry.element.closest("li");
    if (entry.element === listParent) {
      entry.element.appendChild(translationBlock);
      return;
    }

    entry.element.parentNode.insertBefore(translationBlock, entry.element.nextSibling);
  });
}

function clearTranslations() {
  stopDynamicTranslationObserver();
  document.querySelectorAll(".pit-translation").forEach((node) => node.remove());
  document.querySelectorAll("[data-pit-translated='true']").forEach((node) => {
    node.dataset.pitTranslated = "false";
  });
  PIT_STATE.translated = false;
  updateFloatingState();
  setFloatingStatus("Cleared");
}

function startDynamicTranslationObserver(options) {
  if (!document.body) {
    return;
  }

  stopDynamicTranslationObserver();
  const observer = new MutationObserver((mutations) => {
    if (PIT_STATE.running || !hasPageTranslations()) {
      return;
    }

    const hasRelevantChange = mutations.some((mutation) => {
      if (mutation.type === "attributes") {
        return mutation.target instanceof HTMLElement && !shouldSkipElement(mutation.target);
      }

      return Array.from(mutation.addedNodes).some((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return normalizeText(node.nodeValue || "").length >= 4;
        }
        return node instanceof HTMLElement && !shouldSkipElement(node);
      });
    });

    if (!hasRelevantChange) {
      return;
    }

    window.clearTimeout(PIT_STATE.dynamicTimer);
    PIT_STATE.dynamicTimer = window.setTimeout(() => {
      translateDiscoveredBlocks(options).catch((error) => {
        setFloatingStatus("Update failed");
        updateOverlay(error instanceof Error ? error.message : String(error), true);
      });
    }, 900);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"]
  });
  PIT_STATE.dynamicObserver = observer;
}

function stopDynamicTranslationObserver() {
  PIT_STATE.dynamicObserver?.disconnect();
  PIT_STATE.dynamicObserver = null;
  window.clearTimeout(PIT_STATE.dynamicTimer);
  PIT_STATE.dynamicTimer = null;
}

async function translateDiscoveredBlocks(options) {
  if (PIT_STATE.running) {
    return;
  }

  const blocks = collectTranslationBlocks(document.body, {
    minChars: Number(options.minChars || 4)
  });
  const orderedBlocks = prioritizeBlocks(blocks, true).slice(0, 40);
  if (orderedBlocks.length === 0) {
    return;
  }

  PIT_STATE.running = true;
  PIT_STATE.cancelRequested = false;
  showOverlay();
  updateFloatingState("running");

  try {
    const translated = await translateBlocks(orderedBlocks, { ...options, clearPrevious: false }, "Updating");
    if (translated > 0) {
      PIT_STATE.translated = true;
      setFloatingStatus(`Added: ${translated}`);
      updateOverlay(`Done. Added ${translated} text blocks.`, true);
    }
  } finally {
    PIT_STATE.running = false;
    updateFloatingState();
  }
}

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

function isMostlyPunctuation(text) {
  const meaningful = text.replace(/[\s\p{P}\p{S}\d]/gu, "");
  return meaningful.length < 2;
}

function applyInheritedTextStyle(sourceElement, translationElement) {
  const style = window.getComputedStyle(sourceElement);
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

function initFloatingControl() {
  injectStyles();

  chrome.storage.local.get({ showFloatingButton: true }, (settings) => {
    setFloatingVisible(settings.showFloatingButton !== false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.showFloatingButton) {
      setFloatingVisible(changes.showFloatingButton.newValue !== false);
    }
  });
}

function setFloatingVisible(visible) {
  if (!visible) {
    PIT_STATE.floating?.remove();
    PIT_STATE.floating = null;
    return;
  }

  if (PIT_STATE.floating || document.getElementById("pit-floating")) {
    return;
  }

  mountFloatingControl();
}

function mountFloatingControl() {
  const root = document.createElement("div");
  root.id = "pit-floating";
  root.dataset.pitSkip = "true";
  root.dataset.expanded = "false";
  root.dataset.mode = PIT_STATE.translated ? "translated" : "idle";
  root.innerHTML = `
    <button class="pit-fab" type="button" title="Left click: translate/original. Right click: menu">
      <span class="pit-fab-label">${PIT_STATE.translated ? "原" : "译"}</span>
      <span class="pit-fab-dot"></span>
    </button>
    <div class="pit-floating-menu" role="menu">
      <div class="pit-floating-title">Spark Translate</div>
      <button type="button" data-action="toggle">Translate / Original</button>
      <button type="button" data-action="clear">Clear</button>
      <button type="button" data-action="hide">Hide Floating</button>
      <div class="pit-floating-status">Ready</div>
    </div>
  `;

  document.documentElement.appendChild(root);
  PIT_STATE.floating = root;
  restoreFloatingPosition(root);
  wireFloatingControl(root);
}

function wireFloatingControl(root) {
  const fab = root.querySelector(".pit-fab");
  let drag = null;
  let suppressClick = false;

  fab.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    const rect = root.getBoundingClientRect();
    drag = {
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false
    };
    fab.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  fab.addEventListener("pointermove", (event) => {
    if (!drag) {
      return;
    }

    const dx = Math.abs(event.clientX - drag.startX);
    const dy = Math.abs(event.clientY - drag.startY);
    if (dx + dy > 4) {
      drag.moved = true;
      root.dataset.dragging = "true";
    }

    if (!drag.moved) {
      return;
    }

    root.style.left = `${clamp(event.clientX - drag.offsetX, 8, window.innerWidth - 64)}px`;
    root.style.right = "auto";
    root.style.top = `${clamp(event.clientY - drag.offsetY, 8, window.innerHeight - 64)}px`;
  });

  fab.addEventListener("pointerup", (event) => {
    if (!drag) {
      return;
    }

    fab.releasePointerCapture(event.pointerId);
    suppressClick = drag.moved;
    if (drag.moved) {
      snapFloatingToEdge(root);
      window.setTimeout(() => {
        root.dataset.dragging = "false";
        suppressClick = false;
      }, 120);
    }
    drag = null;
  });

  fab.addEventListener("click", () => {
    if (suppressClick) {
      return;
    }
    toggleTranslationFromFloating();
  });

  fab.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    root.dataset.expanded = root.dataset.expanded === "true" ? "false" : "true";
  });

  root.querySelector(".pit-floating-menu").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    root.dataset.expanded = "false";
    if (action === "toggle") {
      await toggleTranslationFromFloating();
    } else if (action === "clear") {
      clearTranslations();
    } else if (action === "hide") {
      await chrome.storage.local.set({ showFloatingButton: false });
      setFloatingVisible(false);
    }
  });
}

async function toggleTranslationFromFloating() {
  if (PIT_STATE.running) {
    setFloatingStatus("Already running");
    return;
  }

  if (hasPageTranslations()) {
    clearTranslations();
    return;
  }

  await translateFromFloating();
}

async function translateFromFloating() {
  if (PIT_STATE.running) {
    setFloatingStatus("Already running");
    return;
  }

  setFloatingStatus("Starting...");
  updateFloatingState("running");
  try {
    const options = await readTranslationSettings();
    const summary = await translatePage(options);
    PIT_STATE.translated = summary.translated > 0;
    updateFloatingState();
    setFloatingStatus(`Done: ${summary.translated}`);
  } catch (error) {
    updateFloatingState();
    setFloatingStatus("Failed");
    updateOverlay(error instanceof Error ? error.message : String(error), true);
  }
}

function readTranslationSettings() {
  return chrome.storage.local.get({
    targetLanguage: "中文",
    endpoint: "http://127.0.0.1:8787",
    mode: "bilingual",
    clearPrevious: true,
    viewportFirst: true
  }).then((settings) => ({
    ...settings,
    batchSize: 24,
    minChars: 4
  }));
}

function hasPageTranslations() {
  return Boolean(document.querySelector(".pit-translation"));
}

function updateFloatingState(forceMode) {
  const root = PIT_STATE.floating;
  if (!root) {
    return;
  }

  const mode = forceMode || (hasPageTranslations() || PIT_STATE.translated ? "translated" : "idle");
  const label = root.querySelector(".pit-fab-label");
  root.dataset.mode = mode;
  if (label) {
    label.textContent = mode === "running" ? "…" : mode === "translated" ? "原" : "译";
  }
}

function setFloatingStatus(text) {
  const status = PIT_STATE.floating?.querySelector(".pit-floating-status");
  if (!status) {
    return;
  }

  status.textContent = text;
  window.clearTimeout(PIT_STATE.floatingStatusTimer);
  PIT_STATE.floatingStatusTimer = window.setTimeout(() => {
    if (status.textContent === text) {
      status.textContent = "Ready";
    }
  }, 4500);
}

function restoreFloatingPosition(root) {
  const saved = readFloatingPosition();
  setFloatingPosition(root, saved.side || "right", saved.top || Math.round(window.innerHeight * 0.55));
}

function snapFloatingToEdge(root) {
  const rect = root.getBoundingClientRect();
  const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
  const top = clamp(rect.top, 8, window.innerHeight - 64);
  setFloatingPosition(root, side, top);
  localStorage.setItem("pit-floating-position", JSON.stringify({ side, top }));
}

function setFloatingPosition(root, side, top) {
  root.dataset.side = side;
  root.style.top = `${clamp(top, 8, window.innerHeight - 64)}px`;
  if (side === "left") {
    root.style.left = "16px";
    root.style.right = "auto";
  } else {
    root.style.left = "auto";
    root.style.right = "16px";
  }
}

function readFloatingPosition() {
  try {
    return JSON.parse(localStorage.getItem("pit-floating-position") || "{}");
  } catch {
    return {};
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function injectStyles() {
  if (document.getElementById("pit-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "pit-style";
  style.dataset.pitSkip = "true";
  style.textContent = `
    .pit-translation {
      display: block;
      width: auto;
      max-width: 100%;
      margin: 0.22em 0 0.9em;
      letter-spacing: 0;
      opacity: 0.68;
      text-decoration-line: underline;
      text-decoration-style: dashed;
      text-decoration-thickness: 1px;
      text-underline-offset: 0.18em;
      white-space: normal;
      word-break: normal;
      overflow-wrap: anywhere;
    }

    li > .pit-translation {
      margin-bottom: 0.45em;
    }

    #pit-floating {
      position: fixed;
      top: 55vh;
      right: 16px;
      z-index: 2147483646;
      color-scheme: light;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      user-select: none;
    }

    #pit-floating .pit-fab {
      position: relative;
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 999px;
      background: #101828;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.24);
      color: #ffffff;
      cursor: grab;
      font: 700 18px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      letter-spacing: 0;
    }

    #pit-floating[data-mode="translated"] .pit-fab {
      background: #0f766e;
    }

    #pit-floating[data-mode="running"] .pit-fab {
      background: #344054;
      cursor: wait;
    }

    #pit-floating .pit-fab-dot {
      position: absolute;
      right: 5px;
      bottom: 5px;
      width: 9px;
      height: 9px;
      border: 2px solid #ffffff;
      border-radius: 999px;
      background: #98a2b3;
    }

    #pit-floating[data-mode="translated"] .pit-fab-dot {
      background: #12b76a;
    }

    #pit-floating[data-mode="running"] .pit-fab-dot {
      background: #fdb022;
    }

    #pit-floating[data-dragging="true"] .pit-fab {
      cursor: grabbing;
    }

    #pit-floating .pit-floating-menu {
      position: absolute;
      top: 0;
      display: none;
      width: 168px;
      padding: 8px;
      border: 1px solid rgba(15, 23, 42, 0.14);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.98);
      box-shadow: 0 18px 42px rgba(15, 23, 42, 0.22);
      color: #101828;
    }

    #pit-floating[data-expanded="true"] .pit-floating-menu {
      display: grid;
      gap: 6px;
    }

    #pit-floating[data-side="right"] .pit-floating-menu {
      right: 56px;
    }

    #pit-floating[data-side="left"] .pit-floating-menu {
      left: 56px;
    }

    #pit-floating .pit-floating-title {
      padding: 4px 6px 2px;
      color: #475467;
      font-size: 12px;
      font-weight: 650;
    }

    #pit-floating .pit-floating-menu button {
      min-height: 32px;
      width: 100%;
      border: 0;
      border-radius: 6px;
      background: #f2f4f7;
      color: #101828;
      cursor: pointer;
      font: 650 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: left;
      padding: 0 10px;
    }

    #pit-floating .pit-floating-menu button:hover {
      background: #e4e7ec;
    }

    #pit-floating .pit-floating-status {
      padding: 3px 6px 1px;
      color: #667085;
      font-size: 12px;
    }

    #pit-status {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      max-width: min(360px, calc(100vw - 32px));
      padding: 10px 12px;
      border: 1px solid rgba(17, 24, 39, 0.14);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 10px 28px rgba(17, 24, 39, 0.18);
      color: #111827;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #pit-status[data-error="true"] {
      border-color: rgba(185, 28, 28, 0.28);
      color: #991b1b;
    }
  `;
  document.documentElement.appendChild(style);
}

function showOverlay() {
  let overlay = document.getElementById("pit-status");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "pit-status";
    overlay.dataset.pitSkip = "true";
    document.documentElement.appendChild(overlay);
  }

  PIT_STATE.overlay = overlay;
  updateOverlay("Preparing translation...");
}

function updateOverlay(text, done = false) {
  if (!PIT_STATE.overlay) {
    return;
  }

  PIT_STATE.overlay.dataset.error = String(text.toLowerCase().includes("error") || text.toLowerCase().includes("failed"));
  PIT_STATE.overlay.textContent = text;

  if (done) {
    window.setTimeout(() => {
      PIT_STATE.overlay?.remove();
      PIT_STATE.overlay = null;
    }, 4500);
  }
}
