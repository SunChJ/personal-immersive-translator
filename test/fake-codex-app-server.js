#!/usr/bin/env node

const fs = require("node:fs");
const readline = require("node:readline");

let nextThreadId = 1;
let nextTurnId = 1;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  recordRequest(request);

  if (request.method === "initialize") {
    respond(request.id, {});
    return;
  }

  if (request.method === "thread/start") {
    respond(request.id, { thread: { id: `fake-thread-${nextThreadId++}` } });
    return;
  }

  if (["thread/delete", "turn/interrupt"].includes(request.method)) {
    respond(request.id, {});
    return;
  }

  if (request.method !== "turn/start") {
    respond(request.id, {});
    return;
  }

  const turnId = `fake-turn-${nextTurnId++}`;
  const prompt = request.params.input[0].text;
  const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
  const interrupted = input.items.some((item) => item.text === "interrupt this turn");
  const delayed = input.items.some((item) => item.text.startsWith("bounded concurrency "));
  const translations = input.items.map((item) => ({
    id: item.id,
    index: item.index,
    text: `translated:${item.text}`
  }));

  const started = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } });
  const completed = [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { turnId, delta: JSON.stringify({ translations }) }
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: turnId, status: interrupted ? "interrupted" : "completed" } }
    })
  ].join("\n") + "\n";

  if (delayed) {
    process.stdout.write(`${started}\n`);
    setTimeout(() => process.stdout.write(completed), 350);
  } else {
    process.stdout.write(`${started}\n${completed}`);
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function recordRequest(request) {
  const statsFile = process.env.PIT_FAKE_CODEX_STATS_FILE;
  if (!statsFile) {
    return;
  }
  fs.appendFileSync(statsFile, `${JSON.stringify({
    method: request.method,
    threadId: request.params?.threadId || null
  })}\n`);
}
