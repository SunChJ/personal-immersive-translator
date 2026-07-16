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
    }]
  });
  assert.equal(JSON.stringify(published).includes("extraPrivateData"), false);
  assert.equal(JSON.stringify(published).includes("must not cross"), false);
});

test("route changes remain safe on non-YouTube pages", () => {
  const { context, history } = createRuntime("example.com", null);
  vm.runInContext(ROUTE_PATCH, context);
  assert.doesNotThrow(() => history.pushState({}, "", "/next"));
});

function createRuntime(hostname, playerResponse) {
  class TestCustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  }
  const window = new EventTarget();
  const document = new EventTarget();
  const history = {
    pushState() {},
    replaceState() {}
  };
  document.getElementById = (id) => (
    id === "movie_player" && playerResponse
      ? { getPlayerResponse: () => playerResponse }
      : null
  );
  Object.assign(window, {
    clearTimeout() {},
    setInterval() { return 1; },
    setTimeout(callback) { callback(); return 1; }
  });
  const context = vm.createContext({
    Array,
    CustomEvent: TestCustomEvent,
    Event,
    JSON,
    String,
    document,
    history,
    location: { hostname },
    window
  });
  return { context, history, window };
}
