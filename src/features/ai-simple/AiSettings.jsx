import { useState } from "react";
import { AiDialog } from "./AiDialog.jsx";

export function AiSettings({ configured, onSave, onClear, onClose }) {
  const [value, setValue] = useState("");
  return <AiDialog title="DeepSeek 设置" onClose={onClose}>
    <form className="ai-settings-form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) { onSave(value.trim()); setValue(""); } }}>
      <p>{configured ? "当前标签页已设置密钥。需要更换时，在下方填写新密钥。" : "填写你的 DeepSeek API 密钥后，即可开始整理。"}</p>
      <label className="ai-field"><span>API 密钥</span><input type="password" autoComplete="off" spellCheck={false} value={value} placeholder={configured ? "填写新密钥" : "sk-…"} onChange={(event) => setValue(event.target.value)} /></label>
      <p className="ai-helper">密钥仅在当前标签页内存中使用，刷新后需要重新填写。原件保留在本机，处理时会将本次对话及相关财务字段、识别文字发送给 DeepSeek。</p>
      <div className="ai-dialog-actions">{configured && <button type="button" className="ai-text-button" onClick={() => { setValue(""); onClear(); }}>清除密钥</button>}<button className="ai-primary-button" type="submit" disabled={!value.trim()}>保存并返回</button></div>
    </form>
  </AiDialog>;
}
