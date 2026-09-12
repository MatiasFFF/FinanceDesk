import { useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, FileText, Robot } from "@phosphor-icons/react";
import { createAiFinanceService } from "../../application/aiFinanceService.js";
import { runFinanceAssistant } from "../../application/deepseekClient.js";
import { AI_FINANCE_SYSTEM } from "../../application/aiFinanceTools.js";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { isPeriodArchived } from "../../domain/periods.js";
import { usePeriodLeaveGuard } from "../workspaces/periodNavigation.js";
import { AiComposer } from "./AiComposer.jsx";
import { AiDialog } from "./AiDialog.jsx";
import { AiProposalPreview, proposalHasPreview } from "./AiProposalPreview.jsx";

const proposalLabels = { bank_import: "流水导入待确认", bank_business: "业务归属待确认", document_fields: "票据资料待确认" };
const cleanText = (value, key = "") => (key ? String(value || "").split(key).join("[密钥已隐藏]") : String(value || "")).replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]");

function ProposalReview({ proposals, service, busy, onConfirm, onDismiss, onClose, onOriginal, onAccountCreated, onTransaction, workspace }) {
  const [notes, setNotes] = useState({});
  const [error, setError] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  return <AiDialog wide title={pending.length ? "查看并确认" : !workspace.bankAccounts?.length ? "添加银行账户" : "确认事项"} onClose={() => { if (!busy && !accountBusy) onClose(); }}>
    <p className="ai-helper">{workspace.name} · {workspace.currentPeriod}。确认前请核对来源与内容，凭证入账仍需单独复核。</p>
    {error && <p className="ai-error" role="alert">{error}</p>}
    {!workspace.bankAccounts?.length && <form className="ai-proposal" onSubmit={async (event) => { event.preventDefault(); setAccountBusy(true); setError(""); try { await service.createBankAccount({ name: accountName.trim(), accountNumber: accountNumber.trim() }); onAccountCreated(); } catch (caught) { setError(caught.message); } finally { setAccountBusy(false); } }}>
      <h3>先添加流水所属银行账户</h3><div className="ai-settings-form"><label className="ai-field"><span>账户名称</span><input required value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="例如：公司基本户" /></label><label className="ai-field"><span>账号后四位（可选）</span><input inputMode="numeric" maxLength={4} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))} /></label><div className="ai-dialog-actions"><button className="ai-primary-button" type="submit" disabled={!accountName.trim() || accountBusy}>{accountBusy ? "正在保存…" : "添加账户"}</button></div></div>
    </form>}
    <div className="ai-proposal-list">{pending.length ? pending.map((proposal) => <section className="ai-proposal" key={proposal.id}>
      <h3>{proposal.title || proposalLabels[proposal.kind] || "待确认事项"}</h3>
      {proposal.summary && <p>{proposal.summary}</p>}
      <AiProposalPreview proposal={proposal} workspace={workspace} />
      <div className="ai-proposal-originals">{(proposal.sourceIds || []).filter((id) => workspace.documents?.some((document) => document.id === id)).map((id) => <button type="button" className="ai-text-button" key={id} onClick={() => onOriginal(id)}><FileText size={16} />{workspace.documents.find((document) => document.id === id)?.name || "查看原件"}</button>)}</div>
      {proposal.kind === "bank_business" && proposal.preview?.transaction?.id && <button type="button" className="ai-text-button" disabled={busy} onClick={() => onTransaction(proposal.preview.transaction.id)}>打开这笔流水，补充或调整</button>}
      <label className="ai-field"><span>补充说明（可选）</span><textarea value={notes[proposal.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [proposal.id]: event.target.value }))} placeholder="有需要说明的内容，可以写在这里" /></label>
      <div className="ai-dialog-actions"><button type="button" className="ai-text-button" disabled={busy} onClick={async () => { try { setError(""); await onDismiss(proposal.id); } catch (caught) { setError(caught.message); } }}>暂不采用</button><button className="ai-primary-button" type="button" disabled={busy || !proposalHasPreview(proposal)} onClick={async () => { try { setError(""); await onConfirm(proposal.id, notes[proposal.id]?.trim() || ""); } catch (caught) { setError(caught.message); } }}>{busy ? "正在处理…" : proposal.kind === "bank_import" ? "确认导入" : proposal.kind === "bank_business" ? proposal.preview?.voucher ? "确认业务并生成草稿" : "确认业务归属" : "确认并保存"}</button></div>
    </section>) : workspace.bankAccounts?.length ? <p className="ai-empty-copy">当前待确认事项已处理完，可以返回对话继续整理。</p> : null}</div>
  </AiDialog>;
}

function OriginalPreview({ original, onClose }) {
  const [url, setUrl] = useState("");
  useEffect(() => { if (!original?.blob) return undefined; const value = URL.createObjectURL(original.blob); setUrl(value); return () => URL.revokeObjectURL(value); }, [original]);
  const name = original.name || original.fileName || "原件";
  const type = original.mimeType || original.blob?.type || "";
  return <AiDialog wide title={name} onClose={onClose}>
    {url && (type.startsWith("image/") ? <img className="ai-original-preview" src={url} alt={name} /> : type === "application/pdf" || /\.pdf$/i.test(name) ? <iframe className="ai-original-preview ai-original-pdf" title={name} src={url} /> : <p className="ai-helper">表格原件可下载到本机查看，也可在“资料与报表”的流水页核对已导入记录。</p>)}
    {url && <div className="ai-dialog-actions"><a className="ai-primary-button" href={url} download={name}>下载原件</a></div>}
  </AiDialog>;
}

export default function AiConversation({ draft, onDraftChange, readKey, configured, requestSettings, autoSendNonce, onBusyChange, onOpenResources, onToast }) {
  const { store, fileVault, activeWorkspace, persistenceStatus, state } = useFinanceDesk();
  const workspaceId = activeWorkspace.id;
  const period = activeWorkspace.currentPeriod;
  const service = useMemo(() => createAiFinanceService({ store, fileVault, workspaceId, period }), [store, fileVault, workspaceId, period, state.activeUserId]);
  let conversation = { messages: [], proposals: [] };
  let accessError = "";
  try { conversation = service.getConversation(); } catch (caught) { accessError = caught.message || "请在我的工作台中选择有效操作身份。"; }
  const messages = conversation.messages || [];
  const proposals = conversation.proposals || [];
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const lastUserAt = [...messages].reverse().find((message) => message.role === "user")?.createdAt || "";
  const recentApplied = proposals.filter((proposal) => proposal.status === "applied" && (proposal.appliedAt || "") >= lastUserAt).slice(-5);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [original, setOriginal] = useState(null);
  const [accountAdded, setAccountAdded] = useState(false);
  const jobRef = useRef(null);
  const sendRef = useRef(null);
  const sentNonce = useRef(0);
  const listRef = useRef(null);
  const mountedRef = useRef(true);
  usePeriodLeaveGuard({ busy: () => !!jobRef.current });
  const archived = isPeriodArchived(activeWorkspace);
  const needsBankAccount = !activeWorkspace.bankAccounts?.length && (messages.some((message) => message.attachments?.some((file) => file.kind === "bank")) || draft.files.some((entry) => /\.(csv|xlsx?)$/i.test(entry.file.name)));

  function status(value) { if (mountedRef.current) setProgress(value); }
  function startJob(label) {
    if (jobRef.current) return null;
    const controller = new AbortController(); jobRef.current = controller;
    setBusy(true); onBusyChange(true); setError(""); status(label);
    return controller;
  }
  function finishJob(controller) {
    if (jobRef.current !== controller) return;
    jobRef.current = null;
    if (mountedRef.current) { setBusy(false); onBusyChange(false); status(""); }
  }
  async function requestReply(controller) {
    status("正在整理本期资料…");
    const context = await service.getContext("overview");
    const history = service.getConversation().messages.slice(-20).map((message) => ({ role: message.role, content: cleanText(message.content, readKey()) + (message.attachments?.length ? `\n本次附件：${JSON.stringify(message.attachments.map(({ documentId, name, kind }) => ({ documentId, name, kind })))}` : "") }));
    const result = await runFinanceAssistant({ apiKey: readKey(), signal: controller.signal,
      messages: [{ role: "system", content: `${AI_FINANCE_SYSTEM}\n当前工作台与账期：${JSON.stringify(context)}\n面向用户的回复使用文件名、日期和凭证编号，不显示内部ID、JSON、工具名称或程序操作名称。` }, ...history],
      executeTool: async ({ name, arguments: args, signal }) => { status(name === "read_document" ? "正在读取已保存的票据…" : name === "prepare_bank_import" ? "正在整理银行流水…" : "正在核对当前工作台…"); return service.invokeTool(name, args, { signal }); },
      onToolResult: () => status("核对结果已保留，正在继续整理…"),
    });
    controller.signal.throwIfAborted();
    if (result.message?.content) await service.appendMessage({ role: "assistant", content: cleanText(result.message.content, readKey()) });
    setRetryAvailable(false);
    setAccountAdded(false);
  }
  async function send(retry = false, prompt = null) {
    const submission = prompt ? { text: prompt, files: [] } : draft;
    if (jobRef.current || (!retry && !submission.text.trim() && !submission.files.length)) return;
    if (!readKey()) { requestSettings(); return; }
    const controller = startJob(submission.files.length && !retry ? "正在保存原件…" : "正在联系财务助手…");
    if (!controller) return;
    let userMessageSaved = retry;
    try {
      if (!retry) {
        const attachments = [];
        for (const entry of submission.files) {
          controller.signal.throwIfAborted();
          let saved = entry.uploaded;
          if (!saved || (saved.kind === "document" && saved.recognitionStatus !== "completed")) {
            try {
              const result = await service.uploadFiles([entry.file], { signal: controller.signal, onProgress: (value) => status(typeof value === "string" ? value : value?.message || `正在保存和识别 ${entry.file.name}…`) });
              saved = result[0];
            } catch (caught) {
              const partial = caught.uploaded?.[0];
              if (partial?.documentId) onDraftChange((current) => ({ ...current, files: current.files.map((item) => item.id === entry.id ? { ...item, uploaded: partial, documentId: partial.documentId } : item) }));
              throw caught;
            }
            if (!saved?.documentId) throw new Error(`未能保存「${entry.file.name}」，请保留附件后重试。`);
            onDraftChange((current) => ({ ...current, files: current.files.map((item) => item.id === entry.id ? { ...item, uploaded: saved, documentId: saved.documentId } : item) }));
          }
          attachments.push({ documentId: saved.documentId, name: saved.name || entry.file.name, kind: saved.kind });
        }
        controller.signal.throwIfAborted();
        await service.appendMessage({ role: "user", content: cleanText(submission.text.trim() || "请整理这些资料并指出需要我确认的事项。", readKey()), attachments });
        userMessageSaved = true;
        if (!prompt) onDraftChange({ text: "", files: [] });
      }
      await requestReply(controller);
    } catch (caught) {
      if (mountedRef.current) {
        setError(controller.signal.aborted ? "已停止。本次已保存的原件和待确认事项会保留。" : cleanText(caught.message || "本次整理未完成，输入与已保存的资料会保留。", readKey()));
        setRetryAvailable(userMessageSaved);
        if (caught.code === "KEY_REQUIRED") requestSettings();
      }
    } finally { finishJob(controller); }
  }
  sendRef.current = send;
  async function showOriginal(id) {
    try { const record = await service.readOriginal(id); if (!record?.blob) throw new Error("本机未找到这份原件，请在资料中重新关联。"); setOriginal(record); }
    catch (caught) { onToast(caught.message); }
  }
  async function confirm(id, reason) {
    const controller = startJob("正在保存确认结果…");
    if (!controller) return;
    try { const result = await service.confirmProposal(id, { reason, signal: controller.signal }); if (result.message) onToast(result.message); if (!service.getConversation().proposals.some((proposal) => proposal.status === "pending")) setReviewOpen(false); }
    finally { finishJob(controller); }
  }
  async function dismiss(id) { await service.dismissProposal(id); }
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; jobRef.current?.abort(); onBusyChange(false); };
  }, [onBusyChange]);
  useEffect(() => {
    if (!autoSendNonce || sentNonce.current === autoSendNonce) return undefined;
    const timer = setTimeout(() => { sentNonce.current = autoSendNonce; void sendRef.current(); }, 0);
    return () => clearTimeout(timer);
  }, [autoSendNonce]);
  useEffect(() => { const element = listRef.current; if (element) element.scrollTop = element.scrollHeight; }, [messages.length, pending.length, busy]);

  return <section className="ai-conversation" aria-label="财务助手会话">
    <div className="ai-message-list" ref={listRef} role="log" aria-label="当前账期对话" aria-live="polite">
      {!messages.length && <div className="ai-conversation-empty"><div className="ai-assistant-avatar"><Robot size={30} weight="fill" /></div><p>把这个月的流水或票据发给我，我们从这里开始。</p></div>}
      {messages.map((message) => message.role === "user" ? <article className="ai-message ai-message-user" key={message.id}><p className="ai-message-text">{message.content}</p>{!!message.attachments?.length && <div className="ai-message-files">{message.attachments.map((file) => <button type="button" key={file.documentId} className="ai-message-file" onClick={() => showOriginal(file.documentId)}><FileText size={23} weight="duotone" /><span>{file.name}</span></button>)}</div>}</article>
        : <article className="ai-message ai-message-assistant" key={message.id}><div className="ai-assistant-avatar"><Robot size={30} weight="fill" /></div><div><span className="ai-assistant-label">财务助手</span><p className="ai-message-text">{message.content}</p></div></article>)}
      {!!pending.length && <div className="ai-confirmation-summary"><dl className="ai-confirmation-counts">{Object.entries(proposalLabels).map(([kind, label]) => { const count = pending.filter((proposal) => proposal.kind === kind).length; return count ? <div key={kind}><dt>{label}</dt><dd>{count} 笔</dd></div> : null; })}</dl><button className="ai-primary-button" type="button" disabled={busy} onClick={() => setReviewOpen(true)}>查看并确认</button></div>}
      {needsBankAccount && !pending.length && <div className="ai-confirmation-summary"><p className="ai-helper">整理这批流水前，需先确定它属于哪个银行账户。</p><button className="ai-primary-button" type="button" disabled={busy || archived || !persistenceStatus.canWrite} onClick={() => setReviewOpen(true)}>添加银行账户</button></div>}
      {!!recentApplied.length && <div className="ai-confirmation-summary ai-confirmation-results">{recentApplied.map((proposal) => <div key={proposal.id}><p>{proposal.message || "确认结果已保存。"}</p>{proposal.result?.voucherId ? <button className="ai-text-button" type="button" disabled={busy} onClick={() => onOpenResources({ initialTab: "vouchers", voucherId: proposal.result.voucherId })}>查看并复核凭证</button> : proposal.result?.transactionId ? <button className="ai-text-button" type="button" disabled={busy} onClick={() => onOpenResources({ transactionId: proposal.result.transactionId })}>补充这笔流水的资料</button> : null}</div>)}</div>}
      {(accountAdded || (recentApplied.length > 0 && !pending.length)) && <div className="ai-confirmation-summary"><button className="ai-primary-button" type="button" disabled={busy || archived || !persistenceStatus.canWrite} onClick={() => accountAdded && (draft.text.trim() || draft.files.length) ? send() : send(false, accountAdded ? "银行账户已添加，请继续整理刚才的流水。" : "请根据刚才的确认结果，继续整理本期流水和票据。")}>继续整理</button></div>}
      {busy && <p className="ai-processing" role="status"><CircleNotch size={18} />{progress}</p>}
    </div>
    <div className="ai-conversation-footer">
      {(error || accessError) && <div className="ai-error" role="alert">{accessError || error}{!accessError && retryAvailable && !busy && <button className="ai-inline-button" type="button" onClick={() => send(true)}>继续本次整理</button>}</div>}
      {archived && <p className="ai-helper">本期已归档，只能查看资料、凭证与报表。选择未归档账期后可继续整理。</p>}
      <AiComposer value={draft.text} files={draft.files} onChange={(text) => onDraftChange((current) => ({ ...current, text }))} onFiles={(files) => onDraftChange((current) => ({ ...current, files: [...current.files, ...files.map((file) => ({ id: crypto.randomUUID(), file }))] }))} onRemoveFile={(id) => onDraftChange((current) => ({ ...current, files: current.files.filter((entry) => entry.id !== id) }))} onSend={() => send()} busy={busy} onCancel={() => { status("正在停止…"); jobRef.current?.abort(); }} disabled={archived || !persistenceStatus.canWrite || !!accessError} />
    </div>
    {reviewOpen && <ProposalReview proposals={proposals} service={service} busy={busy} onConfirm={confirm} onDismiss={dismiss} onClose={() => setReviewOpen(false)} onOriginal={showOriginal} onAccountCreated={() => { setReviewOpen(false); setAccountAdded(true); onToast("银行账户已添加，可以继续整理流水。"); }} onTransaction={(transactionId) => { setReviewOpen(false); onOpenResources({ transactionId }); }} workspace={activeWorkspace} />}
    {original && <OriginalPreview original={original} onClose={() => setOriginal(null)} />}
  </section>;
}
