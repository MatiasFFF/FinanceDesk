export const bankMoney = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? "待核对"
  : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function bankAccountLabel(account = {}) {
  const name = account.name || account.sourceAccountName || account.sourceBank || "银行账户";
  const tail = String(account.accountTail || account.accountNumber || account.sourceAccount || "").replace(/\s/g, "").slice(-4);
  return `${name}${tail && !name.includes(`尾号${tail}`) && !name.includes(`尾号 ${tail}`) ? ` · 尾号 ${tail}` : ""}`;
}

// Counts and totals always come from the full-file calculation. The twenty
// preview transactions are samples and must never become the totals shown here.
export function bankGroupView(proposal) {
  const preview = proposal.preview || {};
  const group = preview.group || {};
  const summary = preview.summary || group.summary || {};
  const resolution = preview.accountResolution || {};
  const label = bankAccountLabel({ name: [...new Set([group.sourceBank, group.sourceAccountName].filter(Boolean))].join(" · ") || preview.accountName,
    accountTail: group.accountTail, accountNumber: group.sourceAccount });
  const alreadyImported = proposal.status === "already_imported";
  const imported = proposal.status === "applied" || alreadyImported;
  const blocked = !imported && (preview.canConfirm === false || ["ambiguous", "missing"].includes(resolution.status) || Number(preview.errorCount || summary.errorCount) > 0);
  const status = alreadyImported ? "已导入，无新增" : imported ? "已导入" : proposal.status === "failed" ? "导入失败" : blocked
    ? ["ambiguous", "missing"].includes(resolution.status) ? "待确认账户" : "需修正原件" : "待确认导入";
  return { label, summary, group, resolution, status, blocked,
    rowCount: summary.rowCount ?? group.rowCount ?? null,
    dateRange: summary.dateFrom && summary.dateTo ? summary.dateFrom === summary.dateTo ? summary.dateFrom : `${summary.dateFrom} 至 ${summary.dateTo}` : "待核对",
    confirmLabel: resolution.status === "new" ? "确认账户并导入本组" : group.groupId || preview.sourceGroupId ? "确认导入本组" : "确认导入" };
}

export function bankSourceRows(group = {}) {
  const rows = group.sourceRowNumbers || [];
  if (!rows.length) return "原表行号待核对";
  return `原表第 ${rows.slice(0, 8).join("、")}${rows.length > 8 ? ` 等 ${rows.length}` : ""} 行`;
}

export function bankRetrySettings(saved, recovery, disableThinking = false) {
  const settings = recovery?.modelSettings || saved;
  return { ...settings, ...(disableThinking ? { thinking: "disabled" } : {}) };
}

export function hasLocalBankAttachments(draft) {
  return !!draft?.files?.some((entry) => /\.(csv|xlsx?)$/i.test(entry.file?.name || ""));
}

export function bankAccountDraft(proposal, workspace) {
  const preview = proposal.preview || {};
  const resolution = preview.accountResolution || {};
  const suggested = resolution.suggestedAccount || {};
  const candidates = (resolution.candidateAccounts?.length ? resolution.candidateAccounts : workspace.bankAccounts || []).filter((account) => account.status !== "inactive");
  return { candidates, mustChoose: ["ambiguous", "missing"].includes(resolution.status),
    accountId: resolution.status === "existing" ? resolution.accountId || "" : resolution.status === "new" || !candidates.length ? "new" : "",
    name: suggested.name || preview.group?.sourceAccountName || preview.group?.sourceBank || "",
    accountNumber: String(suggested.accountNumber || preview.group?.accountTail || preview.group?.sourceAccount || "").replace(/\s/g, "").match(/\d{4}$/)?.[0] || "" };
}

export function bankAmountRows(preview) {
  const summary = preview.summary || preview.group?.summary || {};
  const original = [["原表收入合计", `${bankMoney(summary.rawIncome)} 元`], ["原表支出合计", `${bankMoney(summary.rawExpense)} 元`]];
  const changed = Number(summary.duplicateCount || 0) > 0
    || ["Income", "Expense"].some((key) => summary[`raw${key}`] != null && summary[key.toLowerCase()] != null
      && Number(summary[`raw${key}`]) !== Number(summary[key.toLowerCase()]));
  return { main: [...(changed ? original : []), [changed ? "原表收入（去重）" : "原表收入合计", `${bankMoney(summary.income)} 元`], [changed ? "原表支出（去重）" : "原表支出合计", `${bankMoney(summary.expense)} 元`]],
    original: changed ? [] : original };
}

export function bankSaveErrorMessage(error, { importing = false } = {}) {
  const message = error?.message || "本次操作未完成，请稍后重试。";
  if (error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || /(?:quota|storage[_ ]quota|存储空间不足|保存空间不足)/i.test(`${error?.code || ""} ${message}`)) {
    return `本机保存空间不足，${importing ? "本组尚未导入" : "本次操作尚未保存"}，已保存资料和其它分组保留。`;
  }
  return message;
}

export function bankPreparedReadback(result) {
  const groups = (result.alreadyImportedGroups || []).map((existing) => {
    const group = result.analysis?.groups?.find((item) => item.groupId === existing.sourceGroupId);
    return { sourceGroupId: existing.sourceGroupId, counts: existing.counts,
      group: { groupId: existing.sourceGroupId, sourceBank: group?.sourceBank, sourceAccountName: group?.sourceAccountName, accountTail: group?.accountTail },
      summary: group?.summary || {} };
  });
  return { status: result.status, groups, message: result.status === "already_imported" ? result.message || "这份原件已导入，没有新增，不需要再次确认。" : "",
    usable: result.status === "already_imported" || !!result.proposals?.length || !!result.proposal };
}
