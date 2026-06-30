const PIT_STATE = {
  running: false,
  cancelRequested: false,
  dynamicObserver: null,
  dynamicRoots: [],
  dynamicTimer: null,
  dynamicRouteUrl: location.href,
  routePollTimer: null,
  routeSettlingTimers: [],
  routeEventHandler: null,
  routeTranslationTimer: null,
  routeUpdatePending: false,
  floating: null,
  floatingStatusTimer: null,
  selectionTooltip: null,
  selectionTimer: null,
  selectionRequestId: 0,
  selectionTranslationEnabled: true,
  lazyObserver: null,
  lazyQueue: [],
  lazyQueuedIds: new Set(),
  lazyTimer: null,
  translated: false,
  autoTranslateActive: false,
  nextBlockId: 1,
  lastModel: "",
  sessionId: createShortId()
};

const PIT_DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";
const PIT_DEFAULT_BILINGUAL_STYLE = "dashed";
const PIT_BILINGUAL_STYLES = new Set(["dashed", "dotted", "wavy", "highlight", "soft-box", "blur"]);
const PIT_MAX_BATCH_ITEMS = 40;
const PIT_DEFAULT_BATCH_CHAR_LIMIT = 9000;
const PIT_MIN_BATCH_CHAR_LIMIT = 1800;
const PIT_MAX_BATCH_CHAR_LIMIT = 18000;
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
const PIT_TARGET_LANGUAGE_LABELS = {
  "Chinese (Simplified)": "中文 (简体)",
  "Chinese (Traditional)": "中文 (繁体)",
  "English": "English",
  "Japanese": "日本語",
  "Korean": "한국어",
  "French": "Français",
  "German": "Deutsch",
  "Spanish": "Español",
  "Portuguese": "Português",
  "Italian": "Italiano",
  "Russian": "Русский",
  "Arabic": "العربية",
  "Hindi": "हिन्दी",
  "Vietnamese": "Tiếng Việt",
  "Thai": "ไทย",
  "Indonesian": "Indonesia"
};
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
const PIT_DYNAMIC_SKIP_OPTIONS = {
  allowTranslatedAncestors: true,
  allowDeferredAncestors: true,
  allowInteractiveAncestors: false
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

const PIT_INTERACTIVE_ANCESTOR_SELECTOR = [
  "button",
  "select",
  "textarea",
  "[role='button']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']"
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
initSelectionTranslation();

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

    if (options.preserveDynamicObserver && PIT_STATE.dynamicObserver) {
      PIT_STATE.dynamicRoots = [];
    } else {
      stopDynamicTranslationObserver();
    }
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
    if (translated > 0) {
      PIT_STATE.autoTranslateActive = true;
    }
    updateFloatingState();
    setFloatingStatus(deferred.length > 0 ? `Done: ${translated}, queued ${deferred.length}` : `Done: ${translated}`);
    if (translated > 0) {
      if (options.preserveDynamicObserver && PIT_STATE.dynamicObserver) {
        PIT_STATE.dynamicRouteUrl = location.href;
      } else {
        startDynamicTranslationObserver(options);
      }
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
    const rect = getEntryRect(entry);
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
  const maxBatchItems = clamp(Number(options.batchSize || PIT_MAX_BATCH_ITEMS), 1, PIT_MAX_BATCH_ITEMS);
  const maxBatchChars = clamp(Number(options.batchCharLimit || PIT_DEFAULT_BATCH_CHAR_LIMIT), PIT_MIN_BATCH_CHAR_LIMIT, PIT_MAX_BATCH_CHAR_LIMIT);
  const mode = options.mode || "bilingual";
  let translated = 0;

  const bilingualStyle = normalizeBilingualStyle(options.bilingualStyle);
  const batches = createAdaptiveTranslationBatches(orderedBlocks, {
    maxItems: maxBatchItems,
    maxChars: maxBatchChars
  });

  prepareStableTranslationSurfaces(orderedBlocks, mode, bilingualStyle);
  await nextAnimationFrame();

  try {
    for (const batch of batches) {
      if (PIT_STATE.cancelRequested) {
        removePendingTranslationSurfaces(orderedBlocks, mode);
        setFloatingStatus(`Stopped: ${translated}/${orderedBlocks.length}`);
        return translated;
      }

      const batchChars = batch.reduce((sum, entry) => sum + estimateTranslationEntryChars(entry), 0);
      setFloatingStatus(`${overlayPrefix} ${translated + 1}-${Math.min(translated + batch.length, orderedBlocks.length)} / ${orderedBlocks.length} (${formatCharCount(batchChars)})`);

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

      applyTranslations(batch, response.translations, mode, bilingualStyle);
      translated += batch.length;
    }
  } catch (error) {
    markPendingTranslationSurfacesFailed(orderedBlocks, mode, options, error);
    throw error;
  }

  return translated;
}

function createAdaptiveTranslationBatches(entries, options) {
  const batches = [];
  let batch = [];
  let batchChars = 0;

  entries.forEach((entry) => {
    const entryChars = estimateTranslationEntryChars(entry);
    const wouldExceedItems = batch.length >= options.maxItems;
    const wouldExceedChars = batch.length > 0 && batchChars + entryChars > options.maxChars;

    if (wouldExceedItems || wouldExceedChars) {
      batches.push(batch);
      batch = [];
      batchChars = 0;
    }

    batch.push(entry);
    batchChars += entryChars;
  });

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}

function estimateTranslationEntryChars(entry) {
  return String(entry.text || "").length + String(entry.id || "").length + 24;
}

function formatCharCount(value) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k chars`;
  }
  return `${value} chars`;
}

function collectTranslationBlocks(root, options) {
  const seen = new Set();
  const blocks = [];
  const textFingerprints = new Set();
  const minChars = Number(options.minChars || 4);
  const context = {
    seen,
    blocks,
    textFingerprints,
    minChars,
    skipOptions: {
      allowTranslatedAncestors: Boolean(options.allowTranslatedAncestors),
      allowDeferredAncestors: Boolean(options.allowDeferredAncestors),
      allowInteractiveAncestors: false
    },
    measurements: createMeasurementCache(),
    collectedElements: []
  };

  try {
    if (options.mode !== "replace") {
      collectTweetTextSegments(root, context);
    }

    collectSiteRuleBlocks(root, context);

    queryElementsIncludingRoot(root, PIT_DIRECT_TEXT_SELECTOR).forEach((element) => {
      pushTranslationBlock(element, {
        ...context,
        kind: "semantic",
        allowChildBlocks: false
      });
    });

    walkParagraphCandidates(root, (element) => {
      pushTranslationBlock(element, {
        ...context,
        kind: "walked",
        allowChildBlocks: false
      });
    }, context.measurements, context.skipOptions);

    return blocks.sort((a, b) => {
      if (a.element === b.element) {
        return 0;
      }
      return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
    });
  } finally {
    context.collectedElements.forEach((element) => {
      delete element.dataset.pitCollected;
    });
  }
}

function queryElementsIncludingRoot(root, selector) {
  const elements = [];
  if (root instanceof HTMLElement && root.matches(selector)) {
    elements.push(root);
  }
  if (root.querySelectorAll) {
    elements.push(...root.querySelectorAll(selector));
  }
  return elements;
}

function createMeasurementCache() {
  return {
    rects: new WeakMap(),
    styles: new WeakMap()
  };
}

function getCachedStyle(element, measurements) {
  if (!measurements) {
    return window.getComputedStyle(element);
  }

  let style = measurements.styles.get(element);
  if (!style) {
    style = window.getComputedStyle(element);
    measurements.styles.set(element, style);
  }
  return style;
}

function getCachedRect(element, measurements) {
  if (!measurements) {
    return element.getBoundingClientRect();
  }

  let rect = measurements.rects.get(element);
  if (!rect) {
    rect = element.getBoundingClientRect();
    measurements.rects.set(element, rect);
  }
  return rect;
}

function getEntryRect(entry) {
  if (!entry.rect) {
    entry.rect = entry.element.getBoundingClientRect();
  }
  return entry.rect;
}

function getEntryStyle(entry) {
  if (!entry.style) {
    entry.style = window.getComputedStyle(entry.element);
  }
  return entry.style;
}

function collectSiteRuleBlocks(root, context) {
  const rule = PIT_SITE_RULES.find((item) => item.host.test(location.hostname));
  if (!rule) {
    return;
  }

  queryElementsIncludingRoot(root, rule.selectors.join(",")).forEach((element) => {
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
  queryElementsIncludingRoot(root, "[data-testid='tweetText']").forEach((element) => {
    if (
      context.seen.has(element) ||
      shouldSkipElement(element, context.skipOptions) ||
      hasExistingTranslation(element) ||
      !isVisible(element, context.measurements) ||
      isAssistiveOnlyElement(element, context.measurements)
    ) {
      return;
    }

    const segments = extractTweetTextSegments(element, context.skipOptions)
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
        rect: getCachedRect(element, context.measurements),
        style: getCachedStyle(element, context.measurements),
        text: segment.text
      });
      accepted += 1;
    });

    if (accepted > 0) {
      context.seen.add(element);
      element.dataset.pitCollected = "true";
      context.collectedElements.push(element);
      element.dataset.pitBlockKind = "tweet-segment";
    }
  });
}

function extractTweetTextSegments(element, skipOptions) {
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

    if (node !== element && shouldSkipElement(node, getTextExtractionSkipOptions(skipOptions))) {
      return;
    }

    node.childNodes.forEach((child) => visit(child, directAnchor));
  };

  element.childNodes.forEach((child) => visit(child, child));
  flush();

  return segments;
}

function walkParagraphCandidates(root, visit, measurements, skipOptions) {
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
    if (isParagraphCandidate(element, measurements, skipOptions)) {
      visit(element);
    }
    element = walker.nextNode();
  }
}

function isParagraphCandidate(element, measurements, skipOptions) {
  if (!(element instanceof HTMLElement) || element.matches(PIT_DIRECT_TEXT_SELECTOR)) {
    return false;
  }

  if (element.matches(PIT_FORCE_TEXT_SELECTOR)) {
    return true;
  }

  const display = getCachedStyle(element, measurements).display;
  if (!PIT_BLOCK_DISPLAYS.has(display)) {
    return false;
  }

  if (hasParagraphLikeChild(element)) {
    return false;
  }

  return hasDirectReadableText(element, measurements, getTextExtractionSkipOptions(skipOptions));
}

function pushTranslationBlock(element, context) {
  if (
    context.seen.has(element) ||
    shouldSkipElement(element, context.skipOptions) ||
    hasExistingTranslation(element) ||
    !isVisible(element, context.measurements) ||
    isAssistiveOnlyElement(element, context.measurements)
  ) {
    return false;
  }

  if (!context.allowChildBlocks && shouldPreferChildBlocks(element)) {
    return false;
  }

  if (hasCollectedAncestor(element, context.seen) || hasCollectedDescendant(element)) {
    return false;
  }

  const text = extractReadableText(element, context.measurements, getTextExtractionSkipOptions(context.skipOptions));
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
  element.dataset.pitCollected = "true";
  context.collectedElements.push(element);
  element.dataset.pitBlockKind = context.kind;
  context.blocks.push({
    element,
    id: ensurePitId(element),
    text,
    kind: context.kind,
    rect: getCachedRect(element, context.measurements),
    style: getCachedStyle(element, context.measurements)
  });
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
      rect: getEntryRect(entry)
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

function shouldSkipElement(element, options = {}) {
  if (isHardSkipElement(element)) {
    return true;
  }

  if (options.allowTranslatedAncestors && element.dataset?.pitTranslated === "true") {
    return true;
  }

  if (options.allowDeferredAncestors && element.dataset?.pitDeferred === "true") {
    return true;
  }

  const selectors = [
    "[contenteditable='true']",
    "[contenteditable='']",
    "[data-pit-skip]",
    "[translate='no']",
    ".notranslate",
    ".pit-translation",
    "#pit-floating"
  ];

  if (!options.allowInteractiveAncestors) {
    selectors.push(PIT_INTERACTIVE_ANCESTOR_SELECTOR);
  }

  if (!options.allowTranslatedAncestors) {
    selectors.push("[data-pit-translated='true']");
  }

  if (!options.allowDeferredAncestors) {
    selectors.push("[data-pit-deferred='true']");
  }

  return Boolean(
    element.closest(selectors.join(","))
  );
}

function getTextExtractionSkipOptions(options = {}) {
  return {
    ...options,
    allowInteractiveAncestors: true
  };
}

function isHardSkipElement(element) {
  const tagName = element.tagName?.toLowerCase();
  return Boolean(tagName && PIT_SKIP_TAGS.has(tagName));
}

function isVisible(element, measurements) {
  const style = getCachedStyle(element, measurements);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = getCachedRect(element, measurements);
  return rect.width > 0 && rect.height > 0;
}

function isAssistiveOnlyElement(element, measurements) {
  const style = getCachedStyle(element, measurements);
  const rect = getCachedRect(element, measurements);
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

function hasDirectReadableText(element, measurements, skipOptions) {
  let text = "";

  element.childNodes.forEach((child) => {
    text += extractInlineReadableText(child, element, measurements, skipOptions);
  });

  return normalizeText(text).length >= 4;
}

function extractInlineReadableText(node, rootElement, measurements, skipOptions) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return "";
  }

  if (node !== rootElement && shouldSkipElement(node, skipOptions)) {
    return "";
  }

  if (node.tagName.toLowerCase() === "br") {
    return "\n";
  }

  if (node !== rootElement) {
    const display = getCachedStyle(node, measurements).display;
    if (PIT_BLOCK_DISPLAYS.has(display) && !PIT_INLINE_DISPLAYS.has(display)) {
      return "";
    }
  }

  let text = "";
  node.childNodes.forEach((child) => {
    text += extractInlineReadableText(child, rootElement, measurements, skipOptions);
  });
  return text;
}

function extractReadableText(element, measurements, skipOptions) {
  if (element.matches("[data-testid='tweetText']")) {
    return normalizeReadableText(element.innerText || element.textContent || "");
  }

  const text = extractReadableTextFromNode(element, element, measurements, skipOptions);
  return normalizeReadableText(text);
}

function extractReadableTextFromNode(node, rootElement, measurements, skipOptions) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return "";
  }

  if (
    node !== rootElement &&
    (shouldSkipElement(node, skipOptions) || !isVisible(node, measurements) || isAssistiveOnlyElement(node, measurements))
  ) {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === "br") {
    return "\n";
  }

  let text = "";
  node.childNodes.forEach((child) => {
    text += extractReadableTextFromNode(child, rootElement, measurements, skipOptions);
    if (child.nodeType === Node.ELEMENT_NODE && child instanceof HTMLElement) {
      const display = getCachedStyle(child, measurements).display;
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

function hasCollectedDescendant(element) {
  return Boolean(element.querySelector("[data-pit-collected='true']"));
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

function prepareStableTranslationSurfaces(entries, mode, bilingualStyle = PIT_DEFAULT_BILINGUAL_STYLE) {
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
    slot.dataset.pitPlacement = translationSlotPlacement(entry);
    slot.dataset.pitStyle = normalizeBilingualStyle(bilingualStyle);
    renderPendingTranslationSlot(slot);
    applyInheritedTextStyle(entry.element, slot);
    slot.style.minHeight = estimateTranslationSlotHeight(entry);
    insertTranslationSlot(entry, slot);
    entry.translationSlot = slot;
  });
}

function renderPendingTranslationSlot(slot) {
  slot.className = "pit-translation pit-translation-pending";
  slot.dataset.pitSkip = "true";
  slot.setAttribute("aria-label", "Translation loading");
  slot.innerHTML = `
    <span class="pit-translation-spinner" aria-hidden="true"></span>
    <span class="pit-translation-status-text">Translating...</span>
  `;
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

function markPendingTranslationSurfacesFailed(entries, mode, options, error) {
  entries.forEach((entry) => {
    if (mode === "replace") {
      unlockElementHeight(entry.element);
      return;
    }

    if (entry.translationSlot?.classList.contains("pit-translation-pending")) {
      renderFailedTranslationSlot(entry, options, error);
    }
  });
}

function renderFailedTranslationSlot(entry, options, error) {
  const slot = entry.translationSlot;
  if (!slot) {
    return;
  }

  slot.className = "pit-translation pit-translation-failed";
  slot.dataset.pitSkip = "true";
  slot.removeAttribute("aria-label");
  slot.setAttribute("role", "group");
  slot.setAttribute("aria-label", "Translation failed");
  slot.innerHTML = `
    <span class="pit-translation-status-text">Translation failed</span>
    <button class="pit-translation-retry" type="button">Retry</button>
  `;

  const retry = slot.querySelector(".pit-translation-retry");
  retry.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    retryTranslationEntry(entry, options).catch((retryError) => {
      renderFailedTranslationSlot(entry, options, retryError);
      setFloatingStatus("Retry failed");
    });
  });

  slot.title = error instanceof Error ? error.message : String(error || "Translation failed");
}

async function retryTranslationEntry(entry, options) {
  if (PIT_STATE.running) {
    setFloatingStatus("Already running");
    return;
  }

  if (!entry.element.parentNode) {
    entry.translationSlot?.remove();
    entry.translationSlot = null;
    return;
  }

  PIT_STATE.running = true;
  PIT_STATE.cancelRequested = false;
  updateFloatingState("running");
  renderPendingTranslationSlot(entry.translationSlot);

  try {
    const translated = await translateBlocks([entry], { ...options, clearPrevious: false }, "Retrying");
    if (translated > 0) {
      PIT_STATE.translated = true;
      setFloatingStatus("Retried");
    }
  } finally {
    PIT_STATE.running = false;
    updateFloatingState();
  }
}

function findTranslationSlot(entry) {
  if (entry.kind === "tweet-segment") {
    return entry.element.querySelector(`:scope > .pit-translation[data-pit-slot-id="${entry.id}"]`);
  }

  const element = entry.element;
  const child = element.querySelector?.(":scope > .pit-translation");
  if (child) {
    return child;
  }

  const sibling = element.nextElementSibling;
  if (sibling?.classList?.contains("pit-translation")) {
    return sibling;
  }

  return null;
}

function insertTranslationSlot(entry, slot) {
  slot.dataset.pitSlotId = entry.id;

  if (entry.kind === "tweet-segment" && entry.insertAfter?.parentNode === entry.element) {
    entry.element.insertBefore(slot, entry.insertAfter.nextSibling);
    return;
  }

  const element = entry.element;
  if (translationSlotPlacement(entry) === "inside") {
    element.appendChild(slot);
    return;
  }

  const listParent = element.closest("li");
  if (element === listParent) {
    element.appendChild(slot);
    return;
  }

  element.parentNode.insertBefore(slot, element.nextSibling);
}

function translationSlotPlacement(entry) {
  if (entry.kind === "tweet-segment") {
    return "inside";
  }

  const tagName = entry.element.tagName.toLowerCase();
  if (["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "figcaption", "caption", "dt", "dd", "summary", "td", "th"].includes(tagName)) {
    return "inside";
  }

  if (entry.kind === "walked" && !entry.element.matches("main, article, section, body")) {
    return "inside";
  }

  return "after";
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
  const style = getEntryStyle(entry);
  const rect = getEntryRect(entry);
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

function applyTranslations(batch, translations, mode, bilingualStyle = PIT_DEFAULT_BILINGUAL_STYLE) {
  const translationsById = normalizeTranslationMap(batch, translations);
  const normalizedStyle = normalizeBilingualStyle(bilingualStyle);

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
      markOwnReplaceMutation(entry.element);
      entry.element.textContent = translation;
      unlockElementHeightSoon(entry.element);
      return;
    }

    const translationBlock = entry.translationSlot || document.createElement("div");
    translationBlock.className = "pit-translation pit-translation-ready";
    translationBlock.dataset.pitSkip = "true";
    translationBlock.dataset.pitPlacement = translationSlotPlacement(entry);
    translationBlock.dataset.pitStyle = normalizedStyle;
    translationBlock.textContent = translation;
    translationBlock.removeAttribute("aria-label");
    translationBlock.removeAttribute("role");
    translationBlock.removeAttribute("title");
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
  PIT_STATE.autoTranslateActive = false;
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

  const batch = PIT_STATE.lazyQueue.splice(0, PIT_MAX_BATCH_ITEMS).filter((entry) => entry.element.parentNode && !hasExistingTranslation(entry.element));
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
  PIT_STATE.dynamicRouteUrl = location.href;
  const observer = new MutationObserver((mutations) => {
    if (!isAutoTranslationActive()) {
      return;
    }

    if (PIT_STATE.routeUpdatePending) {
      scheduleRouteFullPageTranslation(options, 700);
      return;
    }

    const roots = collectMutationScanRoots(mutations);
    if (roots.length === 0) {
      return;
    }

    PIT_STATE.dynamicRoots = mergeScanRoots(PIT_STATE.dynamicRoots.concat(roots));
    scheduleDynamicTranslation(options, PIT_STATE.running ? 400 : 250);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"]
  });
  PIT_STATE.dynamicObserver = observer;
  startRouteTranslationWatcher(options);
}

function markOwnReplaceMutation(element) {
  element.dataset.pitApplyingReplace = "true";
  window.setTimeout(() => {
    if (element.dataset.pitApplyingReplace === "true") {
      delete element.dataset.pitApplyingReplace;
    }
  }, 500);
}

function scheduleDynamicTranslation(options, delayMs) {
  window.clearTimeout(PIT_STATE.dynamicTimer);
  PIT_STATE.dynamicTimer = window.setTimeout(() => {
    if (PIT_STATE.running) {
      scheduleDynamicTranslation(options, 500);
      return;
    }

    const scanRoots = PIT_STATE.dynamicRoots;
    PIT_STATE.dynamicRoots = [];
    translateDiscoveredBlocks(options, scanRoots).catch((error) => {
      setFloatingStatus("Update failed");
    });
  }, delayMs);
}

function stopDynamicTranslationObserver() {
  PIT_STATE.dynamicObserver?.disconnect();
  PIT_STATE.dynamicObserver = null;
  PIT_STATE.dynamicRoots = [];
  window.clearTimeout(PIT_STATE.dynamicTimer);
  PIT_STATE.dynamicTimer = null;
  PIT_STATE.routeUpdatePending = false;
  stopRouteTranslationWatcher();
}

function collectMutationScanRoots(mutations) {
  const roots = [];

  mutations.forEach((mutation) => {
    if (mutation.type === "characterData") {
      const parent = mutation.target.parentElement;
      if (parent && normalizeText(mutation.target.nodeValue || "").length >= 4) {
        const root = prepareDynamicScanRoot(parent, { resetTranslatedAncestor: true });
        if (root) {
          roots.push(root);
        }
      }
      return;
    }

    if (mutation.type === "attributes") {
      if (mutation.target instanceof HTMLElement) {
        const root = prepareDynamicScanRoot(mutation.target, { resetTranslatedAncestor: false });
        if (root) {
          roots.push(root);
        }
      }
      return;
    }

    Array.from(mutation.addedNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent && normalizeText(node.nodeValue || "").length >= 4) {
          const root = prepareDynamicScanRoot(parent, { resetTranslatedAncestor: true });
          if (root) {
            roots.push(root);
          }
        }
        return;
      }

      if (node instanceof HTMLElement && normalizeText(node.textContent || "").length >= 4) {
        const root = prepareDynamicScanRoot(node, { resetTranslatedAncestor: true });
        if (root) {
          roots.push(root);
        }
      }
    });
  });

  return mergeScanRoots(roots);
}

function prepareDynamicScanRoot(element, options = {}) {
  if (!element || element.closest(".pit-translation, #pit-floating, [data-pit-skip]")) {
    return null;
  }

  if (element.closest("[data-pit-applying-replace='true']")) {
    return null;
  }

  const translatedAncestor = element.closest("[data-pit-translated='true']");
  if (translatedAncestor instanceof HTMLElement) {
    if (options.resetTranslatedAncestor) {
      resetTranslationForElement(translatedAncestor);
      return translatedAncestor;
    }
    return null;
  }

  if (shouldSkipElement(element, PIT_DYNAMIC_SKIP_OPTIONS)) {
    return null;
  }

  return resolveScanRoot(element);
}

function startRouteTranslationWatcher(options) {
  stopRouteTranslationWatcher();

  const handler = () => handlePossibleRouteChange(options);
  PIT_STATE.routeEventHandler = handler;
  window.addEventListener("popstate", handler);
  window.addEventListener("hashchange", handler);
  PIT_STATE.routePollTimer = window.setInterval(handler, 300);
}

function stopRouteTranslationWatcher() {
  if (PIT_STATE.routeEventHandler) {
    window.removeEventListener("popstate", PIT_STATE.routeEventHandler);
    window.removeEventListener("hashchange", PIT_STATE.routeEventHandler);
    PIT_STATE.routeEventHandler = null;
  }

  window.clearInterval(PIT_STATE.routePollTimer);
  PIT_STATE.routePollTimer = null;
  PIT_STATE.routeSettlingTimers.forEach((timer) => window.clearTimeout(timer));
  PIT_STATE.routeSettlingTimers = [];
  window.clearTimeout(PIT_STATE.routeTranslationTimer);
  PIT_STATE.routeTranslationTimer = null;
}

function handlePossibleRouteChange(options) {
  if (!isAutoTranslationActive() || location.href === PIT_STATE.dynamicRouteUrl) {
    return;
  }

  PIT_STATE.dynamicRouteUrl = location.href;
  PIT_STATE.routeUpdatePending = true;
  resetTranslationArtifactsForAutoUpdate();
  scheduleRouteFullPageTranslation(options, 700);
  [300, 900, 1800, 3000].forEach((delay) => {
    const timer = window.setTimeout(() => {
      PIT_STATE.routeSettlingTimers = PIT_STATE.routeSettlingTimers.filter((item) => item !== timer);
      scheduleRouteFullPageTranslation(options, PIT_STATE.running ? 500 : 700);
    }, delay);
    PIT_STATE.routeSettlingTimers.push(timer);
  });
  setFloatingStatus("Route changed, updating...");
}

function scheduleRouteFullPageTranslation(options, delayMs) {
  if (!document.body || (!PIT_STATE.dynamicObserver && !PIT_STATE.autoTranslateActive)) {
    return;
  }

  window.clearTimeout(PIT_STATE.routeTranslationTimer);
  PIT_STATE.routeTranslationTimer = window.setTimeout(() => {
    if (PIT_STATE.running) {
      scheduleRouteFullPageTranslation(options, 500);
      return;
    }

    PIT_STATE.routeTranslationTimer = null;
    PIT_STATE.routeUpdatePending = false;
    translatePage({
      ...options,
      clearPrevious: false,
      preserveDynamicObserver: true
    }).catch((error) => {
      setFloatingStatus("Route update failed");
    });
  }, delayMs);
}

function isAutoTranslationActive() {
  return PIT_STATE.autoTranslateActive || PIT_STATE.translated || hasPageTranslations() || Boolean(PIT_STATE.dynamicObserver);
}

function resetTranslationArtifactsForAutoUpdate() {
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
  document.querySelectorAll("[data-pit-applying-replace='true']").forEach((node) => {
    delete node.dataset.pitApplyingReplace;
  });
  PIT_STATE.translated = false;
  // Keep autoTranslateActive intact so the control stays "on" while we
  // re-translate the new route; show an updating state instead of idle.
  updateFloatingState(PIT_STATE.autoTranslateActive ? "running" : undefined);
}

function resetTranslationForElement(element) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  element.querySelectorAll(":scope > .pit-translation").forEach((node) => node.remove());
  if (element.nextElementSibling?.classList?.contains("pit-translation")) {
    element.nextElementSibling.remove();
  }
  element.dataset.pitTranslated = "false";
  delete element.dataset.pitDeferred;
  unlockElementHeight(element);
}

function resolveScanRoot(element) {
  if (!element || element === document.body) {
    return document.body;
  }

  if (element.closest("[data-pit-translated='true'], [data-pit-deferred='true']")) {
    return element;
  }

  return element.closest(
    [
      "article",
      "section",
      "main",
      "li",
      "[role='article']",
      "[data-testid='cellInnerDiv']",
      ".markdown-body",
      ".comment-body",
      ".commtext",
      ".titleline"
    ].join(",")
  ) || element;
}

function mergeScanRoots(roots) {
  const merged = [];

  roots.forEach((root) => {
    if (!(root instanceof HTMLElement) || !root.isConnected) {
      return;
    }

    if (merged.some((existing) => existing === root || existing.contains(root))) {
      return;
    }

    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (root.contains(merged[index])) {
        merged.splice(index, 1);
      }
    }

    merged.push(root);
  });

  return merged.slice(0, 24);
}

async function translateDiscoveredBlocks(options, roots = [document.body]) {
  if (PIT_STATE.running) {
    return;
  }

  const seenElements = new Set();
  const blocks = [];
  mergeScanRoots(roots).forEach((root) => {
    collectTranslationBlocks(root, {
      minChars: Number(options.minChars || 4),
      mode: options.mode || "bilingual",
      allowTranslatedAncestors: true,
      allowDeferredAncestors: true
    }).forEach((entry) => {
      if (seenElements.has(entry.element)) {
        return;
      }

      seenElements.add(entry.element);
      blocks.push(entry);
    });
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
    if (area === "local" && changes.bilingualStyle) {
      applyBilingualStyleToExistingTranslations(changes.bilingualStyle.newValue);
    }
    if (area === "local" && changes.translateSelection) {
      PIT_STATE.selectionTranslationEnabled = changes.translateSelection.newValue !== false;
      if (!PIT_STATE.selectionTranslationEnabled) {
        hideSelectionTooltip();
      }
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

function initSelectionTranslation() {
  chrome.storage.local.get({ translateSelection: true }, (settings) => {
    PIT_STATE.selectionTranslationEnabled = settings.translateSelection !== false;
  });

  document.addEventListener("mouseup", scheduleSelectionTranslation);
  document.addEventListener("keyup", (event) => {
    if (["Shift", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      scheduleSelectionTranslation(event);
    }
  });
  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest?.("#pit-selection-tooltip")) {
      hideSelectionTooltip();
    }
  });
  window.addEventListener("scroll", hideSelectionTooltip, { passive: true });
}

function scheduleSelectionTranslation(event) {
  if (!PIT_STATE.selectionTranslationEnabled || event.target?.closest?.("#pit-floating, #pit-selection-tooltip")) {
    return;
  }

  window.clearTimeout(PIT_STATE.selectionTimer);
  PIT_STATE.selectionTimer = window.setTimeout(() => {
    translateCurrentSelection().catch(() => {
      renderSelectionTooltipError("Translation failed");
    });
  }, 180);
}

async function translateCurrentSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    hideSelectionTooltip();
    return;
  }

  const range = selection.getRangeAt(0);
  if (selectionIntersectsSkippedUi(range)) {
    return;
  }

  const text = normalizeReadableText(selection.toString());
  if (text.length < 3 || text.length > 1200 || isMostlyPunctuation(text)) {
    hideSelectionTooltip();
    return;
  }

  const rect = selectionRangeRect(range);
  if (!rect) {
    return;
  }

  const requestId = PIT_STATE.selectionRequestId + 1;
  PIT_STATE.selectionRequestId = requestId;
  renderSelectionTooltipPending(rect);

  const settings = await readTranslationSettings();
  const response = await chrome.runtime.sendMessage({
    type: "translate-batch",
    items: [{
      id: "selection",
      index: 0,
      kind: "selection",
      tag: "selection",
      path: "selection",
      text
    }],
    targetLanguage: settings.targetLanguage,
    endpoint: settings.endpoint,
    sourceUrl: location.href
  });

  if (PIT_STATE.selectionRequestId !== requestId) {
    return;
  }

  if (!response?.ok) {
    throw new Error(response?.error || "Selection translation failed.");
  }

  const translations = normalizeTranslationMap([{ id: "selection" }], response.translations);
  const translation = String(translations.get("selection") || "").trim();
  if (!translation) {
    throw new Error("Selection translation returned empty text.");
  }

  renderSelectionTooltipResult(rect, translation, settings.targetLanguage);
}

function selectionIntersectsSkippedUi(range) {
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!element?.closest) {
    return false;
  }

  if (element.closest("#pit-floating, #pit-selection-tooltip, .pit-translation, input, textarea, select, [contenteditable]")) {
    return true;
  }

  return false;
}

function selectionRangeRect(range) {
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }

  return Array.from(range.getClientRects()).find((item) => item.width > 0 || item.height > 0) || null;
}

function renderSelectionTooltipPending(rect) {
  const root = ensureSelectionTooltip(rect);
  root.innerHTML = `
    <div class="pit-selection-body">
      <div class="pit-selection-label">Translation</div>
      <div class="pit-selection-loading">
        <span class="pit-translation-spinner" aria-hidden="true"></span>
        <span>Translating selection…</span>
      </div>
    </div>
  `;
}

function renderSelectionTooltipResult(rect, translation, targetLanguage) {
  const root = ensureSelectionTooltip(rect);
  root.innerHTML = `
    <div class="pit-selection-body">
      <div class="pit-selection-label">Translation · ${escapeHtml(selectionLanguageLabel(targetLanguage))}</div>
      <div class="pit-selection-text"></div>
    </div>
    <div class="pit-selection-foot">
      <div class="pit-selection-engine">
        <span class="pit-selection-engine-dot"></span>
        <span></span>
      </div>
      <div class="pit-selection-icons">
        <button type="button" class="pit-selection-icon" data-action="copy" title="Copy" aria-label="Copy translation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="1.8"/>
            <rect x="9" y="9" width="12" height="12" rx="2.5" fill="var(--pit-tip-surface)" stroke="currentColor" stroke-width="1.8"/>
          </svg>
        </button>
        <button type="button" class="pit-selection-icon" data-action="speak" title="Play" aria-label="Play translation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 5 L19 12 L7 19 Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  root.querySelector(".pit-selection-text").textContent = translation;
  root.querySelector(".pit-selection-engine span:last-child").textContent = prettyModelLabel(PIT_STATE.lastModel);
  root.querySelector("[data-action='copy']").addEventListener("click", async () => {
    await navigator.clipboard.writeText(translation);
    flashSelectionIcon(root.querySelector("[data-action='copy']"));
  });
  root.querySelector("[data-action='speak']").addEventListener("click", () => {
    speakSelectionTranslation(translation, targetLanguage);
    flashSelectionIcon(root.querySelector("[data-action='speak']"));
  });
}

function selectionLanguageLabel(targetLanguage) {
  const normalized = normalizeTargetLanguage(targetLanguage);
  return PIT_TARGET_LANGUAGE_LABELS?.[normalized] || normalized;
}

function flashSelectionIcon(button) {
  if (!button) {
    return;
  }
  button.dataset.flash = "true";
  window.setTimeout(() => {
    if (button.isConnected) {
      button.dataset.flash = "false";
    }
  }, 900);
}

function renderSelectionTooltipError(message) {
  const root = PIT_STATE.selectionTooltip;
  if (!root) {
    return;
  }

  root.innerHTML = `
    <div class="pit-selection-body">
      <div class="pit-selection-label">Translation</div>
      <div class="pit-selection-error">${escapeHtml(message)}</div>
    </div>
  `;
}

function ensureSelectionTooltip(rect) {
  let root = PIT_STATE.selectionTooltip || document.getElementById("pit-selection-tooltip");
  if (!root) {
    root = document.createElement("div");
    root.id = "pit-selection-tooltip";
    root.dataset.pitSkip = "true";
    document.documentElement.appendChild(root);
    PIT_STATE.selectionTooltip = root;
  }

  positionSelectionTooltip(root, rect);
  return root;
}

function positionSelectionTooltip(root, rect) {
  const width = 330;
  const left = clamp(rect.left, 12, window.innerWidth - width - 12);
  const belowTop = rect.bottom + 12;
  const aboveTop = rect.top - 178;
  const flip = belowTop + 168 > window.innerHeight && aboveTop > 12;
  const top = flip ? aboveTop : belowTop;
  root.dataset.placement = flip ? "above" : "below";
  root.style.setProperty("--pit-tip-arrow", `${clamp(rect.left + rect.width / 2 - left, 18, width - 18)}px`);
  root.style.left = `${left}px`;
  root.style.top = `${clamp(top, 12, window.innerHeight - 180)}px`;
}

function speakSelectionTranslation(text, targetLanguage) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = speechLanguageForTarget(targetLanguage);
  window.speechSynthesis.speak(utterance);
}

function speechLanguageForTarget(targetLanguage) {
  const normalized = String(targetLanguage || "").toLowerCase();
  if (normalized.includes("chinese")) {
    return normalized.includes("traditional") ? "zh-TW" : "zh-CN";
  }
  if (normalized.includes("japanese")) {
    return "ja-JP";
  }
  if (normalized.includes("korean")) {
    return "ko-KR";
  }
  if (normalized.includes("french")) {
    return "fr-FR";
  }
  if (normalized.includes("german")) {
    return "de-DE";
  }
  if (normalized.includes("spanish")) {
    return "es-ES";
  }
  return "";
}

function hideSelectionTooltip() {
  PIT_STATE.selectionRequestId += 1;
  PIT_STATE.selectionTooltip?.remove();
  PIT_STATE.selectionTooltip = null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mountFloatingControl() {
  const root = document.createElement("div");
  root.id = "pit-floating";
  root.dataset.pitSkip = "true";
  root.dataset.expanded = "false";
  root.dataset.mode = PIT_STATE.translated ? "translated" : "idle";
  root.innerHTML = `
    <button class="pit-fab" type="button" title="Left click: translate/original. Right click: menu">
      <svg class="pit-fab-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4 L20 19 L4 19 Z" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" fill="rgba(255,255,255,0.25)"/>
      </svg>
      <span class="pit-fab-dot"></span>
    </button>
    <div class="pit-floating-menu" role="menu">
      <div class="pit-floating-head">
        <div class="pit-floating-brand">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4 L20 19 L4 19 Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" fill="rgba(42,111,219,0.12)"/>
          </svg>
          <span class="pit-floating-title">Prism</span>
        </div>
        <span class="pit-floating-badge" data-role="badge" data-ok="true">ON</span>
      </div>
      <div class="pit-floating-row" data-action="toggle" role="button" tabindex="0">
        <span>Translate page</span>
        <span class="pit-toggle" aria-hidden="true"></span>
      </div>
      <label class="pit-floating-field">
        <span>Target</span>
        <select data-setting="targetLanguage">
          ${renderTargetLanguageOptions()}
          <option value="__custom__">Custom…</option>
        </select>
        <input data-setting="customTargetLanguage" placeholder="e.g. Dutch, Brazilian Portuguese" hidden>
      </label>
      <label class="pit-floating-field">
        <span>Display</span>
        <select data-setting="mode">
          <option value="bilingual">Bilingual</option>
          <option value="replace">Replace original</option>
        </select>
      </label>
      <button class="pit-floating-settings" type="button" data-action="opensettings" aria-expanded="false">
        <span>Open settings</span>
        <span class="pit-caret" aria-hidden="true"></span>
      </button>
      <div class="pit-floating-advanced">
        <label class="pit-floating-field">
          <span>Bilingual style</span>
          <select data-setting="bilingualStyle">
            <option value="dashed">Dashed underline</option>
            <option value="dotted">Dotted underline</option>
            <option value="wavy">Wavy underline</option>
            <option value="highlight">Highlight</option>
            <option value="soft-box">Soft box</option>
            <option value="blur">Blur</option>
          </select>
        </label>
        <label class="pit-floating-check">
          <span>Translate on selection</span>
          <input data-setting="translateSelection" type="checkbox">
        </label>
        <label class="pit-floating-check">
          <span>Auto-translate this site</span>
          <input data-setting="autoTranslateSite" type="checkbox">
        </label>
        <label class="pit-floating-check">
          <span>Clear before translating</span>
          <input data-setting="clearPrevious" type="checkbox">
        </label>
        <label class="pit-floating-check">
          <span>Translate visible text first</span>
          <input data-setting="viewportFirst" type="checkbox">
        </label>
        <div class="pit-floating-server">
          <div>
            <span class="pit-floating-server-dot"></span>
            <strong data-role="serverState">Checking…</strong>
          </div>
          <em data-role="latency">--</em>
        </div>
        <div class="pit-floating-actions">
          <button type="button" data-action="clear">Clear page</button>
          <button type="button" data-action="hide">Hide button</button>
        </div>
      </div>
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
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !menu.contains(actionEl)) {
      return;
    }

    const action = actionEl.dataset.action;
    if (action === "opensettings") {
      const open = root.dataset.settings !== "true";
      root.dataset.settings = open ? "true" : "false";
      actionEl.setAttribute("aria-expanded", String(open));
      return;
    }

    if (action === "toggle") {
      await toggleTranslationFromFloating();
    } else if (action === "clear") {
      root.dataset.expanded = "false";
      clearTranslations();
    } else if (action === "hide") {
      root.dataset.expanded = "false";
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
  return PIT_TARGET_LANGUAGES.map((language) => `<option value="${language}">${PIT_TARGET_LANGUAGE_LABELS[language] || language}</option>`).join("");
}

async function hydrateFloatingSettings(root) {
  const settings = await readTranslationSettings();
  const targetSelect = root.querySelector("[data-setting='targetLanguage']");
  const customTarget = root.querySelector("[data-setting='customTargetLanguage']");
  const mode = root.querySelector("[data-setting='mode']");
  const bilingualStyle = root.querySelector("[data-setting='bilingualStyle']");
  const clearPrevious = root.querySelector("[data-setting='clearPrevious']");
  const viewportFirst = root.querySelector("[data-setting='viewportFirst']");
  const translateSelection = root.querySelector("[data-setting='translateSelection']");
  const autoTranslateSite = root.querySelector("[data-setting='autoTranslateSite']");
  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  const host = currentAutoTranslateHost();

  if (PIT_TARGET_LANGUAGES.includes(targetLanguage)) {
    targetSelect.value = targetLanguage;
    customTarget.value = "";
  } else {
    targetSelect.value = "__custom__";
    customTarget.value = targetLanguage;
  }

  mode.value = settings.mode;
  bilingualStyle.value = normalizeBilingualStyle(settings.bilingualStyle);
  clearPrevious.checked = settings.clearPrevious !== false;
  viewportFirst.checked = settings.viewportFirst !== false;
  translateSelection.checked = settings.translateSelection !== false;
  autoTranslateSite.checked = Boolean(host && settings.autoTranslateSites?.[host]);
  autoTranslateSite.disabled = !host;
  updateFloatingCustomLanguage(root);
  updateFloatingState();
  checkFloatingHealth(root, settings.endpoint);
}

async function saveFloatingSettings(root) {
  const current = await readTranslationSettings();
  const host = currentAutoTranslateHost();
  const autoTranslateSites = { ...(current.autoTranslateSites || {}) };
  if (host) {
    if (root.querySelector("[data-setting='autoTranslateSite']").checked) {
      autoTranslateSites[host] = true;
    } else {
      delete autoTranslateSites[host];
    }
  }

  await chrome.storage.local.set({
    ...current,
    targetLanguage: readFloatingTargetLanguage(root),
    mode: root.querySelector("[data-setting='mode']").value,
    bilingualStyle: normalizeBilingualStyle(root.querySelector("[data-setting='bilingualStyle']").value),
    clearPrevious: root.querySelector("[data-setting='clearPrevious']").checked,
    viewportFirst: root.querySelector("[data-setting='viewportFirst']").checked,
    translateSelection: root.querySelector("[data-setting='translateSelection']").checked,
    autoTranslateSites
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

function normalizeBilingualStyle(value) {
  return PIT_BILINGUAL_STYLES.has(value) ? value : PIT_DEFAULT_BILINGUAL_STYLE;
}

function prettyModelLabel(model) {
  const raw = String(model || "").trim();
  if (!raw) {
    return "Codex Spark 5.3";
  }
  const spark = raw.match(/(\d+(?:\.\d+)?)[-_ ]?codex[-_ ]?spark|codex[-_ ]?spark[-_ ]?(\d+(?:\.\d+)?)/i);
  if (spark) {
    const version = spark[1] || spark[2];
    return version ? `Codex Spark ${version}` : "Codex Spark";
  }
  return raw;
}

function applyBilingualStyleToExistingTranslations(value) {
  const bilingualStyle = normalizeBilingualStyle(value);
  document.querySelectorAll(".pit-translation").forEach((node) => {
    node.dataset.pitStyle = bilingualStyle;
  });
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
    if (body.model) {
      PIT_STATE.lastModel = body.model;
    }
    const model = prettyModelLabel(body.model);
    serverState.textContent = body.warm === false ? `${model} warming` : model;
    latency.textContent = body.lastLatencyMs ? `${body.lastLatencyMs}ms` : body.warm === false ? "warming" : "--";
    badge.textContent = PIT_STATE.running ? "BUSY" : "ON";
    badge.dataset.ok = "true";
  } catch {
    serverState.textContent = "Not running";
    latency.textContent = "--";
    badge.textContent = "OFF";
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
    bilingualStyle: PIT_DEFAULT_BILINGUAL_STYLE,
    clearPrevious: true,
    viewportFirst: true,
    translateSelection: true,
    autoTranslateSites: {}
  }).then((settings) => ({
    ...settings,
    targetLanguage: normalizeTargetLanguage(settings.targetLanguage),
    batchSize: PIT_MAX_BATCH_ITEMS,
    batchCharLimit: PIT_DEFAULT_BATCH_CHAR_LIMIT,
    minChars: 4
  }));
}

function currentAutoTranslateHost() {
  if (!["http:", "https:"].includes(location.protocol)) {
    return "";
  }
  return location.hostname.toLowerCase();
}

function hasPageTranslations() {
  return Boolean(document.querySelector(".pit-translation"));
}

function updateFloatingState(forceMode) {
  const root = PIT_STATE.floating;
  if (!root) {
    return;
  }

  const mode = forceMode || (hasPageTranslations() || PIT_STATE.translated || PIT_STATE.autoTranslateActive ? "translated" : "idle");
  const badge = root.querySelector(".pit-floating-badge");
  root.dataset.mode = mode;
  if (badge && (mode === "running" || badge.dataset.ok !== "false")) {
    badge.textContent = mode === "running" ? "BUSY" : "ON";
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
      --pit-tr-accent: rgba(42, 111, 219, 0.5);
      --pit-tr-soft-box: rgba(246, 247, 249, 0.92);
      display: block;
      width: auto;
      max-width: 100%;
      margin: 0.22em 0 0.9em;
      letter-spacing: 0;
      opacity: 0.68;
      white-space: pre-line;
      word-break: normal;
      overflow-wrap: anywhere;
      pointer-events: none;
      transition: opacity 140ms ease;
      contain: layout style paint;
    }

    .pit-translation[data-pit-placement="inside"] {
      flex-basis: 100%;
      grid-column: 1 / -1;
      margin: 0.28em 0 0;
    }

    .pit-translation-pending {
      display: flex;
      align-items: center;
      gap: 0.48em;
      opacity: 0.54;
      text-decoration: none;
    }

    .pit-translation-ready {
      opacity: 0.68;
    }

    .pit-translation-ready[data-pit-style="dashed"],
    .pit-translation-ready:not([data-pit-style]) {
      text-decoration-line: underline;
      text-decoration-style: dashed;
      text-decoration-color: var(--pit-tr-accent);
      text-decoration-thickness: 1px;
      text-underline-offset: 0.18em;
    }

    .pit-translation-ready[data-pit-style="dotted"] {
      text-decoration-line: underline;
      text-decoration-style: dotted;
      text-decoration-color: var(--pit-tr-accent);
      text-decoration-thickness: 1.5px;
      text-underline-offset: 0.18em;
    }

    .pit-translation-ready[data-pit-style="wavy"] {
      text-decoration-line: underline;
      text-decoration-style: wavy;
      text-decoration-color: var(--pit-tr-accent);
      text-decoration-thickness: 1px;
      text-underline-offset: 0.18em;
    }

    .pit-translation-ready[data-pit-style="highlight"] {
      width: fit-content;
      padding: 0.04em 0.28em;
      border-radius: 4px;
      background: rgba(42, 111, 219, 0.14);
      text-decoration: none;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }

    .pit-translation-ready[data-pit-style="soft-box"] {
      width: fit-content;
      padding: 0.32em 0.62em;
      border: 1px solid rgba(42, 111, 219, 0.20);
      border-radius: 7px;
      background: var(--pit-tr-soft-box);
      text-decoration: none;
    }

    @media (prefers-color-scheme: dark) {
      .pit-translation {
        --pit-tr-accent: rgba(91, 146, 255, 0.55);
        --pit-tr-soft-box: rgba(30, 33, 39, 0.92);
      }
    }

    .pit-translation-ready[data-pit-style="blur"] {
      filter: blur(3.5px);
      text-decoration: none;
    }

    @media (hover: hover) {
      .pit-translation-ready[data-pit-style="blur"] {
        pointer-events: auto;
      }

      .pit-translation-ready[data-pit-style="blur"]:hover {
        filter: none;
      }
    }

    .pit-translation-ready[data-pit-placement="inside"]::before,
    .pit-translation-pending[data-pit-placement="inside"]::before {
      content: "";
      display: block;
      height: 0;
    }

    .pit-translation-failed {
      display: inline-flex;
      align-items: center;
      gap: 0.55em;
      width: fit-content;
      max-width: 100%;
      min-height: auto !important;
      padding: 0.24em 0.55em;
      border: 1px solid rgba(180, 35, 24, 0.25);
      border-radius: 6px;
      background: rgba(255, 241, 241, 0.92);
      color: #b42318 !important;
      opacity: 1;
      pointer-events: auto;
      text-decoration: none;
      white-space: normal;
      contain: layout style paint;
    }

    .pit-translation-spinner {
      flex: 0 0 auto;
      width: 0.92em;
      height: 0.92em;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 999px;
      opacity: 0.78;
      animation: pit-spin 780ms linear infinite;
    }

    .pit-translation-status-text {
      min-width: 0;
    }

    .pit-translation-retry {
      flex: 0 0 auto;
      width: auto;
      min-width: 0;
      min-height: 0;
      padding: 0.12em 0.48em;
      border: 1px solid currentColor;
      border-radius: 5px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 700;
      line-height: 1.35;
      pointer-events: auto;
      cursor: pointer;
    }

    .pit-translation-retry:hover {
      background: rgba(180, 35, 24, 0.08);
    }

    @keyframes pit-spin {
      to {
        transform: rotate(360deg);
      }
    }

    li > .pit-translation {
      margin-bottom: 0.45em;
    }

    #pit-selection-tooltip {
      --pit-tip-surface: #ffffff;
      --pit-tip-border: #e8e9ed;
      --pit-tip-foot: #fbfbfc;
      --pit-tip-foot-line: #f1f2f4;
      --pit-tip-label: #9aa0aa;
      --pit-tip-text: #2c2f36;
      --pit-tip-muted: #6e7178;
      --pit-tip-icon: #8a8f98;
      --pit-tip-dot: #1f8a5b;
      --pit-tip-shadow: 0 10px 34px rgba(16, 18, 23, 0.16);
      position: fixed;
      z-index: 2147483647;
      width: 330px;
      max-width: calc(100vw - 24px);
      border: 1px solid var(--pit-tip-border);
      border-radius: 12px;
      background: var(--pit-tip-surface);
      box-shadow: var(--pit-tip-shadow);
      color: var(--pit-tip-text);
      font: 13px/1.45 "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
      letter-spacing: 0;
      pointer-events: auto;
    }

    @media (prefers-color-scheme: dark) {
      #pit-selection-tooltip {
        --pit-tip-surface: #1b1e23;
        --pit-tip-border: #2a2e35;
        --pit-tip-foot: #16181c;
        --pit-tip-foot-line: #20242a;
        --pit-tip-label: #7b818b;
        --pit-tip-text: #e7e9ed;
        --pit-tip-muted: #9aa0aa;
        --pit-tip-icon: #7b818b;
        --pit-tip-dot: #2fbe7a;
        --pit-tip-shadow: 0 12px 38px rgba(0, 0, 0, 0.5);
      }
    }

    #pit-selection-tooltip .pit-selection-body {
      padding: 13px 15px 14px;
    }

    #pit-selection-tooltip .pit-selection-label {
      margin-bottom: 8px;
      color: var(--pit-tip-label);
      font-family: "Geist Mono", ui-monospace, monospace;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    #pit-selection-tooltip .pit-selection-text {
      color: var(--pit-tip-text);
      font-family: "Noto Sans SC", sans-serif;
      font-size: 15.5px;
      line-height: 1.6;
      white-space: pre-line;
    }

    #pit-selection-tooltip .pit-selection-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--pit-tip-muted);
      font-size: 13px;
    }

    #pit-selection-tooltip .pit-selection-error {
      color: #d0524a;
      font-size: 14px;
      line-height: 1.55;
    }

    #pit-selection-tooltip .pit-selection-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 15px;
      border-top: 1px solid var(--pit-tip-foot-line);
      border-radius: 0 0 12px 12px;
      background: var(--pit-tip-foot);
    }

    #pit-selection-tooltip .pit-selection-engine {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      color: var(--pit-tip-muted);
      font-family: "Geist Mono", ui-monospace, monospace;
      font-size: 10.5px;
    }

    #pit-selection-tooltip .pit-selection-engine-dot {
      flex: 0 0 auto;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--pit-tip-dot);
    }

    #pit-selection-tooltip .pit-selection-icons {
      display: flex;
      gap: 4px;
    }

    #pit-selection-tooltip .pit-selection-icon {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--pit-tip-icon);
      cursor: pointer;
    }

    #pit-selection-tooltip .pit-selection-icon:hover {
      background: var(--pit-tip-foot-line);
      color: var(--pit-tip-text);
    }

    #pit-selection-tooltip .pit-selection-icon[data-flash="true"] {
      color: var(--pit-tip-dot);
    }

    #pit-selection-tooltip::before,
    #pit-selection-tooltip::after {
      content: "";
      position: absolute;
      left: var(--pit-tip-arrow, 44px);
      width: 0;
      height: 0;
      border-left: 7px solid transparent;
      border-right: 7px solid transparent;
    }

    #pit-selection-tooltip[data-placement="below"]::before {
      top: -8px;
      border-bottom: 8px solid var(--pit-tip-border);
    }

    #pit-selection-tooltip[data-placement="below"]::after {
      top: -7px;
      border-bottom: 8px solid var(--pit-tip-surface);
    }

    #pit-selection-tooltip[data-placement="above"]::before {
      bottom: -8px;
      border-top: 8px solid var(--pit-tip-border);
    }

    #pit-selection-tooltip[data-placement="above"]::after {
      bottom: -7px;
      border-top: 8px solid var(--pit-tip-foot);
    }

    #pit-floating {
      --pit-fl-surface: #ffffff;
      --pit-fl-border: #e8e9ed;
      --pit-fl-line: #f1f2f4;
      --pit-fl-text: #15171c;
      --pit-fl-muted: #6e7178;
      --pit-fl-faint: #9aa0aa;
      --pit-fl-chip: #f6f7f9;
      --pit-fl-chip-line: #e8e9ed;
      --pit-fl-track: #dadde3;
      --pit-fl-shadow: 0 10px 34px rgba(16, 18, 23, 0.16);
      --pit-fl-fab: #2a6fdb;
      --pit-fl-fab-shadow: 0 8px 24px rgba(42, 111, 219, 0.4);
      --pit-fl-on: #1f8a5b;
      position: fixed;
      top: 55vh;
      right: 16px;
      z-index: 2147483646;
      font: 13px/1.35 "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
      user-select: none;
    }

    @media (prefers-color-scheme: dark) {
      #pit-floating {
        --pit-fl-surface: #1b1e23;
        --pit-fl-border: #2a2e35;
        --pit-fl-line: #20242a;
        --pit-fl-text: #f3f4f6;
        --pit-fl-muted: #9aa0aa;
        --pit-fl-faint: #7b818b;
        --pit-fl-chip: #1e2127;
        --pit-fl-chip-line: #2a2e35;
        --pit-fl-track: #34393f;
        --pit-fl-shadow: 0 12px 38px rgba(0, 0, 0, 0.5);
        --pit-fl-fab: #5b92ff;
        --pit-fl-fab-shadow: 0 8px 24px rgba(91, 146, 255, 0.45);
        --pit-fl-on: #2fbe7a;
      }
    }

    #pit-floating .pit-fab {
      position: relative;
      display: grid;
      place-items: center;
      width: 52px;
      height: 52px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: var(--pit-fl-fab);
      box-shadow: var(--pit-fl-fab-shadow);
      color: #ffffff;
      cursor: grab;
    }

    #pit-floating[data-dragging="true"] .pit-fab {
      cursor: grabbing;
    }

    #pit-floating[data-mode="running"] .pit-fab {
      cursor: wait;
    }

    #pit-floating .pit-fab-dot {
      position: absolute;
      right: 6px;
      bottom: 6px;
      width: 11px;
      height: 11px;
      border: 2px solid #ffffff;
      border-radius: 999px;
      background: #b6bac1;
    }

    #pit-floating[data-mode="translated"] .pit-fab-dot {
      background: #12b76a;
    }

    #pit-floating[data-mode="running"] .pit-fab-dot {
      background: #fdb022;
    }

    #pit-floating .pit-floating-menu {
      position: absolute;
      top: 0;
      display: none;
      width: 252px;
      border: 1px solid var(--pit-fl-border);
      border-radius: 13px;
      background: var(--pit-fl-surface);
      box-shadow: var(--pit-fl-shadow);
      color: var(--pit-fl-text);
      overflow: hidden;
    }

    #pit-floating[data-expanded="true"] .pit-floating-menu {
      display: block;
    }

    #pit-floating[data-side="right"] .pit-floating-menu {
      right: 62px;
    }

    #pit-floating[data-side="left"] .pit-floating-menu {
      left: 62px;
    }

    #pit-floating .pit-floating-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px 10px;
      border-bottom: 1px solid var(--pit-fl-line);
    }

    #pit-floating .pit-floating-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--pit-fl-fab);
    }

    #pit-floating .pit-floating-title {
      color: var(--pit-fl-text);
      font-size: 13px;
      font-weight: 600;
    }

    #pit-floating .pit-floating-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex: 0 0 auto;
      color: var(--pit-fl-on);
      font-family: "Geist Mono", ui-monospace, monospace;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }

    #pit-floating .pit-floating-badge::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    #pit-floating .pit-floating-badge[data-ok="false"] {
      color: var(--pit-fl-faint);
    }

    #pit-floating[data-mode="running"] .pit-floating-badge {
      color: #b54708;
    }

    #pit-floating .pit-floating-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--pit-fl-line);
      color: var(--pit-fl-text);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }

    #pit-floating .pit-toggle {
      position: relative;
      flex: 0 0 auto;
      width: 32px;
      height: 19px;
      border-radius: 999px;
      background: var(--pit-fl-track);
    }

    #pit-floating .pit-toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      transition: left 120ms ease;
    }

    #pit-floating[data-mode="translated"] .pit-toggle {
      background: var(--pit-fl-fab);
    }

    #pit-floating[data-mode="translated"] .pit-toggle::after {
      left: 15px;
    }

    #pit-floating[data-mode="running"] .pit-toggle {
      background: #fdb022;
    }

    #pit-floating .pit-floating-field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--pit-fl-line);
      color: var(--pit-fl-text);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
    }

    #pit-floating .pit-floating-field select,
    #pit-floating .pit-floating-field input {
      flex: 0 0 auto;
      width: 110px;
      min-height: 28px;
      border: 1px solid var(--pit-fl-chip-line);
      border-radius: 8px;
      background: var(--pit-fl-chip);
      color: var(--pit-fl-text);
      font: 12px/1.2 inherit;
      letter-spacing: 0;
      padding: 4px 8px;
    }

    #pit-floating .pit-floating-field input[hidden] {
      display: none;
    }

    #pit-floating .pit-floating-settings {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 12px 14px;
      border: 0;
      border-bottom: 1px solid var(--pit-fl-line);
      background: transparent;
      color: var(--pit-fl-text);
      font: 500 13px/1.2 inherit;
      cursor: pointer;
      text-align: left;
    }

    #pit-floating .pit-floating-settings:hover {
      background: var(--pit-fl-chip);
    }

    #pit-floating .pit-caret {
      flex: 0 0 auto;
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid var(--pit-fl-faint);
      transition: transform 120ms ease;
    }

    #pit-floating[data-settings="true"] .pit-floating-settings .pit-caret {
      transform: rotate(180deg);
    }

    #pit-floating .pit-floating-advanced {
      display: none;
    }

    #pit-floating[data-settings="true"] .pit-floating-advanced {
      display: block;
    }

    #pit-floating .pit-floating-check {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--pit-fl-line);
      color: var(--pit-fl-text);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }

    #pit-floating .pit-floating-check input {
      appearance: none;
      -webkit-appearance: none;
      position: relative;
      flex: 0 0 auto;
      width: 32px;
      height: 19px;
      margin: 0;
      border: 0;
      border-radius: 999px;
      background: var(--pit-fl-track);
      cursor: pointer;
    }

    #pit-floating .pit-floating-check input::before {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
      transition: left 120ms ease;
    }

    #pit-floating .pit-floating-check input:checked {
      background: var(--pit-fl-fab);
    }

    #pit-floating .pit-floating-check input:checked::before {
      left: 15px;
    }

    #pit-floating .pit-floating-check input:disabled {
      cursor: not-allowed;
    }

    #pit-floating .pit-floating-check:has(input:disabled) {
      opacity: 0.55;
      cursor: not-allowed;
    }

    #pit-floating .pit-floating-server {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 11px 14px;
      border-bottom: 1px solid var(--pit-fl-line);
    }

    #pit-floating .pit-floating-server > div {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    #pit-floating .pit-floating-server-dot {
      flex: 0 0 auto;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--pit-fl-on);
    }

    #pit-floating .pit-floating-server strong {
      max-width: 130px;
      overflow: hidden;
      color: var(--pit-fl-muted);
      font-family: "Geist Mono", ui-monospace, monospace;
      font-size: 11px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #pit-floating .pit-floating-server em {
      flex: 0 0 auto;
      color: var(--pit-fl-faint);
      font-family: "Geist Mono", ui-monospace, monospace;
      font-size: 11px;
      font-style: normal;
    }

    #pit-floating .pit-floating-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--pit-fl-line);
    }

    #pit-floating .pit-floating-actions button {
      min-height: 32px;
      border: 1px solid var(--pit-fl-chip-line);
      border-radius: 8px;
      background: var(--pit-fl-surface);
      color: var(--pit-fl-text);
      cursor: pointer;
      font: 600 12px/1.2 inherit;
    }

    #pit-floating .pit-floating-actions button:hover {
      background: var(--pit-fl-chip);
    }

    #pit-floating .pit-floating-status {
      padding: 9px 14px;
      color: var(--pit-fl-muted);
      font-size: 11.5px;
    }

  `;
  document.documentElement.appendChild(style);
}
