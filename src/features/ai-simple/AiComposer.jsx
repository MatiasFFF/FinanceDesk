import { useRef } from "react";
import { ArrowUp, FileText, Paperclip, Stop, X } from "@phosphor-icons/react";

export function AiComposer({ value, files, onChange, onFiles, onRemoveFile, onSend, busy, onCancel, home = false, disabled = false }) {
  const inputRef = useRef(null);
  return <form className={`ai-composer${home ? " ai-composer-home" : ""}`} onSubmit={(event) => { event.preventDefault(); onSend(); }}>
    {files.length > 0 && <div className="ai-attachments" aria-label="待发送附件">{files.map((entry) => <span className="ai-attachment" key={entry.id}>
      <FileText size={19} weight="duotone" aria-hidden="true" /><span>{entry.file.name}</span>
      {entry.documentId ? <small>已保存</small> : null}
      <button type="button" disabled={busy} aria-label={`移除 ${entry.file.name}`} onClick={() => onRemoveFile(entry.id)}><X size={14} /></button>
    </span>)}</div>}
    <div className="ai-composer-row">
      <input ref={inputRef} className="ai-file-input" type="file" multiple accept=".csv,.xls,.xlsx,.pdf,image/*" aria-label="添加银行流水或票据" onChange={(event) => { onFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      <button className="ai-attach-button" type="button" disabled={busy || disabled} aria-label="添加银行流水或票据" title="上传银行流水、票据图片或 PDF" onClick={() => inputRef.current?.click()}><Paperclip size={home ? 31 : 26} /></button>
      <textarea aria-label="告诉财务助手你想处理什么" rows={1} value={value} disabled={busy || disabled} placeholder={home ? "今天想处理什么财务事项？" : "补充信息，或添加资料…"} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) onSend(); }
      }} />
      {busy ? <button className="ai-send-button ai-stop-button" type="button" onClick={onCancel} aria-label="停止处理" title="停止处理"><Stop size={21} weight="fill" /></button>
        : <button className="ai-send-button" type="submit" disabled={disabled || (!value.trim() && !files.length)} aria-label="发送"><ArrowUp size={home ? 31 : 27} weight="bold" /></button>}
    </div>
  </form>;
}
