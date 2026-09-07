import { createDocumentMetadata } from "../../src/features/intake/documentIntake.js";
import { createMemoryFileVault } from "../../src/features/intake/browserFileVault.js";

// Synthetic originals for success-path fixtures only. Negative evidence tests must
// construct their own missing/corrupt files instead of invoking this helper.
export async function withVoucherEvidence(input) {
  const workspace = structuredClone(input);
  workspace.id ||= "fixture-workspace";
  const fileVault = createMemoryFileVault();
  const documents = [];
  for (const document of (workspace.documents || []).filter((item) => !item.id.startsWith("fixture-original-"))) {
    const blob = new Blob([`Fixture original for ${document.id}`], { type: "text/plain" });
    const metadata = await createDocumentMetadata(blob, { ...document, id: document.id, name: document.name || `${document.id}.txt`, period: document.period || workspace.currentPeriod });
    const saved = { ...document, hash: metadata.hash, size: blob.size, storage: { ...(document.storage || {}), mode: "indexeddb", blobId: document.storage?.blobId || document.id, availableLocally: true } };
    documents.push(saved);
    await fileVault.put({ id: saved.storage.blobId, workspaceId: workspace.id, hash: saved.hash, size: blob.size, blob });
  }
  const ids = [];
  for (const type of ["bankStatement", "contract", "order", "invoice", "approval", "payroll", "attendance", "refundBasis", "purchaseOrder", "transferReceipt"]) {
    const id = `fixture-original-${type}`;
    const blob = new Blob([`Synthetic ${type} original for a legal posting fixture`], { type: "text/plain" });
    const document = await createDocumentMetadata(blob, { id, name: `${type}.txt`, period: workspace.currentPeriod });
    Object.assign(document, { type, category: type });
    documents.push(document);
    ids.push(id);
    await fileVault.put({ id: document.storage?.blobId || id, workspaceId: workspace.id, hash: document.hash, size: blob.size, blob });
  }
  workspace.documents = documents;
  for (const collection of ["transactions", "businessEvents", "bills", "contracts", "invoices", "approvals", "inventoryMovements", "payrollRecords", "payrollImports", "advanceApplications"]) {
    for (const record of workspace[collection] || []) record.evidenceIds = [...new Set([...(record.evidenceIds || []), ...ids])];
  }
  for (const voucher of workspace.vouchers || []) {
    if (["draft", "changes_requested"].includes(voucher.status)) voucher.evidenceIds = [...new Set([...(voucher.evidenceIds || []), ...ids])];
  }
  return { workspace, fileVault };
}
