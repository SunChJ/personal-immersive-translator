// Runs in the page's MAIN world (see manifest.json), not the extension's isolated
// world, because only main-world code can intercept the page's own pushState/
// replaceState calls — the mechanism SPA routers use to change the URL without
// a native popstate event. Dispatches a DOM event that content-observers.js
// listens for from the isolated world.
(function () {
  if (window.__pitRoutePatched) {
    return;
  }
  window.__pitRoutePatched = true;

  ["pushState", "replaceState"].forEach((methodName) => {
    const original = history[methodName];
    history[methodName] = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event("pit:route-change"));
      if (isYouTubePage()) {
        scheduleYouTubeTrackPublish();
      }
      return result;
    };
  });

  if (!isYouTubePage()) {
    return;
  }

  let lastTrackSignature = "";
  let lastCaptionPayload = null;
  let publishTimer = null;
  const timedTextUrlCache = new Map();

  observeYouTubeTimedTextRequests();

  window.addEventListener("pit:request-youtube-caption-tracks", () => {
    publishYouTubeCaptionTracks(true);
  });
  window.addEventListener("pit:ensure-youtube-subtitles", ensureYouTubeSubtitlesEnabled);
  window.addEventListener("pit:fetch-youtube-subtitles", fetchYouTubeSubtitles);
  window.addEventListener("popstate", scheduleYouTubeTrackPublish);
  document.addEventListener("yt-navigate-finish", scheduleYouTubeTrackPublish);
  window.setInterval(() => publishYouTubeCaptionTracks(false), 1500);
  scheduleYouTubeTrackPublish();

  function scheduleYouTubeTrackPublish() {
    window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(() => publishYouTubeCaptionTracks(true), 100);
  }

  function publishYouTubeCaptionTracks(force) {
    const player = document.getElementById("movie_player");
    const response = player?.getPlayerResponse?.();
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const videoId = String(response?.videoDetails?.videoId || "");
    if (!videoId) {
      return;
    }
    const safeTracks = (Array.isArray(tracks) ? tracks : []).flatMap((track) => {
      const baseUrl = String(track?.baseUrl || "");
      const languageCode = String(track?.languageCode || "");
      if (!baseUrl || !languageCode) {
        return [];
      }
      const name = String(
        track?.name?.simpleText
        || track?.name?.runs?.map((run) => run?.text || "").join("")
        || languageCode
      );
      return [{
        baseUrl,
        languageCode,
        name,
        kind: String(track?.kind || ""),
        isTranslatable: track?.isTranslatable === true
      }];
    });
    const playerUrl = playerTimedTextUrl(player, videoId);
    if (playerUrl) {
      timedTextUrlCache.set(videoId, playerUrl);
    }
    const payload = {
      videoId,
      tracks: safeTracks,
      timedTextUrl: timedTextUrlCache.get(videoId) || ""
    };
    lastCaptionPayload = payload;
    publishCaptionPayload(payload, force);
  }

  function publishCaptionPayload(payload, force) {
    const signature = JSON.stringify(payload);
    if (!force && signature === lastTrackSignature) {
      return;
    }
    lastTrackSignature = signature;
    window.dispatchEvent(new CustomEvent("pit:youtube-caption-tracks", { detail: signature }));
  }

  function observeYouTubeTimedTextRequests() {
    const xhr = window.XMLHttpRequest;
    if (!xhr?.prototype || xhr.prototype.__pitTimedTextObserved) {
      return;
    }
    const originalOpen = xhr.prototype.open;
    const originalSend = xhr.prototype.send;
    if (typeof originalOpen !== "function" || typeof originalSend !== "function") {
      return;
    }
    Object.defineProperty(xhr.prototype, "__pitTimedTextObserved", {
      configurable: true,
      value: true
    });
    xhr.prototype.open = function (method, url, ...args) {
      this.__pitTimedTextRequestUrl = String(url || "");
      return originalOpen.call(this, method, url, ...args);
    };
    xhr.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        cacheTimedTextUrl(this.responseURL || this.__pitTimedTextRequestUrl);
      }, { once: true });
      return originalSend.apply(this, args);
    };
  }

  function cacheTimedTextUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      return;
    }
    if (url.pathname !== "/api/timedtext" || !url.searchParams.has("pot")) {
      return;
    }
    const videoId = String(url.searchParams.get("v") || "");
    if (!videoId) {
      return;
    }
    const normalized = url.toString();
    timedTextUrlCache.set(videoId, normalized);
    if (lastCaptionPayload?.videoId === videoId) {
      lastCaptionPayload = { ...lastCaptionPayload, timedTextUrl: normalized };
      publishCaptionPayload(lastCaptionPayload, true);
    } else {
      scheduleYouTubeTrackPublish();
    }
  }

  function playerTimedTextUrl(player, videoId) {
    const audioTracks = player?.getAudioTrack?.()?.captionTracks;
    if (!Array.isArray(audioTracks)) {
      return "";
    }
    const selectedTrack = player?.getOption?.("captions", "track");
    const candidates = audioTracks.flatMap((track) => {
      try {
        const url = new URL(String(track?.url || ""));
        if (
          url.protocol !== "https:"
          || !["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(url.hostname.toLowerCase())
          || url.pathname !== "/api/timedtext"
          || !url.searchParams.has("pot")
          || (url.searchParams.get("v") && url.searchParams.get("v") !== videoId)
        ) {
          return [];
        }
        return [{
          url: url.toString(),
          vssId: String(track?.vssId || ""),
          languageCode: String(url.searchParams.get("lang") || ""),
          kind: String(track?.kind || "")
        }];
      } catch {
        return [];
      }
    });
    const selectedVssId = String(selectedTrack?.vssId || selectedTrack?.vss_id || "");
    const selectedLanguage = String(selectedTrack?.languageCode || "");
    const selectedKind = String(selectedTrack?.kind || selectedTrack?.trackKind || "");
    return (
      candidates.find((track) => selectedVssId && track.vssId === selectedVssId)
      || candidates.find((track) => (
        selectedLanguage
        && track.languageCode === selectedLanguage
        && (!selectedKind || track.kind === selectedKind)
      ))
      || candidates.find((track) => selectedLanguage && track.languageCode === selectedLanguage)
      || candidates[0]
    )?.url || "";
  }

  function ensureYouTubeSubtitlesEnabled() {
    const button = document.querySelector?.(".ytp-subtitles-button");
    if (button?.getAttribute("aria-pressed") === "true") {
      return;
    }
    const player = document.querySelector?.(".html5-video-player");
    if (typeof player?.toggleSubtitles === "function") {
      player.toggleSubtitles();
    } else if (typeof button?.click === "function" && !button.disabled) {
      button.click();
    }
  }

  async function fetchYouTubeSubtitles(event) {
    let request;
    try {
      request = JSON.parse(String(event.detail || ""));
    } catch {
      return;
    }
    const requestId = String(request?.requestId || "");
    if (!requestId) {
      return;
    }
    try {
      const url = normalizedTimedTextUrl(request?.url);
      const response = await window.fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`YouTube subtitle request failed (${response.status}).`);
      }
      const subtitles = await response.json();
      publishSubtitleResponse({ requestId, ok: true, subtitles });
    } catch (error) {
      publishSubtitleResponse({
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Subtitle download failed."
      });
    }
  }

  function normalizedTimedTextUrl(value) {
    const url = new URL(String(value || ""));
    if (
      url.protocol !== "https:"
      || !["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(url.hostname.toLowerCase())
      || url.pathname !== "/api/timedtext"
    ) {
      throw new Error("Unsupported YouTube subtitle URL.");
    }
    url.searchParams.set("fmt", "json3");
    url.searchParams.set("xorb", "2");
    url.searchParams.set("xobt", "3");
    url.searchParams.set("xovt", "3");
    url.searchParams.set("c", "WEB");
    url.searchParams.set("cplayer", "UNIPLAYER");
    return url.toString();
  }

  function publishSubtitleResponse(payload) {
    window.dispatchEvent(new CustomEvent("pit:youtube-subtitles-response", {
      detail: JSON.stringify(payload)
    }));
  }

  function isYouTubePage() {
    return ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(location.hostname.toLowerCase());
  }
})();
