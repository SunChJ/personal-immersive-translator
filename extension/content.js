const PIT_STATE = {
  running: false,
  cancelRequested: false,
  dynamicObserver: null,
  dynamicTimer: null,
  floating: null,
  floatingStatusTimer: null,
  lazyObserver: null,
  lazyQueue: [],
  lazyQueuedIds: new Set(),
  lazyTimer: null,
  translated: false,
  nextBlockId: 1,
  sessionId: createShortId()
};

const PIT_DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";
const PIT_TARGET_LANGUAGES = [
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "English",
  "Japanese",
  "Korean",
  "French",
  "German",
  "Spanish",
  "Portuguese",
  "Italian",
  "Russian",
  "Arabic",
  "Hindi",
  "Vietnamese",
  "Thai",
  "Indonesian"
];
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
const PIT_LAZY_ROOT_MARGIN = 600;

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
      setFloatingStatus("Failed");
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

  try {
    if (options.clearPrevious) {
      clearTranslations();
    }

    stopDynamicTranslationObserver();
    stopLazyTranslationObserver();

    const blocks = collectTranslationBlocks(document.body, {
      minChars: Number(options.minChars || 4),
      mode: options.mode || "bilingual"
    });
    const orderedBlocks = prioritizeBlocks(blocks, options.viewportFirst !== false);

    if (orderedBlocks.length === 0) {
      setFloatingStatus("No text found");
      return { translated: 0, total: 0 };
    }

    const { immediate, deferred } = splitImmediateTranslationBlocks(orderedBlocks, options.viewportFirst !== false);
    const translated = await translateBlocks(immediate, options);

    if (deferred.length > 0) {
      startLazyTranslationObserver(deferred, options);
    }

    PIT_STATE.translated = translated > 0;
    updateFloatingState();
    setFloatingStatus(deferred.length > 0 ? `Done: ${translated}, queued ${deferred.length}` : `Done: ${translated}`);
    if (translated > 0) {
      startDynamicTranslationObserver(options);
    }
    return { translated, total: orderedBlocks.length, deferred: deferred.length };
  } finally {
    PIT_STATE.running = false;
  }
}

function splitImmediateTranslationBlocks(blocks, viewportFirst) {
  if (!viewportFirst) {
    return { immediate: blocks, deferred: [] };
  }

  const immediate = [];
  const deferred = [];

  blocks.forEach((entry) => {
    const rect = entry.element.getBoundingClientRect();
    if (isNearViewport(rect, PIT_LAZY_ROOT_MARGIN)) {
      immediate.push(entry);
    } else {
      deferred.push(entry);
    }
  });

  if (immediate.length === 0 && blocks.length > 0) {
    immediate.push(...blocks.slice(0, 12));
    return {
      immediate,
      deferred: blocks.slice(12)
    };
  }

  return { immediate, deferred };
}

async function translateBlocks(orderedBlocks, options, overlayPrefix = "Translating") {
  const batchSize = clamp(Number(options.batchSize || 24), 1, 40);
  const mode = options.mode || "bilingual";
  let translated = 0;

  prepareStableTranslationSurfaces(orderedBlocks, mode);
  await nextAnimationFrame();

  try {
    for (let offset = 0; offset < orderedBlocks.length; offset += batchSize) {
      if (PIT_STATE.cancelRequested) {
        removePendingTranslationSurfaces(orderedBlocks, mode);
        setFloatingStatus(`Stopped: ${translated}/${orderedBlocks.length}`);
        return translated;
      }

      const batch = orderedBlocks.slice(offset, offset + batchSize);
      setFloatingStatus(`${overlayPrefix} ${offset + 1}-${Math.min(offset + batch.length, orderedBlocks.length)} / ${orderedBlocks.length}`);

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
        targetLanguage: options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE,
        endpoint: options.endpoint || "http://127.0.0.1:8787",
        sourceUrl: location.href
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || "Translation request failed.");
      }

      applyTranslations(batch, response.translations, mode);
      translated += batch.length;
    }
  } catch (error) {
    removePendingTranslationSurfaces(orderedBlocks, mode);
    throw error;
  }

  return translated;
}

function collectTranslationBlocks(root, options) {
  const seen = new Set();
  const blocks = [];
  const textFingerprints = new Set();
  const minChars = Number(options.minChars || 4);

  if (options.mode !== "replace") {
    collectTweetTextSegments(root, { seen, blocks, textFingerprints, minChars });
  }

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

function collectTweetTextSegments(root, context) {
  root.querySelectorAll("[data-testid='tweetText']").forEach((element) => {
    if (
      context.seen.has(element) ||
      shouldSkipElement(element) ||
      hasExistingTranslation(element) ||
      !isVisible(element) ||
      isAssistiveOnlyElement(element)
    ) {
      return;
    }

    const segments = extractTweetTextSegments(element)
      .map((segment, index) => ({
        ...segment,
        text: normalizeReadableText(segment.text),
        index
      }))
      .filter((segment) => segment.text.length >= context.minChars && !isMostlyPunctuation(segment.text) && !isBoilerplateText(segment.text));

    if (segments.length <= 1) {
      return;
    }

    const baseId = ensurePitId(element);
    let accepted = 0;

    segments.forEach((segment) => {
      const fingerprint = createTextFingerprint(segment.text);
      if (context.textFingerprints.has(fingerprint)) {
        return;
      }

      context.textFingerprints.add(fingerprint);
      context.blocks.push({
        element,
        id: `${baseId}-seg-${String(segment.index + 1).padStart(3, "0")}`,
        insertAfter: segment.anchor,
        kind: "tweet-segment",
        text: segment.text
      });
      accepted += 1;
    });

    if (accepted > 0) {
      context.seen.add(element);
      element.dataset.pitBlockKind = "tweet-segment";
    }
  });
}

function extractTweetTextSegments(element) {
  const segments = [];
  let text = "";
  let anchor = null;
  let brCount = 0;

  const flush = () => {
    const normalized = normalizeReadableText(text);
    if (normalized && anchor) {
      segments.push({ text: normalized, anchor });
    }
    text = "";
    anchor = null;
    brCount = 0;
  };

  const appendText = (value, nodeAnchor) => {
    text += value;
    anchor = nodeAnchor;
    brCount = 0;
  };

  const visit = (node, directAnchor) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) {
        appendText(node.nodeValue, directAnchor);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE || !(node instanceof HTMLElement)) {
      return;
    }

    const tagName = node.tagName.toLowerCase();
    if (tagName === "br") {
      brCount += 1;
      anchor = directAnchor;
      if (brCount >= 2) {
        flush();
      } else {
        text += "\n";
      }
      return;
    }

    if (node !== element && shouldSkipElement(node)) {
      return;
    }

    node.childNodes.forEach((child) => visit(child, directAnchor));
  };

  element.childNodes.forEach((child) => visit(child, child));
  flush();

  return segments;
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
        "[data-pit-deferred='true']",
        "[translate='no']",
        ".notranslate",
        ".pit-translation",
        "#pit-floating"
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

function isNearViewport(rect, margin) {
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin && rect.right >= -margin && rect.left <= window.innerWidth + margin;
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
  if (element.matches("[data-testid='tweetText']")) {
    return normalizeReadableText(element.innerText || element.textContent || "");
  }

  const text = extractReadableTextFromNode(element, element);
  return normalizeReadableText(text);
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

  if (isLikelyNavigationOrActionElement(element, text)) {
    return true;
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

function isLikelyNavigationOrActionElement(element, text) {
  if (text.length > 120) {
    return false;
  }

  if (isShortInteractiveLabel(element, text)) {
    return true;
  }

  const chromeAncestor = closestChromeLikeAncestor(element);
  if (chromeAncestor && text.length < 90) {
    return true;
  }

  return isDenseInteractiveContainer(element, text);
}

function isShortInteractiveLabel(element, text) {
  if (!element.matches("a, button, [role='link'], [role='button'], [role='menuitem'], [role='tab']")) {
    return false;
  }

  return text.length <= 36 && !looksLikeSentence(text);
}

function closestChromeLikeAncestor(element) {
  let current = element;
  let depth = 0;

  while (current && current !== document.body && depth < 7) {
    if (hasChromeLikeDescriptor(current)) {
      return current;
    }

    current = current.parentElement;
    depth += 1;
  }

  return null;
}

function hasChromeLikeDescriptor(element) {
  const descriptor = [
    element.id || "",
    typeof element.className === "string" ? element.className : "",
    element.getAttribute("role") || "",
    element.getAttribute("aria-label") || ""
  ].join(" ");

  return /(^|[\s_-])(appbar|breadcrumb|button|cta|download|footer|header|login|menu|menubar|nav|navbar|navigation|navlink|pagination|sidebar|signedout|tabbar|tabs|toolbar|topbar)([\s_-]|$)/i.test(descriptor);
}

function isDenseInteractiveContainer(element, text) {
  if (text.length > 90 || element.matches("article, main, section")) {
    return false;
  }

  const interactiveCount = element.querySelectorAll("a, button, [role='link'], [role='button'], [role='menuitem'], [role='tab']").length;
  if (interactiveCount < 2) {
    return false;
  }

  const paragraphCount = element.querySelectorAll("p, blockquote, li, h1, h2, h3, h4, h5, h6").length;
  return paragraphCount === 0 || interactiveCount >= paragraphCount;
}

function looksLikeSentence(text) {
  const trimmed = text.trim();
  if (trimmed.length > 48) {
    return true;
  }

  return /[.!?。！？]\s*$/.test(trimmed) || /\s+\S+\s+\S+\s+\S+/.test(trimmed);
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

function prepareStableTranslationSurfaces(entries, mode) {
  entries.forEach((entry) => {
    if (!entry.element.parentNode) {
      return;
    }

    if (mode === "replace") {
      lockElementHeight(entry.element);
      return;
    }

    if (entry.translationSlot?.isConnected) {
      return;
    }

    const existingSlot = findTranslationSlot(entry);
    if (existingSlot) {
      entry.translationSlot = existingSlot;
      return;
    }

    const slot = document.createElement("div");
    slot.className = "pit-translation pit-translation-pending";
    slot.dataset.pitSkip = "true";
    slot.setAttribute("aria-hidden", "true");
    applyInheritedTextStyle(entry.element, slot);
    slot.style.minHeight = estimateTranslationSlotHeight(entry);
    insertTranslationSlot(entry, slot);
    entry.translationSlot = slot;
  });
}

function removePendingTranslationSurfaces(entries, mode) {
  entries.forEach((entry) => {
    if (mode === "replace") {
      unlockElementHeight(entry.element);
      return;
    }

    if (entry.translationSlot?.classList.contains("pit-translation-pending")) {
      entry.translationSlot.remove();
      entry.translationSlot = null;
    }
  });
}

function findTranslationSlot(entry) {
  if (entry.kind === "tweet-segment") {
    return entry.element.querySelector(`:scope > .pit-translation[data-pit-slot-id="${entry.id}"]`);
  }

  const element = entry.element;
  const sibling = element.nextElementSibling;
  if (sibling?.classList?.contains("pit-translation")) {
    return sibling;
  }

  const child = element.querySelector?.(":scope > .pit-translation");
  return child || null;
}

function insertTranslationSlot(entry, slot) {
  slot.dataset.pitSlotId = entry.id;

  if (entry.kind === "tweet-segment" && entry.insertAfter?.parentNode === entry.element) {
    entry.element.insertBefore(slot, entry.insertAfter.nextSibling);
    return;
  }

  const element = entry.element;
  const listParent = element.closest("li");
  if (element === listParent) {
    element.appendChild(slot);
    return;
  }

  element.parentNode.insertBefore(slot, element.nextSibling);
}

function lockElementHeight(element) {
  if (element.dataset.pitHeightLocked === "true") {
    return;
  }

  const rect = element.getBoundingClientRect();
  if (rect.height <= 0) {
    return;
  }

  element.dataset.pitHeightLocked = "true";
  element.dataset.pitPreviousMinHeight = element.style.minHeight || "";
  element.style.minHeight = `${Math.ceil(rect.height)}px`;
}

function unlockElementHeight(element) {
  if (element.dataset.pitHeightLocked !== "true") {
    return;
  }

  element.style.minHeight = element.dataset.pitPreviousMinHeight || "";
  delete element.dataset.pitHeightLocked;
  delete element.dataset.pitPreviousMinHeight;
}

function unlockElementHeightSoon(element) {
  window.setTimeout(() => {
    unlockElementHeight(element);
  }, 320);
}

function estimateTranslationSlotHeight(entry) {
  const sourceElement = entry.element;
  const style = window.getComputedStyle(sourceElement);
  const rect = sourceElement.getBoundingClientRect();
  const lineHeight = readableLineHeight(style);

  if (entry.kind === "tweet-segment") {
    const fontSize = Number.parseFloat(style.fontSize);
    const averageCharWidth = Number.isFinite(fontSize) ? fontSize * 0.58 : 9;
    const availableWidth = Number.isFinite(rect.width) && rect.width > 0 ? rect.width : 520;
    const charsPerLine = Math.max(18, Math.floor(availableWidth / averageCharWidth));
    const estimatedLines = entry.text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
    return `${Math.ceil(Math.max(lineHeight, estimatedLines * lineHeight))}px`;
  }

  const sourceHeight = Number.isFinite(rect.height) && rect.height > 0 ? rect.height : lineHeight;
  const estimated = Math.max(lineHeight, sourceHeight * 0.82);
  return `${Math.ceil(estimated)}px`;
}

function readableLineHeight(style) {
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight)) {
    return lineHeight;
  }

  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) ? fontSize * 1.35 : 20;
}

function applyTranslations(batch, translations, mode) {
  const translationsById = normalizeTranslationMap(batch, translations);

  batch.forEach((entry) => {
    const translation = String(translationsById.get(entry.id) || "").trim();
    if (!translation || !entry.element.parentNode) {
      if (!translation && entry.translationSlot?.classList.contains("pit-translation-pending")) {
        entry.translationSlot.remove();
      }
      if (mode === "replace") {
        unlockElementHeight(entry.element);
      }
      return;
    }

    if (mode === "replace") {
      entry.element.dataset.pitTranslated = "true";
      entry.element.textContent = translation;
      unlockElementHeightSoon(entry.element);
      return;
    }

    const translationBlock = entry.translationSlot || document.createElement("div");
    translationBlock.className = "pit-translation pit-translation-ready";
    translationBlock.dataset.pitSkip = "true";
    translationBlock.textContent = translation;
    translationBlock.removeAttribute("aria-hidden");
    applyInheritedTextStyle(entry.element, translationBlock);
    entry.element.dataset.pitTranslated = "true";

    if (!translationBlock.parentNode) {
      insertTranslationSlot(entry, translationBlock);
    }
  });
}

function clearTranslations() {
  stopDynamicTranslationObserver();
  stopLazyTranslationObserver();
  document.querySelectorAll(".pit-translation").forEach((node) => node.remove());
  document.querySelectorAll("[data-pit-translated='true']").forEach((node) => {
    node.dataset.pitTranslated = "false";
  });
  document.querySelectorAll("[data-pit-deferred='true']").forEach((node) => {
    delete node.dataset.pitDeferred;
  });
  document.querySelectorAll("[data-pit-height-locked='true']").forEach((node) => {
    unlockElementHeight(node);
  });
  PIT_STATE.translated = false;
  updateFloatingState();
  setFloatingStatus("Cleared");
}

function startLazyTranslationObserver(entries, options) {
  stopLazyTranslationObserver();

  if (!entries.length || !("IntersectionObserver" in window)) {
    return;
  }

  const observer = new IntersectionObserver((observedEntries) => {
    observedEntries.forEach((observed) => {
      if (!observed.isIntersecting) {
        return;
      }

      observer.unobserve(observed.target);
      const entry = entries.find((item) => item.element === observed.target);
      if (entry) {
        queueLazyTranslation(entry, options);
      }
    });
  }, {
    root: null,
    rootMargin: `${PIT_LAZY_ROOT_MARGIN}px`,
    threshold: 0.1
  });

  entries.forEach((entry) => {
    if (!entry.element.parentNode || hasExistingTranslation(entry.element)) {
      return;
    }

    entry.element.dataset.pitDeferred = "true";
    observer.observe(entry.element);
  });

  PIT_STATE.lazyObserver = observer;
}

function queueLazyTranslation(entry, options) {
  if (PIT_STATE.lazyQueuedIds.has(entry.id) || hasExistingTranslation(entry.element)) {
    return;
  }

  delete entry.element.dataset.pitDeferred;
  PIT_STATE.lazyQueuedIds.add(entry.id);
  PIT_STATE.lazyQueue.push(entry);
  window.clearTimeout(PIT_STATE.lazyTimer);
  PIT_STATE.lazyTimer = window.setTimeout(() => {
    flushLazyTranslationQueue(options).catch((error) => {
      setFloatingStatus("Update failed");
    });
  }, 120);
}

async function flushLazyTranslationQueue(options) {
  if (PIT_STATE.running || PIT_STATE.lazyQueue.length === 0) {
    if (PIT_STATE.lazyQueue.length > 0) {
      PIT_STATE.lazyTimer = window.setTimeout(() => {
        flushLazyTranslationQueue(options).catch((error) => {
          setFloatingStatus("Update failed");
        });
      }, 500);
    }
    return;
  }

  const batch = PIT_STATE.lazyQueue.splice(0, 24).filter((entry) => entry.element.parentNode && !hasExistingTranslation(entry.element));
  batch.forEach((entry) => PIT_STATE.lazyQueuedIds.delete(entry.id));
  if (batch.length === 0) {
    return;
  }

  PIT_STATE.running = true;
  PIT_STATE.cancelRequested = false;
  updateFloatingState("running");

  try {
    const translated = await translateBlocks(prioritizeBlocks(batch, true), { ...options, clearPrevious: false }, "Loading nearby");
    if (translated > 0) {
      PIT_STATE.translated = true;
      setFloatingStatus(`Added: ${translated}`);
    }
  } finally {
    PIT_STATE.running = false;
    updateFloatingState();
  }

  if (PIT_STATE.lazyQueue.length > 0) {
    PIT_STATE.lazyTimer = window.setTimeout(() => {
      flushLazyTranslationQueue(options).catch((error) => {
        setFloatingStatus("Update failed");
      });
    }, 120);
  }
}

function stopLazyTranslationObserver() {
  PIT_STATE.lazyObserver?.disconnect();
  PIT_STATE.lazyObserver = null;
  PIT_STATE.lazyQueue.forEach((entry) => {
    delete entry.element.dataset.pitDeferred;
  });
  document.querySelectorAll("[data-pit-deferred='true']").forEach((node) => {
    delete node.dataset.pitDeferred;
  });
  PIT_STATE.lazyQueue = [];
  PIT_STATE.lazyQueuedIds.clear();
  window.clearTimeout(PIT_STATE.lazyTimer);
  PIT_STATE.lazyTimer = null;
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
    minChars: Number(options.minChars || 4),
    mode: options.mode || "bilingual"
  });
  const orderedBlocks = prioritizeBlocks(blocks, true).slice(0, 40);
  if (orderedBlocks.length === 0) {
    return;
  }

  PIT_STATE.running = true;
  PIT_STATE.cancelRequested = false;
  updateFloatingState("running");

  try {
    const translated = await translateBlocks(orderedBlocks, { ...options, clearPrevious: false }, "Updating");
    if (translated > 0) {
      PIT_STATE.translated = true;
      setFloatingStatus(`Added: ${translated}`);
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

function nextAnimationFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
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
      <span class="pit-fab-label">${PIT_STATE.translated ? "O" : "T"}</span>
      <span class="pit-fab-dot"></span>
    </button>
    <div class="pit-floating-menu" role="menu">
      <div class="pit-floating-head">
        <div>
          <div class="pit-floating-title">Spark Translate</div>
          <div class="pit-floating-subtitle">Local Codex bridge</div>
        </div>
        <span class="pit-floating-badge">Ready</span>
      </div>
      <button class="pit-floating-primary" type="button" data-action="toggle">Translate Page</button>
      <div class="pit-floating-server">
        <div>
          <span>Server</span>
          <strong data-role="serverState">Checking...</strong>
        </div>
        <em data-role="latency">--</em>
      </div>
      <div class="pit-floating-actions">
        <button type="button" data-action="clear">Clear</button>
        <button type="button" data-action="hide">Hide</button>
      </div>
      <label class="pit-floating-field">
        <span>Target</span>
        <select data-setting="targetLanguage">
          ${renderTargetLanguageOptions()}
          <option value="__custom__">Custom...</option>
        </select>
        <input data-setting="customTargetLanguage" placeholder="e.g. Dutch, Brazilian Portuguese" hidden>
      </label>
      <label class="pit-floating-field">
        <span>Mode</span>
        <select data-setting="mode">
          <option value="bilingual">Bilingual</option>
          <option value="replace">Replace original</option>
        </select>
      </label>
      <label class="pit-floating-check">
        <input data-setting="clearPrevious" type="checkbox">
        <span>Clear before translating</span>
      </label>
      <label class="pit-floating-check">
        <input data-setting="viewportFirst" type="checkbox">
        <span>Translate visible text first</span>
      </label>
      <div class="pit-floating-status">Ready</div>
    </div>
  `;

  document.documentElement.appendChild(root);
  PIT_STATE.floating = root;
  restoreFloatingPosition(root);
  wireFloatingControl(root);
  hydrateFloatingSettings(root);
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
    const expanded = root.dataset.expanded !== "true";
    root.dataset.expanded = expanded ? "true" : "false";
    if (expanded) {
      hydrateFloatingSettings(root);
    }
  });

  const menu = root.querySelector(".pit-floating-menu");
  menu.addEventListener("click", async (event) => {
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

  menu.addEventListener("change", async (event) => {
    if (!event.target.matches("[data-setting]")) {
      return;
    }

    if (event.target.dataset.setting === "targetLanguage") {
      updateFloatingCustomLanguage(root);
    }

    await saveFloatingSettings(root);
  });

  menu.addEventListener("input", async (event) => {
    if (event.target.dataset.setting !== "customTargetLanguage") {
      return;
    }

    await saveFloatingSettings(root);
  });
}

function renderTargetLanguageOptions() {
  return PIT_TARGET_LANGUAGES.map((language) => `<option value="${language}">${language}</option>`).join("");
}

async function hydrateFloatingSettings(root) {
  const settings = await readTranslationSettings();
  const targetSelect = root.querySelector("[data-setting='targetLanguage']");
  const customTarget = root.querySelector("[data-setting='customTargetLanguage']");
  const mode = root.querySelector("[data-setting='mode']");
  const clearPrevious = root.querySelector("[data-setting='clearPrevious']");
  const viewportFirst = root.querySelector("[data-setting='viewportFirst']");
  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);

  if (PIT_TARGET_LANGUAGES.includes(targetLanguage)) {
    targetSelect.value = targetLanguage;
    customTarget.value = "";
  } else {
    targetSelect.value = "__custom__";
    customTarget.value = targetLanguage;
  }

  mode.value = settings.mode;
  clearPrevious.checked = settings.clearPrevious !== false;
  viewportFirst.checked = settings.viewportFirst !== false;
  updateFloatingCustomLanguage(root);
  updateFloatingState();
  checkFloatingHealth(root, settings.endpoint);
}

async function saveFloatingSettings(root) {
  const current = await readTranslationSettings();
  await chrome.storage.local.set({
    ...current,
    targetLanguage: readFloatingTargetLanguage(root),
    mode: root.querySelector("[data-setting='mode']").value,
    clearPrevious: root.querySelector("[data-setting='clearPrevious']").checked,
    viewportFirst: root.querySelector("[data-setting='viewportFirst']").checked
  });
  setFloatingStatus("Saved");
}

function readFloatingTargetLanguage(root) {
  const targetSelect = root.querySelector("[data-setting='targetLanguage']");
  if (targetSelect.value === "__custom__") {
    return normalizeTargetLanguage(root.querySelector("[data-setting='customTargetLanguage']").value);
  }
  return normalizeTargetLanguage(targetSelect.value);
}

function normalizeTargetLanguage(value) {
  const language = String(value || "").trim();
  if (!language) {
    return PIT_DEFAULT_TARGET_LANGUAGE;
  }
  return PIT_LEGACY_TARGET_LANGUAGE_ALIASES.get(language) || language;
}

function updateFloatingCustomLanguage(root) {
  const custom = root.querySelector("[data-setting='targetLanguage']").value === "__custom__";
  root.querySelector("[data-setting='customTargetLanguage']").hidden = !custom;
}

async function checkFloatingHealth(root, endpoint) {
  const serverState = root.querySelector("[data-role='serverState']");
  const latency = root.querySelector("[data-role='latency']");
  const badge = root.querySelector(".pit-floating-badge");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "check-health",
      endpoint
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Health check failed.");
    }

    const body = response.health || {};
    const backend = body.backend || "proxy";
    const model = body.model || "model";
    serverState.textContent = body.warm === false ? `${backend} warming` : `${backend} / ${model}`;
    latency.textContent = body.lastLatencyMs ? `${body.lastLatencyMs}ms` : body.warm === false ? "warming" : "--";
    badge.textContent = PIT_STATE.running ? "Busy" : "Ready";
    badge.dataset.ok = "true";
  } catch {
    serverState.textContent = "Not running";
    latency.textContent = "--";
    badge.textContent = "Offline";
    badge.dataset.ok = "false";
  }
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
  }
}

function readTranslationSettings() {
  return chrome.storage.local.get({
    targetLanguage: PIT_DEFAULT_TARGET_LANGUAGE,
    endpoint: "http://127.0.0.1:8787",
    mode: "bilingual",
    clearPrevious: true,
    viewportFirst: true
  }).then((settings) => ({
    ...settings,
    targetLanguage: normalizeTargetLanguage(settings.targetLanguage),
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
  const action = root.querySelector("[data-action='toggle']");
  const badge = root.querySelector(".pit-floating-badge");
  root.dataset.mode = mode;
  if (label) {
    label.textContent = mode === "running" ? "..." : mode === "translated" ? "O" : "T";
  }
  if (action) {
    action.textContent = mode === "translated" ? "Show Original" : "Translate Page";
  }
  if (badge && (mode === "running" || badge.dataset.ok !== "false")) {
    badge.textContent = mode === "running" ? "Busy" : "Ready";
  }
}

function setFloatingStatus(text) {
  const status = PIT_STATE.floating?.querySelector(".pit-floating-status");
  const badge = PIT_STATE.floating?.querySelector(".pit-floating-badge");
  if (!status && !badge) {
    return;
  }

  if (status) {
    status.textContent = text;
  }
  if (badge && (PIT_STATE.running || badge.dataset.ok !== "false")) {
    badge.textContent = PIT_STATE.running ? "Busy" : "Ready";
  }
  window.clearTimeout(PIT_STATE.floatingStatusTimer);
  PIT_STATE.floatingStatusTimer = window.setTimeout(() => {
    if (status?.textContent === text) {
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
      white-space: pre-line;
      word-break: normal;
      overflow-wrap: anywhere;
      transition: opacity 140ms ease;
      contain: layout style paint;
    }

    .pit-translation-pending {
      opacity: 0;
      pointer-events: none;
    }

    .pit-translation-ready {
      opacity: 0.68;
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
      width: 272px;
      padding: 10px;
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

    #pit-floating .pit-floating-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      padding: 2px 2px 4px;
    }

    #pit-floating .pit-floating-title {
      color: #475467;
      font-size: 12px;
      font-weight: 650;
    }

    #pit-floating .pit-floating-subtitle {
      margin-top: 1px;
      color: #667085;
      font-size: 11px;
      font-weight: 500;
    }

    #pit-floating .pit-floating-badge {
      flex: 0 0 auto;
      min-width: 48px;
      padding: 2px 7px;
      border: 1px solid #b7dfc8;
      border-radius: 999px;
      background: #eefaf2;
      color: #0f7a3f;
      font-size: 11px;
      font-weight: 650;
      text-align: center;
    }

    #pit-floating[data-mode="running"] .pit-floating-badge {
      border-color: #fedf89;
      background: #fffaeb;
      color: #b54708;
    }

    #pit-floating .pit-floating-badge[data-ok="false"] {
      border-color: #f1b8b8;
      background: #fff1f1;
      color: #b42318;
    }

    #pit-floating .pit-floating-server {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 9px;
      border: 1px solid #dde3ea;
      border-radius: 8px;
      background: #ffffff;
    }

    #pit-floating .pit-floating-server span {
      display: block;
      color: #687280;
      font-size: 11px;
      font-weight: 600;
    }

    #pit-floating .pit-floating-server strong {
      display: block;
      margin-top: 1px;
      max-width: 180px;
      overflow: hidden;
      color: #101828;
      font-size: 12px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #pit-floating .pit-floating-server em {
      flex: 0 0 auto;
      color: #667085;
      font-size: 11px;
      font-style: normal;
      font-weight: 500;
    }

    #pit-floating .pit-floating-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    #pit-floating .pit-floating-menu button {
      min-height: 32px;
      width: 100%;
      border: 1px solid #d0d5dd;
      border-radius: 6px;
      background: #ffffff;
      color: #101828;
      cursor: pointer;
      font: 650 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
      padding: 0 10px;
    }

    #pit-floating .pit-floating-menu .pit-floating-primary {
      min-height: 36px;
      border-color: #101828;
      background: #101828;
      color: #ffffff;
      font-weight: 700;
    }

    #pit-floating .pit-floating-menu button:hover {
      background: #e4e7ec;
    }

    #pit-floating .pit-floating-menu .pit-floating-primary:hover {
      background: #1d2939;
    }

    #pit-floating .pit-floating-field {
      display: grid;
      gap: 5px;
      color: #384250;
      font-size: 12px;
      font-weight: 650;
    }

    #pit-floating .pit-floating-field select,
    #pit-floating .pit-floating-field input {
      width: 100%;
      min-height: 32px;
      border: 1px solid #cbd3dd;
      border-radius: 6px;
      background: #ffffff;
      color: #101828;
      font: 13px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      padding: 6px 8px;
    }

    #pit-floating .pit-floating-field input[hidden] {
      display: none;
    }

    #pit-floating .pit-floating-check {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 24px;
      color: #384250;
      font-size: 12px;
      font-weight: 500;
    }

    #pit-floating .pit-floating-check input {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      margin: 0;
    }

    #pit-floating .pit-floating-status {
      min-height: 18px;
      padding: 3px 2px 1px;
      color: #667085;
      font-size: 12px;
    }

  `;
  document.documentElement.appendChild(style);
}
