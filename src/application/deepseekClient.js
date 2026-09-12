import { AI_FINANCE_TOOLS } from "./aiFinanceTools.js";

export const ASSISTANT_MAX_ROUNDS = 6;
export const ASSISTANT_REQUEST_TIMEOUT_MS = 55_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_TOOL_CALLS = 8;
const toolNames = new Set(AI_FINANCE_TOOLS.map((tool) => tool.function.name));
class AssistantClientError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => new AssistantClientError(code, message);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const cancelled = () => fail("ASSISTANT_CANCELLED", "已停止本轮整理，已保存的资料和待确认事项会保留");

function redact(value, key) {
  return String(value).split(key).join("[密钥已隐藏]").replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[密钥已隐藏]");
}

function copyMessages(messages, key) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 80) {
    throw fail("ASSISTANT_INVALID_MESSAGES", "对话内容过多或为空，请另起一轮处理");
  }
  return messages.map((message) => {
    if (!isObject(message) || !["system", "user", "assistant", "tool"].includes(message.role)
      || (message.content != null && typeof message.content !== "string")) {
      throw fail("ASSISTANT_INVALID_MESSAGES", "对话内容格式不正确，请重新发送");
    }
    const clean = { role: message.role, content: redact(message.content || "", key) };
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id) throw fail("ASSISTANT_INVALID_MESSAGES", "工具结果缺少对应操作");
      clean.tool_call_id = redact(message.tool_call_id, key);
    }
    if (message.role === "assistant" && message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw fail("ASSISTANT_INVALID_MESSAGES", "工具调用格式不正确");
      if (message.tool_calls.length) clean.tool_calls = normalizeCalls(message.tool_calls, key);
    }
    return clean;
  });
}

function normalizeCalls(calls, key) {
  if (!Array.isArray(calls) || !calls.length || calls.length > MAX_TOOL_CALLS) {
    throw fail("ASSISTANT_INVALID_TOOL", "助手返回的操作数量不正确，请分批整理");
  }
  const ids = new Set();
  return calls.map((call) => {
    if (!isObject(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || call.id.length > 128
      || ids.has(call.id) || !toolNames.has(call.function?.name) || typeof call.function.arguments !== "string"
      || call.function.arguments.length > 65_536) {
      throw fail("ASSISTANT_INVALID_TOOL", "助手请求了本批不支持的操作，已停止处理");
    }
    ids.add(call.id);
    return { id: redact(call.id, key), type: "function", function: { name: call.function.name, arguments: redact(call.function.arguments, key) } };
  });
}

const statusErrors = {
  400: ["ASSISTANT_INVALID_REQUEST", "本轮内容格式不正确或过多，请分批发送"],
  401: ["KEY_REQUIRED", "DeepSeek 密钥无效或已失效，请在设置中修改"],
  402: ["ASSISTANT_BALANCE", "DeepSeek 账户余额不足，请充值后继续"],
  403: ["ASSISTANT_FORBIDDEN", "本轮请求未获允许，请从 FinanceDesk 网页重新发送"],
  404: ["ASSISTANT_UNAVAILABLE", "当前网页未提供 AI 接口，请使用 FinanceDesk 正式网页或本地服务"],
  413: ["ASSISTANT_TOO_LARGE", "本轮资料过多，请分批处理"],
  415: ["ASSISTANT_INVALID_REQUEST", "请求格式不正确，请重新发送"],
  422: ["ASSISTANT_INCOMPLETE", "DeepSeek 返回的内容未完成，请缩小本轮范围后继续"],
  429: ["ASSISTANT_RATE_LIMIT", "DeepSeek 请求过于频繁，请稍后继续"],
  504: ["ASSISTANT_TIMEOUT", "DeepSeek 回复超时，已保存的资料和待确认事项会保留"],
};

async function requestCompletion({ apiKey, messages, signal, fetchImpl }) {
  if (signal?.aborted) throw cancelled();
  const body = JSON.stringify({ messages });
  if (messages.length > 80 || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw fail("ASSISTANT_TOO_LARGE", "本轮资料过多，请分批处理");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ASSISTANT_REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl("/api/finance-assistant", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body, signal: controller.signal,
    });
    if (!response.ok) {
      // Never forward the response body: providers and gateways can echo credentials.
      const [code, message] = statusErrors[response.status] || ["ASSISTANT_UNAVAILABLE", "DeepSeek 暂时无法回复，已保存的资料仍在工作台"];
      throw fail(code, message);
    }
    const result = await response.json();
    if (signal?.aborted) throw cancelled();
    if (timedOut) throw fail("ASSISTANT_TIMEOUT", statusErrors[504][1]);
    if (!isObject(result?.message) || result.message.role !== "assistant"
      || (result.message.content != null && typeof result.message.content !== "string")) {
      throw fail("ASSISTANT_INVALID_RESPONSE", "当前网页没有返回有效的 AI 回复，请使用已配置接口的 FinanceDesk 网页");
    }
    if (!["stop", "tool_calls"].includes(result.finishReason)) {
      throw fail("ASSISTANT_INCOMPLETE", "DeepSeek 返回的内容未完成，请缩小本轮范围后继续");
    }
    const message = { role: "assistant", content: redact(result.message.content || "", apiKey) };
    if (result.message.tool_calls != null) {
      if (!Array.isArray(result.message.tool_calls)) throw fail("ASSISTANT_INVALID_RESPONSE", "助手的操作内容不完整，已停止处理");
      if (result.message.tool_calls.length) message.tool_calls = normalizeCalls(result.message.tool_calls, apiKey);
    }
    if ((result.finishReason === "tool_calls") !== Boolean(message.tool_calls?.length)) {
      throw fail("ASSISTANT_INVALID_RESPONSE", "助手的操作内容不完整，已停止处理");
    }
    if (!message.tool_calls?.length && !message.content.trim()) throw fail("ASSISTANT_INVALID_RESPONSE", "助手没有返回可处理的回复，请重新发送");
    return { message, finishReason: result.finishReason };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (timedOut) throw fail("ASSISTANT_TIMEOUT", statusErrors[504][1]);
    if (error instanceof AssistantClientError) throw error;
    throw fail("ASSISTANT_NETWORK", "本轮连接未能完成，已保存的资料仍在工作台；可以稍后继续");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Transport only. executeTool must validate business inputs and must not treat a call as user confirmation. */
export async function runFinanceAssistant({ apiKey, messages: inputMessages, tools = AI_FINANCE_TOOLS, executeTool,
  signal, onMessage = () => {}, onToolResult = () => {}, fetchImpl = globalThis.fetch }) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(key)) throw fail("KEY_REQUIRED", "请先在 DeepSeek 设置中填写有效密钥，输入和附件会保留");
  let messages = [];
  const toolResults = [];
  try {
    messages = copyMessages(inputMessages, key);
    if (!Array.isArray(tools) || tools.some((tool) => !toolNames.has(tool?.function?.name))) {
      throw fail("ASSISTANT_INVALID_TOOL", "本轮工具配置不正确，已停止处理");
    }
    const allowedNames = new Set(tools.map((tool) => tool.function.name));
    const completedIds = new Set(messages.flatMap((message) => message.role === "tool" ? [message.tool_call_id] : []));
    for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
      const { message, finishReason } = await requestCompletion({ apiKey: key, messages, signal, fetchImpl });
      const calls = message.tool_calls || [];
      if (calls.length && round === ASSISTANT_MAX_ROUNDS - 1) {
        throw fail("ASSISTANT_ROUND_LIMIT", "本轮整理已到上限，已生成的待确认事项会保留；核对后可继续处理");
      }
      // Validate the whole batch before invoking any business operation.
      const parsedCalls = calls.map((call) => {
        if (!allowedNames.has(call.function.name) || completedIds.has(call.id) || typeof executeTool !== "function") {
          throw fail("ASSISTANT_INVALID_TOOL", "助手请求了未允许或已处理的操作，已停止处理");
        }
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { throw fail("ASSISTANT_INVALID_TOOL", "助手给出的操作参数不完整，已停止处理"); }
        if (!isObject(args)) throw fail("ASSISTANT_INVALID_TOOL", "助手给出的操作参数格式不正确，已停止处理");
        return { id: call.id, name: call.function.name, arguments: args };
      });
      messages.push(message);
      await onMessage(message);
      if (signal?.aborted) throw cancelled();
      if (!calls.length) return { messages, message, toolResults, finishReason };
      for (const call of parsedCalls) {
        if (signal?.aborted) throw cancelled();
        let result;
        try {
          const output = await executeTool({ ...call, signal });
          result = JSON.parse(redact(JSON.stringify(output ?? null), key));
        } catch (error) {
          if (signal?.aborted) throw cancelled();
          if (error?.code === "AI_TARGET_CHANGED") throw fail("AI_TARGET_CHANGED", "当前工作台或账期已改变，本轮整理已停止");
          throw fail("ASSISTANT_TOOL_FAILED", redact(error?.message || "本地处理未能完成，请核对当前资料后继续", key).slice(0, 1000));
        }
        completedIds.add(call.id);
        const entry = { call, result };
        toolResults.push(entry);
        const toolMessage = { role: "tool", tool_call_id: call.id, content: JSON.stringify(result) };
        messages.push(toolMessage);
        await onMessage(toolMessage);
        await onToolResult(entry);
      }
    }
  } catch (error) {
    // Keep interrupted transcripts usable without ever replaying unfinished calls.
    const answered = new Set(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
    for (const message of [...messages]) {
      for (const call of message.tool_calls || []) {
        if (!answered.has(call.id)) messages.push({ role: "tool", tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: "本轮已停止；此操作未取得完成结果，继续前须重新查询工作台状态" }) });
      }
    }
    const safeError = fail(signal?.aborted ? "ASSISTANT_CANCELLED" : (error instanceof AssistantClientError ? error.code : "ASSISTANT_FAILED"),
      signal?.aborted ? cancelled().message : redact(error?.message || "本轮整理未能完成，请稍后继续", key));
    safeError.messages = messages;
    safeError.toolResults = toolResults;
    throw safeError;
  }
}
