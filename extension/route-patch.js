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
  let publishTimer = null;

  window.addEventListener("pit:request-youtube-caption-tracks", () => {
    publishYouTubeCaptionTracks(true);
  });
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
    const payload = { videoId, tracks: safeTracks };
    const signature = JSON.stringify(payload);
    if (!force && signature === lastTrackSignature) {
      return;
    }
    lastTrackSignature = signature;
    window.dispatchEvent(new CustomEvent("pit:youtube-caption-tracks", { detail: signature }));
  }

  function isYouTubePage() {
    return ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(location.hostname.toLowerCase());
  }
})();
