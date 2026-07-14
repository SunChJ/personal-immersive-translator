const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BACKGROUND_PATH = path.join(__dirname, "..", "extension", "background.js");
const PAIRING_TOKEN = "a".repeat(43);

test("Safari obtains and stores its pairing token through native messaging", async () => {
  const runtime = createRuntime({ nativeToken: PAIRING_TOKEN });

  assert.equal(await runtime.readPairingToken(), PAIRING_TOKEN);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.nativeMessages)), [{
    application: "com.samsoncj.gloss",
    message: { type: "pairing-token" }
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.storedValues)), [{ pairingToken: PAIRING_TOKEN }]);
});

test("Safari reuses a stored token without native messaging", async () => {
  const runtime = createRuntime({ storedToken: PAIRING_TOKEN });

  assert.equal(await runtime.readPairingToken(), PAIRING_TOKEN);
  assert.equal(runtime.nativeMessages.length, 0);
});

test("Safari pairing failure remains unauthenticated", async () => {
  const runtime = createRuntime({ nativeError: new Error("Gloss is unavailable") });

  assert.equal(await runtime.readPairingToken(), "");
  assert.equal(runtime.storedValues.length, 0);
});

function createRuntime({ nativeError, nativeToken = "", storedToken = "" }) {
  const nativeMessages = [];
  const storedValues = [];
  const event = { addListener() {} };
  const context = vm.createContext({
    URL,
    clearTimeout() {},
    console,
    importScripts() {},
    setTimeout,
    chrome: {
      runtime: {
        onMessage: event,
        async sendNativeMessage(application, message) {
          nativeMessages.push({ application, message });
          if (nativeError) throw nativeError;
          return { pairingToken: nativeToken };
        }
      },
      storage: {
        local: {
          async get() {
            return { pairingToken: storedToken };
          },
          async set(value) {
            storedValues.push(value);
          }
        }
      },
      tabs: {
        onRemoved: event,
        onUpdated: event
      }
    },
    normalizePairingToken(value) {
      return String(value || "").trim();
    },
    PIT_BROWSER_TARGET: "safari",
    PIT_DEFAULT_PAIRING_TOKEN: ""
  });

  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, "utf8"), context, {
    filename: BACKGROUND_PATH
  });

  return {
    nativeMessages,
    storedValues,
    readPairingToken: context.readPairingToken
  };
}
