import { useState } from "react";
import { AiDialog } from "./AiDialog.jsx";

export function AiSettings({ configured, onSave, onClear, onClose }) {
  const [value, setValue] = useState("");
  return <AiDialog title="DeepSeek 设置" onClose={onClose}>
    <form className="ai-settings-form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) { onSave(value.trim()); setValue(""); } }}>
      <p>{configured ? "已设置密钥，填写新密钥即可更换。" : "填写 DeepSeek API 密钥后，即可开始整理。"}</p>
      <label className="ai-field"><span>API 密钥</span><input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={8} maxLength={512} pattern={"[A-Za-z0-9_\\-]{8,512}"} title="请填写完整的 DeepSeek API 密钥" value={value} placeholder={configured ? "填写新密钥" : "sk-…"} onChange={(event) => setValue(event.target.value)} /></label>
      <p className="ai-helper">密钥仅在当前标签页内存中使用，刷新或关闭后需要重新填写。原件保留在本机；本次对话、相关财务字段和识别文字会发送给 DeepSeek。</p>
      <div className="ai-dialog-actions">{configured && <button type="button" className="ai-text-button" onClick={() => { setValue(""); onClear(); }}>清除密钥</button>}<button className="ai-primary-button" type="submit" disabled={!value.trim()}>保存并返回</button></div>
    </form>
  </AiDialog>;
}
