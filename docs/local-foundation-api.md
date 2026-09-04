# 财务工作台本地数据底座

## 稳定入口

- `src/foundation.js`：纯 JavaScript API，可在浏览器、Node 测试和其他业务模块中使用。
- `src/foundation-react.js`：React Provider 与可挂载界面组件。

不要从纯 API 入口导出 JSX；这能保证 Node 自动化测试不依赖 JSX 转译。

## 状态与持久化

```js
import {
  createFinanceDeskStore,
  createLocalFoundationRepository,
} from "../foundation.js";

const repository = createLocalFoundationRepository();
const store = createFinanceDeskStore({ repository });
const workspace = store.getActiveWorkspace();
```

当前数据版本为 `schemaVersion: 4`。主副本保存在 `financedesk.local-state.v4`，最近一次有效副本保存在 `financedesk.local-state.v4.last-good`。读取顺序是：主副本 → 最近有效副本 → 旧版键迁移 → 首次行业模板。

首次仅创建“山岚健身工作室”健身行业模板。它与用户后续创建的工作台使用相同的数据结构，可复制、重命名，并在至少还有另一个工作台时删除。

## Store actions

```text
createWorkspace       创建空白工作台
duplicateWorkspace    深复制工作台，数据与来源隔离
renameWorkspace       重命名
switchWorkspace       切换当前工作台
deleteWorkspace       删除工作台（至少保留一个）
clearWorkspace        清空单工作台 operational 或 all 范围
setPeriod             设置当前账期
setStageStatus        更新 S0-S4 阶段状态
updateCompanyProfile  更新企业主体资料
upsertEntity          新增或更新集合记录
removeEntity          删除集合记录
setEntityStatus       更新记录状态
recordAuthorization   记录本地授权，不建立外部连接
linkEvidence          建立资料与业务对象关联
applyBankImport       执行已预检查的银行导入计划
exportBackup          导出 JSON 备份
importBackup          replace 或 merge 导入 JSON 备份
```

`upsertEntity` 支持：`books`、`stores`、`users`、`roles`、`authorizations`、`ruleSets`、`counterparties`、`contracts`、`invoices`、`approvals`、`personnelRecords`、`bankAccounts`，以及工作台内的业务集合。所有写操作都会追加工作台审计记录。

## 银行流水导入

```js
import {
  readBankFile,
  inspectBankTable,
  prepareBankImport,
} from "../foundation.js";

const parsed = await readBankFile(file); // CSV / XLSX / XLS
const inspection = inspectBankTable(parsed.table);
const plan = prepareBankImport(workspace, {
  accountId,
  fileName: parsed.fileName,
  sheetName: parsed.sheetName,
  table: parsed.table,
  mapping: inspection.mapping,
  openingBalance,
  statementClosing,
});

store.actions.applyBankImport(workspace.id, plan);
```

必须先 `prepareBankImport`，再由用户查看：字段映射、坏行、文件内重复、工作台内重复，以及“期初余额 + 收入 − 支出 = 期末余额”结果。执行后只写入 `plan.transactions` 中的新增流水；每笔记录保留来源文件名、文件哈希、原始行号和原始单元格。

XLSX 解析库只在选择 Excel 文件时动态加载，不进入首屏主包。

## 资料与证据

资料元数据在版本化工作台状态中；原文件 Blob 在当前浏览器 IndexedDB 的 `financedesk-local-files` 数据库中。文件不会上传网络。

```js
import { saveLocalDocument } from "../foundation.js";

await saveLocalDocument({
  store,
  fileVault,
  workspaceId: workspace.id,
  file,
  metadata: {
    category: "合同",
    period: "2026-08",
    relatedObjectIds: [contractId],
  },
});
```

JSON 备份包含业务数据、资料元数据、哈希、证据关联和审计日志，不包含 IndexedDB 中的原文件 Blob。跨浏览器恢复后需要重新选择原文件，才能恢复下载能力。

## React 接入

```jsx
import {
  FinanceDeskProvider,
  FoundationRecordsPanel,
  WorkspaceManager,
} from "../foundation-react.js";

<FinanceDeskProvider>
  <FoundationRecordsPanel />
  <WorkspaceManager open={open} onClose={close} />
</FinanceDeskProvider>
```

现有 `src/main.jsx` 已接入 Provider，`src/App.jsx` 已把活动工作台、S0-S4、银行导入和资料入口连入页面。外部银行、税务、AI、OCR 均固定标记为未连接/未来能力。
