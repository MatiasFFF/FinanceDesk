# 财务工作台本地 API：第一批共享入口

`src/foundation.js` 是纯 JavaScript 入口，可在 Node 或浏览器中直接调用，不挂载 React。`src/foundation-react.js` 保留 Provider 和现有页面组件。

本批提供银行导入的完整应用服务：查询目标 → 注册本地文件 → 准备映射与导入计划 → 保存并核验原件 → 导入流水 → 查询批次结果。当前手动银行页面已使用这一条调用链。凭证、库存、其他财务模块仍使用原有领域函数和页面流程，尚未逐项收回应用服务；模型调用、DeepSeek 和简版页面均未接入。

## 可直接运行的 Node 示例

在仓库根目录执行下列命令。示例只用内存存储、内存原件库及模拟 CSV，不接触真实账本。

```sh
node --input-type=module <<'JS'
import {
  createFinanceDeskStore,
  createFinanceDeskService,
  createLocalFoundationRepository,
  createMemoryStorage,
  createMemoryFileVault,
} from './src/foundation.js';

const repository = createLocalFoundationRepository({ storage: createMemoryStorage() });
const store = createFinanceDeskStore({ repository });
const fileVault = createMemoryFileVault();

// 工作台和账户由本地宿主准备；不是让模型提交一整份工作台。
const workspace = store.actions.createWorkspace({ name: '导入示例', currentPeriod: '2026-09' });
const account = store.actions.upsertEntity(workspace.id, 'bankAccounts', {
  name: '基本户', accountNumber: '1234', currency: 'CNY', status: 'active',
});
const service = createFinanceDeskService({ store, fileVault });
const file = new Blob([
  '日期,对方,摘要,收入,支出,流水号,余额\n2026-08-01,示例客户,服务款,25,,EXAMPLE-001,125',
], { type: 'text/csv' });

const registered = await service.registerBankFile(file, {
  workspaceId: workspace.id,
  fileName: '银行流水.csv',
});
const context = service.getWorkspaceContext({ workspaceId: workspace.id, period: '2026-08' });
console.log('目标账户', context.accounts.map(item => ({ id: item.id, name: item.name })));
const plan = service.prepareBankImport({
  workspaceId: workspace.id, period: '2026-08', accountId: account.id,
  fileRef: registered.fileRef, mapping: registered.inspection.mapping,
  openingBalance: 100, statementClosing: 125,
});
console.log('预检查', { canImport: plan.canImport, errors: plan.errors, reconciliation: plan.reconciliation });
const result = await service.executeBankImport({ workspaceId: workspace.id, planId: plan.planId });
console.log('导入结果', result.counts, result.importIds, result.transactionIds, result.documentIds);
console.log('后续动作', result.nextActions);
console.log('仍在显示九月', store.getActiveWorkspace().currentPeriod);
console.log(service.getBankImportResult({ workspaceId: workspace.id, importId: result.importIds[0] }));
service.releaseBankFile(registered.fileRef);
service.dispose();
JS
```

浏览器宿主可用 `createBrowserFileVault()` 和浏览器默认 repository；需要通过 `store.startPersistenceSession()` 持有本地保存会话，且 `store.getPersistenceStatus().canWrite === true` 后执行写入。现有 `FinanceDeskProvider` 已负责这些工作，不应再创建第二份页面 store。文件仍保存在当前浏览器，CSV/XLSX/XLS 解析复用现有入口，XLSX 库按需加载。

## 真实操作定义

`FINANCE_DESK_OPERATIONS` 导出实际操作名称、说明、参数 JSON Schema 和结果字段清单。`service.invoke(name, parameters)` 只分派下表中的操作，不接受工作台快照、原始 File/Blob、自定义交易数组、任意 plan 或 `actor`。具名方法也执行同样的参数边界检查。

| 操作 | 必填参数 | 可选参数 | 结果 |
| --- | --- | --- | --- |
| `listWorkspaces` | 无，传 `{}` | 无 | `workspaces: [{id, name, displayedPeriod}]`，只列出当前本地身份可读取的工作台 |
| `getWorkspaceContext` | `workspaceId`, `period` | 无 | 目标 `accounts`、`imports` 摘要、`periods`、`archived`、`displayedPeriod`；查询不会创建或切换账期 |
| `prepareBankImport` | `workspaceId`, `period`, `accountId`, `fileRef` | `mapping`, `openingBalance`, `statementClosing`, `counterpartyMappings`, `largeTransactionThreshold` | `planId` 和现有导入预览字段：交易行、映射、错误、重复、余额勾稽、缺项和后续动作 |
| `executeBankImport` | `workspaceId`, `planId` | 无 | 批次、交易、原件 ID，实际统计、原页面可用的 `import` 结果、缺项和后续动作 |
| `getBankImportResult` | `workspaceId`, `importId` | 无 | 重新查询已保存批次及其当前交易、待复核事项 |

`workspaceId`、`accountId`、`planId` 和 `importId` 是非空字符串；`period` 必须明确指定为 `YYYY-MM`，并与文件内流水日期一致。一次文件仅导入一个月份。`mapping` 将字段名映射到从零开始的非负整数列序号，不能越过文件实际列数，也不接受未知字段；省略或传空对象时保留自动映射。标准字段包括 `date`、`amount`、`credit`、`debit`、`direction`、`counterparty`、`counterpartyAccount`、`summary`、`serial`、`balance`、`channel`、`currency`。

余额可传有限数值或有效金额字符串，省略、`null` 或空白字符串使用目标月份的账户余额及文件中余额。无效金额和非有限数值会被拒绝。`largeTransactionThreshold` 接受非负有限数值，省略或传 `0` 沿用现有默认阈值计算。异步期间账户余额有新修改时，自动余额按最新值重新计算；先前明确填写的余额若与新修改冲突，会返回 `BANK_BALANCE_CHANGED`，要求核对后重新预检查，不覆盖新值。

`counterpartyMappings` 以预览交易的 `counterpartyAliasKey` 为键，每项是对象，保留页面使用的 `targetKey`。允许字段为 `rawName`、`counterpartyAccount`、`standardName`、`objectId`、`objectType`、`kind`、`targetKey`、`ruleId`、`createdAt`；字段值须为字符串，只有 `objectId` 还允许 `null`。至少提供银行原始名称 `rawName` 或原始账号 `counterpartyAccount`。

- `objectType: "counterparty"` / `"personnelRecord"`：用 `objectId` 从目标工作台对应集合解析真实对象，名称和类别由对象资料决定，调用方传入的 `standardName`、`kind` 不会覆盖真实资料；人员类别固定为 `employee`。其他工作台对象、不存在的对象或类型不匹配会被拒绝。离职或停用不抹去财务身份，仍存在的对象及其已存别名可以继续关联历史流水或结算。
- `objectType: "manual"`（或省略类型）：保留手工标准名称，`standardName` 必须非空，`objectId` 留空；`kind` 可用 `customer`、`supplier`、`employee`、`related_party`、`other`，默认 `other`。

应用服务和领域预检查共用上述可选参数校验。执行时重新读取目标对象，包括保存原件后的再次准备；期间改名或改类别使用最新资料，对象被删除则停止导入并沿用既有未使用原件清理流程。已匹配的历史别名也按真实对象重新解析。

具名方法失败时抛出异常，页面可以显示 `error.message`。`invoke` 则把成功和失败均转成 JSON：

```js
const response = await service.invoke('executeBankImport', {
  workspaceId, planId,
});
// 成功：{ ok: true, data: { status, workspaceId, period, accountId, ... } }
// 失败：{ ok: false, error: { code, message, details?, cleanup? } }
```

常见错误代码为 `FILE_REFERENCE_EXPIRED`、`BANK_PLAN_EXPIRED`、`BANK_IMPORT_INPUT_INVALID`、`BANK_COUNTERPARTY_UNAVAILABLE`、`BANK_IMPORT_INVALID`、`BANK_IMPORT_EMPTY`、`BANK_BALANCE_CHANGED`、`WORKSPACE_NOT_FOUND`、`LOCAL_STATE_STALE`、`LOCAL_RECOVERY_REQUIRED`；未独立编码的领域错误通过 `OPERATION_FAILED` 和具体中文原因返回。可选参数错误在 `details.field` 中定位，对手归属错误提供 `details.objectType` / `objectId`，文件行错误在 `details.errors` 中定位。归档、权限、账户归属、资料真实性和去重规则仍由现有领域与 store 校验。

执行结果包含：

- `status`：`imported` 为本次新增；同一已执行计划再次调用为 `already_imported`；新的预检查全部重复为 `duplicate`。
- `importIds`、`transactionIds`、`documentIds`：真实保存或匹配到的来源 ID。旧交易没有保存 `dedupeKey` 时，仍按领域去重规则定位。
- `counts: { imported, duplicates, errors }`：实际结果统计。`duplicate` 的新增数为零；`already_imported` 返回原批次结果，不产生第二次写入。
- `import`：保存的批次记录及该批次真实 `transactions`，兼容现有结果卡片和“开始处理本批”入口。重复行可能分属多个已有批次；无法对应单一批次时为 `null`。
- `importSnapshots`：相关已保存批次的导入时摘要数组，每项包括 `importId`、`importedAt`、`counts`、`reconciliation`、`monthlyReconciliation`。它们与 `import` 内同名勾稽字段保留当时事实，后续查询不覆盖旧快照；重复文件匹配多个批次时分别返回快照。
- `currentReconciliation`：按目标账户和月份，用当前完整流水、补导批次及已重新核对的余额计算的月度勾稽，包含状态、金额、差额和余额来源，不包含整份历史 `imports`。后来补导或重新勾稽通过后，查询旧批次仍会得到当前通过状态。
- `missingItems`：目标账户和月份当前未解决的银行异常/缺件事项，包含后来补导批次的问题；`nextActions` 描述本批或重复匹配交易的复核入口，以及当前仍需勾稽的账户月份。月度勾稽通过后不再提示 `reconcile_bank_account`。同一计划再次执行、重复文件和已保存批次查询使用同一当前状态计算。后续动作不会自动导航，也不代表自动执行下一步。
- `cleanup`（仅需要时）：失败或晚到重复情况下，有原件因新增业务引用、权限/归档变化或存储失败而保留；包含资料 ID 和原因。不会通过 `force` 绕过真实引用去删除资料。

## 文件、身份与显示选择的边界

`registerBankFile(file, options)` 是本地宿主接口，不在模型操作清单中。`file` 必须是真实 File/Blob；`options.workspaceId` 明确所属工作台，还可指定 `fileName`、`sheetName`、`encoding`、取消 `signal` 和进度回调 `onProgress`。它读取文件、计算哈希并返回可序列化的 `fileRef`、表格预览、映射和文件信息。调用方修改返回的表格或计划对象，不会改变服务保存的解析来源和执行参数。文件原件保存与核验由执行流程负责。

`fileRef` 和 `planId` 仅在创建它们的 service 实例内有效，不跨刷新或重启，也不能跨工作台借用。更换文件或页面卸载时调用 `releaseBankFile(fileRef)`；只替换预检查可用 `releaseBankPlan(planId)`；结束宿主时调用 `dispose()`。释放文件会同时释放其计划，已经开始的执行保留必要引用直至完成。释放不会删除已保存业务与原件。已保存的 `importId`、交易 ID 和原件 ID 可持久查询。

服务所有业务操作明确使用 `workspaceId`、`period`、`accountId`。读取和导入其他工作台或月份，都不会改变 `activeWorkspaceId`、`activeUserId` 或工作台正在显示的 `currentPeriod`。银行余额、税务、申报、期初状态及 S2–S4 状态仍按月保存；页面显示动作独立执行。

银行异常归属与 S3 银行阶段使用同一按月筛选。新银行异常写入 `period`；旧任务没有账期时，按来源交易日期、关联导入批次、勾稽记录的账期或勾稽任务身份中的月份确定归属，也支持 `sourceIds` 引用。来源无法确定月份的旧任务原样保留，不猜成当前显示月份；查询不会为旧任务补写账期。其他月份遗留异常不影响本月阶段，本月可追溯的旧异常仍纳入待复核。已有同名别名回写与内部转账配对行为保持原样。

默认权限主体仍是 store 中的当前本地用户。目标工作台已配置用户、且当前身份不属于目标时，调用会被拒绝，不会自动选择负责人。可信本地宿主可在创建 store 时提供 `resolveWorkspaceUserId(workspaceId, state)`，从自己已确认的本地身份映射中返回该工作台的用户 ID；每次操作仍按目标用户、启用状态及真实角色重新检查权限。例如：

```js
const store = createFinanceDeskStore({
  repository,
  resolveWorkspaceUserId: (workspaceId) => authorizedLocalUserIds.get(workspaceId) ?? null,
});
```

该映射不能交给模型参数设置，用户姓名、`actor` 和审计显示文字不会授予权限。尚未配置本地用户的首次空白工作台沿用既有单机权限规则。

执行时会在原件写入、原件核验等异步步骤后重新读取工作台，重新准备导入计划。已删除的工作台/账户、归档月份或失效权限不会沿用旧预览继续入账；期间的公司资料和其他修改不会被旧工作台快照覆盖。同一执行中的重复请求共用结果；不同计划或重复文件仍由领域去重拦截。原件先作为本次未关联资料保存，成功提交流水时才与银行账户、批次和交易正式关联。失败仅清理本次新建且仍未被使用的原件。

## 当前页面接入

`BankImportPanel.jsx` 在既有 Provider 的 store/fileVault 上创建 service：

1. 选择文件调用 `registerBankFile`，自动或手动预检查调用 `service.prepareBankImport`。
2. 提交前保留现有 `allowPeriodNavigation` 和 `usePeriodLeaveGuard`，保护其他未保存输入。
3. 提交仅调用 `service.executeBankImport({ workspaceId, planId })`，不再自行串联保存原件和银行入账。
4. 成功后由页面显式调用 `actions.setPeriod`，保留原来的跨月导入显示行为；结果卡片和 `onComplete` 使用 `result.import`，完成提示中的勾稽状态使用 `result.currentReconciliation`。
5. 更换文件、重做预检查或卸载时释放引用。

平台结算、工资和其他资料流程仍保留既有路径，不属于本批银行应用操作清单。没有新增页面、网络识别或 AI 连接。

## 底层 API 与数据恢复

已有领域函数、`store.actions` 和资料函数继续从原入口使用；它们是可信本地代码接口，不应直接全部暴露为模型工具。`prepareBankImport(workspace, input)` / `applyBankImport(state, workspaceId, plan)` 仍是低层领域变换，不包含完整原件流程；新调用方应使用 service。`store.actions.applyBankImport` 现在保留显示账期，需要显示跳转的页面自行调用 `setPeriod`。

`saveLocalDocument` 保存资料元数据与 Blob，并以异步步骤后的最新工作台提交自己的变更。`removeLocalDocument` 在原件 lookup/delete 后重新取得工作台；公司资料等无关新修改被保留，资料自身、业务关联或归档发生变化时停止删除并恢复必要原件。

数据版本仍为 `schemaVersion: 4`。主副本为 `financedesk.local-state.v4`，最近有效副本为 `financedesk.local-state.v4.last-good`。读取顺序与结果如下：

- 主副本有效：正常读取。
- 主副本损坏或缺失、最近有效副本可读取：从备份恢复，不用 seed 覆盖有效备份。
- 主副本和备份不存在：继续旧版键迁移或正常首次模板初始化。
- 存在无法读取的本地副本、又没有有效副本：`loadReport.source = 'unreadable'`、`recoveryRequired = true`，`recovered = false`。原字符串保留在原键，初始模板仅供界面查看；`persistenceStatus.status = 'recovery_required'`、`canWrite = false`。获得保存锁也不会变成可写或写回 seed。

使用现有备份入口选择有效 JSON/ZIP 进行**替换恢复**。此状态不允许把初始模板合并进恢复账本。仓库会先将主、副本原文存入 `financedesk.local-state.v4.unreadable.<唯一恢复 ID>`，再写入经过校验的备份；损坏原文保存失败时停止恢复。成功后恢复正常写入，不新增恢复页面。`restoreWorkspaceJsonBackup` 与 `restoreWorkspaceBackup` 在此路径保留原文件保险箱中的既有原件，避免较旧备份遗漏的资料被当作孤立文件删除。健康账本的正常替换清理规则保持原样。

JSON 备份含业务数据、资料元数据、证据关联和审计记录，不含原文件 Blob；ZIP 备份可以包含原件。损坏原文另存不是自动修复，也不保证损坏内容能够被解析；未被恢复账本引用的旧原件仍保留在本机供后续人工恢复。
