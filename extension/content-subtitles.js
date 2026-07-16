// YouTube subtitle translation: caption discovery, timed-text parsing, independent
// translation queue, progress-aware prefetching, and an isolated bilingual overlay.
const PIT_SUBTITLE_INITIAL_WINDOW_MS = 50_000;
const PIT_SUBTITLE_NEXT_WINDOW_MS = 60_000;
const PIT_SUBTITLE_PREFETCH_LEAD_MS = 40_000;

function initSubtitleTranslation() {
  if (!isYouTubeLocation()) {
    return;
  }
  PIT_STATE.subtitle = createSubtitleState();
  window.addEventListener("pit:youtube-caption-tracks", handleYouTubeCaptionTracks);
  window.addEventListener("pit:route-change", handleSubtitleRouteChange);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.translateSubtitles || !PIT_STATE.subtitle) {
      if (area === "local" && changes.targetLanguage && PIT_STATE.subtitle?.wantsEnabled) {
        stopSubtitleTranslation({ preservePreference: true });
        startSubtitleTranslation().catch(showSubtitleError);
      }
      return;
    }
    setSubtitlePreference(changes.translateSubtitles.newValue === true);
  });
  chrome.storage.local.get({ translateSubtitles: false }).then((settings) => {
    setSubtitlePreference(settings.translateSubtitles === true);
    requestYouTubeCaptionTracks();
  });
}

function createSubtitleState() {
  return {
    activeRequestIds: new Set(),
    button: null,
    buttonAttempts: 0,
    coveredEndMs: 0,
    coveredStartMs: 0,
    cues: [],
    enabled: false,
    generation: 0,
    inFlightCueIds: new Set(),
    lastCueId: "",
    overlay: null,
    pendingWindowKeys: new Set(),
    pendingWindows: [],
    scheduler: null,
    sourceTrack: null,
    tracks: [],
    translations: new Map(),
    videoId: "",
    wantsEnabled: false,
    windowDrain: null
  };
}

function isYouTubeLocation() {
  return ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(location.hostname.toLowerCase());
}

function requestYouTubeCaptionTracks() {
  window.dispatchEvent(new Event("pit:request-youtube-caption-tracks"));
}

function handleYouTubeCaptionTracks(event) {
  const state = PIT_STATE.subtitle;
  if (!state) return;
  let payload;
  try {
    payload = JSON.parse(String(event.detail || ""));
  } catch {
    return;
  }
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks.filter(isUsableCaptionTrack) : [];
  const videoId = String(payload?.videoId || "");
  if (!videoId) {
    return;
  }
  const videoChanged = state.videoId && state.videoId !== videoId;
  if (videoChanged) {
    stopSubtitleTranslation({ preservePreference: true });
  }
  state.videoId = videoId;
  state.tracks = tracks;
  ensureSubtitleButton();
  if (tracks.length === 0) {
    if (state.button) {
      state.button.disabled = true;
      state.button.title = "This video has no available subtitles";
    }
    return;
  }
  if (state.button) state.button.disabled = false;
  if (state.wantsEnabled && !state.enabled) {
    startSubtitleTranslation().catch(showSubtitleError);
  }
}

function isUsableCaptionTrack(track) {
  if (!track || !track.baseUrl || !track.languageCode) return false;
  try {
    const url = new URL(track.baseUrl);
    return url.protocol === "https:" && ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function chooseCaptionTrack(tracks) {
  return tracks.find((track) => track.kind !== "asr") || tracks[0] || null;
}

function ensureSubtitleButton() {
  const state = PIT_STATE.subtitle;
  if (!state || state.button?.isConnected) return;
  const controls = document.querySelector(".html5-video-player .ytp-right-controls");
  if (!controls) {
    state.buttonAttempts += 1;
    if (state.buttonAttempts <= 20) window.setTimeout(ensureSubtitleButton, 500);
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ytp-button pit-youtube-subtitle-button";
  button.dataset.pitSkip = "true";
  button.textContent = "译";
  button.setAttribute("aria-label", "Translate subtitles with Gloss");
  button.title = "Translate subtitles with Gloss";
  button.addEventListener("click", async () => {
    await chrome.storage.local.set({ translateSubtitles: !state.wantsEnabled });
  });
  controls.prepend(button);
  state.button = button;
  state.buttonAttempts = 0;
  updateSubtitleButton();
  if (state.tracks.length === 0) {
    button.disabled = true;
    button.title = "This video has no available subtitles";
  }
}

function setSubtitlePreference(enabled) {
  const state = PIT_STATE.subtitle;
  if (!state) return;
  state.wantsEnabled = enabled;
  if (!enabled) {
    stopSubtitleTranslation({ preservePreference: false });
    return;
  }
  updateSubtitleButton("loading");
  if (state.tracks.length > 0) {
    startSubtitleTranslation().catch(showSubtitleError);
  } else {
    requestYouTubeCaptionTracks();
  }
}

async function startSubtitleTranslation() {
  const state = PIT_STATE.subtitle;
  if (!state || state.enabled || !state.wantsEnabled) return;
  const track = chooseCaptionTrack(state.tracks);
  if (!track) {
    requestYouTubeCaptionTracks();
    return;
  }
  state.enabled = true;
  state.sourceTrack = track;
  state.generation += 1;
  const generation = state.generation;
  updateSubtitleButton("loading");
  const response = await chrome.runtime.sendMessage({
    type: "fetch-youtube-subtitles",
    url: track.baseUrl
  });
  if (!state.enabled || generation !== state.generation) return;
  if (!response?.ok) {
    throw new Error(response?.error || "Subtitle download failed.");
  }
  state.cues = parseYouTubeSubtitleEvents(response.subtitles);
  if (state.cues.length === 0) {
    throw new Error("This video has no readable subtitle cues.");
  }
  ensureSubtitleOverlay();
  const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
  if (!video) {
    throw new Error("YouTube video player is not ready.");
  }
  const currentMs = Math.max(0, video.currentTime * 1000);
  state.coveredStartMs = Math.max(0, currentMs - 5000);
  state.coveredEndMs = currentMs + PIT_SUBTITLE_INITIAL_WINDOW_MS;
  queueSubtitleWindow(state.coveredStartMs, state.coveredEndMs);
  window.clearInterval(state.scheduler);
  state.scheduler = window.setInterval(updateSubtitlePlayback, 250);
  updateSubtitleButton("active");
  updateSubtitlePlayback();
}

function parseYouTubeSubtitleEvents(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const cues = [];
  events.forEach((event, index) => {
    const startMs = Number(event?.tStartMs);
    const text = normalizeSubtitleText(
      Array.isArray(event?.segs) ? event.segs.map((segment) => segment?.utf8 || "").join("") : ""
    );
    if (!Number.isFinite(startMs) || !text) return;
    const durationMs = Number(event?.dDurationMs);
    const endMs = startMs + (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 3000);
    const previous = cues.at(-1);
    if (previous && previous.startMs === startMs && previous.text === text) return;
    cues.push({ id: `yt-${index}-${Math.round(startMs)}`, startMs, endMs, text });
  });
  return cues;
}

function normalizeSubtitleText(value) {
  return String(value || "").replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim();
}

function queueSubtitleWindow(startMs, endMs) {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled) return;
  const key = `${Math.floor(startMs / 1000)}:${Math.floor(endMs / 1000)}`;
  if (state.pendingWindowKeys.has(key)) return;
  state.pendingWindowKeys.add(key);
  state.pendingWindows.push({ startMs, endMs, key });
  if (!state.windowDrain) {
    const drain = drainSubtitleWindows().catch(showSubtitleError);
    state.windowDrain = drain;
    drain.finally(() => {
      if (PIT_STATE.subtitle?.windowDrain === drain) PIT_STATE.subtitle.windowDrain = null;
    });
  }
}

async function drainSubtitleWindows() {
  const state = PIT_STATE.subtitle;
  while (state?.enabled && state.pendingWindows.length > 0) {
    const windowRange = state.pendingWindows.shift();
    state.pendingWindowKeys.delete(windowRange.key);
    await translateSubtitleWindow(windowRange.startMs, windowRange.endMs, state.generation);
  }
}

async function translateSubtitleWindow(startMs, endMs, generation) {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled || generation !== state.generation) return;
  const settings = await readTranslationSettings();
  const cues = state.cues.filter((cue) => (
    cue.endMs >= startMs
    && cue.startMs <= endMs
    && !state.translations.has(cue.id)
    && !state.inFlightCueIds.has(cue.id)
  ));
  cues.forEach((cue) => state.inFlightCueIds.add(cue.id));
  const batches = buildTranslationBatches(
    cues,
    normalizeBatchItems(settings.batchSize),
    normalizeBatchCharLimit(settings.batchCharLimit)
  );
  try {
    for (const batch of batches) {
      if (!state.enabled || generation !== state.generation) return;
      const requestId = `${PIT_STATE.sessionId}-subtitle-${state.videoId}-${PIT_STATE.nextStreamRequestId++}`;
      state.activeRequestIds.add(requestId);
      PIT_STATE.translationRequestEndpoints.set(requestId, settings.endpoint || PIT_DEFAULT_ENDPOINT);
      PIT_STATE.translationStreams.set(requestId, (translation) => {
        if (!state.enabled || generation !== state.generation || !translation?.id) return false;
        state.translations.set(translation.id, String(translation.text || ""));
        updateSubtitlePlayback();
        return true;
      });
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: "translate-batch",
          items: batch.map((cue, index) => ({ id: cue.id, index, text: cue.text })),
          targetLanguage: settings.targetLanguage,
          endpoint: settings.endpoint,
          priority: "background",
          profile: "subtitle",
          contentKind: "subtitle",
          sourceUrl: location.href,
          requestId
        });
      } finally {
        state.activeRequestIds.delete(requestId);
        PIT_STATE.translationStreams.delete(requestId);
        PIT_STATE.translationRequestEndpoints.delete(requestId);
      }
      if (!state.enabled || generation !== state.generation) return;
      if (!response?.ok) {
        throw new Error(response?.error || "Subtitle translation failed.");
      }
      (response.translations || []).forEach((translation) => {
        if (translation?.id && typeof translation.text === "string") {
          state.translations.set(translation.id, translation.text);
        }
      });
      updateSubtitlePlayback();
    }
  } finally {
    cues.forEach((cue) => state.inFlightCueIds.delete(cue.id));
  }
}

function updateSubtitlePlayback() {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled) return;
  const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
  if (!video) return;
  const currentMs = video.currentTime * 1000;
  if (currentMs < state.coveredStartMs - 1500 || currentMs > state.coveredEndMs + 1500) {
    state.coveredStartMs = Math.max(0, currentMs - 5000);
    state.coveredEndMs = currentMs + PIT_SUBTITLE_INITIAL_WINDOW_MS;
    queueSubtitleWindow(state.coveredStartMs, state.coveredEndMs);
  } else if (currentMs + PIT_SUBTITLE_PREFETCH_LEAD_MS >= state.coveredEndMs) {
    const nextStart = state.coveredEndMs;
    state.coveredEndMs += PIT_SUBTITLE_NEXT_WINDOW_MS;
    queueSubtitleWindow(nextStart, state.coveredEndMs);
  }
  renderSubtitleCue(findSubtitleCue(state.cues, currentMs));
}

function findSubtitleCue(cues, currentMs) {
  let low = 0;
  let high = cues.length - 1;
  let candidate = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle];
    if (cue.startMs <= currentMs) {
      candidate = cue;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate && currentMs <= candidate.endMs + 250 ? candidate : null;
}

function ensureSubtitleOverlay() {
  const state = PIT_STATE.subtitle;
  if (!state || state.overlay?.host?.isConnected) return;
  const player = document.querySelector(".html5-video-player");
  if (!player) return;
  const host = document.createElement("div");
  host.id = "pit-youtube-subtitles";
  host.dataset.pitSkip = "true";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { position:absolute; inset:0; z-index:61; pointer-events:none; display:block; }
      .wrap { position:absolute; left:8%; right:8%; bottom:12%; display:grid; justify-items:center; gap:4px; text-align:center; }
      :host([data-native-captions="true"]) .wrap { bottom:22%; }
      .line { max-width:min(900px, 90vw); padding:3px 9px; border-radius:5px; background:rgba(0,0,0,.76); color:#fff; font:600 clamp(15px,2.1vw,28px)/1.28 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; text-shadow:0 1px 2px #000; box-decoration-break:clone; }
      .source { color:rgba(255,255,255,.88); font-size:clamp(12px,1.55vw,20px); font-weight:500; }
      .line:empty { display:none; }
    </style>
    <div class="wrap" aria-live="off"><div class="line source"></div><div class="line translated"></div></div>
  `;
  player.appendChild(host);
  state.overlay = {
    host,
    source: shadow.querySelector(".source"),
    translated: shadow.querySelector(".translated")
  };
}

function renderSubtitleCue(cue) {
  const state = PIT_STATE.subtitle;
  ensureSubtitleOverlay();
  if (!state?.overlay) return;
  if (!cue) {
    state.lastCueId = "";
    state.overlay.source.textContent = "";
    state.overlay.translated.textContent = "";
    return;
  }
  const translation = state.translations.get(cue.id) || "";
  const nativeCaptionsVisible = document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed") === "true";
  state.overlay.host.dataset.nativeCaptions = String(nativeCaptionsVisible);
  state.overlay.source.textContent = nativeCaptionsVisible ? "" : cue.text;
  state.overlay.translated.textContent = translation;
  state.lastCueId = cue.id;
}

function stopSubtitleTranslation({ preservePreference = true } = {}) {
  const state = PIT_STATE.subtitle;
  if (!state) return;
  state.enabled = false;
  state.generation += 1;
  window.clearInterval(state.scheduler);
  state.scheduler = null;
  const requestIds = Array.from(state.activeRequestIds);
  const requestsByEndpoint = new Map();
  requestIds.forEach((requestId) => {
    const endpoint = PIT_STATE.translationRequestEndpoints.get(requestId) || PIT_DEFAULT_ENDPOINT;
    const endpointRequestIds = requestsByEndpoint.get(endpoint) || [];
    endpointRequestIds.push(requestId);
    requestsByEndpoint.set(endpoint, endpointRequestIds);
    PIT_STATE.translationStreams.delete(requestId);
    PIT_STATE.translationRequestEndpoints.delete(requestId);
  });
  requestsByEndpoint.forEach((endpointRequestIds, endpoint) => {
    chrome.runtime.sendMessage({
      type: "cancel-translation",
      requestIds: endpointRequestIds,
      endpoint
    }).catch(() => {});
  });
  state.activeRequestIds.clear();
  state.pendingWindows = [];
  state.pendingWindowKeys.clear();
  state.inFlightCueIds.clear();
  state.windowDrain = null;
  state.overlay?.host.remove();
  state.overlay = null;
  state.cues = [];
  state.translations.clear();
  state.sourceTrack = null;
  state.coveredStartMs = 0;
  state.coveredEndMs = 0;
  if (!preservePreference) state.wantsEnabled = false;
  updateSubtitleButton();
}

function updateSubtitleButton(mode = "") {
  const state = PIT_STATE.subtitle;
  const button = state?.button;
  if (!button) return;
  const active = mode === "active" || state.enabled;
  button.dataset.active = String(active);
  button.dataset.loading = String(mode === "loading");
  button.setAttribute("aria-pressed", String(active));
  button.title = mode === "loading"
    ? "Gloss is preparing subtitles"
    : active
      ? `Gloss subtitles on · ${state.sourceTrack?.name || state.sourceTrack?.languageCode || "source"}`
      : "Translate subtitles with Gloss";
}

function showSubtitleError(error) {
  const state = PIT_STATE.subtitle;
  if (!state) return;
  stopSubtitleTranslation({ preservePreference: false });
  chrome.storage.local.set({ translateSubtitles: false }).finally(() => {
    if (!state.button) return;
    state.button.dataset.error = "true";
    state.button.title = error instanceof Error ? error.message : String(error);
    window.setTimeout(() => {
      if (state.button?.isConnected) state.button.dataset.error = "false";
    }, 4000);
  });
}

function handleSubtitleRouteChange() {
  const state = PIT_STATE.subtitle;
  if (!state) return;
  stopSubtitleTranslation({ preservePreference: true });
  state.button?.remove();
  state.button = null;
  state.buttonAttempts = 0;
  state.videoId = "";
  state.tracks = [];
  window.setTimeout(requestYouTubeCaptionTracks, 500);
}
