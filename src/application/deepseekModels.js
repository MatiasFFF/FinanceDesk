// Official documentation reviewed 2026-09-12. Availability comes from /models;
// this small table describes documented capabilities, not an availability gate.
// https://api-docs.deepseek.com/updates/
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
export const DEFAULT_DEEPSEEK_MODEL_SETTINGS = Object.freeze({ model: "deepseek-flash", thinking: "disabled", reasoningEffort: "high" });
export const DEEPSEEK_REASONING_EFFORTS = Object.freeze(["low", "high", "max"]);
const knownCapabilities = Object.freeze({ known: true, thinking: true, reasoningEfforts: DEEPSEEK_REASONING_EFFORTS, toolCalls: true });
const unknownCapabilities = Object.freeze({ known: false, thinking: false, reasoningEfforts: Object.freeze([]), toolCalls: null });
const labels = Object.freeze({
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4.1 Flash（旧版别名）",
  "deepseek-v4-flash-vision-exp": "DeepSeek V4.1 Flash（旧版视觉别名）",
});
export const isDeepSeekModelId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !/^sk-/i.test(value);
export const getDeepSeekModelCapabilities = (model) => Object.hasOwn(labels, model) ? knownCapabilities : unknownCapabilities;
const modelItem = (id, ownedBy = "deepseek") => ({ id, label: Object.hasOwn(labels, id) ? labels[id] : id, ownedBy, capabilities: getDeepSeekModelCapabilities(id) });
export const KNOWN_DEEPSEEK_MODELS = Object.freeze(["deepseek-flash", "deepseek-v4-pro"].map((id) => Object.freeze(modelItem(id))));

export function normalizeDeepSeekModelSettings(settings = {}) {
  const invalid = (message) => Object.assign(new Error(message), { code: "ASSISTANT_INVALID_MODEL_SETTINGS" });
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw invalid("模型设置格式不正确，请重新选择");
  const model = settings.model === undefined ? DEFAULT_DEEPSEEK_MODEL_SETTINGS.model : settings.model;
  const thinking = settings.thinking === undefined ? DEFAULT_DEEPSEEK_MODEL_SETTINGS.thinking : settings.thinking;
  const reasoningEffort = settings.reasoningEffort === undefined ? DEFAULT_DEEPSEEK_MODEL_SETTINGS.reasoningEffort : settings.reasoningEffort;
  if (!isDeepSeekModelId(model)) throw invalid("模型标识不正确，请从模型列表重新选择");
  if (!["enabled", "disabled"].includes(thinking) || !DEEPSEEK_REASONING_EFFORTS.includes(reasoningEffort)) throw invalid("思考模式或强度不正确，请重新选择");
  if (thinking === "enabled" && !getDeepSeekModelCapabilities(model).thinking) throw invalid("这个模型的思考能力尚未确认，请关闭思考模式或选择已知支持的模型");
  return { model, thinking, reasoningEffort };
}

/** Preserve new official IDs without inventing their capabilities or silently adding defaults. */
export function normalizeDeepSeekModels(payload) {
  const invalid = () => Object.assign(new Error("DeepSeek 模型列表格式不完整，请稍后刷新"), { code: "ASSISTANT_INVALID_MODELS" });
  const data = Array.isArray(payload) ? payload : payload?.object === "list" ? payload.data : null;
  if (!Array.isArray(data) || data.length > 256) throw invalid();
  const seen = new Set();
  const result = [];
  for (const item of data) {
    if (!item || !isDeepSeekModelId(item.id)) throw invalid();
    const owner = item.owned_by ?? item.ownedBy;
    if (typeof owner !== "string" || owner.length > 128 || /[\r\n]/.test(owner)) throw invalid();
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(modelItem(item.id, owner));
  }
  return result;
}
