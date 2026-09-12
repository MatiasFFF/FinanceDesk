import * as XLSX from "xlsx";

const safeFileName = (value) => String(value).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim();

export function buildAiReportExcelWorkbook(model, { generatedAt = new Date().toISOString() } = {}) {
  const workbook = XLSX.utils.book_new();
  const prefix = (title) => [
    [title], ["工作台", model.workspaceName], ["账期", model.period], ["报表性质", model.copyStatus],
    ["计算口径", model.basis], ["已入账凭证数", model.postedCount], ["待入账凭证数（不计入金额）", model.pendingCount],
    ["待核对事项数", model.notes.length], ["生成时间", generatedAt], ["导出方式", "本地导出；未上传网络"], [],
  ];
  function append(title, headers, values, moneyColumns = []) {
    const intro = prefix(title);
    const rows = [...intro, headers, ...values];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = headers.map((header, index) => ({ wch: /来源|摘要|原因|说明|口径/.test(header) ? 48 : moneyColumns.includes(index) ? 18 : 24 }));
    values.forEach((row, rowIndex) => moneyColumns.forEach((columnIndex) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: intro.length + 1 + rowIndex, c: columnIndex })];
      if (cell?.t === "n") cell.z = "#,##0.00;[Red]-#,##0.00;0.00";
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, title);
  }
  for (const section of model.sections) {
    append(section.title, ["项目", "金额（元）", "来源引用 ID", "本期凭证 ID"], section.rows.map((row) => [row.label, row.value, row.sourceIds.join("；"), row.voucherIds.join("；")]), [1]);
  }
  append("科目明细", ["报表", "分类", "科目 ID", "科目名称", "报表金额（元）", "期初借方余额（贷方为负）", "本期借方", "本期贷方", "期末借方余额（贷方为负）", "本期凭证 ID", "来源引用 ID"],
    model.sections.flatMap((section) => section.details.map((line) => [section.title, line.group, line.id, line.label, line.value,
      line.account.opening, line.account.debit, line.account.credit, line.account.closing, line.voucherIds.join("；"), line.sourceIds.join("；")])), [4, 5, 6, 7, 8]);
  const cash = model.sections.find((section) => section.id === "cashflow");
  append("来源明细", ["来源类型", "科目或分类", "科目 ID", "日期", "凭证编号", "凭证 ID", "摘要或说明", "借方金额", "贷方金额", "期初余额或现金变动", "来源引用 ID", "原件引用 ID"], [
    ...model.sources.map((source) => source.type === "opening"
      ? ["期初余额", source.accountLabel, source.accountId, source.date, "", "", "借方为正、贷方为负；期初余额不是本期凭证", "", "", source.opening, source.sourceId, ""]
      : ["已入账凭证分录", source.accountLabel, source.accountId, source.date, source.voucherNo || source.voucherId, source.voucherId, source.summary || "", source.debit, source.credit, "", source.sourceIds.join("；"), source.evidenceIds.join("；")]),
    ...cash.cashGroups.flatMap((group) => group.entries.map((entry) => ["现金流分类", group.label, "", entry.date, "", entry.voucherId, entry.reason && group.id === "pending" ? entry.reason : entry.summary || "", "", "", entry.amount, entry.sourceIds.join("；"), ""])),
  ], [7, 8, 9]);
  append("核对状态", ["事项", "状态", "原因或说明", "差额（元）", "相关凭证 ID", "来源引用 ID"], [
    ["本期报表", model.copyStatus, "本次导出不冻结报表、不确认结账、不改变凭证状态。"],
    ["账期", model.archived ? "已归档，只读" : "未归档", model.period],
    ["待入账凭证", model.pendingCount ? "未完成" : "当前无待入账凭证", `${model.pendingCount} 张；不计入三张报表金额。`, "", model.pending.map((voucher) => voucher.id).join("；")],
    ...model.notes.filter((note) => note.id === "opening").map((note) => [note.title, "未完成", note.detail]),
    ...model.checkResults.map((check) => [check.label, check.passed ? "通过" : "待核对", check.detail, check.difference, check.voucherIds.join("；"), check.sourceIds.join("；")]),
    ...model.pending.map((voucher) => ["未计入报表的凭证", voucher.status === "changes_requested" ? "退回修订" : "草稿", `${voucher.no || voucher.id} · ${voucher.date || "日期待补"} · ${voucher.summary || ""}`, "", voucher.id]),
  ], [3]);
  return { workbook, metadata: {
    workspaceId: model.workspaceId, period: model.period, fileName: `${safeFileName(model.workspaceName)}-${model.period}-本期核对稿.xlsx`,
    generatedAt, sheetNames: [...workbook.SheetNames], copyStatus: model.copyStatus, postedCount: model.postedCount,
    pendingCount: model.pendingCount, unresolvedCount: model.notes.length, localOnly: true, uploaded: false, frozen: false,
  } };
}

// Generation has no DOM, download, workspace mutation, or implicit freezing.
export async function generateAiReportExcel(model, options = {}) {
  const { workbook, metadata } = buildAiReportExcelWorkbook(model, options);
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
  const bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return { bytes, blob, metadata: { ...metadata, size: blob.size } };
}

export function downloadAiReportExcel({ blob, metadata }) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = metadata.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    return { ...metadata, downloadRequested: true };
  } finally {
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
