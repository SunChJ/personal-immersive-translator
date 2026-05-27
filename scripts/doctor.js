#!/usr/bin/env node

const { execFileSync, spawnSync } = require("child_process");

let ok = true;

check("Node.js", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    throw new Error(`Node ${process.versions.node} found; Node 18+ is required.`);
  }
  return process.version;
});

check("Codex CLI", () => execFileSync("codex", ["--version"], { encoding: "utf8" }).trim());

check("Codex login", () => {
  const result = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  const status = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (!status.includes("Logged in")) {
    throw new Error(status || "Not logged in.");
  }
  return status;
});

process.exit(ok ? 0 : 1);

function check(name, fn) {
  try {
    console.log(`OK ${name}: ${fn()}`);
  } catch (error) {
    ok = false;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
