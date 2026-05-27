#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const packageJson = readJson(path.join(root, "package.json"));
const manifestJson = readJson(path.join(root, "extension", "manifest.json"));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

const version = packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version must use x.y.z semver, got ${version}`);
}

if (manifestJson.version !== version) {
  fail(`manifest version ${manifestJson.version} does not match package version ${version}`);
}

if (!changelog.includes(`## ${version} - `)) {
  fail(`CHANGELOG.md is missing an entry for ${version}`);
}

console.log(`OK version: ${version}`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}
