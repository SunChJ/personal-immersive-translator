// Renders pending/ready/failed translation surfaces into the DOM and clears them.
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

    const slot = document.createElement("span");
    slot.className = "pit-translation pit-translation-pending";
    slot.dataset.pitSkip = "true";
    slot.dataset.pitPlacement = translationSlotPlacement(entry);
    slot.dataset.pitStyle = normalizeBilingualStyle(bilingualStyle);
    renderPendingTranslationSlot(slot);
    applyInheritedTextStyle(entry.element, slot, getEntryStyle(entry));
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
  const translationEpoch = ++PIT_STATE.translationEpoch;
  updateFloatingState("running");
  renderPendingTranslationSlot(entry.translationSlot);

  try {
    const translated = await translateBlocks([entry], { ...options, clearPrevious: false }, "Retrying", translationEpoch);
    if (translationEpoch === PIT_STATE.translationEpoch && !PIT_STATE.cancelRequested && translated > 0) {
      PIT_STATE.translated = true;
      setFloatingStatus("Retried");
    }
  } finally {
    PIT_STATE.running = false;
    updateFloatingState();
  }
}

function findTranslationSlot(entry) {
  const element = entry.element;
  const selector = `:scope > .pit-translation[data-pit-slot-id="${entry.id}"]`;
  if (translationSlotPlacement(entry) === "inside") {
    return element.querySelector?.(selector) || null;
  }

  const sibling = element.nextElementSibling;
  if (sibling?.classList?.contains("pit-translation") && sibling.dataset.pitSlotId === entry.id) {
    return sibling;
  }

  return null;
}

function insertTranslationSlot(entry, slot) {
  slot.dataset.pitSlotId = entry.id;
  slot.pitOwnerElement = entry.element;

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
  if (entry.kind === "tweet-segment" || entry.kind === "walked") {
    return "inside";
  }

  const tagName = entry.element.tagName.toLowerCase();
  if (["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "figcaption", "caption", "dt", "dd", "summary", "td", "th"].includes(tagName)) {
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
  let applied = 0;

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
      applyReplaceTranslation(entry, translation);
      applied += 1;
      return;
    }

    const translationBlock = entry.translationSlot || document.createElement("span");
    const needsStyle = !entry.translationSlot;
    translationBlock.className = "pit-translation pit-translation-ready";
    translationBlock.dataset.pitSkip = "true";
    translationBlock.dataset.pitPlacement = translationSlotPlacement(entry);
    translationBlock.dataset.pitStyle = normalizedStyle;
    translationBlock.textContent = translation;
    translationBlock.removeAttribute("aria-label");
    translationBlock.removeAttribute("role");
    translationBlock.removeAttribute("title");
    translationBlock.style.minHeight = "";
    if (needsStyle) {
      applyInheritedTextStyle(entry.element, translationBlock, getEntryStyle(entry));
    }
    entry.element.dataset.pitTranslated = "true";

    if (!translationBlock.parentNode) {
      insertTranslationSlot(entry, translationBlock);
    }
    entry.translationSlot = translationBlock;
    applied += 1;
  });

  return applied;
}

function applyReplaceTranslation(entry, translation) {
  const element = entry.element;
  let state = PIT_STATE.replaceStates.get(element);
  markOwnReplaceMutation(element);

  if (!state) {
    state = {
      hiddenElements: [],
      slot: null,
      textWrappers: []
    };

    Array.from(element.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const wrapper = document.createElement("span");
        wrapper.className = "pit-replace-original";
        wrapper.dataset.pitSkip = "true";
        element.insertBefore(wrapper, node);
        wrapper.appendChild(node);
        state.textWrappers.push(wrapper);
        return;
      }

      if (node instanceof Element && !node.classList.contains("pit-translation")) {
        const hadClass = node.classList.contains("pit-replace-original");
        node.classList.add("pit-replace-original");
        state.hiddenElements.push({ hadClass, node });
      }
    });

    state.slot = document.createElement("span");
    state.slot.className = "pit-translation pit-translation-ready pit-translation-replace";
    state.slot.dataset.pitPlacement = "inside";
    state.slot.dataset.pitSkip = "true";
    state.slot.dataset.pitSlotId = entry.id;
    state.slot.dataset.pitStyle = "replace";
    state.slot.pitOwnerElement = element;
    applyInheritedTextStyle(element, state.slot, getEntryStyle(entry));
    element.appendChild(state.slot);
    PIT_STATE.replaceStates.set(element, state);
  }

  state.slot.textContent = translation;
  element.dataset.pitTranslated = "true";
  unlockElementHeightSoon(element);
}

function restoreReplaceTranslation(element) {
  const state = PIT_STATE.replaceStates.get(element);
  if (!state) {
    return false;
  }

  markOwnReplaceMutation(element);
  if (state.slot) {
    state.slot.pitIntentionalRemoval = true;
    state.slot.remove();
  }
  state.hiddenElements.forEach(({ hadClass, node }) => {
    if (!hadClass) {
      node.classList.remove("pit-replace-original");
    }
  });
  state.textWrappers.forEach((wrapper) => {
    const parent = wrapper.parentNode;
    if (!parent) {
      return;
    }
    while (wrapper.firstChild) {
      parent.insertBefore(wrapper.firstChild, wrapper);
    }
    wrapper.remove();
  });

  PIT_STATE.replaceStates.delete(element);
  element.dataset.pitTranslated = "false";
  unlockElementHeight(element);
  return true;
}

function restoreAllReplaceTranslations() {
  Array.from(PIT_STATE.replaceStates.keys()).forEach((element) => {
    restoreReplaceTranslation(element);
  });
}

function clearTranslations() {
  PIT_STATE.translationEpoch += 1;
  PIT_STATE.cancelRequested = true;
  stopDynamicTranslationObserver();
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
  PIT_STATE.translated = false;
  PIT_STATE.autoTranslateActive = false;
  updateFloatingState();
  setFloatingStatus("Cleared");
}

