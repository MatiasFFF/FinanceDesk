import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, CaretDown, FileText, Paperclip, Stop, X } from "@phosphor-icons/react";
import { AI_ATTACHMENT_ACCEPT, AI_ATTACHMENT_HELP, selectAiAttachments, shouldSendFromKey } from "./aiAttachments.js";

export function AiComposer({ value, files, onChange, onFiles, onRemoveFile, onSend, busy, onCancel, home = false, disabled = false, attachmentNotice = null, modelLabel = "", onOpenSettings }) {
  const inputRef = useRef(null);
  const textareaRef = useRef(null);
  const composingRef = useRef(false);
  const compositionEndRef = useRef(-Infinity);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const helpId = useId();
  const noticeId = useId();
  const canSend = !busy && !disabled && (!!value.trim() || files.length > 0);

  function resizeInput() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const maximum = parseFloat(getComputedStyle(textarea).maxHeight) || 168;
    const height = textarea.scrollHeight;
    textarea.style.height = `${Math.min(height, maximum)}px`;
    textarea.style.overflowY = height > maximum ? "auto" : "hidden";
  }
  useLayoutEffect(resizeInput, [value, home]);
  useEffect(() => {
    const textarea = textareaRef.current;
    let width = textarea?.clientWidth;
    const observer = new ResizeObserver(() => { if (textarea && textarea.clientWidth !== width) { width = textarea.clientWidth; resizeInput(); } });
    if (textarea) observer.observe(textarea);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (attachmentNotice) setFeedback(attachmentNotice); }, [attachmentNotice]);
  useEffect(() => { if (busy) { setDragging(false); dragDepth.current = 0; setFeedback(null); } }, [busy]);

  function receiveFiles(selected) {
    if (busy || disabled) return;
    const result = selectAiAttachments(selected, files);
    setFeedback({ message: result.message, tone: result.tone });
    if (result.accepted.length) onFiles(result.accepted);
    textareaRef.current?.focus({ preventScroll: true });
  }
  const fileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  return <form className={`ai-composer${home ? " ai-composer-home" : ""}${dragging ? " is-dragging" : ""}`} onSubmit={(event) => { event.preventDefault(); if (canSend && !composingRef.current) onSend(); }}
    onDragEnter={(event) => { if (!fileDrag(event)) return; event.preventDefault(); event.stopPropagation(); dragDepth.current += 1; if (!busy && !disabled) setDragging(true); }}
    onDragOver={(event) => { if (!fileDrag(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy || disabled ? "none" : "copy"; }}
    onDragLeave={(event) => { if (!fileDrag(event)) return; event.stopPropagation(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={(event) => { if (!fileDrag(event)) return; event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); receiveFiles(Array.from(event.dataTransfer.files || [])); }}>
    <span className="sr-only" id={helpId}>{AI_ATTACHMENT_HELP}电脑上 Enter 发送，Shift 加 Enter 换行；触屏设备回车换行，点击发送按钮提交。</span>
    {files.length > 0 && <div className="ai-attachments" aria-label={`待发送附件，共 ${files.length} 份`}>{files.map((entry) => <span className="ai-attachment" key={entry.id}>
      <FileText size={19} weight="duotone" aria-hidden="true" /><span title={entry.file.name}>{entry.file.name}</span>
      {entry.documentId ? <small>已保存</small> : null}
      <button type="button" disabled={busy || disabled} aria-label={`移除 ${entry.file.name}`} onClick={() => { onRemoveFile(entry.id); setFeedback(null); textareaRef.current?.focus({ preventScroll: true }); }}><X size={16} /></button>
    </span>)}</div>}
    <div className="ai-composer-row">
      <input ref={inputRef} className="ai-file-input" type="file" multiple accept={AI_ATTACHMENT_ACCEPT} aria-label="添加银行流水或票据" onChange={(event) => { receiveFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      <button className="ai-attach-button" type="button" disabled={busy || disabled} aria-label="添加银行流水或票据" aria-describedby={helpId} title={AI_ATTACHMENT_HELP} onClick={() => inputRef.current?.click()}><Paperclip size={home ? 31 : 26} /></button>
      <textarea ref={textareaRef} aria-label="告诉财务助手你想处理什么" aria-describedby={`${helpId}${feedback?.message ? ` ${noticeId}` : ""}`} rows={1} value={value} disabled={busy || disabled} placeholder={home ? "今天想处理什么财务事项？" : "补充信息，或添加资料…"}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; compositionEndRef.current = performance.now(); }}
        onPaste={(event) => { const selected = Array.from(event.clipboardData?.files || []); if (!selected.length) return; if (!event.clipboardData.getData("text/plain")) event.preventDefault(); receiveFiles(selected); }}
        onKeyDown={(event) => {
          const composing = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
          const touch = window.matchMedia("(pointer: coarse)").matches;
          if (shouldSendFromKey({ key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, keyCode: event.nativeEvent.keyCode, isComposing: event.nativeEvent.isComposing, composing, compositionJustEnded: performance.now() - compositionEndRef.current < 50, touch, busy, disabled, hasContent: !!value.trim() || files.length > 0 })) { event.preventDefault(); onSend(); }
          else if (event.key === "Enter" && !event.shiftKey && !event.altKey && !touch && !composing && performance.now() - compositionEndRef.current >= 50) event.preventDefault();
        }} />
      {busy ? <button className="ai-send-button ai-stop-button" type="button" onClick={onCancel} aria-label="停止处理" title="停止处理"><Stop size={21} weight="fill" /></button>
        : <button className="ai-send-button" type="submit" disabled={!canSend} aria-label="发送"><ArrowUp size={home ? 31 : 27} weight="bold" /></button>}
    </div>
    {!home && modelLabel && <button type="button" className="ai-text-button ai-current-model" disabled={busy} onClick={onOpenSettings} title={busy ? "本次整理期间模型保持不变" : "选择模型与思考模式"} aria-label={`${busy ? "本次整理模型" : "当前模型"}：${modelLabel}${busy ? "" : "，打开 DeepSeek 设置"}`}><span>{modelLabel}</span><CaretDown size={14} aria-hidden="true" /></button>}
    {(feedback?.message || dragging) && <div className={`ai-composer-feedback${feedback?.tone === "warning" ? " is-warning" : ""}`} role="status" id={noticeId}>{dragging ? "松开即可添加资料" : feedback?.message}{feedback?.tone === "warning" && <small>{AI_ATTACHMENT_HELP}</small>}</div>}
  </form>;
}
