const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROUTE_PATCH = fs.readFileSync(
  path.join(__dirname, "..", "extension", "route-patch.js"),
  "utf8"
);

test("YouTube route patch publishes only the caption-track metadata needed by the extension", () => {
  const response = {
    videoDetails: { videoId: "video-123", title: "must not cross the world boundary" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
          languageCode: "en",
          name: { simpleText: "English" },
          kind: "asr",
          isTranslatable: true,
          extraPrivateData: "must not be published"
        }]
      }
    }
  };
  const { context, window } = createRuntime("www.youtube.com", response);
  let published;
  window.addEventListener("pit:youtube-caption-tracks", (event) => {
    published = JSON.parse(event.detail);
  });

  vm.runInContext(ROUTE_PATCH, context);

  assert.deepEqual(published, {
    videoId: "video-123",
    tracks: [{
      baseUrl: "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
      languageCode: "en",
      name: "English",
      kind: "asr",
      isTranslatable: true
    }],
    timedTextUrl: ""
  });
  assert.equal(JSON.stringify(published).includes("extraPrivateData"), false);
  assert.equal(JSON.stringify(published).includes("must not cross"), false);
});

test("YouTube route patch republishes POT-protected timed-text URLs", () => {
  const response = {
    videoDetails: { videoId: "video-123" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
          languageCode: "en",
          name: { simpleText: "English" },
          kind: "asr"
        }]
      }
    }
  };
  const { context, window, XMLHttpRequest } = createRuntime("www.youtube.com", response);
  const published = [];
  window.addEventListener("pit:youtube-caption-tracks", (event) => {
    published.push(JSON.parse(event.detail));
  });

  vm.runInContext(ROUTE_PATCH, context);
  const request = new XMLHttpRequest();
  request.open("GET", "https://www.youtube.com/api/timedtext?v=video-123&lang=en&pot=proof&potc=context");
  request.send();

  assert.equal(published.length, 2);
  assert.match(published[1].timedTextUrl, /pot=proof/);
  assert.match(published[1].timedTextUrl, /potc=context/);
});

test("YouTube route patch prefers the selected audio caption POT URL", () => {
  const response = {
    videoDetails: { videoId: "video-123" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
          languageCode: "en",
          vssId: ".en"
        }]
      }
    }
  };
  const audioCaptionTracks = [{
    url: "https://www.youtube.com/api/timedtext?v=video-123&lang=en&pot=audio-proof&potc=audio-context",
    vssId: ".en",
    kind: "asr"
  }];
  const { context, window } = createRuntime("www.youtube.com", response, {
    audioCaptionTracks,
    selectedTrack: { languageCode: "en", vssId: ".en" }
  });
  let published;
  window.addEventListener("pit:youtube-caption-tracks", (event) => {
    published = JSON.parse(event.detail);
  });

  vm.runInContext(ROUTE_PATCH, context);

  assert.match(published.timedTextUrl, /pot=audio-proof/);
  assert.match(published.timedTextUrl, /potc=audio-context/);
});

test("YouTube route patch retains a discovered POT URL across later player snapshots", () => {
  const response = {
    videoDetails: { videoId: "video-123" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
          languageCode: "en"
        }]
      }
    }
  };
  let audioCaptionTracks = [{
    url: "https://www.youtube.com/api/timedtext?v=video-123&lang=en&pot=retained-proof",
    vssId: ".en"
  }];
  const { context, window } = createRuntime("www.youtube.com", response, {
    audioCaptionTracks: () => audioCaptionTracks
  });
  const published = [];
  window.addEventListener("pit:youtube-caption-tracks", (event) => {
    published.push(JSON.parse(event.detail));
  });

  vm.runInContext(ROUTE_PATCH, context);
  audioCaptionTracks = [];
  window.dispatchEvent(new Event("pit:request-youtube-caption-tracks"));

  assert.equal(published.length, 2);
  assert.match(published[1].timedTextUrl, /pot=retained-proof/);
});

test("YouTube route patch fetches timed text in the page session", async () => {
  const response = {
    videoDetails: { videoId: "video-123" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
          languageCode: "en"
        }]
      }
    }
  };
  let requestedUrl = "";
  const { context, window } = createRuntime("www.youtube.com", response, {
    fetch: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ events: [{ tStartMs: 0, segs: [{ utf8: "Hello" }] }] })
      };
    }
  });
  let result;
  window.addEventListener("pit:youtube-subtitles-response", (event) => {
    result = JSON.parse(event.detail);
  });
  vm.runInContext(ROUTE_PATCH, context);

  window.dispatchEvent(new TestCustomEvent("pit:fetch-youtube-subtitles", {
    detail: JSON.stringify({
      requestId: "request-1",
      url: "https://www.youtube.com/api/timedtext?v=video-123&lang=en&pot=proof"
    })
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const normalized = new URL(requestedUrl);
  assert.equal(normalized.searchParams.get("fmt"), "json3");
  assert.equal(normalized.searchParams.get("pot"), "proof");
  assert.equal(result.requestId, "request-1");
  assert.equal(result.ok, true);
  assert.equal(result.subtitles.events[0].segs[0].utf8, "Hello");
});

test("route changes remain safe on non-YouTube pages", () => {
  const { context, history } = createRuntime("example.com", null);
  vm.runInContext(ROUTE_PATCH, context);
  assert.doesNotThrow(() => history.pushState({}, "", "/next"));
});

class TestCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

function createRuntime(hostname, playerResponse, options = {}) {
  class RuntimeCustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  }
  class TestXMLHttpRequest extends EventTarget {
    open(_method, url) {
      this.requestUrl = String(url);
    }

    send() {
      this.responseURL = this.requestUrl;
      this.dispatchEvent(new Event("load"));
    }
  }
  const window = new EventTarget();
  const document = new EventTarget();
  const history = {
    pushState() {},
    replaceState() {}
  };
  const player = playerResponse
    ? {
        getAudioTrack: () => ({
          captionTracks: typeof options.audioCaptionTracks === "function"
            ? options.audioCaptionTracks()
            : (options.audioCaptionTracks || [])
        }),
        getOption: () => options.selectedTrack || null,
        getPlayerResponse: () => playerResponse
      }
    : null;
  document.getElementById = (id) => (
    id === "movie_player" ? player : null
  );
  Object.assign(window, {
    clearTimeout() {},
    fetch: options.fetch,
    XMLHttpRequest: TestXMLHttpRequest,
    setInterval() { return 1; },
    setTimeout(callback) { callback(); return 1; }
  });
  const context = vm.createContext({
    Array,
    CustomEvent: RuntimeCustomEvent,
    Event,
    JSON,
    Map,
    Object,
    String,
    URL,
    XMLHttpRequest: TestXMLHttpRequest,
    document,
    history,
    location: { hostname },
    window
  });
  return { context, history, window, XMLHttpRequest: TestXMLHttpRequest };
}
