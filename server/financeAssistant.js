import { AI_FINANCE_TOOLS } from "../src/application/aiFinanceTools.js";

const ENDPOINT = "https://api.deepseek.com/chat/completions";
export const FINANCE_ASSISTANT_BODY_LIMIT = 1_000_000;
export const FINANCE_ASSISTANT_TIMEOUT_MS = 50_000;
class AssistantRequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => new AssistantRequestError(status, message);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const toolNames = new Set(AI_FINANCE_TOOLS.map((tool) => tool.function.name));
const redact = (value, key) => String(value).split(key).join("[密钥已隐藏]").replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[密钥已隐藏]");

function normalizeCalls(calls, key, status = 400) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 8) throw fail(status, "本轮工具调用格式或数量不正确");
  const ids = new Set();
  return calls.map((call) => {
    if (!isObject(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || call.id.length > 128
      || ids.has(call.id) || !toolNames.has(call.function?.name) || typeof call.function.arguments !== "string"
      || call.function.arguments.length > 65_536) throw fail(status, "工具调用不在本批允许范围");
    ids.add(call.id);
    return { id: redact(call.id, key), type: "function", function: { name: call.function.name, arguments: redact(call.function.arguments, key) } };
  });
}

function normalizeMessages(body, key) {
  if (!isObject(body) || Object.keys(body).some((name) => name !== "messages")) throw fail(400, "请求参数不正确，请重新发送当前消息");
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > FINANCE_ASSISTANT_BODY_LIMIT) throw fail(413, "本轮内容过多，请分批处理资料");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 80) throw fail(400, "本轮对话为空或过长，请另起一轮处理");
  const pending = new Set();
  const seen = new Set();
  const messages = body.messages.map((message) => {
    if (!isObject(message) || !["system", "user", "assistant", "tool"].includes(message.role)
      || (message.content != null && typeof message.content !== "string")) throw fail(400, "对话内容格式不正确");
    const clean = { role: message.role, content: redact(message.content || "", key) };
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !pending.delete(redact(message.tool_call_id, key))) throw fail(400, "工具结果缺少对应操作");
      clean.tool_call_id = redact(message.tool_call_id, key);
    } else if (pending.size) throw fail(400, "上一轮操作结果不完整，请重新发起整理");
    if (message.role === "assistant" && message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw fail(400, "工具调用格式不正确");
      if (message.tool_calls.length) {
        clean.tool_calls = normalizeCalls(message.tool_calls, key);
        for (const call of clean.tool_calls) {
          if (seen.has(call.id)) throw fail(400, "对话包含重复操作，请重新发起整理");
          seen.add(call.id);
          pending.add(call.id);
        }
      }
    }
    return clean;
  });
  if (pending.size) throw fail(400, "上一轮操作结果不完整，请重新发起整理");
  return messages;
}

export async function requestDeepSeek({ authorization, body, signal, fetchImpl = fetch }) {
  if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{8,512}$/.test(authorization)) throw fail(401, "请先在 DeepSeek 设置中填写有效密钥");
  const key = authorization.slice(7);
  const messages = normalizeMessages(body, key);
  if (signal?.aborted) throw fail(504, "请求已取消或超时，已保存的资料仍在工作台");
  let response;
  try {
    response = await fetchImpl(ENDPOINT, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: authorization }, signal,
      body: JSON.stringify({ model: "deepseek-flash", thinking: { type: "disabled" }, stream: false, max_tokens: 4096, temperature: 0.2,
        messages, tools: AI_FINANCE_TOOLS, tool_choice: "auto" }) });
  } catch {
    if (signal?.aborted) throw fail(504, "请求已取消或超时，已保存的资料仍在工作台");
    throw fail(502, "暂时无法连接 DeepSeek，请稍后继续；已保存资料仍在工作台");
  }
  if (!response.ok) {
    const labels = { 400: "DeepSeek 未接受本轮请求，请减少内容后继续", 401: "DeepSeek 密钥无效或已失效，请在设置中修改", 402: "DeepSeek 账户余额不足，请充值后继续", 403: "DeepSeek 未允许本轮请求，请核对账户状态", 429: "DeepSeek 请求过于频繁，请稍后继续" };
    // Do not read or relay upstream errors, headers, credentials, or stack traces.
    throw fail(labels[response.status] ? response.status : 502, labels[response.status] || "DeepSeek 暂时未能完成请求，请稍后继续");
  }
  let result;
  try { result = await response.json(); } catch {
    if (signal?.aborted) throw fail(504, "请求已取消或超时，已保存的资料仍在工作台");
    throw fail(502, "DeepSeek 返回内容不完整，请重新发送");
  }
  if (signal?.aborted) throw fail(504, "请求已取消或超时，已保存的资料仍在工作台");
  const choice = result?.choices?.[0];
  const message = choice?.message;
  if (!isObject(message) || message.role !== "assistant" || (message.content != null && typeof message.content !== "string")) throw fail(502, "DeepSeek 没有返回可处理的回复");
  if (!["stop", "tool_calls"].includes(choice.finish_reason)) throw fail(422, "DeepSeek 本轮内容未完成，请缩小处理范围后继续");
  const clean = { role: "assistant", content: redact(message.content || "", key) };
  if (message.tool_calls != null) {
    if (!Array.isArray(message.tool_calls)) throw fail(502, "DeepSeek 操作内容格式不正确");
    if (message.tool_calls.length) clean.tool_calls = normalizeCalls(message.tool_calls, key, 502);
  }
  if ((choice.finish_reason === "tool_calls") !== Boolean(clean.tool_calls?.length)) throw fail(502, "DeepSeek 操作内容不完整");
  if (!clean.tool_calls?.length && !clean.content.trim()) throw fail(502, "DeepSeek 没有返回可处理的回复");
  return { message: clean, finishReason: choice.finish_reason };
}

async function readRequestBody(req) {
  const length = req.headers?.["content-length"];
  if (length != null && (!/^\d+$/.test(String(length)) || Number(length) > FINANCE_ASSISTANT_BODY_LIMIT)) throw fail(413, "资料内容过多，请分批发送");
  let body = req.body;
  if (body == null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > FINANCE_ASSISTANT_BODY_LIMIT) throw fail(413, "资料内容过多，请分批发送");
      chunks.push(bytes);
    }
    body = Buffer.concat(chunks).toString("utf8");
  } else if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > FINANCE_ASSISTANT_BODY_LIMIT) throw fail(413, "资料内容过多，请分批发送");
    try { return JSON.parse(body); } catch { throw fail(400, "请求内容不正确"); }
  }
  return body;
}

export async function financeAssistantHandler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") { res.statusCode = 405; res.setHeader("Allow", "POST"); res.end(JSON.stringify({ error: "请从 FinanceDesk 对话框发送请求" })); return; }
  const controller = new AbortController();
  const send = (status, body) => {
    if (!res.writableEnded && !res.destroyed) { res.statusCode = status; res.end(JSON.stringify(body)); }
  };
  const timer = setTimeout(() => { controller.abort(); send(504, { error: "请求已超时，已保存的资料仍在工作台" }); }, FINANCE_ASSISTANT_TIMEOUT_MS);
  const abort = () => controller.abort();
  req.on?.("aborted", abort);
  const close = () => { if (!res.writableEnded) abort(); };
  res.on?.("close", close);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.["content-type"] || "")) throw fail(415, "请使用正确的对话请求格式");
    if (req.headers?.["sec-fetch-site"] === "cross-site") throw fail(403, "请从 FinanceDesk 网页发送请求");
    const body = await readRequestBody(req);
    const result = await requestDeepSeek({ authorization: req.headers?.authorization, body, signal: controller.signal });
    send(200, result);
  } catch (error) {
    send(error instanceof AssistantRequestError ? error.status : 500, { error: error instanceof AssistantRequestError ? error.message : "本轮请求未能完成，请重新发送" });
  } finally { clearTimeout(timer); req.off?.("aborted", abort); res.off?.("close", close); }
}

export function financeAssistantPlugin() {
  const configure = (server) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/api/finance-assistant") return next();
      return financeAssistantHandler(req, res);
    });
  };
  return { name: "financedesk-ai-proxy", configureServer: configure, configurePreviewServer: configure };
}
