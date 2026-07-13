// Top-level page translation orchestration: batching, viewport-first ordering, adaptive batch sizing.
async function translatePage(options) {
  if (PIT_STATE.running) {
    PIT_STATE.cancelRequested = true;
    PIT_STATE.translationEpoch += 1;
    throw new Error("A translation is already running. Click again after it stops.");
  }

  PIT_STATE.running = true;
  injectStyles();

  try {
    if (options.clearPrevious) {
      clearTranslations();
    }
    PIT_STATE.cancelRequested = false;
    const translationEpoch = ++PIT_STATE.translationEpoch;

    if (options.preserveDynamicObserver && PIT_STATE.dynamicObserver) {
      PIT_STATE.dynamicRoots = [];
    } else {
      stopDynamicTranslationObserver();
      PIT_STATE.dynamicRouteUrl = location.href;
      startRouteTranslationWatcher(options);
    }
    stopLazyTranslationObserver();

    const blocks = collectTranslationBlocks(document.body, {
      minChars: Number(options.minChars || 4),
      mode: options.mode || "bilingual"
    });
    const orderedBlocks = prioritizeBlocks(blocks, options.viewportFirst !== false);

    if (orderedBlocks.length === 0) {
      if (options.preserveDynamicObserver) {
        PIT_STATE.autoTranslateActive = true;
        startDynamicTranslationObserver(options);
        PIT_STATE.dynamicRoots = [document.body];
        scheduleDynamicTranslation(options, 250);
        updateFloatingState();
        setFloatingStatus("Waiting for content");
        return { translated: 0, total: 0, deferred: 0 };
      }
      if (!PIT_STATE.dynamicObserver) {
        stopRouteTranslationWatcher();
      }
      setFloatingStatus("No text found");
      return { translated: 0, total: 0 };
    }

    const { immediate, deferred } = splitImmediateTranslationBlocks(orderedBlocks, options.viewportFirst !== false);
    const translated = await translateBlocks(immediate, options, "Translating", translationEpoch);

    if (location.href !== PIT_STATE.dynamicRouteUrl) {
      handlePossibleRouteChange(options);
    }
    if (PIT_STATE.cancelRequested || translationEpoch !== PIT_STATE.translationEpoch) {
      if (!PIT_STATE.dynamicObserver && !PIT_STATE.routeUpdatePending) {
        stopRouteTranslationWatcher();
      }
      return { translated: 0, total: orderedBlocks.length, deferred: 0, cancelled: true };
    }

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
      if (options.preserveDynamicObserver) {
        PIT_STATE.dynamicRoots = mergeScanRoots(PIT_STATE.dynamicRoots.concat(document.body));
        scheduleDynamicTranslation(options, 250);
      }
    } else if (!PIT_STATE.dynamicObserver) {
      stopRouteTranslationWatcher();
    }
    return { translated, total: orderedBlocks.length, deferred: deferred.length };
  } catch (error) {
    if (!PIT_STATE.dynamicObserver && !PIT_STATE.routeUpdatePending) {
      stopRouteTranslationWatcher();
    }
    throw error;
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
    if (isNearViewport(rect, PIT_INITIAL_ROOT_MARGIN)) {
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

function buildTranslationBatches(entries, maxItems, maxChars = PIT_DEFAULT_BATCH_CHAR_LIMIT) {
  if (entries.length === 0) {
    return [];
  }

  const batches = [];
  const totalChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  const fastFirst = entries.length > maxItems || totalChars > PIT_FIRST_BATCH_MAX_CHARS;
  let offset = 0;

  if (fastFirst) {
    const first = takeTranslationBatch(
      entries,
      offset,
      Math.min(PIT_FIRST_BATCH_MAX_ITEMS, maxItems),
      Math.min(PIT_FIRST_BATCH_MAX_CHARS, maxChars)
    );
    batches.push(first);
    offset += first.length;
  }

  while (offset < entries.length) {
    const batch = takeTranslationBatch(entries, offset, maxItems, maxChars);
    batches.push(batch);
    offset += batch.length;
  }

  return batches;
}

function takeTranslationBatch(entries, offset, maxItems, maxChars) {
  const batch = [];
  let chars = 0;

  while (offset + batch.length < entries.length && batch.length < maxItems) {
    const entry = entries[offset + batch.length];
    if (batch.length > 0 && chars + entry.text.length > maxChars) {
      break;
    }
    batch.push(entry);
    chars += entry.text.length;
  }

  return batch;
}

// The small fast-first batch is awaited before the remaining batches fan out.
// That keeps first-screen latency low while still using bounded concurrency for
// the long-page tail. The server applies the same limit to isolated Codex turns.
const PIT_MAX_CONCURRENT_BATCHES = 3;

async function translateBlocks(
  orderedBlocks,
  options,
  overlayPrefix = "Translating",
  translationEpoch = PIT_STATE.translationEpoch
) {
  const maxBatchItems = clamp(Number(options.batchSize || PIT_MAX_BATCH_ITEMS), 1, PIT_MAX_BATCH_ITEMS);
  const maxBatchChars = clamp(Number(options.batchCharLimit || PIT_DEFAULT_BATCH_CHAR_LIMIT), PIT_MIN_BATCH_CHAR_LIMIT, PIT_MAX_BATCH_CHAR_LIMIT);
  const mode = options.mode || "bilingual";
  const bilingualStyle = normalizeBilingualStyle(options.bilingualStyle);
  const batches = buildTranslationBatches(orderedBlocks, maxBatchItems, maxBatchChars);
  const sourceUrl = location.href;
  let translatedItems = 0;
  let processedItems = 0;
  let firstError = null;
  let nextBatchIndex = 0;

  async function sendBatch(batch) {
    if (location.href !== sourceUrl) {
      handlePossibleRouteChange(options);
    }
    if (PIT_STATE.cancelRequested || translationEpoch !== PIT_STATE.translationEpoch) {
      return false;
    }

    setFloatingStatus(`${overlayPrefix} ${processedItems + 1}-${processedItems + batch.length} / ${orderedBlocks.length}`);
    const responsePromise = chrome.runtime.sendMessage({
      type: "translate-batch",
      items: batch.map((entry, index) => ({
        id: entry.id,
        index,
        text: entry.text
      })),
      targetLanguage: options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE,
      endpoint: options.endpoint || PIT_DEFAULT_ENDPOINT,
      sourceUrl
    });
    prepareStableTranslationSurfaces(batch, mode, bilingualStyle);

    const response = await responsePromise;
    if (location.href !== sourceUrl) {
      handlePossibleRouteChange(options);
    }
    if (PIT_STATE.cancelRequested || translationEpoch !== PIT_STATE.translationEpoch) {
      removePendingTranslationSurfaces(batch, mode);
      return false;
    }

    if (!response || !response.ok) {
      throw new Error(response?.error || "Translation request failed.");
    }

    translatedItems += applyTranslations(batch, response.translations, mode, bilingualStyle);
    processedItems += batch.length;
    return true;
  }

  async function worker() {
    while (nextBatchIndex < batches.length) {
      if (PIT_STATE.cancelRequested || firstError) {
        return;
      }

      const batch = batches[nextBatchIndex];
      nextBatchIndex += 1;

      try {
        if (!await sendBatch(batch)) {
          return;
        }
      } catch (error) {
        firstError = firstError || error;
        return;
      }
    }
  }

  if (batches.length > 0) {
    nextBatchIndex = 1;
    try {
      await sendBatch(batches[0]);
    } catch (error) {
      firstError = error;
    }
  }

  if (!firstError && !PIT_STATE.cancelRequested && translationEpoch === PIT_STATE.translationEpoch) {
    const workerCount = Math.min(PIT_MAX_CONCURRENT_BATCHES, batches.length - nextBatchIndex);
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  if (firstError) {
    markPendingTranslationSurfacesFailed(orderedBlocks, mode, options, firstError);
    throw firstError;
  }

  if (PIT_STATE.cancelRequested || translationEpoch !== PIT_STATE.translationEpoch) {
    removePendingTranslationSurfaces(orderedBlocks, mode);
  }

  return translatedItems;
}
