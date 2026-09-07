import { activateWorkspacePeriod } from "./periods.js";

const FINANCE_TAX_FIELDS = ["financeConfirmedAt", "financeConfirmedVersionId", "payrollConfirmedAt", "payrollConfirmedVersionId", "payrollConfirmedFingerprint", "socialSecurityConfirmedAt", "socialSecurityConfirmedVersionId", "socialSecurityConfirmedFingerprint"];
const OWNER_TAX_FIELDS = ["ownerConfirmedAt", "ownerConfirmedVersionId", "finalConfirmationId"];
const changed = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
const hasNewValue = (before, after, fields) => fields.some((field) => after?.[field] && changed(before?.[field], after[field]));

// Only confirmation claims are protected here. Invalidating their markers and
// viewing an already saved period do not grant a new confirmation.
export function confirmationWritePermissions(previous, next) {
  const permissions = new Set();
  const existing = new Map((previous.confirmations || []).map((record) => [record.id, record]));
  for (const record of next.confirmations || []) {
    const before = existing.get(record.id);
    if (!changed(before, record)) continue;
    if (record.kind === "final") {
      if (record.status === "approved") permissions.add("confirm.owner");
    } else if (record.status === "approved" || record.decisions?.length || Object.values(record.sections || {}).some((section) => ["approved", "rejected"].includes(section.status))) {
      permissions.add("confirm.finance");
    }
  }
  const periods = new Map(Object.entries(next.periodStates || {}));
  periods.set(next.currentPeriod, { tax: next.tax, filing: next.delivery?.filing });
  for (const [period, target] of periods) {
    const current = period === previous.currentPeriod ? previous : activateWorkspacePeriod(previous, period);
    if (hasNewValue(current.tax, target.tax, FINANCE_TAX_FIELDS)
      || hasNewValue(current.delivery?.filing, target.filing, ["initialConfirmationId"])) permissions.add("confirm.finance");
    if (hasNewValue(current.tax, target.tax, OWNER_TAX_FIELDS)
      || (target.tax?.ownerConfirmedAt && hasNewValue(current.tax, target.tax, ["confirmedBy"]))
      || hasNewValue(current.delivery?.filing, target.filing, ["finalConfirmedVersionId"])) permissions.add("confirm.owner");
  }
  return [...permissions];
}
