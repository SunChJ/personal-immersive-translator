// Top-level page translation orchestration: batching, viewport-first ordering, adaptive batch sizing.
async function translatePage(options) {
  if (PIT_STATE.running) {
    PIT_STATE.cancelRequested = true;
    PIT_STATE.translationEpoch += 1;
    throw new Error("A translation is already running. Click again after it stops.");
  }

  PIT_STATE.running = true;
  if (options.autoTranslate) {
    PIT_STATE.autoTranslateEnabled = true;
  }
  injectStyles();
  updateFloatingState("running");

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
      if (options.autoTranslate || options.preserveDynamicObserver) {
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
    if (deferred.length > 0) {
      startLazyTranslationObserver(deferred, options);
    }
    const pending = enqueuePendingTranslations(immediate, options, {
      priority: 2,
      translationEpoch
    });
    const translated = pending.cached + await flushPendingTranslationQueue(
      translationEpoch,
      "Translating",
      {
        firstBatchPriority: "visible",
        remainingBatchPriority: "background",
        firstBatchLeadMs: PIT_FIRST_BATCH_LEAD_MS
      }
    );

    if (location.href !== PIT_STATE.dynamicRouteUrl) {
      handlePossibleRouteChange(options);
    }
    if (PIT_STATE.cancelRequested || translationEpoch !== PIT_STATE.translationEpoch) {
      if (!PIT_STATE.dynamicObserver && !PIT_STATE.routeUpdatePending) {
        stopRouteTranslationWatcher();
      }
      return { translated: 0, total: orderedBlocks.length, deferred: 0, cancelled: true };
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
    updateFloatingState();
    schedulePendingTranslationDrain();
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

// Page work owns at most two native turns. The third stays free for an explicit
// selection translation or another foreground interaction.
const PIT_MAX_CONCURRENT_PAGE_BATCHES = 2;
const PIT_FIRST_BATCH_LEAD_MS = 120;
// Dynamic pages often reveal a few text nodes over several mutation callbacks.
// Let those background-only updates settle into one turn, but never hold them
// long enough to feel stalled.
const PIT_BACKGROUND_BATCH_DEBOUNCE_MS = 600;
const PIT_BACKGROUND_BATCH_MAX_WAIT_MS = 1200;
const PIT_BACKGROUND_BATCH_MIN_ITEMS = 8;

async function translateBlocks(
  orderedBlocks,
  options,
  overlayPrefix = "Translating",
  translationEpoch = PIT_STATE.translationEpoch,
  {
    firstBatchPriority = "visible",
    remainingBatchPriority = "background",
    firstBatchLeadMs = PIT_FIRST_BATCH_LEAD_MS
  } = {}
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

  async function sendBatch(batch, priority) {
    if (location.href !== sourceUrl) {
      handlePossibleRouteChange(options);
    }
    if (PIT_STATE.cancelRequested || translationEpoch !== PIT_STATE.translationEpoch) {
      return false;
    }

    setFloatingStatus(`${overlayPrefix} ${processedItems + 1}-${processedItems + batch.length} / ${orderedBlocks.length}`);
    prepareStableTranslationSurfaces(batch, mode, bilingualStyle);
    const requestId = `${PIT_STATE.sessionId}-${translationEpoch}-${PIT_STATE.nextStreamRequestId++}`;
    const entriesByID = new Map(batch.map((entry) => [entry.id, entry]));
    const renderedIDs = new Set();
    PIT_STATE.translationStreams.set(requestId, (translation) => {
      if (
        location.href !== sourceUrl
        || PIT_STATE.cancelRequested
        || translationEpoch !== PIT_STATE.translationEpoch
      ) {
        return false;
      }
      const entry = entriesByID.get(translation?.id);
      if (!entry?.element.isConnected || renderedIDs.has(entry.id)) {
        return false;
      }
      rememberCachedTranslations(
        [entry],
        [translation],
        options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE
      );
      const applied = applyTranslations([entry], [translation], mode, bilingualStyle);
      if (applied > 0) {
        renderedIDs.add(entry.id);
        translatedItems += applied;
        return true;
      }
      return false;
    });

    await acquireBatchRequestSlot();
    let response;
    try {
      if (PIT_STATE.cancelRequested || translationEpoch !== PIT_STATE.translationEpoch) {
        return false;
      }
      response = await chrome.runtime.sendMessage({
        type: "translate-batch",
        items: batch.map((entry, index) => ({
          id: entry.id,
          index,
          text: entry.text
        })),
        targetLanguage: options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE,
        endpoint: options.endpoint || PIT_DEFAULT_ENDPOINT,
        priority: normalizeTranslationPriority(priority),
        sourceUrl,
        requestId
      });
    } finally {
      PIT_STATE.translationStreams.delete(requestId);
      releaseBatchRequestSlot();
    }
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

    const remainingBatch = batch.filter((entry) => !renderedIDs.has(entry.id));
    const failedIDs = new Set(response.failedIds || []);
    const successfulBatch = remainingBatch.filter((entry) => !failedIDs.has(entry.id));
    const successfulIDs = new Set(successfulBatch.map((entry) => entry.id));
    const remainingTranslations = response.translations.filter((translation) => successfulIDs.has(translation.id));
    rememberCachedTranslations(
      successfulBatch,
      remainingTranslations,
      options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE
    );
    translatedItems += applyTranslations(successfulBatch, remainingTranslations, mode, bilingualStyle);
    const failedEntries = batch.filter((entry) => failedIDs.has(entry.id));
    if (failedEntries.length > 0) {
      markPendingTranslationSurfacesFailed(
        failedEntries,
        mode,
        options,
        new Error(response.error || "Translation request partially failed.")
      );
    }
    processedItems += batch.length;
    return true;
  }

  async function worker(priority) {
    while (nextBatchIndex < batches.length) {
      if (PIT_STATE.cancelRequested || firstError) {
        return;
      }

      const batch = batches[nextBatchIndex];
      nextBatchIndex += 1;

      try {
        if (!await sendBatch(batch, priority)) {
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
    let firstBatchFinished = false;
    const firstWorker = (async () => {
      try {
        await sendBatch(batches[0], firstBatchPriority);
      } catch (error) {
        firstError = firstError || error;
      } finally {
        firstBatchFinished = true;
      }
    })();

    if (batches.length > nextBatchIndex && firstBatchLeadMs > 0) {
      await Promise.race([
        firstWorker,
        new Promise((resolve) => window.setTimeout(resolve, firstBatchLeadMs))
      ]);
    }

    const activeFirstBatchCount = firstBatchFinished ? 0 : 1;
    const workerCount = (
      !firstError
      && !PIT_STATE.cancelRequested
      && translationEpoch === PIT_STATE.translationEpoch
    )
      ? Math.min(
        Math.max(0, PIT_MAX_CONCURRENT_PAGE_BATCHES - activeFirstBatchCount),
        batches.length - nextBatchIndex
      )
      : 0;
    const workers = Array.from({ length: workerCount }, () => worker(remainingBatchPriority));
    await Promise.all([firstWorker, ...workers]);
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

function enqueuePendingTranslations(entries, options, { force = false, priority = 0, translationEpoch = PIT_STATE.translationEpoch } = {}) {
  const mode = options.mode || "bilingual";
  const bilingualStyle = normalizeBilingualStyle(options.bilingualStyle);
  const targetLanguage = options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE;
  const batchSequence = PIT_STATE.nextPendingBatchSequence++;
  let cached = 0;

  entries.forEach((entry, entryIndex) => {
    if (!entry.element.isConnected || PIT_STATE.pendingIds.has(entry.id) || (!force && hasExistingTranslation(entry))) {
      return;
    }

    const cachedTranslation = getCachedTranslation(entry, targetLanguage);
    if (cachedTranslation) {
      cached += applyTranslations([entry], [{ id: entry.id, text: cachedTranslation }], mode, bilingualStyle);
      return;
    }

    prepareStableTranslationSurfaces([entry], mode, bilingualStyle);
    PIT_STATE.pendingIds.add(entry.id);
    PIT_STATE.pendingQueue.set(entry.id, {
      entry,
      options,
      priority,
      translationEpoch,
      batchSequence,
      entryIndex
    });
  });

  return { cached };
}

async function flushPendingTranslationQueue(
  translationEpoch = PIT_STATE.translationEpoch,
  overlayPrefix = "Translating",
  batchPriorities = {
    firstBatchPriority: "background",
    remainingBatchPriority: "background",
    firstBatchLeadMs: 0
  }
) {
  const { cached, jobs } = takePendingTranslationJobs(translationEpoch);
  if (jobs.length === 0) {
    return cached;
  }

  PIT_STATE.pendingDraining += 1;
  try {
    const translated = await translateBlocks(
      jobs.map((job) => job.entry),
      jobs[0].options,
      overlayPrefix,
      translationEpoch,
      batchPriorities
    );
    return cached + translated;
  } finally {
    jobs.forEach((job) => PIT_STATE.pendingIds.delete(job.entry.id));
    PIT_STATE.pendingDraining = Math.max(0, PIT_STATE.pendingDraining - 1);
  }
}

function takePendingTranslationJobs(translationEpoch) {
  let cached = 0;
  const candidates = Array.from(PIT_STATE.pendingQueue.values())
    .sort((left, right) => (
      right.priority - left.priority
      || pendingEntryDistance(left.entry) - pendingEntryDistance(right.entry)
      || right.batchSequence - left.batchSequence
      || left.entryIndex - right.entryIndex
    ));
  const jobs = [];
  let configKey = "";

  candidates.forEach((job) => {
    if (job.translationEpoch !== translationEpoch) {
      removePendingTranslationJob(job);
      return;
    }

    if (!job.entry.element.isConnected || hasCompletedTranslation(job.entry)) {
      removePendingTranslationJob(job);
      return;
    }

    const targetLanguage = job.options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE;
    const cachedTranslation = getCachedTranslation(job.entry, targetLanguage);
    if (cachedTranslation) {
      cached += applyTranslations(
        [job.entry],
        [{ id: job.entry.id, text: cachedTranslation }],
        job.options.mode || "bilingual",
        normalizeBilingualStyle(job.options.bilingualStyle)
      );
      removePendingTranslationJob(job);
      return;
    }

    const jobConfigKey = pendingTranslationConfigKey(job.options);
    if (!configKey) {
      configKey = jobConfigKey;
    }
    if (jobConfigKey !== configKey || jobs.length >= PIT_PENDING_DRAIN_LIMIT) {
      return;
    }

    PIT_STATE.pendingQueue.delete(job.entry.id);
    jobs.push(job);
  });

  return { cached, jobs };
}

function removePendingTranslationJob(job) {
  if (PIT_STATE.pendingQueue.get(job.entry.id) === job) {
    PIT_STATE.pendingQueue.delete(job.entry.id);
  }
  PIT_STATE.pendingIds.delete(job.entry.id);
  if (job.entry.translationSlot?.classList.contains("pit-translation-pending")) {
    job.entry.translationSlot.remove();
    job.entry.translationSlot = null;
  }
}

function schedulePendingTranslationDrain(delayMs = PIT_BACKGROUND_BATCH_DEBOUNCE_MS, resetTimer = true) {
  if (
    PIT_STATE.pendingQueue.size === 0 ||
    PIT_STATE.pendingDraining >= PIT_MAX_CONCURRENT_PAGE_BATCHES
  ) {
    return;
  }

  if (PIT_STATE.pendingTimer !== null) {
    if (!resetTimer) {
      return;
    }
    window.clearTimeout(PIT_STATE.pendingTimer);
  }

  const now = Date.now();
  if (!PIT_STATE.pendingQueuedAt) {
    PIT_STATE.pendingQueuedAt = now;
  }
  const elapsed = now - PIT_STATE.pendingQueuedAt;
  const waitMs = PIT_STATE.pendingQueue.size >= PIT_BACKGROUND_BATCH_MIN_ITEMS
    ? 0
    : Math.min(delayMs, Math.max(0, PIT_BACKGROUND_BATCH_MAX_WAIT_MS - elapsed));

  PIT_STATE.pendingTimer = window.setTimeout(async () => {
    PIT_STATE.pendingTimer = null;
    PIT_STATE.pendingQueuedAt = 0;
    if (PIT_STATE.pendingQueue.size === 0) {
      return;
    }

    const ownsRunningState = !PIT_STATE.running;
    if (ownsRunningState) {
      PIT_STATE.running = true;
      PIT_STATE.cancelRequested = false;
    } else if (PIT_STATE.cancelRequested) {
      return;
    }
    updateFloatingState("running");
    try {
      const translated = await flushPendingTranslationQueue(PIT_STATE.translationEpoch, "Updating");
      if (translated > 0 && !PIT_STATE.cancelRequested) {
        PIT_STATE.translated = true;
      }
    } catch (error) {
      setFloatingStatus("Update failed");
    } finally {
      if (ownsRunningState) {
        PIT_STATE.running = false;
      }
      if (!PIT_STATE.running && PIT_STATE.pendingDraining === 0) {
        updateFloatingState();
      }
      schedulePendingTranslationDrain(PIT_BACKGROUND_BATCH_DEBOUNCE_MS, false);
    }
  }, waitMs);
}

async function acquireBatchRequestSlot() {
  if (PIT_STATE.activeBatchRequests < PIT_MAX_CONCURRENT_PAGE_BATCHES) {
    PIT_STATE.activeBatchRequests += 1;
    return;
  }

  await new Promise((resolve) => {
    PIT_STATE.batchRequestWaiters.push(resolve);
  });
}

function releaseBatchRequestSlot() {
  const next = PIT_STATE.batchRequestWaiters.shift();
  if (next) {
    next();
    return;
  }
  PIT_STATE.activeBatchRequests = Math.max(0, PIT_STATE.activeBatchRequests - 1);
}

function clearPendingTranslationQueue() {
  window.clearTimeout(PIT_STATE.pendingTimer);
  PIT_STATE.pendingTimer = null;
  PIT_STATE.pendingQueuedAt = 0;
  PIT_STATE.pendingQueue.forEach((job) => {
    if (job.entry.translationSlot?.classList.contains("pit-translation-pending")) {
      job.entry.translationSlot.remove();
      job.entry.translationSlot = null;
    }
  });
  PIT_STATE.pendingQueue.clear();
  PIT_STATE.pendingIds.clear();
}

function pendingEntryDistance(entry) {
  const rect = getEntryRect(entry);
  if (isInViewport(rect)) {
    return 0;
  }
  return Math.min(Math.abs(rect.top), Math.abs(rect.bottom - window.innerHeight));
}

function pendingTranslationConfigKey(options) {
  return [
    options.targetLanguage || PIT_DEFAULT_TARGET_LANGUAGE,
    options.endpoint || PIT_DEFAULT_ENDPOINT,
    options.mode || "bilingual",
    normalizeBilingualStyle(options.bilingualStyle)
  ].join("\u0000");
}

function translationCacheKey(entry, targetLanguage) {
  return `${targetLanguage}\u0000${entry.text}`;
}

function getCachedTranslation(entry, targetLanguage) {
  const key = translationCacheKey(entry, targetLanguage);
  const translation = PIT_STATE.translationCache.get(key);
  if (!translation) {
    return "";
  }
  PIT_STATE.translationCache.delete(key);
  PIT_STATE.translationCache.set(key, translation);
  return translation;
}

function rememberCachedTranslations(batch, translations, targetLanguage) {
  const byId = normalizeTranslationMap(batch, translations);
  batch.forEach((entry) => {
    const translation = String(byId.get(entry.id) || "").trim();
    if (!translation) {
      return;
    }
    const key = translationCacheKey(entry, targetLanguage);
    if (PIT_STATE.translationCache.has(key)) {
      PIT_STATE.translationCache.delete(key);
    } else if (PIT_STATE.translationCache.size >= PIT_TRANSLATION_CACHE_LIMIT) {
      PIT_STATE.translationCache.delete(PIT_STATE.translationCache.keys().next().value);
    }
    PIT_STATE.translationCache.set(key, translation);
  });
}
