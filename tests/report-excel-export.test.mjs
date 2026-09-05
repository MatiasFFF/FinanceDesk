import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as XLSX from "xlsx";

import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { createBlankWorkspace } from "../src/domain/foundation.js";
import {
  FROZEN_REPORT_EXCEL_SHEETS,
  buildFrozenReportExcelWorkbook,
  recordFrozenReportExcelExport,
} from "../src/domain/accounting/reporting.js";
import { buildReportSnapshot, workflowSourceFingerprint } from "../src/productWorkflow.js";

const generatedAt = "2026-09-05T08:30:00.000Z";

function frozenWorkspace() {
  const base = createAccountingFixture();
  base.modules = { overview: true, members: true, reconcile: true, reports: true, tax: true, archive: true, setup: true };
  const sourceFingerprint = workflowSourceFingerprint(base);
  const version = {
    id: "report-version-current",
    period: base.currentPeriod,
    label: "V1",
    createdAt: "2026-09-05T08:00:00.000Z",
    actor: "测试会计",
    frozen: true,
    sourceFingerprint,
    snapshot: buildReportSnapshot(base),
  };
  return {
    workspace: {
      ...base,
      delivery: {
        reportVersions: [version],
        reportExports: [],
        notices: [],
        archives: [],
        filing: { period: base.currentPeriod },
      },
    },
    version,
    sourceFingerprint,
  };
}

test("current frozen report exports seven traceable worksheets and survives XLSX round-trip", () => {
  const { workspace, version, sourceFingerprint } = frozenWorkspace();
  const { workbook, metadata } = buildFrozenReportExcelWorkbook(workspace, {
    reportVersion: version,
    currentSourceFingerprint: sourceFingerprint,
    generatedAt,
  });

  assert.deepEqual(workbook.SheetNames, FROZEN_REPORT_EXCEL_SHEETS);
  assert.equal(metadata.localOnly, true);
  assert.equal(metadata.uploaded, false);
  assert.equal(metadata.reportVersionId, version.id);
  assert.ok(metadata.fileName.endsWith("-本地财务报表.xlsx"));

  for (const sheetName of FROZEN_REPORT_EXCEL_SHEETS) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
    assert.ok(rows.some((row) => row[0] === "工作台" && row[1] === workspace.name), `${sheetName} 缺少工作台表头`);
    assert.ok(rows.some((row) => row[0] === "期间" && row[1] === workspace.currentPeriod), `${sheetName} 缺少期间表头`);
    assert.ok(rows.some((row) => row[0] === "报表版本" && row[1] === version.label), `${sheetName} 缺少版本表头`);
    assert.ok(rows.some((row) => row[0] === "生成时间" && row[1] === generatedAt), `${sheetName} 缺少生成时间`);
    assert.ok(rows.some((row) => row[0] === "导出方式" && row[1] === "本地导出（未上传网络）"), `${sheetName} 缺少本地导出声明`);
  }

  const sourceRows = XLSX.utils.sheet_to_json(workbook.Sheets["来源明细"], { header: 1, defval: "" });
  const headerIndex = sourceRows.findIndex((row) => row[0] === "工作表" && row[1] === "指标 ID");
  assert.ok(headerIndex >= 0);
  const detailRows = sourceRows.slice(headerIndex + 1).filter((row) => row[0] && row[1]);
  assert.equal(new Set(detailRows.map((row) => `${row[0]}:${row[1]}`)).size, metadata.metricCount);
  assert.ok(detailRows.every((row) => Array.isArray(JSON.parse(row[5])) && JSON.parse(row[5]).length > 0));
  assert.ok(detailRows.some((row) => row[0] === "资产负债表" && String(row[6]).includes("voucher")));

  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array", cellStyles: true });
  const reopened = XLSX.read(bytes, { type: "array", cellStyles: true });
  assert.deepEqual(reopened.SheetNames, FROZEN_REPORT_EXCEL_SHEETS);
});

test("member module controls fitness-specific content in the owner workbook sheet", () => {
  const blank = createBlankWorkspace({ id: "workspace-neutral-excel", name: "通用服务工作台" }, { timestamp: generatedAt });
  const blankFingerprint = workflowSourceFingerprint(blank);
  const blankVersion = {
    id: "report-version-neutral",
    period: blank.currentPeriod,
    label: "V1",
    createdAt: generatedAt,
    actor: "本地用户",
    frozen: true,
    sourceFingerprint: blankFingerprint,
    snapshot: buildReportSnapshot(blank),
  };
  const blankWorkspace = {
    ...blank,
    delivery: { ...blank.delivery, reportVersions: [blankVersion] },
  };
  const { workbook: blankWorkbook } = buildFrozenReportExcelWorkbook(blankWorkspace, {
    reportVersion: blankVersion,
    currentSourceFingerprint: blankFingerprint,
    generatedAt,
  });
  const blankOwnerRows = XLSX.utils.sheet_to_json(blankWorkbook.Sheets["老板管理报表"], { header: 1, defval: "" });
  assert.doesNotMatch(JSON.stringify(blankOwnerRows), /会员|教练|私教|团课|门店经营汇总/);
  assert.match(JSON.stringify(blankOwnerRows), /场所经营汇总/);
  assert.notEqual(
    workflowSourceFingerprint({ ...blank, modules: { ...blank.modules, members: true } }),
    blankFingerprint,
    "模块变化必须让旧冻结版本失效",
  );

  const { workspace, version, sourceFingerprint } = frozenWorkspace();
  const { workbook: fitnessWorkbook } = buildFrozenReportExcelWorkbook(workspace, {
    reportVersion: version,
    currentSourceFingerprint: sourceFingerprint,
    generatedAt,
  });
  const fitnessOwnerRows = XLSX.utils.sheet_to_json(fitnessWorkbook.Sheets["老板管理报表"], { header: 1, defval: "" });
  assert.match(JSON.stringify(fitnessOwnerRows), /教练提成/);
  assert.match(JSON.stringify(fitnessOwnerRows), /门店经营汇总/);
});

test("missing, old, or stale frozen versions cannot export", () => {
  const { workspace, version, sourceFingerprint } = frozenWorkspace();
  assert.throws(() => buildFrozenReportExcelWorkbook(workspace), (error) => error.code === "FROZEN_REPORT_REQUIRED");
  assert.throws(() => buildFrozenReportExcelWorkbook(workspace, {
    reportVersion: { ...version, id: "old-report" },
    currentSourceFingerprint: sourceFingerprint,
  }), (error) => error.code === "REPORT_VERSION_NOT_CURRENT");
  assert.throws(() => buildFrozenReportExcelWorkbook(workspace, {
    reportVersion: version,
    currentSourceFingerprint: "changed-data",
  }), (error) => error.code === "REPORT_VERSION_STALE");
});

test("completed local download metadata is persisted without any upload state", () => {
  const { workspace, version, sourceFingerprint } = frozenWorkspace();
  const { metadata } = buildFrozenReportExcelWorkbook(workspace, {
    reportVersion: version,
    currentSourceFingerprint: sourceFingerprint,
    generatedAt,
  });
  const next = recordFrozenReportExcelExport(workspace, { ...metadata, size: 4096, hash: "local-sha256" }, { actor: "测试会计", at: generatedAt });
  assert.equal(next.delivery.reportExports.length, 1);
  assert.equal(next.delivery.reportExports[0].reportVersionId, version.id);
  assert.equal(next.delivery.reportExports[0].localOnly, true);
  assert.equal(next.delivery.reportExports[0].uploaded, false);
  assert.equal(next.auditLog.at(-1).action, "report.excel_export");
});

test("report page only offers the current validated frozen-version export", () => {
  const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(appSource, /const excelExportReady = Boolean\(currentFrozenVersion\?\.sourceFingerprint\)/);
  assert.match(appSource, /导出当前冻结版 Excel/);
  assert.match(appSource, /if \(!flow\.version\?\.sourceFingerprint\) throw new Error/);
  assert.match(appSource, /latestFlow\.version\.sourceFingerprint !== metadata\.sourceFingerprint/);
  assert.match(appSource, /未上传网络/);
});
