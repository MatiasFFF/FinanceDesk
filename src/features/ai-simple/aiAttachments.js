export const AI_ATTACHMENT_LIMIT = 20;
export const AI_ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;
export const AI_ATTACHMENT_ACCEPT = ".csv,.xls,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff";
export const AI_ATTACHMENT_HELP = "支持 CSV、Excel、PDF 和常见票据图片；每份不超过 30 MB，每次最多 20 份。";

const extensions = new Set(["csv", "xls", "xlsx", "pdf", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"]);
const mimeTypes = new Set(["text/csv", "application/pdf", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff"]);

export function attachmentIdentity(file) {
  return JSON.stringify([file?.name || "", file?.size || 0, file?.type || "", file?.lastModified || 0]);
}

export function attachmentIssue(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) return "empty";
  const extension = String(file.name || "").match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (extension ? !extensions.has(extension) : !mimeTypes.has(String(file.type || "").toLowerCase())) return "type";
  if (file.size > AI_ATTACHMENT_MAX_BYTES) return "size";
  return null;
}

export function selectAiAttachments(incoming, existing = []) {
  const accepted = [];
  const rejected = [];
  const duplicates = [];
  const seen = new Set(existing.map((entry) => attachmentIdentity(entry.file || entry)));
  for (const file of Array.from(incoming || [])) {
    const issue = attachmentIssue(file);
    if (issue) { rejected.push({ file, reason: issue }); continue; }
    const identity = attachmentIdentity(file);
    if (seen.has(identity)) { duplicates.push(file); continue; }
    if (existing.length + accepted.length >= AI_ATTACHMENT_LIMIT) { rejected.push({ file, reason: "count" }); continue; }
    seen.add(identity);
    accepted.push(file);
  }
  const reasons = { empty: "文件为空", type: "格式暂不支持", size: "超过 30 MB", count: "超出每次 20 份的限制" };
  const parts = [];
  if (accepted.length) parts.push(`已添加 ${accepted.length} 份资料`);
  if (duplicates.length) parts.push(`已略过 ${duplicates.length} 份重复附件`);
  if (rejected.length) parts.push(rejected.slice(0, 3).map(({ file, reason }) => `「${file?.name || "文件"}」${reasons[reason]}`).join("；") + (rejected.length > 3 ? `，另有 ${rejected.length - 3} 份未添加` : ""));
  return { accepted, rejected, duplicates, message: parts.join("；") + (parts.length ? "。" : ""), tone: rejected.length ? "warning" : "info" };
}

export function shouldSendFromKey({ key, shiftKey, altKey, isComposing, keyCode, composing, compositionJustEnded, touch, busy, disabled, hasContent }) {
  return key === "Enter" && !shiftKey && !altKey && !isComposing && keyCode !== 229 && !composing && !compositionJustEnded && !touch && !busy && !disabled && !!hasContent;
}
