// Top-level page translation orchestration: batching, viewport-first ordering, adaptive batch sizing.
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

// Batches are dispatched with bounded concurrency instead of one-at-a-time. The
// codex-app backend now runs a matching-size pool of independent conversation
// threads (see server/server.js CODEX_APP_THREAD_POOL_SIZE), so this concurrency
// translates into genuine parallel wall-clock savings there too, not just fewer
// idle round-trips between batches.
const PIT_MAX_CONCURRENT_BATCHES = 3;

async function translateBlocks(orderedBlocks, options, overlayPrefix = "Translating") {
  const maxBatchItems = clamp(Number(options.batchSize || PIT_MAX_BATCH_ITEMS), 1, PIT_MAX_BATCH_ITEMS);
  const maxBatchChars = clamp(Number(options.batchCharLimit || PIT_DEFAULT_BATCH_CHAR_LIMIT), PIT_MIN_BATCH_CHAR_LIMIT, PIT_MAX_BATCH_CHAR_LIMIT);
  const mode = options.mode || "bilingual";

  const bilingualStyle = normalizeBilingualStyle(options.bilingualStyle);
  const batches = createAdaptiveTranslationBatches(orderedBlocks, {
    maxItems: maxBatchItems,
    maxChars: maxBatchChars
  });

  prepareStableTranslationSurfaces(orderedBlocks, mode, bilingualStyle);
  await nextAnimationFrame();

  let translatedItems = 0;
  let translatedChars = 0;
  let firstError = null;
  let nextBatchIndex = 0;

  async function sendBatch(batch) {
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

    applyTranslations(batch, response.translations, mode, bilingualStyle, options);
    translatedItems += batch.length;
    translatedChars += batch.reduce((sum, entry) => sum + estimateTranslationEntryChars(entry), 0);
    setFloatingStatus(`${overlayPrefix} ${translatedItems}/${orderedBlocks.length} (${formatCharCount(translatedChars)})`);
  }

  async function worker() {
    while (nextBatchIndex < batches.length) {
      if (PIT_STATE.cancelRequested || firstError) {
        return;
      }

      const batch = batches[nextBatchIndex];
      nextBatchIndex += 1;

      try {
        await sendBatch(batch);
      } catch (error) {
        firstError = firstError || error;
        return;
      }
    }
  }

  const workerCount = Math.min(PIT_MAX_CONCURRENT_BATCHES, batches.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (firstError) {
    markPendingTranslationSurfacesFailed(orderedBlocks, mode, options, firstError);
    throw firstError;
  }

  if (PIT_STATE.cancelRequested) {
    removePendingTranslationSurfaces(orderedBlocks, mode);
    setFloatingStatus(`Stopped: ${translatedItems}/${orderedBlocks.length}`);
  }

  return translatedItems;
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

