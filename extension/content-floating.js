// Floating translate button: mount, drag/snap, settings sync, health check.
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

