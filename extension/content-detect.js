// DOM scanning: turns a page into translatable text blocks (collectTranslationBlocks and its heuristics).
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
    styles: new WeakMap(),
    denseContainer: new WeakMap()
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
  if (text.length < context.minChars || isMostlyPunctuation(text) || isLikelyChromeText(element, text, context.measurements)) {
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

function isLikelyChromeText(element, text, measurements) {
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

  if (isLikelyNavigationOrActionElement(element, text, measurements)) {
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

function isLikelyNavigationOrActionElement(element, text, measurements) {
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

  return isDenseInteractiveContainer(element, text, measurements);
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

function isDenseInteractiveContainer(element, text, measurements) {
  if (text.length > 90 || element.matches("article, main, section")) {
    return false;
  }

  const cached = measurements?.denseContainer.get(element);
  if (cached) {
    return cached.result;
  }

  const interactiveCount = element.querySelectorAll("a, button, [role='link'], [role='button'], [role='menuitem'], [role='tab']").length;
  let result;
  if (interactiveCount < 2) {
    result = false;
  } else {
    const paragraphCount = element.querySelectorAll("p, blockquote, li, h1, h2, h3, h4, h5, h6").length;
    result = paragraphCount === 0 || interactiveCount >= paragraphCount;
  }

  measurements?.denseContainer.set(element, { result });
  return result;
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

