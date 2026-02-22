require("dotenv").config();

const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadSavedAuth, saveAuth, promptAuthInteractive } = require("./authStore.js");

const PORT = Number(process.env.PORT || 3000);
const LOG_FILE = process.env.LOG_FILE || path.resolve(process.cwd(), "gateway.debug.log");
const LOG_DEEPSEEK_RAW = String(process.env.LOG_DEEPSEEK_RAW || "true").toLowerCase() === "true";
const LOG_DEEPSEEK_RAW_MAX_CHARS = Number(process.env.LOG_DEEPSEEK_RAW_MAX_CHARS || 4000);

let DeepSeekWebClientCtor = null;
let client = null;
let chatSessionId = "";
let parentMessageId = undefined;

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {}
}

function clip(text, maxChars) {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...<truncated ${text.length - maxChars} chars>`;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function createChatId() {
  return `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part?.type || "text") === "text")
    .map((part) => String(part?.text || ""))
    .join("");
}

function requestToPrompt(body, rawBody) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (messages && messages.length > 0) {
    return messages.length === 1 ? flattenContent(messages[0]?.content) : JSON.stringify(messages);
  }
  if (typeof body?.prompt === "string") return body.prompt;
  if (typeof body?.input === "string") return body.input;
  if (typeof rawBody === "string" && rawBody.trim()) return rawBody;
  return "";
}

function streamChunk({ id, model, content, done = false, role = null }) {
  const delta = {};
  if (role) delta.role = role;
  if (!done && content) delta.content = content;
  return {
    id,
    object: "chat.completion.chunk",
    created: nowTs(),
    model,
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: done ? "stop" : null }],
  };
}

function fullResponse({ id, model, content }) {
  return {
    id,
    object: "chat.completion",
    created: nowTs(),
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function errorResponse(message, type = "server_error", code = null) {
  return { error: { message, type, param: null, code } };
}

async function loadClientCtor() {
  if (DeepSeekWebClientCtor) return DeepSeekWebClientCtor;
  const mod = await import("./deepseek-web-client.ts");
  const candidate = mod?.DeepSeekWebClient || mod?.default?.DeepSeekWebClient || mod?.default;
  if (typeof candidate !== "function") {
    throw new Error(`Failed to load DeepSeekWebClient constructor. Export keys: ${Object.keys(mod || {}).join(",")}`);
  }
  DeepSeekWebClientCtor = candidate;
  return DeepSeekWebClientCtor;
}

async function validateAuth(auth) {
  try {
    const Ctor = await loadClientCtor();
    const probe = new Ctor(auth);
    await probe.init();
    const session = await probe.createChatSession();
    return { ok: Boolean(session?.chat_session_id), reason: "" };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

async function applyAuthAndResetSession(auth, { persist = true } = {}) {
  const Ctor = await loadClientCtor();
  const nextClient = new Ctor(auth);
  await nextClient.init();
  const session = await nextClient.createChatSession();
  if (!session?.chat_session_id) {
    throw new Error("Auth valid check failed: cannot create chat session");
  }
  client = nextClient;
  chatSessionId = session.chat_session_id;
  parentMessageId = undefined;
  if (persist) await saveAuth(auth);
}

async function bootstrapAuth() {
  const envCookie = String(process.env.DEEPSEEK_COOKIE || "").trim();
  if (envCookie) {
    const envAuth = {
      cookie: envCookie,
      bearer: String(process.env.DEEPSEEK_BEARER || "").trim() || undefined,
      userAgent: String(process.env.DEEPSEEK_USER_AGENT || "").trim() || undefined,
    };
    const envCheck = await validateAuth(envAuth);
    if (!envCheck.ok) {
      throw new Error(`Env auth invalid: ${envCheck.reason || "unknown"}. Refresh DEEPSEEK_COOKIE / DEEPSEEK_BEARER.`);
    }
    await saveAuth(envAuth);
    return envAuth;
  }

  const saved = await loadSavedAuth();
  if (saved) {
    const savedCheck = await validateAuth(saved);
    if (savedCheck.ok) return saved;
    logLine(`[auth] saved auth invalid: ${savedCheck.reason || "unknown"}`);
  }

  if (!process.stdin.isTTY) {
    throw new Error("No valid saved auth and non-interactive mode. Set DEEPSEEK_COOKIE.");
  }

  logLine("DeepSeek login required. Paste Cookie/Bearer now.");
  const inputAuth = await promptAuthInteractive();
  const inputCheck = await validateAuth(inputAuth);
  if (!inputCheck.ok) {
    throw new Error(`Login failed: invalid cookie/bearer. ${inputCheck.reason || ""}`);
  }
  await saveAuth(inputAuth);
  return inputAuth;
}

async function* parseUpstreamSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastFragmentType = "";

  const isAnswerFragmentType = (type) => {
    const t = String(type || "").toUpperCase();
    return !t || t === "RESPONSE" || t === "TEXT";
  };

  const isThinkingFragmentType = (type) => {
    const t = String(type || "").toUpperCase();
    return t === "THINK" || t === "THINKING" || t === "REASONING";
  };

  const mapData = (data) => {
    if (data?.response_message_id) return { messageId: data.response_message_id };

    if ((typeof data?.p === "string" && (data.p.includes("thinking") || data.p.includes("reasoning"))) || data?.type === "thinking") {
      return null;
    }

    if (data?.type === "text" && typeof data?.content === "string") {
      return { text: data.content };
    }

    const fragments = data?.v?.response?.fragments;
    if (Array.isArray(fragments)) {
      let text = "";
      for (const frag of fragments) {
        if (frag?.type) lastFragmentType = String(frag.type);
        if (typeof frag?.content === "string" && isAnswerFragmentType(frag?.type)) {
          text += String(frag.content);
        }
      }
      if (text) return { text };
    }

    if (data?.p === "response/fragments" && Array.isArray(data?.v)) {
      let text = "";
      for (const frag of data.v) {
        if (frag?.type) lastFragmentType = String(frag.type);
        if (typeof frag?.content === "string" && isAnswerFragmentType(frag?.type)) {
          text += String(frag.content);
        }
      }
      if (text) return { text };
      return null;
    }

    if (typeof data?.v === "string" && typeof data?.p === "string" && data.p.startsWith("response/fragments/-1/content")) {
      if (isThinkingFragmentType(lastFragmentType) && (data.p.includes("thinking") || data.p.includes("reasoning"))) return null;
      return { text: data.v };
    }

    if (typeof data?.v === "string" && (!data?.p || data.p.includes("content") || data.p.includes("choices"))) {
      return { text: data.v };
    }

    const choice = data?.choices?.[0];
    if (choice?.delta?.content) return { text: choice.delta.content };

    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n");

    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (line.startsWith("data: ")) {
        const payload = line.slice(6).trim();
        if (LOG_DEEPSEEK_RAW && payload) {
          logLine(`[deepseek-raw][sse-line] ${clip(payload, LOG_DEEPSEEK_RAW_MAX_CHARS)}`);
        }
        if (payload && payload !== "[DONE]") {
          try {
            const data = JSON.parse(payload);
            const mapped = mapData(data);
            if (mapped) yield mapped;
            else if (LOG_DEEPSEEK_RAW) logLine(`[deepseek-raw][sse-unmapped] ${clip(payload, LOG_DEEPSEEK_RAW_MAX_CHARS)}`);
          } catch {}
        }
      }

      idx = buffer.indexOf("\n");
    }
  }
}

const app = express();
app.use(
  express.json({
    limit: "4mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf ? buf.toString("utf8") : "";
    },
  }),
);

app.use((err, _req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    logLine(`[inbound][json-parse-error] ${err.message || String(err)}`);
    return res.status(400).json(errorResponse("invalid json body", "invalid_request_error"));
  }
  return next(err);
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ready: Boolean(client && chatSessionId), service: "deepseek-web-api-proxy" });
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "deepseek-chat", object: "model", created: nowTs(), owned_by: "deepseek-web" },
      { id: "deepseek-reasoner", object: "model", created: nowTs(), owned_by: "deepseek-web" },
    ],
  });
});

app.post("/auth/refresh", async (req, res) => {
  try {
    const cookie = String(req.body?.cookie || "").trim();
    const bearer = String(req.body?.bearer || "").trim();
    const userAgent = String(req.body?.userAgent || "").trim();
    if (!cookie) return res.status(400).json(errorResponse("cookie is required", "invalid_request_error"));

    await applyAuthAndResetSession({ cookie, bearer: bearer || undefined, userAgent: userAgent || undefined }, { persist: true });
    return res.json({ ok: true, message: "auth refreshed", hasBearer: Boolean(bearer) });
  } catch (err) {
    return res.status(500).json(errorResponse(err?.message || String(err), "server_error"));
  }
});

async function handleChatCompletions(req, res) {
  const body = req.body || {};
  const model = String(body.model || "deepseek-chat");
  const stream = Boolean(body.stream);

  const prompt = requestToPrompt(body, req.rawBody);
  if (!prompt.trim()) {
    return res.status(400).json(errorResponse("empty input", "invalid_request_error"));
  }

  if (!client || !chatSessionId) {
    return res.status(503).json(errorResponse("gateway not initialized", "service_unavailable"));
  }

  const id = createChatId();
  const startedAt = Date.now();

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const upstream = await client.chatCompletions({
      sessionId: chatSessionId,
      parentMessageId,
      message: prompt,
      model,
      searchEnabled: true,
      preempt: false,
      signal: controller.signal,
    });

    if (!upstream) throw new Error("DeepSeek returned empty stream body");

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      res.write(`data: ${JSON.stringify(streamChunk({ id, model, role: "assistant" }))}\n\n`);

      for await (const part of parseUpstreamSse(upstream)) {
        if (part.messageId) parentMessageId = part.messageId;
        const delta = part.text || "";
        if (!delta) continue;
        res.write(`data: ${JSON.stringify(streamChunk({ id, model, content: delta }))}\n\n`);
      }

      res.write(`data: ${JSON.stringify(streamChunk({ id, model, done: true }))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      logLine(`[outbound][sse][done] id=${id} ms=${Date.now() - startedAt}`);
      return;
    }

    let finalText = "";
    for await (const part of parseUpstreamSse(upstream)) {
      if (part.messageId) parentMessageId = part.messageId;
      if (part.text) finalText += part.text;
    }

    const payload = fullResponse({ id, model, content: finalText });
    logLine(`[outbound][json] id=${id} ms=${Date.now() - startedAt} chars=${finalText.length}`);
    return res.status(200).json(payload);
  } catch (err) {
    const msg = err?.message || String(err);
    logLine(`[outbound][error] id=${id} ms=${Date.now() - startedAt} err=${msg}`);
    if (stream) {
      if (!res.headersSent) res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.write(`data: ${JSON.stringify(errorResponse(msg, "server_error"))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    return res.status(500).json(errorResponse(msg, "server_error"));
  }
}

app.post("/v1/chat/completions", handleChatCompletions);
app.post("/chat/completions", handleChatCompletions);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

(async () => {
  try {
    await loadClientCtor();
    const auth = await bootstrapAuth();
    await applyAuthAndResetSession(auth, { persist: false });
    app.listen(PORT, () => {
      logLine(`[gateway] listening on http://127.0.0.1:${PORT}`);
      logLine(`[gateway] auth/session ready`);
      logLine(`[gateway] log file: ${LOG_FILE}`);
    });
  } catch (err) {
    logLine(`[gateway] startup failed: ${err?.message || String(err)}`);
    process.exit(1);
  }
})();
