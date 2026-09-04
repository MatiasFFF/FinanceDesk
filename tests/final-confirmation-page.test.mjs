import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("S12 renders the full local-only review snapshot and all required choices", () => {
  for (const label of [
    "申报所属期",
    "各税种金额",
    "三大报表关键数字",
    "工资与社保总额",
    "是否需要扣款",
    "申报风险",
    "仍未处理事项",
    "数字已复核",
    "风险已知晓",
    "理解这里只生成本地申报包、尚未提交税务局",
    "外部扣款授权",
    "最终负责人姓名",
  ]) assert.match(appSource, new RegExp(label));
  assert.match(appSource, /Object\.values\(finalChecks\)\.every\(Boolean\)/);
  assert.match(appSource, /\["authorize_external", "do_not_authorize"\]\.includes\(deductionAuthorization\)/);
  assert.match(appSource, /保存最终确认（不提交税务局）/);
  assert.match(styleSource, /\.final-review-grid/);
  assert.match(styleSource, /\.final-confirm-form/);
});

test("final confirmation persists its snapshot and becomes invalid when its binding changes", () => {
  assert.match(appSource, /kind: "final"/);
  assert.match(appSource, /reportSourceFingerprint: flow\.version\.sourceFingerprint \|\| null/);
  assert.match(appSource, /filingDraftCreatedAt: current\.delivery\.filing\.draftCreatedAt/);
  assert.match(appSource, /selections: \{/);
  assert.match(appSource, /signature: \{ name: name\.trim\(\), signedAt: now \}/);
  assert.match(appSource, /snapshot,/);
  assert.match(appSource, /confirmations: \[\.\.\.\(current\.confirmations \|\| \[\]\), finalRecord\]/);
  assert.match(appSource, /storedFinalConfirmation\.reportSourceFingerprint === \(version\?\.sourceFingerprint \|\| null\)/);
  assert.match(appSource, /storedFinalConfirmation\.filingDraftCreatedAt === filing\.draftCreatedAt/);
  assert.match(appSource, /const exportReady = finalConfirmationCurrent && flow\.export\.every/);
});

test("final confirmation copy never represents a local record as submitted or paid", () => {
  assert.match(appSource, /尚未提交税务局，也未执行扣款/);
  assert.match(appSource, /仅保存本地记录，未提交税务局、未执行扣款/);
  assert.doesNotMatch(appSource, /最终确认已提交/);
  assert.doesNotMatch(appSource, /税款已缴/);
});
