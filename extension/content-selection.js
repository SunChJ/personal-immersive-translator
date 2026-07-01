// Selection-translation tooltip: init, render, copy, speech playback.
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
  const result = translations.get("selection");
  const translation = String(result?.text || "").trim();
  if (!translation || result.ok === false) {
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

