// injectStyles() — all injected CSS for bilingual styles, floating button, and tooltip.
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
