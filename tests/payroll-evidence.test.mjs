import test from "node:test";
import assert from "node:assert/strict";
import {
  preparePayrollSocialImport, applyPayrollSocialImport, buildPayrollSocialEvidence,
  verifyPayrollSocialEvidence, createDocumentMetadata, saveLocalDocument, getLocalDocumentUsage,
} from "../src/features/intake/documentIntake.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";

const period = "2026-09";
const mapping = { employee: 0, period: 1, grossSalary: 2, personalSocial: 3, employerSocial: 4, individualIncomeTax: 5, netSalary: 6 };
const headers = ["员工", "所属期", "应发工资", "个人社保", "企业社保", "个人所得税", "实发工资"];

async function fixture() {
  const fileVault = createMemoryFileVault();
  let workspace = {
    id: "payroll-evidence-workspace", currentPeriod: period,
    personnelRecords: [{ id: "person-1", name: "林同事", department: "运营", status: "active" }],
    payrollRecords: [], payrollImports: [], documents: [],
  };
  for (const sourceKind of ["payroll", "socialSecurity"]) {
    const table = [headers, ["林同事", period, 10000, 800, 1600, 250, 8950]];
    const file = Object.assign(new Blob([table.map((row) => row.join(",")).join("\n")], { type: "text/csv" }), { name: `${sourceKind}.csv` });
    const document = await createDocumentMetadata(file, { id: `document-${sourceKind}`, period });
    await fileVault.put({ id: document.id, workspaceId: workspace.id, hash: document.hash, blob: file });
    workspace = { ...workspace, documents: [...workspace.documents, document] };
    const plan = preparePayrollSocialImport(workspace, {
      id: `import-${sourceKind}`, table, mapping, sourceKind, defaultPeriod: period, fileName: file.name,
      sourceDocumentId: document.id, sourceDocumentHash: document.hash, sourceDocumentVersion: document.version,
    });
    assert.equal(plan.canApply, true);
    workspace = applyPayrollSocialImport(workspace, plan, { actor: "资料员" });
  }
  return { workspace, fileVault };
}

test("工资社保依据复用本期汇总并保留人员部门、导入和真实原件哈希版本", async () => {
  const { workspace, fileVault } = await fixture();
  const evidence = buildPayrollSocialEvidence(workspace);
  assert.equal(evidence.canGenerate, true);
  assert.equal(evidence.verified, false);
  assert.equal(evidence.summary.rows[0].person.department, "运营");
  assert.equal(evidence.summary.totals.payroll.grossSalary, 10000);
  assert.equal(evidence.summary.totals.socialSecurityPayable, 2400);
  assert.deepEqual(evidence.sourceRecordIds, workspace.payrollRecords.map((record) => record.id).sort());
  assert.deepEqual(evidence.sourceImportIds, ["import-payroll", "import-socialSecurity"]);
  assert.equal(evidence.sourceIds.length, 4);
  assert.deepEqual(evidence.documents, workspace.documents.map(({ id, hash, version }) => ({ id, hash, version })));
  assert.equal((await verifyPayrollSocialEvidence(workspace, { fileVault })).verified, true);
  assert.equal(getLocalDocumentUsage(workspace, "document-payroll").some((usage) => usage.kind === "payroll-import"), true);
});

test("缺表、未识别人员、缺失金额、一分钱差额与旧导入无原件均不能生成工资计提依据", async (t) => {
  const { workspace } = await fixture();
  const scenarios = [
    ["缺社保表", (next) => { next.payrollRecords = next.payrollRecords.filter((row) => row.sourceKind === "payroll"); }, "missing_social_security"],
    ["未识别人员", (next) => { next.personnelRecords = []; }, "missing_personnel"],
    ["缺少个税值", (next) => { next.payrollRecords[0].individualIncomeTax = null; }, "payroll_amount_missing"],
    ["个人社保差一分钱", (next) => { next.payrollRecords[1].personalSocial = 800.01; }, "personalSocial_difference"],
    ["旧导入只有文件名", (next) => { delete next.payrollRecords[0].sourceDocumentId; }, "payroll_original_missing"],
    ["同名人员无法唯一确认", (next) => { next.payrollRecords[0].personnelId = null; next.personnelRecords.push({ id: "person-2", name: "林同事", status: "active" }); }, "payroll_personnel_unresolved"],
  ];
  for (const [name, change, code] of scenarios) await t.test(name, () => {
    const next = structuredClone(workspace);
    change(next);
    const evidence = buildPayrollSocialEvidence(next);
    assert.equal(evidence.canGenerate, false);
    assert.ok(evidence.issues.some((issue) => issue.code === code), JSON.stringify(evidence.issues));
  });
  assert.equal(buildPayrollSocialEvidence(workspace, { period: "2026-10" }).canGenerate, false);
});

test("工资原件索引存在仍需核验本地字节，缺文件、跨工作台与内容替换均阻塞", async (t) => {
  for (const scenario of ["missing", "foreign", "changed"]) await t.test(scenario, async () => {
    const { workspace, fileVault } = await fixture();
    const original = await fileVault.get("document-payroll");
    if (scenario === "missing") await fileVault.delete(original.id);
    if (scenario === "foreign") await fileVault.put({ ...original, workspaceId: "other-workspace" });
    if (scenario === "changed") await fileVault.put({ ...original, blob: new Blob(["替换后的内容"]) });
    assert.equal(buildPayrollSocialEvidence(workspace).canGenerate, true);
    const evidence = await verifyPayrollSocialEvidence(workspace, { fileVault });
    assert.equal(evidence.verified, false);
    assert.equal(evidence.canGenerate, false);
    assert.ok(evidence.issues.some((issue) => issue.code === "payroll_original_unverified"));
  });
});

test("工资金额、人员部门和原件版本改变时依据失效，重新导入继续撤销旧冻结确认", async () => {
  const { workspace } = await fixture();
  const baseline = buildPayrollSocialEvidence(workspace).fingerprint;
  for (const change of [
    (next) => { next.payrollRecords[0].grossSalary += 1; },
    (next) => { next.personnelRecords[0].department = "销售"; },
    (next) => { next.documents[0].version += 1; },
  ]) {
    const next = structuredClone(workspace);
    change(next);
    assert.notEqual(buildPayrollSocialEvidence(next).fingerprint, baseline);
  }
  const changedOriginal = structuredClone(workspace);
  changedOriginal.documents[0].version += 1;
  assert.equal(buildPayrollSocialEvidence(changedOriginal).canGenerate, false);
  assert.ok(buildPayrollSocialEvidence(changedOriginal).issues.some((issue) => issue.code === "payroll_original_changed"));
  const stale = { ...workspace, tax: { ...workspace.tax, frozenAt: "old", payrollConfirmedAt: "old", socialSecurityConfirmedAt: "old", payrollConfirmedFingerprint: "old" } };
  const doc = workspace.documents[0];
  const plan = preparePayrollSocialImport(stale, {
    id: "import-payroll-replacement", sourceKind: "payroll", mapping,
    table: [headers, ["林同事", period, 11000, 800, 1600, 300, 9900]],
    sourceDocumentId: doc.id, sourceDocumentHash: doc.hash, sourceDocumentVersion: doc.version,
  });
  const next = applyPayrollSocialImport(stale, plan);
  assert.equal(next.payrollRecords.length, 2);
  assert.equal(next.tax.frozenAt, null);
  assert.equal(next.tax.payrollConfirmedAt, null);
  assert.equal(next.tax.socialSecurityConfirmedAt, null);
  assert.equal(next.tax.payrollConfirmedFingerprint, null);
  assert.notEqual(buildPayrollSocialEvidence(next).fingerprint, baseline);
});

test("原件异步保存保留工作台新修改，导入任务失效仍撤销新文件", async (t) => {
  for (const scenario of ["workspace", "job"]) await t.test(scenario, async () => {
    let current = { id: "workspace", currentPeriod: period, documents: [] };
    let isCurrent = true;
    let replacements = 0;
    const store = {
      getState: () => ({ workspaces: [current] }),
      actions: { replaceWorkspace: (_workspaceId, next) => { replacements += 1; current = next; } },
    };
    const fileVault = createMemoryFileVault();
    const put = fileVault.put;
    fileVault.put = async (record) => {
      await put(record);
      if (scenario === "workspace") current = { ...current, company: { legalName: "保存期间的新公司名称" }, documents: [{ id: "newer-document" }] };
      else isCurrent = false;
    };
    const saving = saveLocalDocument({
      store, fileVault, workspaceId: current.id, file: new Blob(["工资表"]),
      isCurrent: () => isCurrent,
    });
    if (scenario === "workspace") {
      const saved = await saving;
      assert.equal(replacements, 1);
      assert.equal(current.company.legalName, "保存期间的新公司名称");
      assert.deepEqual(current.documents, [{ id: "newer-document" }, saved]);
      assert.equal((await fileVault.listByWorkspace(current.id)).length, 1);
      assert.equal(await (await fileVault.get(saved.id)).blob.text(), "工资表");
    } else {
      await assert.rejects(saving, /资料导入任务已变化/);
      assert.equal(replacements, 0);
      assert.deepEqual(current.documents, []);
      assert.equal((await fileVault.listByWorkspace(current.id)).length, 0);
    }
  });
});
