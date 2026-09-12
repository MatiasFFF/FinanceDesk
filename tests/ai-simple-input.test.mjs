import test from "node:test";
import assert from "node:assert/strict";
import { AI_ATTACHMENT_MAX_BYTES, attachmentIssue, selectAiAttachments, shouldSendFromKey } from "../src/features/ai-simple/aiAttachments.js";

const file = (name, options = {}) => ({ name, size: 100, type: "", lastModified: 1, ...options });

test("附件边界接受恰好30MB，超限/空文件/不支持格式分别说明", () => {
  const valid = file("银行流水.xlsx", { size: AI_ATTACHMENT_MAX_BYTES });
  const result = selectAiAttachments([valid, file("大票据.pdf", { size: AI_ATTACHMENT_MAX_BYTES + 1 }), file("空表.csv", { size: 0 }), file("图片.heic", { type: "image/heic" }), file("脚本.svg", { type: "image/svg+xml" })]);
  assert.deepEqual(result.accepted, [valid]);
  assert.deepEqual(result.rejected.map((item) => item.reason), ["size", "empty", "type", "type"]);
  assert.equal(result.tone, "warning");
  assert.equal(attachmentIssue(file("扫描件", { type: "application/pdf" })), null);
});

test("保留有效附件，重复项不消耗20份名额，拒绝超出名额的新文件", () => {
  const existing = Array.from({ length: 19 }, (_, index) => ({ id: index, file: file(`流水${index}.csv`) }));
  const selected = [file("流水0.csv"), file("不支持.txt"), file("新票据.png"), file("新票据.png"), file("另一票据.pdf")];
  const result = selectAiAttachments(selected, existing);
  assert.deepEqual(result.accepted.map((item) => item.name), ["新票据.png"]);
  assert.equal(result.duplicates.length, 2);
  assert.deepEqual(result.rejected.map((item) => item.reason), ["type", "count"]);
  assert.equal(existing.length, 19);
  assert.equal(selected.length, 5);
});

test("同名但内容元数据已变的附件可加入，同一次选择只保留一份完全重复项", () => {
  const existing = [{ file: file("发票.pdf") }];
  const result = selectAiAttachments([file("发票.pdf"), file("发票.pdf", { size: 200 }), file("发票.pdf", { lastModified: 2 }), file("新流水.CSV"), file("新流水.CSV")], existing);
  assert.equal(result.accepted.length, 3);
  assert.equal(result.duplicates.length, 2);
  assert.equal(result.rejected.length, 0);
});

test("总20份限制包含此前保留的附件，而非每次选择重置", () => {
  const existing = Array.from({ length: 20 }, (_, index) => ({ file: file(`${index}.pdf`) }));
  const result = selectAiAttachments([file("新图.jpg")], existing);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "count");
});

test("Enter仅在可发送的桌面非组词状态提交，中文选词与触屏回车不提交", () => {
  const ready = { key: "Enter", hasContent: true };
  assert.equal(shouldSendFromKey(ready), true);
  for (const blocked of [{ isComposing: true }, { composing: true }, { keyCode: 229 }, { compositionJustEnded: true }, { shiftKey: true }, { altKey: true }, { touch: true }, { busy: true }, { disabled: true }, { hasContent: false }, { key: "a" }]) assert.equal(shouldSendFromKey({ ...ready, ...blocked }), false);
});
