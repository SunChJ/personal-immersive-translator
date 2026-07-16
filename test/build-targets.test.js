const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

test("WXT emits distinct Chrome and Safari MV3 manifests", () => {
  const chrome = readTarget("chrome-mv3");
  const safari = readTarget("safari-mv3");
  const chromeMain = chrome.manifest.content_scripts.find((script) => script.world === "MAIN");
  const safariMain = safari.manifest.content_scripts.find((script) => script.world === "MAIN");

  assert.equal(chrome.manifest.manifest_version, 3);
  assert.equal(safari.manifest.manifest_version, 3);
  assert.deepEqual(chromeMain?.js, ["route-patch.js"]);
  assert.deepEqual(safariMain?.js, ["route-patch.js"]);
  assert.equal(safariMain?.run_at, "document_start");
  assert.equal(chrome.manifest.permissions.includes("nativeMessaging"), false);
  assert.equal(safari.manifest.permissions.includes("nativeMessaging"), true);
  assert.equal(chrome.manifest.host_permissions.includes("https://www.youtube.com/api/timedtext*"), true);
  assert.equal(safari.manifest.host_permissions.includes("https://www.youtube.com/api/timedtext*"), true);
  assert.equal(
    chrome.manifest.content_scripts.some((script) => script.js.includes("content-subtitles.js")),
    true
  );
  assert.equal(
    safari.manifest.content_scripts.some((script) => script.js.includes("content-subtitles.js")),
    true
  );
  assert.match(chrome.configuration, /GLOSS_BROWSER_TARGET=`chrome`/);
  assert.match(safari.configuration, /GLOSS_BROWSER_TARGET=`safari`/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8"),
    /PIT_BROWSER_TARGET === "safari"[\s\S]*translateSubtitles[\s\S]*hidden/
  );

  const safariProject = fs.readFileSync(
    path.join(ROOT, "safari", "Gloss", "Gloss.xcodeproj", "project.pbxproj"),
    "utf8"
  );
  const safariContentScripts = safari.manifest.content_scripts.flatMap((script) => script.js);
  safariContentScripts.forEach((file) => {
    assert.equal(
      safariProject.includes(`${file} in Resources`),
      true,
      `${file} must be copied into the Safari extension bundle`
    );
  });

  for (const size of [16, 32, 48, 96, 128, 256, 512]) {
    assert.equal(fs.existsSync(path.join(safari.directory, `icon-${size}.png`)), true);
  }
});

function readTarget(target) {
  const directory = path.join(ROOT, ".output", target);
  return {
    directory,
    manifest: JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")),
    configuration: fs.readFileSync(path.join(directory, "gloss-config.js"), "utf8")
  };
}
