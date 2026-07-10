// Lazy (IntersectionObserver), dynamic (MutationObserver), and SPA route-change translation triggers.
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

// Holds PIT_STATE.running for the whole drain (not just one batch), so the
// "is a translation in progress" contract every other flow (manual translate,
// route-change retranslation, dynamic-mutation scan, the floating button) already
// relies on is unchanged. What changes is that while it's held, up to
// PIT_MAX_CONCURRENT_BATCHES batches now run at once against the queue instead of
// one at a time, using the same worker-pool shape as translateBlocks() so the
// codex-app thread pool (server/server.js CODEX_APP_THREAD_POOL_SIZE) actually gets
// used during scroll-triggered loading, not just the initial full-page translation.
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

  PIT_STATE.running = true;
  PIT_STATE.cancelRequested = false;
  updateFloatingState("running");

  try {
    await drainLazyQueue(options);
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

async function drainLazyQueue(options) {
  // Errors are swallowed per-worker (translateBlocks already renders the failed/retry
  // UI for the affected entries before it throws) so one bad batch can't reject
  // Promise.all early and leave a sibling worker's DOM writes running after
  // PIT_STATE.running has already been reset to false.
  async function worker() {
    for (;;) {
      if (PIT_STATE.cancelRequested) {
        return;
      }

      const dequeued = PIT_STATE.lazyQueue.splice(0, PIT_LAZY_BATCH_ITEMS);
      if (dequeued.length === 0) {
        return;
      }

      dequeued.forEach((entry) => PIT_STATE.lazyQueuedIds.delete(entry.id));
      const batch = dequeued.filter((entry) => entry.element.parentNode && !hasExistingTranslation(entry.element));
      if (batch.length === 0) {
        continue;
      }

      try {
        const translated = await translateBlocks(prioritizeBlocks(batch, true), { ...options, clearPrevious: false }, "Loading nearby");
        if (translated > 0) {
          PIT_STATE.translated = true;
          setFloatingStatus(`Added: ${translated}`);
        }
      } catch (error) {
        setFloatingStatus("Update failed");
        return;
      }
    }
  }

  const workerCount = Math.min(PIT_MAX_CONCURRENT_BATCHES, Math.ceil(PIT_STATE.lazyQueue.length / PIT_LAZY_BATCH_ITEMS));
  await Promise.all(Array.from({ length: workerCount }, worker));
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

// route-patch.js runs in the page's MAIN world (content scripts run in an isolated
// world and cannot intercept the page's own pushState/replaceState calls) and
// dispatches this event, which — unlike JS object mutations — does cross the
// isolated/main world boundary because DOM event dispatch is platform-level.
const PIT_ROUTE_CHANGE_EVENT = "pit:route-change";

function startRouteTranslationWatcher(options) {
  stopRouteTranslationWatcher();

  const handler = () => handlePossibleRouteChange(options);
  PIT_STATE.routeEventHandler = handler;
  window.addEventListener("popstate", handler);
  window.addEventListener("hashchange", handler);
  window.addEventListener(PIT_ROUTE_CHANGE_EVENT, handler);
}

function stopRouteTranslationWatcher() {
  if (PIT_STATE.routeEventHandler) {
    window.removeEventListener("popstate", PIT_STATE.routeEventHandler);
    window.removeEventListener("hashchange", PIT_STATE.routeEventHandler);
    window.removeEventListener(PIT_ROUTE_CHANGE_EVENT, PIT_STATE.routeEventHandler);
    PIT_STATE.routeEventHandler = null;
  }

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

