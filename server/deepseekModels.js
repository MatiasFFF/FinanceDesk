import { normalizeDeepSeekModels } from "../src/application/deepseekModels.js";

const ENDPOINT = "https://api.deepseek.com/models";
export const DEEPSEEK_MODELS_TIMEOUT_MS = 15_000;
class ModelsRequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => new ModelsRequestError(status, message);

export async function requestDeepSeekModels({ authorization, signal, fetchImpl = globalThis.fetch }) {
  if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{8,512}$/.test(authorization)) throw fail(401, "请先在 DeepSeek 设置中填写有效密钥");
  const key = authorization.slice(7);
  const aborted = () => { if (signal?.aborted) throw fail(504, "模型列表请求已取消或超时，请稍后刷新"); };
  aborted();
  let response;
  try {
    response = await fetchImpl(ENDPOINT, { method: "GET", headers: { Authorization: authorization, Accept: "application/json" },
      cache: "no-store", redirect: "error", signal });
  } catch {
    aborted();
    throw fail(502, "暂时无法读取 DeepSeek 模型列表，请稍后刷新");
  }
  aborted();
  if (!response.ok) {
    const labels = { 401: "DeepSeek 密钥无效或已失效，请在设置中修改", 402: "DeepSeek 账户余额不足", 403: "DeepSeek 未允许读取模型列表，请核对账户状态", 429: "DeepSeek 请求过于频繁，请稍后刷新" };
    // Upstream error bodies may echo credentials; never read or relay them.
    throw fail(labels[response.status] ? response.status : 502, labels[response.status] || "DeepSeek 暂时无法提供模型列表，请稍后刷新");
  }
  try {
    const payload = await response.json();
    aborted();
    const models = normalizeDeepSeekModels(payload);
    if (JSON.stringify(models).includes(key) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(JSON.stringify(models))) throw fail(502, "DeepSeek 模型列表格式不完整，请稍后刷新");
    return models;
  } catch (error) {
    aborted();
    if (error instanceof ModelsRequestError) throw error;
    throw fail(502, "DeepSeek 模型列表格式不完整，请稍后刷新");
  }
}

export async function deepseekModelsHandler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const send = (status, body) => { if (!res.writableEnded && !res.destroyed) { res.statusCode = status; res.end(JSON.stringify(body)); } };
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); send(405, { error: "请从 DeepSeek 设置读取模型列表" }); return; }
  if (req.headers?.["sec-fetch-site"] === "cross-site") { send(403, { error: "请从 FinanceDesk 网页读取模型列表" }); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!res.writableEnded) abort(); };
  const timer = setTimeout(() => { abort(); send(504, { error: "模型列表请求已超时，请稍后刷新" }); }, DEEPSEEK_MODELS_TIMEOUT_MS);
  req.on?.("aborted", abort);
  res.on?.("close", close);
  try {
    const models = await requestDeepSeekModels({ authorization: req.headers?.authorization, signal: controller.signal });
    send(200, { models });
  } catch (error) {
    send(error instanceof ModelsRequestError ? error.status : 500, { error: error instanceof ModelsRequestError ? error.message : "模型列表请求未完成，请稍后刷新" });
  } finally { clearTimeout(timer); req.off?.("aborted", abort); res.off?.("close", close); }
}
