import { DEFAULT_DEEPSEEK_MODEL_SETTINGS, getDeepSeekModelCapabilities, KNOWN_DEEPSEEK_MODELS, normalizeDeepSeekModelSettings } from "../../application/deepseekModels.js";

export const thinkingEffortLabels = { low: "轻度", high: "高", max: "最高" };

export function snapshotModelSettings(settings) {
  const normalized = normalizeDeepSeekModelSettings(settings);
  return Object.freeze({ model: normalized.model, thinking: normalized.thinking, reasoningEffort: normalized.reasoningEffort });
}

export function settingsForModel(settings, model) {
  const capabilities = getDeepSeekModelCapabilities(model);
  const efforts = capabilities.reasoningEfforts || [];
  return snapshotModelSettings({ model, thinking: capabilities.thinking ? settings.thinking : "disabled",
    reasoningEffort: efforts.includes(settings.reasoningEffort) ? settings.reasoningEffort : efforts.includes(DEFAULT_DEEPSEEK_MODEL_SETTINGS.reasoningEffort) ? DEFAULT_DEEPSEEK_MODEL_SETTINGS.reasoningEffort : efforts[0] || DEFAULT_DEEPSEEK_MODEL_SETTINGS.reasoningEffort });
}

export function modelOptions(models = null, selectedModel) {
  const options = (models ?? KNOWN_DEEPSEEK_MODELS).map((model) => ({ ...model, unavailable: false }));
  if (selectedModel && !options.some((model) => model.id === selectedModel)) options.unshift({ id: selectedModel,
    label: selectedModel, capabilities: getDeepSeekModelCapabilities(selectedModel), unavailable: models !== null });
  return options;
}

export function thinkingLabel(settings) {
  return settings?.thinking === "enabled" ? `思考 · ${thinkingEffortLabels[settings.reasoningEffort] || "默认强度"}` : "非思考";
}

export function currentModelLabel(settings) {
  const model = KNOWN_DEEPSEEK_MODELS.find((item) => item.id === settings.model);
  return `${model?.label || settings.model} · ${thinkingLabel(settings)}`;
}

export function replyModelMetadata(settings, returnedMetadata) {
  return { requestedModel: settings.model, responseModel: returnedMetadata?.responseModel || null,
    thinking: settings.thinking, reasoningEffort: settings.thinking === "enabled" ? returnedMetadata?.reasoningEffort || settings.reasoningEffort : null };
}

export function messageModelLabel(metadata) {
  if (!metadata?.requestedModel) return "";
  const model = metadata.responseModel === metadata.requestedModel ? metadata.responseModel
    : `请求：${metadata.requestedModel} · ${metadata.responseModel ? `返回：${metadata.responseModel}` : "返回型号未提供"}`;
  return `${model} · ${thinkingLabel(metadata)}`;
}
