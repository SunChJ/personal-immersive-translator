// Lazy (IntersectionObserver), dynamic (MutationObserver), and SPA route-change translation triggers.
function startLazyTranslationObserver(entries, options) {
  stopLazyTranslationObserver();

  if (!entries.length || !("IntersectionObserver" in window)) {
    return;
  }

  const entriesByElement = new Map();
  entries.forEach((entry) => {
    const grouped = entriesByElement.get(entry.element) || [];
    grouped.push(entry);
    entriesByElement.set(entry.element, grouped);
  });

  const observer = new IntersectionObserver((observedEntries) => {
    observedEntries.forEach((observed) => {
      if (!observed.isIntersecting) {
        return;
      }

      observer.unobserve(observed.target);
      const grouped = entriesByElement.get(observed.target) || [];
      grouped.forEach((entry) => {
        void queueLazyTranslation(entry, options);
      });
    });
  }, {
    root: null,
    rootMargin: `${PIT_LAZY_ROOT_MARGIN}px`,
    threshold: 0.1
  });

  entriesByElement.forEach((grouped, element) => {
    if (!element.parentNode || grouped.every((entry) => hasExistingTranslation(entry))) {
      return;
    }

    element.dataset.pitDeferred = "true";
    observer.observe(element);
  });

  PIT_STATE.lazyObserver = observer;
}

async function queueLazyTranslation(entry, options) {
  if (hasExistingTranslation(entry)) {
    return;
  }

  await refreshTranslationProviderStatus(options.endpoint || PIT_DEFAULT_ENDPOINT);
  delete entry.element.dataset.pitDeferred;
  enqueuePendingTranslations([entry], options, {
    priority: 3,
    translationEpoch: PIT_STATE.translationEpoch
  });
  schedulePendingTranslationDrain();
}

function stopLazyTranslationObserver() {
  PIT_STATE.lazyObserver?.disconnect();
  PIT_STATE.lazyObserver = null;
  document.querySelectorAll("[data-pit-deferred='true']").forEach((node) => {
    delete node.dataset.pitDeferred;
  });
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
  if (!PIT_STATE.dynamicQueuedAt) {
    PIT_STATE.dynamicQueuedAt = Date.now();
  }
  const elapsed = Date.now() - PIT_STATE.dynamicQueuedAt;
  const boundedDelay = Math.min(delayMs, Math.max(0, PIT_DYNAMIC_MAX_WAIT - elapsed));
  window.clearTimeout(PIT_STATE.dynamicTimer);
  PIT_STATE.dynamicTimer = window.setTimeout(() => {
    PIT_STATE.dynamicQueuedAt = 0;
    const scanRoots = PIT_STATE.dynamicRoots;
    PIT_STATE.dynamicRoots = [];
    translateDiscoveredBlocks(options, scanRoots).catch((error) => {
      setFloatingStatus("Update failed");
    });
  }, boundedDelay);
}

function stopDynamicTranslationObserver() {
  PIT_STATE.dynamicObserver?.disconnect();
  PIT_STATE.dynamicObserver = null;
  PIT_STATE.dynamicQueuedAt = 0;
  PIT_STATE.dynamicQueue.clear();
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
      const replaceOwner = findReplaceOwner(parent);
      if (replaceOwner) {
        restoreReplaceTranslation(replaceOwner);
        if (normalizeText(mutation.target.nodeValue || "").length >= 4) {
          roots.push(resolveScanRoot(replaceOwner));
        }
        return;
      }

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

    Array.from(mutation.removedNodes).forEach((node) => {
      if (!(node instanceof HTMLElement) || !node.classList.contains("pit-translation")) {
        return;
      }

      const owner = node.pitOwnerElement;
      if (node.pitIntentionalRemoval || !(owner instanceof HTMLElement) || !owner.isConnected) {
        return;
      }
      resetTranslationForElement(owner);
      roots.push(resolveScanRoot(owner));
    });

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

  Array.from(PIT_STATE.replaceStates.keys()).forEach((element) => {
    if (!element.isConnected) {
      PIT_STATE.replaceStates.delete(element);
    }
  });

  return mergeScanRoots(roots);
}

function findReplaceOwner(element) {
  const original = element?.closest?.(".pit-replace-original");
  const owner = original?.parentElement;
  return owner && PIT_STATE.replaceStates.has(owner) ? owner : null;
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
  if (PIT_BROWSER_TARGET === "safari") {
    PIT_STATE.routePollTimer = window.setInterval(handler, 1000);
  }
}

function stopRouteTranslationWatcher() {
  if (PIT_STATE.routeEventHandler) {
    window.removeEventListener("popstate", PIT_STATE.routeEventHandler);
    window.removeEventListener("hashchange", PIT_STATE.routeEventHandler);
    window.removeEventListener(PIT_ROUTE_CHANGE_EVENT, PIT_STATE.routeEventHandler);
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
  if ((!isAutoTranslationActive() && !PIT_STATE.running) || location.href === PIT_STATE.dynamicRouteUrl) {
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
  if (!document.body || (!PIT_STATE.dynamicObserver && !PIT_STATE.autoTranslateActive && !PIT_STATE.routeUpdatePending)) {
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
  PIT_STATE.translationEpoch += 1;
  PIT_STATE.cancelRequested = true;
  clearPendingTranslationQueue();
  PIT_STATE.dynamicQueue.clear();
  PIT_STATE.dynamicRoots = [];
  stopLazyTranslationObserver();
  restoreAllReplaceTranslations();
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

  restoreReplaceTranslation(element);
  element.querySelectorAll(":scope > .pit-translation").forEach((node) => {
    node.pitIntentionalRemoval = true;
    node.remove();
  });
  const sibling = element.nextElementSibling;
  if (
    sibling?.classList?.contains("pit-translation") &&
    (!element.dataset.pitId || sibling.dataset.pitSlotId === element.dataset.pitId)
  ) {
    sibling.pitIntentionalRemoval = true;
    sibling.remove();
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
  const unique = Array.from(new Set(roots)).filter((root) => root instanceof HTMLElement && root.isConnected);
  const rootSet = new Set(unique);
  return unique.filter((root) => {
    let parent = root.parentElement;
    while (parent) {
      if (rootSet.has(parent)) {
        return false;
      }
      parent = parent.parentElement;
    }
    return true;
  });
}

async function translateDiscoveredBlocks(options, roots = [document.body]) {
  await refreshTranslationProviderStatus(options.endpoint || PIT_DEFAULT_ENDPOINT);
  const seenIds = new Set();
  const discovered = [];
  mergeScanRoots(roots).forEach((root) => {
    collectTranslationBlocks(root, {
      minChars: Number(options.minChars || 4),
      mode: options.mode || "bilingual",
      allowTranslatedAncestors: true,
      allowDeferredAncestors: true
    }).forEach((entry) => {
      if (seenIds.has(entry.id)) {
        return;
      }

      seenIds.add(entry.id);
      discovered.push(entry);
    });
  });
  const pending = enqueuePendingTranslations(prioritizeBlocks(discovered, true), options, {
    priority: 1,
    translationEpoch: PIT_STATE.translationEpoch
  });
  if (pending.cached > 0) {
    PIT_STATE.translated = true;
    setFloatingStatus(`Added: ${pending.cached}`);
  }
  schedulePendingTranslationDrain();
}

function scheduleDynamicBacklog(options) {
  if (PIT_STATE.dynamicRoots.length > 0) {
    scheduleDynamicTranslation(options, 120);
  }
}
