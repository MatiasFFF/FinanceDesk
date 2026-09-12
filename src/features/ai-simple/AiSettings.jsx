import { useEffect, useRef, useState } from "react";
import { listDeepSeekModels } from "../../application/deepseekClient.js";
import { getDeepSeekModelCapabilities } from "../../application/deepseekModels.js";
import { usePeriodLeaveGuard } from "../workspaces/periodNavigation.js";
import { AiDialog } from "./AiDialog.jsx";
import { useAiSession } from "./AiSessionContext.jsx";
import { hasModelSettingsChanges, modelOptions, settingsForModel, snapshotModelSettings, thinkingEffortLabels } from "./aiModelSettings.js";

export function AiSettings({ onSaved, onCleared, onClose }) {
  const { configured, readKey, setApiKey, clearApiKey, modelSettings, setModelSettings } = useAiSession();
  const [value, setValue] = useState("");
  const [selection, setSelection] = useState(() => snapshotModelSettings(modelSettings));
  const [models, setModels] = useState(null);
  const [listStatus, setListStatus] = useState("unread");
  const [error, setError] = useState("");
  const requestRef = useRef(null);
  const capabilities = getDeepSeekModelCapabilities(selection.model);
  const options = modelOptions(models, selection.model);
  const unavailable = options.find((model) => model.id === selection.model)?.unavailable;
  const hasKey = !!value.trim() || configured;
  const dirty = hasModelSettingsChanges(value, selection, modelSettings);
  usePeriodLeaveGuard({ dirty });
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!dirty) return undefined;
    const beforeUnload = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function close() {
    if (!dirty || window.confirm("DeepSeek 设置尚未保存，确定放弃这些修改并关闭吗？")) onClose();
  }

  function changeKey(next) {
    requestRef.current?.abort(); requestRef.current = null;
    setValue(next); setModels(null); setListStatus("unread"); setError("");
  }
  async function refreshModels() {
    const key = value.trim() || readKey();
    if (!key || requestRef.current) return;
    const controller = new AbortController(); requestRef.current = controller;
    setListStatus("loading"); setError("");
    try {
      const result = await listDeepSeekModels({ apiKey: key, signal: controller.signal });
      if (requestRef.current !== controller || controller.signal.aborted) return;
      setModels(result); setListStatus("loaded");
    } catch (caught) {
      if (requestRef.current !== controller || controller.signal.aborted) return;
      setListStatus("error"); setError(caught.message || "模型列表未能读取，请稍后重试。");
    } finally { if (requestRef.current === controller) requestRef.current = null; }
  }
  function save(event) {
    event.preventDefault();
    if (listStatus === "loading" || unavailable) return;
    try {
      const settings = snapshotModelSettings(selection);
      if (value.trim()) setApiKey(value.trim());
      setModelSettings(settings); setValue("");
      onSaved?.(); onClose();
    } catch (caught) { setError(caught.message || "设置未能保存，请核对填写内容。"); }
  }
  return <AiDialog title="DeepSeek 设置" onClose={close}>
    <form className="ai-settings-form" onSubmit={save}>
      <label className="ai-field"><span>API 密钥{configured ? " · 已设置" : ""}</span><input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={8} maxLength={512} pattern={"[A-Za-z0-9_\\-]{8,512}"} title="请填写完整的 DeepSeek API 密钥" value={value} placeholder={configured ? "留空沿用已有密钥，填写即可更换" : "sk-…"} onChange={(event) => changeKey(event.target.value)} /></label>
      <p className="ai-helper">密钥仅在当前标签页内存中使用，刷新或关闭后需要重新填写。原件保留在本机；本次对话、相关财务字段和识别文字会发送给 DeepSeek。</p>
      <div className="ai-model-controls">
        <div className="ai-model-setting-row"><strong>模型</strong><button className="ai-text-button" type="button" disabled={!hasKey || listStatus === "loading"} onClick={refreshModels}>{listStatus === "loading" ? "正在读取…" : models === null ? "读取模型列表" : "刷新模型列表"}</button></div>
        <label className="ai-field"><span className="sr-only">选择模型</span><select value={selection.model} onChange={(event) => setSelection(settingsForModel(selection, event.target.value))}>{options.map((model) => <option key={model.id} value={model.id} disabled={model.unavailable}>{model.label}{model.label !== model.id ? ` · ${model.id}` : ""}{model.unavailable ? "（不在本次列表）" : ""}</option>)}</select></label>
        <p className="ai-helper ai-model-list-status" role="status">{listStatus === "loading" ? "正在向 DeepSeek 读取此密钥的模型列表。" : listStatus === "error" ? models ? "刷新未完成，仍显示上次读取的模型。" : "尚未读取成功，当前仅列出官方文档中的模型。" : models ? models.length ? `已读取 ${models.length} 个模型；列表可用不代表整理请求已成功。` : "此密钥返回的模型列表为空。" : hasKey ? "尚未读取此密钥的模型列表，当前选项来自官方文档。" : "未设置密钥，官方模型列表尚未读取；当前选项来自官方文档。"}</p>
        {unavailable && <p className="ai-error">当前选择不在本次模型列表中，请选择列表中的模型。</p>}
        {capabilities.thinking ? <>
          <label className="ai-field"><span>思考模式</span><select value={selection.thinking} onChange={(event) => setSelection((current) => snapshotModelSettings({ ...current, thinking: event.target.value }))}><option value="disabled">关闭</option><option value="enabled">开启</option></select></label>
          {selection.thinking === "enabled" && !!capabilities.reasoningEfforts.length && <label className="ai-field"><span>思考强度</span><select value={selection.reasoningEffort} onChange={(event) => setSelection((current) => snapshotModelSettings({ ...current, reasoningEffort: event.target.value }))}>{capabilities.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{thinkingEffortLabels[effort] || effort}</option>)}</select></label>}
        </> : <p className="ai-helper">{capabilities.known ? "此型号没有可调整的思考模式。" : "此型号的思考能力尚未确认，本次按普通模式请求。"}</p>}
      </div>
      {error && <p className="ai-error" role="alert">{error}</p>}
      <div className="ai-dialog-actions">{configured && <button type="button" className="ai-text-button" onClick={() => { changeKey(""); clearApiKey(); onCleared?.(); }}>清除密钥</button>}<button className="ai-primary-button" type="submit" disabled={listStatus === "loading" || unavailable}>保存并返回</button></div>
    </form>
  </AiDialog>;
}
