#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const packageJson = readJson(path.join(root, "package.json"));
const manifests = ["chrome-mv3", "safari-mv3"].map((target) => ({
  target,
  value: readJson(path.join(root, ".output", target, "manifest.json"))
}));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const safariProject = fs.readFileSync(
  path.join(root, "safari", "Gloss", "Gloss.xcodeproj", "project.pbxproj"),
  "utf8"
);

const version = packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version must use x.y.z semver, got ${version}`);
}

manifests.forEach(({ target, value }) => {
  if (value.version !== version) {
    fail(`${target} manifest version ${value.version} does not match package version ${version}`);
  }
});

if (!changelog.includes(`## ${version} - `)) {
  fail(`CHANGELOG.md is missing an entry for ${version}`);
}

const safariMarketingVersions = Array.from(
  safariProject.matchAll(/MARKETING_VERSION = ([^;]+);/g),
  (match) => match[1]
);
if (
  safariMarketingVersions.length === 0
  || safariMarketingVersions.some((value) => value !== version)
) {
  fail(`Safari Xcode marketing versions must all match package version ${version}`);
}

console.log(`OK version: ${version}`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}
