import { createBlankWorkspace } from "../../src/domain/foundation.js";
import { confirmOpeningBalances } from "../../src/domain/periods.js";
import { freezeReportVersion, recordInitialConfirmationSection, prepareFilingDraft, recordFinalConfirmation, markPackageExported } from "../../src/productWorkflow.js";

export function filingWorkspace() {
  let workspace = createBlankWorkspace({ id: "filing-target", name: "回执验收", currentPeriod: "2026-09", modules: { reconcile: false, tax: true, payroll: false } });
  workspace = freezeReportVersion(confirmOpeningBalances(workspace, {}), "测试会计");
  const version = workspace.delivery.reportVersions.at(-1);
  for (const section of ["finance", "revenue", "costExpense", "vat", "inputVat", "openItems"]) {
    workspace = recordInitialConfirmationSection(workspace, { reportVersionId: version.id, section, decision: "approve", note: "已核对冻结金额和来源", confirmationName: "客户负责人" }, { actor: "测试会计" });
  }
  workspace = prepareFilingDraft(workspace, "测试会计");
  workspace = recordFinalConfirmation(workspace, { reportVersionId: version.id, filingDraftCreatedAt: workspace.delivery.filing.draftCreatedAt,
    name: "客户负责人", selections: { numbersReviewed: true, risksAcknowledged: true, localOnlyAcknowledged: true, deductionAuthorization: "do_not_authorize" } }, { actor: "测试会计" });
  return markPackageExported(workspace, { id: "package-original", hash: "package-original-hash", reportVersionId: version.id, fileName: "申报包.zip", size: 100,
    exportedAt: new Date().toISOString() }, "测试会计");
}
