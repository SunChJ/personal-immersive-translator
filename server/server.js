#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_TARGET_LANGUAGE = "Chinese (Simplified)";
const TRANSLATOR_BACKEND = (process.env.TRANSLATOR_BACKEND || "codex-app").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.3-codex-spark";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 120000);
const CODEX_PREWARM = process.env.CODEX_PREWARM !== "0";
const SCHEMA_PATH = path.join(__dirname, "translation.schema.json");
const TRANSLATION_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const CACHE_LIMIT = Number(process.env.TRANSLATION_CACHE_LIMIT || 1200);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const translationCache = new Map();
let codexAppClient = null;

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, {
        ok: TRANSLATOR_BACKEND.startsWith("codex") ? true : Boolean(OPENAI_API_KEY),
        backend: TRANSLATOR_BACKEND,
        model: TRANSLATOR_BACKEND.startsWith("codex") ? CODEX_MODEL : OPENAI_MODEL,
        hasApiKey: Boolean(OPENAI_API_KEY),
        cacheSize: translationCache.size,
        warm: codexAppClient ? codexAppClient.warm : null,
        lastLatencyMs: codexAppClient ? codexAppClient.lastLatencyMs : null
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/translate") {
      if (!TRANSLATOR_BACKEND.startsWith("codex") && !OPENAI_API_KEY) {
        writeJson(res, 500, {
          error: "OPENAI_API_KEY is not set in the local proxy environment."
        });
        return;
      }

      const body = await readJson(req);
      const items = validateItems(body.items || body.texts);
      const texts = items.map((item) => item.text);
      const targetLanguage = String(body.targetLanguage || DEFAULT_TARGET_LANGUAGE).trim() || DEFAULT_TARGET_LANGUAGE;
      const requestId = createRequestId();
      const startedAt = Date.now();
      logInfo(`[${requestId}] translate start: ${items.length} items -> ${targetLanguage}`);

      const translations = await translateItems({ items, targetLanguage, requestId });
      logInfo(`[${requestId}] translate done: ${translations.length} items in ${Date.now() - startedAt}ms`);
      writeJson(res, 200, { translations });
      return;
    }

    writeJson(res, 404, { error: "Not found." });
  } catch (error) {
    logError(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    logError(`port ${PORT} is already in use. The translator server may already be running.`);
    logError(`open http://127.0.0.1:${PORT}/health to check it, or close the old server window and start again.`);
    process.exit(1);
  }

  logError(error.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  logInfo(`server listening: http://127.0.0.1:${PORT}`);
  logInfo(`backend: ${TRANSLATOR_BACKEND}`);
  logInfo(`model: ${TRANSLATOR_BACKEND.startsWith("codex") ? CODEX_MODEL : OPENAI_MODEL}`);

  if (TRANSLATOR_BACKEND === "codex-app") {
    codexAppClient = new CodexAppClient();
  }

  if (codexAppClient && CODEX_PREWARM) {
    logInfo("prewarm start");
    codexAppClient.prewarm().catch((error) => {
      logError(`prewarm failed: ${error.message}`);
    });
  }
});

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function translateItems({ items, targetLanguage, requestId }) {
  const result = new Array(items.length);
  const missing = [];
  const missingIndexes = [];

  items.forEach((item, index) => {
    const key = cacheKey(targetLanguage, item.text);
    if (translationCache.has(key)) {
      result[index] = { id: item.id, text: translationCache.get(key) };
      return;
    }

    missing.push({ ...item, index: missing.length });
    missingIndexes.push(index);
  });

  const cacheHits = items.length - missing.length;
  logInfo(`[${requestId}] cache: ${cacheHits} hit, ${missing.length} miss`);

  if (missing.length > 0) {
    const translated = await translateItemsViaBackend({ items: missing, targetLanguage, requestId });
    translated.forEach((translation, index) => {
      const sourceItem = missing[index];
      const originalIndex = missingIndexes[index];
      result[originalIndex] = { id: sourceItem.id, text: translation.text };
      rememberTranslation(cacheKey(targetLanguage, sourceItem.text), translation.text);
    });
  }

  return result;
}

async function translateItemsViaBackend({ items, targetLanguage, requestId }) {
  if (TRANSLATOR_BACKEND === "codex-app") {
    if (!codexAppClient) {
      codexAppClient = new CodexAppClient();
    }
    return codexAppClient.translate({ items, targetLanguage, requestId });
  }

  if (TRANSLATOR_BACKEND === "codex") {
    return translateItemsWithCodex({ items, targetLanguage, requestId });
  }

  return translateItemsWithOpenAI({ items, targetLanguage, requestId });
}

function cacheKey(targetLanguage, text) {
  return `${targetLanguage}\u0000${text}`;
}

function rememberTranslation(key, value) {
  if (translationCache.size >= CACHE_LIMIT) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(key, value);
}

class CodexAppClient {
  constructor() {
    this.activeTurns = new Map();
    this.buffer = "";
    this.child = null;
    this.lastLatencyMs = null;
    this.nextId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.readyPromise = null;
    this.recentStderr = "";
    this.threadId = null;
    this.warm = false;
  }

  async prewarm() {
    await this.translate({
      items: [{ id: "warmup", index: 0, tag: "p", path: "warmup", text: "warmup" }],
      targetLanguage: DEFAULT_TARGET_LANGUAGE,
      requestId: "warmup"
    });
    this.warm = true;
    logInfo(`prewarm done: ${this.lastLatencyMs}ms`);
  }

  translate({ items, targetLanguage, requestId }) {
    const task = () => this.runTranslationTurn({ items, targetLanguage, requestId });
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  async ensureReady() {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.start();
    return this.readyPromise;
  }

  async start() {
    logInfo("codex app-server starting");
    this.child = spawn(
      CODEX_BIN,
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "model_reasoning_summary='none'",
        "-c",
        "model_reasoning_effort='low'"
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      }
    );

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.recentStderr = `${this.recentStderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => {
      this.failAll(new Error(`Codex app-server exited with code ${code}. ${this.recentStderr}`));
      logWarn(`codex app-server exited: code ${code}`);
      this.child = null;
      this.readyPromise = null;
      this.threadId = null;
      this.warm = false;
    });

    await this.request("initialize", {
      clientInfo: { name: "personal-immersive-translator", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: ["mcpServer/startupStatus/updated"]
      }
    });

    const response = await this.request("thread/start", {
      model: CODEX_MODEL,
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions:
        "You are a deterministic webpage translation engine. Return final answers only as strict JSON matching the requested schema."
    });

    this.threadId = response.result.thread.id;
    logInfo(`codex app-server ready: thread ${this.threadId}`);
  }

  async runTranslationTurn({ items, targetLanguage, requestId }) {
    await this.ensureReady();

    const startedAt = Date.now();
    logInfo(`[${requestId}] codex turn start: ${items.length} cache misses`);
    const prompt = [
      `Translate each item into ${targetLanguage}.`,
      "Preserve names, numbers, code-like tokens, links, and formatting intent.",
      "Return only JSON matching the schema.",
      "Each translation object must keep the exact same id and index as the input item.",
      "Do not add, remove, split, merge, or reorder items.",
      JSON.stringify({ targetLanguage, items })
    ].join("\n");

    const response = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: CODEX_MODEL,
      effort: "low",
      summary: "none",
      outputSchema: TRANSLATION_SCHEMA
    });

    const turnId = response.result.turn.id;
    const outputText = await this.waitForTurn(turnId, CODEX_TIMEOUT_MS);
    this.lastLatencyMs = Date.now() - startedAt;
    logInfo(`[${requestId}] codex turn done: ${this.lastLatencyMs}ms`);
    const parsed = parseModelJson(outputText);

    if (!Array.isArray(parsed.translations)) {
      throw new Error("Codex app-server output did not include translations array.");
    }

    return normalizeTranslations(parsed.translations, items, "Codex app-server", requestId);
  }

  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        reject(new Error("Codex app-server is not running."));
        return;
      }

      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request ${method} timed out.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  waitForTurn(turnId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.activeTurns.delete(turnId);
        reject(new Error(`Codex app-server turn timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.activeTurns.set(turnId, {
        text: "",
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString("utf8");

    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const turn = this.activeTurns.get(message.params.turnId);
      if (turn) {
        turn.text += message.params.delta || "";
      }
      return;
    }

    if (message.method === "item/completed" && message.params.item?.type === "agentMessage") {
      const turn = this.activeTurns.get(message.params.turnId);
      if (turn && !turn.text) {
        turn.text = message.params.item.text || "";
      }
      return;
    }

    if (message.method === "turn/completed") {
      const turn = this.activeTurns.get(message.params.turn.id);
      if (!turn) {
        return;
      }

      this.activeTurns.delete(message.params.turn.id);
      if (message.params.turn.status === "failed") {
        turn.reject(new Error(message.params.turn.error?.message || "Codex app-server turn failed."));
      } else {
        turn.resolve(turn.text);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    for (const turn of this.activeTurns.values()) {
      turn.reject(error);
    }
    this.activeTurns.clear();
  }
}

async function translateItemsWithCodex({ items, targetLanguage, requestId }) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pit-codex-"));
  const outputPath = path.join(tempDir, "translation.json");
  const prompt = [
    "You are a deterministic webpage translation engine.",
    `Translate each item into ${targetLanguage}.`,
    "Preserve names, numbers, code-like tokens, links, and formatting intent.",
    "Return only JSON matching the provided schema.",
    "Each translation object must keep the exact same id and index as the input item.",
    "Do not add, remove, split, merge, or reorder items.",
    "",
    JSON.stringify({ targetLanguage, items })
  ].join("\n");

  try {
    const args = [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "-c",
      "model_reasoning_summary='none'",
      "-c",
      "model_reasoning_effort='low'",
      "--output-schema",
      SCHEMA_PATH,
      "-o",
      outputPath,
      "-m",
      CODEX_MODEL,
      "-"
    ];

    logInfo(`[${requestId}] codex exec start: ${items.length} cache misses`);
    const startedAt = Date.now();
    const { stdout, stderr } = await runProcess(CODEX_BIN, args, prompt, CODEX_TIMEOUT_MS);
    logInfo(`[${requestId}] codex exec done: ${Date.now() - startedAt}ms`);
    const outputText = await readOutputText(outputPath, stdout);
    const parsed = parseModelJson(outputText);

    if (!Array.isArray(parsed.translations)) {
      throw new Error("Codex output did not include translations array.");
    }

    return normalizeTranslations(parsed.translations, items, "Codex", requestId);
  } finally {
    fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function translateItemsWithOpenAI({ items, targetLanguage, requestId }) {
  logInfo(`[${requestId}] openai api start: ${items.length} cache misses`);
  const startedAt = Date.now();
  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content:
            "You are a precise webpage translation engine. Translate each input item into the target language. Preserve names, numbers, code-like tokens, links, and formatting intent. Return only strict JSON with this shape: {\"translations\":[{\"id\":\"pit-abc-000001\",\"index\":0,\"text\":\"...\"}]}. Each translation object must keep the exact same id and index as the input item. Do not add, remove, split, merge, or reorder items."
        },
        {
          role: "user",
          content: JSON.stringify({
            targetLanguage,
            items
          })
        }
      ]
    })
  });

  const responseText = await response.text();
  logInfo(`[${requestId}] openai api done: ${Date.now() - startedAt}ms`);
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`OpenAI returned non-JSON response: ${responseText.slice(0, 240)}`);
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenAI API failed with HTTP ${response.status}`);
  }

  const outputText = extractOutputText(payload);
  const parsed = parseModelJson(outputText);

  if (!Array.isArray(parsed.translations)) {
    throw new Error("Model output did not include translations array.");
  }

  return normalizeTranslations(parsed.translations, items, "Model", requestId);
}

function normalizeTranslations(translations, items, source, requestId = "unknown") {
  if (translations.every((item) => item && typeof item === "object" && item.id)) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const result = items.map((item) => ({ id: item.id, text: item.text }));
    const seen = new Set();

    translations.forEach((translation) => {
      const original = byId.get(translation.id);
      if (!original || seen.has(translation.id)) {
        logWarn(`[${requestId}] ${source} returned unknown or duplicate id ${translation.id}; ignoring item`);
        return;
      }

      seen.add(translation.id);
      result[original.index] = { id: original.id, text: String(translation.text || original.text) };
    });

    if (seen.size !== items.length) {
      logWarn(`[${requestId}] ${source} returned ${seen.size}/${items.length} id-matched translations; filling missing items`);
    }

    return result;
  }

  logWarn(`[${requestId}] ${source} returned legacy positional translations; using best-effort alignment`);

  if (translations.length === items.length) {
    return translations.map((translation, index) => ({
      id: items[index].id,
      text: String(translation?.text || translation)
    }));
  }

  if (translations.length > items.length) {
    logWarn(`[${requestId}] ${source} returned ${translations.length} translations for ${items.length} inputs; trimming extras`);
    return translations.slice(0, items.length).map((translation, index) => ({
      id: items[index].id,
      text: String(translation?.text || translation)
    }));
  }

  logWarn(`[${requestId}] ${source} returned ${translations.length} translations for ${items.length} inputs; filling missing items`);
  return items.map((item, index) => ({
    id: item.id,
    text: String(translations[index]?.text || translations[index] || item.text)
  }));
}

function createRequestId() {
  return Math.random().toString(36).slice(2, 8);
}

function logInfo(message) {
  if (["debug", "info"].includes(LOG_LEVEL)) {
    console.log(`${timestamp()} INFO  ${message}`);
  }
}

function logWarn(message) {
  if (["debug", "info", "warn"].includes(LOG_LEVEL)) {
    console.warn(`${timestamp()} WARN  ${message}`);
  }
}

function logError(message) {
  console.error(`${timestamp()} ERROR ${message}`);
}

function timestamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function runProcess(command, args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`.slice(0, 1200)));
        return;
      }

      resolve({ stdout, stderr });
    });

    child.stdin.end(stdin);
  });
}

async function readOutputText(outputPath, stdout) {
  try {
    const fileText = await fs.promises.readFile(outputPath, "utf8");
    if (fileText.trim()) {
      return fileText;
    }
  } catch {
    // Fall back to stdout below.
  }

  return stdout;
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const fragments = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        fragments.push(content.text);
      }
    }
  }

  const text = fragments.join("\n").trim();
  if (!text) {
    throw new Error("OpenAI response did not contain output text.");
  }
  return text;
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Model did not return JSON: ${text.slice(0, 240)}`);
    }
    return JSON.parse(match[0]);
  }
}

function validateItems(value) {
  if (!Array.isArray(value)) {
    throw new Error("items must be an array.");
  }

  if (value.length === 0 || value.length > 40) {
    throw new Error("items must contain between 1 and 40 items.");
  }

  return value.map((item, index) => {
    if (item && typeof item === "object") {
      return {
        id: String(item.id || `legacy-${index}`),
        index,
        tag: String(item.tag || ""),
        path: String(item.path || ""),
        text: String(item.text || "").slice(0, 4000)
      };
    }

    return {
      id: `legacy-${index}`,
      index,
      tag: "",
      path: "",
      text: String(item).slice(0, 4000)
    };
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}
