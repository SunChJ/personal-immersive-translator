// YouTube subtitle translation: caption discovery, timed-text parsing, a
// progress-aware hot/warm buffer, and native bilingual caption rendering.
const PIT_SUBTITLE_HOT_LOOK_BEHIND_MS = 5_000;
const PIT_SUBTITLE_HOT_LOOK_AHEAD_MS = 20_000;
const PIT_SUBTITLE_READY_LOW_WATER_MS = 25_000;
const PIT_SUBTITLE_READY_TARGET_MS = 60_000;
const PIT_SUBTITLE_MAX_PLAYBACK_RATE_SCALE = 2.5;
const PIT_SUBTITLE_PLAYBACK_LOW_WATER_MS = 1_500;
const PIT_SUBTITLE_PLAYBACK_READY_MS = 6_000;
const PIT_SUBTITLE_BUFFER_TIMEOUT_MS = 10_000;
const PIT_SUBTITLE_BUFFER_POLL_MS = 50;
const PIT_SUBTITLE_RETRY_BASE_MS = 1_000;
const PIT_SUBTITLE_RETRY_MAX_MS = 15_000;
const PIT_SUBTITLE_MAX_BATCH_ITEMS = 5;
const PIT_SUBTITLE_TIMED_TEXT_WAIT_MS = 3_000;
const PIT_SUBTITLE_FETCH_TIMEOUT_MS = 8_000;
let PIT_SUBTITLE_FETCH_SEQUENCE = 0;

function initSubtitleTranslation() {
  if (disableStaleGlossContext() || !isYouTubeLocation()) {
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
    backgroundDrain: null,
    bufferGate: null,
    bufferGateSequence: 0,
    button: null,
    buttonAttempts: 0,
    captionObserver: null,
    captionObserverRoot: null,
    cues: [],
    enabled: false,
    generation: 0,
    inFlightCueIds: new Set(),
    lastCueId: "",
    nativeLine: null,
    nextJobSequence: 0,
    pendingJobs: [],
    queueEpoch: 0,
    queuedCueIds: new Set(),
    retryAfterByCueId: new Map(),
    retryAttemptsByCueId: new Map(),
    retryTimers: new Set(),
    scheduler: null,
    settings: null,
    sourceTrack: null,
    tracks: [],
    translations: new Map(),
    timedTextUrl: "",
    video: null,
    videoId: "",
    visibleDrain: null,
    wantsEnabled: false,
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
  const timedTextUrl = usableTimedTextUrl(payload?.timedTextUrl, videoId);
  if (timedTextUrl || videoChanged) {
    state.timedTextUrl = timedTextUrl;
  }
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
  const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
  if (!video) {
    throw new Error("YouTube video player is not ready.");
  }
  state.enabled = true;
  state.sourceTrack = track;
  state.generation += 1;
  const generation = state.generation;
  state.video = video;
  const bufferGate = beginSubtitleBufferGate(state, video, { hideCaptions: true });
  updateSubtitleButton("loading");
  window.dispatchEvent(new Event("pit:ensure-youtube-subtitles"));
  let subtitleUrl = state.timedTextUrl || track.baseUrl;
  let response = await requestYouTubeSubtitles(subtitleUrl);
  if (!response?.ok) {
    window.dispatchEvent(new Event("pit:ensure-youtube-subtitles"));
    const refreshedUrl = await waitForTimedTextUrl(state, generation, subtitleUrl);
    subtitleUrl = refreshedUrl || state.timedTextUrl || subtitleUrl;
    response = await requestYouTubeSubtitles(subtitleUrl);
  }
  if (!state.enabled || generation !== state.generation) return;
  if (!response?.ok) {
    throw new Error(response?.error || "Subtitle download failed.");
  }
  state.cues = parseYouTubeSubtitleEvents(response.subtitles);
  if (state.cues.length === 0) {
    throw new Error("This video has no readable subtitle cues.");
  }
  ensureSubtitleTranslationLine();
  state.settings = await readTranslationSettings();
  if (!state.enabled || generation !== state.generation) return;
  state.queueEpoch += 1;
  const queueEpoch = state.queueEpoch;
  state.video?.removeEventListener("seeking", handleSubtitleSeeking);
  state.video?.removeEventListener("seeked", handleSubtitleSeek);
  state.video = video;
  video.addEventListener("seeking", handleSubtitleSeeking);
  video.addEventListener("seeked", handleSubtitleSeek);
  const currentMs = Math.max(0, video.currentTime * 1000);
  scheduleSubtitleBuffer(currentMs, { forceWarm: true });
  const activeBufferGate = state.bufferGate || bufferGate;
  await waitForSubtitleBuffer(
    state,
    currentMs,
    currentMs + PIT_SUBTITLE_PLAYBACK_READY_MS,
    generation,
    queueEpoch
  );
  releaseSubtitleBufferGate(state, activeBufferGate);
  if (!state.enabled || generation !== state.generation || queueEpoch !== state.queueEpoch) return;
  window.clearInterval(state.scheduler);
  state.scheduler = window.setInterval(updateSubtitlePlayback, 250);
  updateSubtitleButton("active");
  updateSubtitlePlayback();
}

async function requestYouTubeSubtitles(url) {
  const pageResponse = await requestYouTubeSubtitlesFromPage(url);
  if (pageResponse?.ok) {
    return pageResponse;
  }
  try {
    const backgroundResponse = await chrome.runtime.sendMessage({
      type: "fetch-youtube-subtitles",
      url
    });
    return backgroundResponse?.ok ? backgroundResponse : (pageResponse || backgroundResponse);
  } catch {
    return pageResponse;
  }
}

function requestYouTubeSubtitlesFromPage(url) {
  const requestId = `pit-subtitle-${Date.now()}-${PIT_SUBTITLE_FETCH_SEQUENCE += 1}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("pit:youtube-subtitles-response", handleResponse);
      resolve(response);
    };
    const handleResponse = (event) => {
      let response;
      try {
        response = JSON.parse(String(event.detail || ""));
      } catch {
        return;
      }
      if (response?.requestId === requestId) {
        finish(response);
      }
    };
    const timeout = window.setTimeout(() => finish(null), PIT_SUBTITLE_FETCH_TIMEOUT_MS);
    window.addEventListener("pit:youtube-subtitles-response", handleResponse);
    window.dispatchEvent(new CustomEvent("pit:fetch-youtube-subtitles", {
      detail: JSON.stringify({ requestId, url })
    }));
  });
}

async function waitForTimedTextUrl(state, generation, previousUrl = "") {
  requestYouTubeCaptionTracks();
  const deadline = Date.now() + PIT_SUBTITLE_TIMED_TEXT_WAIT_MS;
  while (state.enabled && generation === state.generation && Date.now() < deadline) {
    if (state.timedTextUrl && state.timedTextUrl !== previousUrl) {
      return state.timedTextUrl;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return state.timedTextUrl !== previousUrl ? state.timedTextUrl : "";
}

function usableTimedTextUrl(value, videoId) {
  try {
    const url = new URL(String(value || ""));
    if (
      url.protocol !== "https:"
      || !["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(url.hostname.toLowerCase())
      || url.pathname !== "/api/timedtext"
      || (url.searchParams.get("v") && url.searchParams.get("v") !== videoId)
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
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

function scheduleSubtitleBuffer(currentMs, { forceWarm = false } = {}) {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled) return;
  const windowMs = subtitleBufferWindowMs(state);
  const hotStartMs = Math.max(0, currentMs - PIT_SUBTITLE_HOT_LOOK_BEHIND_MS);
  const hotEndMs = currentMs + windowMs.hotLookAheadMs;
  queueSubtitleRange(hotStartMs, hotEndMs, "visible");

  const targetEndMs = currentMs + windowMs.readyTargetMs;
  const readyEndMs = subtitleReadyEndMs(state, currentMs, targetEndMs);
  if (forceWarm || readyEndMs - currentMs <= windowMs.readyLowWaterMs) {
    queueSubtitleRange(hotEndMs, targetEndMs, "background");
  }
}

function subtitleBufferWindowMs(state) {
  const playbackRate = Number(state?.video?.playbackRate);
  const rateScale = Math.min(
    PIT_SUBTITLE_MAX_PLAYBACK_RATE_SCALE,
    Math.max(1, Number.isFinite(playbackRate) ? playbackRate : 1)
  );
  return {
    hotLookAheadMs: Math.round(PIT_SUBTITLE_HOT_LOOK_AHEAD_MS * rateScale),
    readyLowWaterMs: Math.round(PIT_SUBTITLE_READY_LOW_WATER_MS * rateScale),
    readyTargetMs: Math.round(PIT_SUBTITLE_READY_TARGET_MS * rateScale)
  };
}

function subtitleReadyEndMs(state, currentMs, targetEndMs) {
  for (const cue of state.cues) {
    if (cue.endMs < currentMs - 250) continue;
    if (cue.startMs > targetEndMs) break;
    if (!state.translations.has(cue.id)) {
      return Math.max(currentMs, cue.startMs);
    }
  }
  return targetEndMs;
}

function beginSubtitleBufferGate(
  state,
  video,
  { hideCaptions = false, replace = false } = {}
) {
  if (!state?.enabled || !video) return null;
  if (state.bufferGate && !replace) {
    if (hideCaptions) setSubtitleBufferVisibility(state.bufferGate, true);
    return state.bufferGate;
  }
  const replacedGate = state.bufferGate;
  if (replacedGate) {
    setSubtitleBufferVisibility(replacedGate, false);
    state.bufferGate = null;
  }
  const gate = {
    hideCaptions,
    id: state.bufferGateSequence += 1,
    player: video.closest(".html5-video-player") || document.querySelector(".html5-video-player"),
    shouldResume: Boolean(replacedGate?.shouldResume || !video.paused),
    video
  };
  state.bufferGate = gate;
  if (gate.shouldResume) video.pause();
  setSubtitleBufferVisibility(gate, hideCaptions);
  updateSubtitleButton("loading");
  return gate;
}

function setSubtitleBufferVisibility(gate, hidden) {
  if (!gate?.player) return;
  if (hidden) {
    gate.hideCaptions = true;
    gate.player.dataset.pitSubtitleBuffering = "true";
  } else {
    delete gate.player.dataset.pitSubtitleBuffering;
  }
}

function releaseSubtitleBufferGate(state, gate = state?.bufferGate) {
  if (!state || !gate || state.bufferGate !== gate) return;
  setSubtitleBufferVisibility(gate, false);
  state.bufferGate = null;
  if (gate.shouldResume && !gate.video.ended) {
    gate.video.play().catch(() => {});
  }
}

async function waitForSubtitleBuffer(
  state,
  currentMs,
  targetEndMs,
  generation,
  queueEpoch,
  timeoutMs = PIT_SUBTITLE_BUFFER_TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;
  while (
    state.enabled
    && generation === state.generation
    && queueEpoch === state.queueEpoch
    && Date.now() < deadline
  ) {
    if (subtitleReadyEndMs(state, currentMs, targetEndMs) >= targetEndMs) {
      return true;
    }
    scheduleSubtitleBuffer(currentMs, { forceWarm: true });
    await new Promise((resolve) => window.setTimeout(resolve, PIT_SUBTITLE_BUFFER_POLL_MS));
  }
  return false;
}

function queueSubtitleRange(startMs, endMs, priority) {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled || !state.settings) return;

  if (priority === "visible") {
    state.pendingJobs.forEach((job) => {
      if (
        job.priority === "background"
        && job.cues.some((cue) => cue.endMs >= startMs && cue.startMs <= endMs)
      ) {
        job.priority = "visible";
      }
    });
  }

  const cues = state.cues.filter((cue) => (
    cue.endMs >= startMs
    && cue.startMs <= endMs
    && !state.translations.has(cue.id)
    && !state.inFlightCueIds.has(cue.id)
    && !state.queuedCueIds.has(cue.id)
    && (state.retryAfterByCueId.get(cue.id) || 0) <= Date.now()
  ));
  const batches = buildTranslationBatches(
    cues,
    Math.min(PIT_SUBTITLE_MAX_BATCH_ITEMS, normalizeBatchItems(state.settings.batchSize)),
    normalizeBatchCharLimit(state.settings.batchCharLimit)
  );
  batches.forEach((batch) => {
    batch.forEach((cue) => state.queuedCueIds.add(cue.id));
    state.pendingJobs.push({
      cues: batch,
      epoch: state.queueEpoch,
      priority,
      sequence: state.nextJobSequence += 1
    });
  });
  sortPendingSubtitleJobs(state);
  startSubtitleDrains();
}

function sortPendingSubtitleJobs(state) {
  state.pendingJobs.sort((left, right) => {
    const priorityDifference = subtitlePriorityRank(left.priority) - subtitlePriorityRank(right.priority);
    if (priorityDifference !== 0) return priorityDifference;
    return left.cues[0].startMs - right.cues[0].startMs || left.sequence - right.sequence;
  });
}

function subtitlePriorityRank(priority) {
  return priority === "visible" ? 0 : 1;
}

function startSubtitleDrains() {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled) return;
  startSubtitleDrain("visible", "visibleDrain");
  startSubtitleDrain("background", "backgroundDrain");
}

function startSubtitleDrain(priority, drainKey) {
  const state = PIT_STATE.subtitle;
  if (
    !state?.enabled
    || state[drainKey]
    || !state.pendingJobs.some((job) => job.priority === priority)
  ) {
    return;
  }
  const drain = drainSubtitleJobs(priority).catch((error) => {
    if (state.enabled) showSubtitleError(error);
  });
  state[drainKey] = drain;
  drain.finally(() => {
    if (PIT_STATE.subtitle?.[drainKey] !== drain) return;
    PIT_STATE.subtitle[drainKey] = null;
    startSubtitleDrains();
  });
}

async function drainSubtitleJobs(priority) {
  const state = PIT_STATE.subtitle;
  while (state?.enabled) {
    const jobIndex = state.pendingJobs.findIndex((job) => job.priority === priority);
    if (jobIndex < 0) return;
    const [job] = state.pendingJobs.splice(jobIndex, 1);
    job.cues.forEach((cue) => {
      state.queuedCueIds.delete(cue.id);
      state.inFlightCueIds.add(cue.id);
    });
    try {
      await translateSubtitleBatch(job, state.generation);
      if (state.enabled && job.epoch === state.queueEpoch) {
        job.cues.forEach((cue) => {
          state.retryAfterByCueId.delete(cue.id);
          state.retryAttemptsByCueId.delete(cue.id);
        });
      }
    } catch (error) {
      if (disableStaleGlossContext()) return;
      if (state.enabled && job.epoch === state.queueEpoch) {
        deferSubtitleJobRetry(state, job, error);
      }
    } finally {
      job.cues.forEach((cue) => state.inFlightCueIds.delete(cue.id));
    }
  }
}

function deferSubtitleJobRetry(state, job, error) {
  const now = Date.now();
  let longestDelayMs = 0;
  job.cues.forEach((cue) => {
    if (state.translations.has(cue.id)) {
      state.retryAfterByCueId.delete(cue.id);
      state.retryAttemptsByCueId.delete(cue.id);
      return;
    }
    const attempts = (state.retryAttemptsByCueId.get(cue.id) || 0) + 1;
    const delayMs = Math.min(
      PIT_SUBTITLE_RETRY_MAX_MS,
      PIT_SUBTITLE_RETRY_BASE_MS * (2 ** Math.min(4, attempts - 1))
    );
    longestDelayMs = Math.max(longestDelayMs, delayMs);
    state.retryAttemptsByCueId.set(cue.id, attempts);
    state.retryAfterByCueId.set(cue.id, now + delayMs);
  });
  showSubtitleRetryState(error, longestDelayMs);
  scheduleSubtitleJobRetry(state, job, longestDelayMs);
}

function scheduleSubtitleJobRetry(state, job, delayMs) {
  if (delayMs <= 0) return;
  const generation = state.generation;
  const timer = window.setTimeout(() => {
    state.retryTimers.delete(timer);
    if (
      !state.enabled
      || generation !== state.generation
      || job.epoch !== state.queueEpoch
    ) {
      return;
    }
    const cues = job.cues.filter((cue) => (
      !state.translations.has(cue.id)
      && !state.inFlightCueIds.has(cue.id)
      && !state.queuedCueIds.has(cue.id)
    ));
    if (cues.length === 0) return;
    cues.forEach((cue) => state.queuedCueIds.add(cue.id));
    state.pendingJobs.push({
      cues,
      epoch: state.queueEpoch,
      priority: job.priority,
      sequence: state.nextJobSequence += 1
    });
    sortPendingSubtitleJobs(state);
    startSubtitleDrains();
  }, delayMs);
  state.retryTimers.add(timer);
}

function showSubtitleRetryState(error, delayMs) {
  const state = PIT_STATE.subtitle;
  if (!state?.button || delayMs <= 0) return;
  state.button.dataset.error = "true";
  const message = error instanceof Error ? error.message : String(error);
  state.button.title = `Subtitle batch delayed; retrying in ${Math.ceil(delayMs / 1000)}s · ${message}`;
  window.setTimeout(() => {
    if (!state.enabled || !state.button?.isConnected) return;
    state.button.dataset.error = "false";
    updateSubtitleButton(state.bufferGate ? "loading" : "active");
  }, Math.min(delayMs, 4_000));
}

async function translateSubtitleBatch(job, generation) {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled || generation !== state.generation || job.epoch !== state.queueEpoch) return;
  const settings = state.settings;
  const requestId = `${PIT_STATE.sessionId}-subtitle-${state.videoId}-${PIT_STATE.nextStreamRequestId++}`;
  state.activeRequestIds.add(requestId);
  PIT_STATE.translationRequestEndpoints.set(requestId, settings.endpoint || PIT_DEFAULT_ENDPOINT);
  PIT_STATE.translationStreams.set(requestId, (translation) => {
    if (
      !state.enabled
      || generation !== state.generation
      || job.epoch !== state.queueEpoch
      || !translation?.id
    ) {
      return false;
    }
    state.translations.set(translation.id, String(translation.text || ""));
    updateSubtitlePlayback();
    return true;
  });
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "translate-batch",
      items: job.cues.map((cue, index) => ({ id: cue.id, index, text: cue.text })),
      targetLanguage: settings.targetLanguage,
      endpoint: settings.endpoint,
      priority: job.priority,
      profile: "subtitle",
      contentKind: "subtitle",
      sourceUrl: location.href,
      requestId
    });
  } catch (error) {
    if (!state.enabled || generation !== state.generation || job.epoch !== state.queueEpoch) return;
    throw error;
  } finally {
    state.activeRequestIds.delete(requestId);
    PIT_STATE.translationStreams.delete(requestId);
    PIT_STATE.translationRequestEndpoints.delete(requestId);
  }
  if (!state.enabled || generation !== state.generation || job.epoch !== state.queueEpoch) return;
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

function updateSubtitlePlayback() {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled) return;
  const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
  if (!video) return;
  const currentMs = video.currentTime * 1000;
  scheduleSubtitleBuffer(currentMs);
  const cue = findSubtitleCue(state.cues, currentMs);
  renderSubtitleCue(cue);
  const readyEndMs = subtitleReadyEndMs(
    state,
    currentMs,
    currentMs + PIT_SUBTITLE_PLAYBACK_READY_MS
  );
  if (
    !state.bufferGate
    && !video.paused
    && readyEndMs - currentMs < PIT_SUBTITLE_PLAYBACK_LOW_WATER_MS
  ) {
    const gate = beginSubtitleBufferGate(state, video, {
      hideCaptions: Boolean(cue && !state.translations.has(cue.id))
    });
    const generation = state.generation;
    const queueEpoch = state.queueEpoch;
    scheduleSubtitleBuffer(currentMs, { forceWarm: true });
    waitForSubtitleBuffer(
      state,
      currentMs,
      currentMs + PIT_SUBTITLE_PLAYBACK_READY_MS,
      generation,
      queueEpoch
    ).finally(() => {
      releaseSubtitleBufferGate(state, gate);
      if (state.enabled && !state.bufferGate) updateSubtitleButton("active");
    });
  }
}

function handleSubtitleSeeking() {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled || !state.video) return;
  beginSubtitleBufferGate(state, state.video, { hideCaptions: true, replace: true });
}

function handleSubtitleSeek() {
  const state = PIT_STATE.subtitle;
  if (!state?.enabled || !state.video) return;
  // Match a media-player queue flush: a new epoch makes late results from the
  // previous playback position harmless even if cancellation races the reply.
  state.queueEpoch += 1;
  clearSubtitleRetryTimers(state);
  clearPendingSubtitleJobs(state);
  cancelActiveSubtitleRequests(state);
  state.inFlightCueIds.clear();
  const currentMs = Math.max(0, state.video.currentTime * 1000);
  const gate = beginSubtitleBufferGate(state, state.video, { hideCaptions: true });
  const generation = state.generation;
  const queueEpoch = state.queueEpoch;
  scheduleSubtitleBuffer(currentMs, { forceWarm: true });
  renderSubtitleCue(findSubtitleCue(state.cues, currentMs));
  waitForSubtitleBuffer(
    state,
    currentMs,
    currentMs + PIT_SUBTITLE_PLAYBACK_READY_MS,
    generation,
    queueEpoch
  ).finally(() => {
    releaseSubtitleBufferGate(state, gate);
    if (state.enabled && !state.bufferGate) updateSubtitleButton("active");
  });
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

function ensureSubtitleTranslationLine() {
  const state = PIT_STATE.subtitle;
  if (!state) return null;
  const captionContainer = document.querySelector(".ytp-caption-window-container");
  ensureSubtitleMutationObserver(state, captionContainer);
  const captionWindows = Array.from(
    captionContainer?.querySelectorAll(".caption-window") || []
  );
  const captionWindow = captionWindows.reverse().find((candidate) => (
    candidate.querySelector(".ytp-caption-segment:not(.pit-youtube-caption-translation)")
  ));
  const captionsText = captionWindow?.querySelector(".captions-text");
  if (!captionsText) {
    state.nativeLine?.host.remove();
    state.nativeLine = null;
    return null;
  }
  if (
    state.nativeLine?.host?.isConnected
    && state.nativeLine.captionsText === captionsText
  ) {
    syncNativeSubtitleStyle(state.nativeLine.translated, captionsText);
    return state.nativeLine;
  }

  state.nativeLine?.host.remove();
  const host = document.createElement("span");
  host.className = "caption-visual-line pit-youtube-caption-translation-line";
  host.dataset.pitSkip = "true";
  host.style.display = "block";
  const translated = document.createElement("span");
  translated.className = "ytp-caption-segment pit-youtube-caption-translation";
  translated.dataset.pitSkip = "true";
  translated.dir = "auto";
  host.appendChild(translated);
  captionsText.appendChild(host);
  syncNativeSubtitleStyle(translated, captionsText);
  state.nativeLine = { host, translated, captionsText };
  return state.nativeLine;
}

function ensureSubtitleMutationObserver(state, root) {
  if (!root || state.captionObserverRoot === root) return;
  state.captionObserver?.disconnect();
  const observer = new MutationObserver((mutations) => {
    if (!state.enabled || !mutations.some(isNativeSubtitleMutation)) return;
    const video = state.video || document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) return;
    renderSubtitleCue(findSubtitleCue(state.cues, video.currentTime * 1000));
  });
  observer.observe(root, { childList: true, subtree: true });
  state.captionObserver = observer;
  state.captionObserverRoot = root;
}

function isNativeSubtitleMutation(mutation) {
  const target = mutation.target?.nodeType === Node.ELEMENT_NODE
    ? mutation.target
    : mutation.target?.parentElement;
  if (target?.closest?.(".pit-youtube-caption-translation-line")) return false;
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return changedNodes.length === 0 || changedNodes.some((node) => !isGlossSubtitleNode(node));
}

function isGlossSubtitleNode(node) {
  if (node?.nodeType !== Node.ELEMENT_NODE) {
    return Boolean(node?.parentElement?.closest?.(".pit-youtube-caption-translation-line"));
  }
  return (
    node.matches(".pit-youtube-caption-translation-line")
    || node.closest(".pit-youtube-caption-translation-line") !== null
  );
}

function syncNativeSubtitleStyle(translated, captionsText) {
  const nativeSegments = captionsText.querySelectorAll(
    ".ytp-caption-segment:not(.pit-youtube-caption-translation)"
  );
  const nativeSegment = nativeSegments[nativeSegments.length - 1];
  if (!nativeSegment) return;
  translated.style.cssText = nativeSegment.style.cssText;
  translated.style.display = "inline-block";
  translated.style.whiteSpace = "pre-wrap";
  translated.style.lineHeight = "1.16";
  translated.style.overflowWrap = "break-word";

  const nativeFontSize = Number.parseFloat(nativeSegment.style.fontSize);
  if (Number.isFinite(nativeFontSize) && nativeFontSize > 0) {
    translated.style.fontSize = `${Math.round(nativeFontSize * 7.8) / 10}px`;
  }

  const host = translated.parentElement;
  const captionWindow = captionsText.closest(".caption-window");
  const player = captionsText.closest(".html5-video-player");
  const nativeWidth = Number.parseFloat(captionWindow?.style.width) || 0;
  const playerWidth = player?.clientWidth || 0;
  const translationWidth = Math.round(
    playerWidth > 0
      ? Math.min(960, Math.max(nativeWidth, playerWidth * 0.72))
      : Math.max(nativeWidth, 720)
  );
  host.style.position = "relative";
  host.style.left = "50%";
  host.style.width = "max-content";
  host.style.maxWidth = `${translationWidth}px`;
  host.style.transform = "translateX(-50%)";
  translated.style.maxWidth = `${translationWidth}px`;
}

function renderSubtitleCue(cue) {
  const state = PIT_STATE.subtitle;
  const nativeLine = ensureSubtitleTranslationLine();
  if (!state || !nativeLine) return;
  if (!cue) {
    state.lastCueId = "";
    nativeLine.translated.textContent = "";
    return;
  }
  const translation = state.translations.get(cue.id) || "";
  nativeLine.translated.textContent = translation;
  state.lastCueId = cue.id;
}

function stopSubtitleTranslation({ preservePreference = true } = {}) {
  const state = PIT_STATE.subtitle;
  if (!state) return;
  releaseSubtitleBufferGate(state);
  state.enabled = false;
  state.generation += 1;
  state.queueEpoch += 1;
  window.clearInterval(state.scheduler);
  state.scheduler = null;
  state.video?.removeEventListener("seeking", handleSubtitleSeeking);
  state.video?.removeEventListener("seeked", handleSubtitleSeek);
  state.video = null;
  state.captionObserver?.disconnect();
  state.captionObserver = null;
  state.captionObserverRoot = null;
  cancelActiveSubtitleRequests(state);
  clearPendingSubtitleJobs(state);
  state.inFlightCueIds.clear();
  state.visibleDrain = null;
  state.backgroundDrain = null;
  state.nativeLine?.host.remove();
  state.nativeLine = null;
  state.cues = [];
  state.translations.clear();
  state.retryAfterByCueId.clear();
  state.retryAttemptsByCueId.clear();
  clearSubtitleRetryTimers(state);
  state.settings = null;
  state.sourceTrack = null;
  state.timedTextUrl = "";
  if (!preservePreference) state.wantsEnabled = false;
  updateSubtitleButton();
}

function cancelActiveSubtitleRequests(state) {
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
    if (disableStaleGlossContext()) return;
    chrome.runtime.sendMessage({
      type: "cancel-translation",
      requestIds: endpointRequestIds,
      endpoint
    }).catch(() => {});
  });
  state.activeRequestIds.clear();
}

function clearPendingSubtitleJobs(state) {
  state.pendingJobs.forEach((job) => {
    job.cues.forEach((cue) => state.queuedCueIds.delete(cue.id));
  });
  state.pendingJobs = [];
  state.queuedCueIds.clear();
}

function clearSubtitleRetryTimers(state) {
  state.retryTimers.forEach((timer) => window.clearTimeout(timer));
  state.retryTimers.clear();
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
  if (disableStaleGlossContext()) return;
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
