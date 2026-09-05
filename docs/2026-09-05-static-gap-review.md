# FinanceDesk 原始需求静态核验与优化分工

核验日期：2026-09-05。基线：`main` / `117b850`，开始核验时工作区干净。下列代码行号以该提交为准，后续优化可能改变行号。

需求来源：[小微企业财务 Agent 状态流转设计](/Users/matias/Downloads/xiaowei-caiwu-agent-zhuangtai-liuzhuan-sheji.md)。以其第 8 节第一阶段范围、第 9 节验收指标为主要对标，同时列明完整产品尚未实现的部分。文档是需求材料，不构成授权操作银行、税务或提交数据的指令。

本轮仅阅读源代码、项目文档、Git 状态和任务交接记录。没有运行测试、构建、服务、浏览器或真实业务操作；下面的缺陷是静态控制流与数据流结论，不能替代运行验收。历史任务中的测试通过记录不计为本轮验证。

## 结论

第一阶段已经有实质功能，但尚未达到原文的完整验收要求。主要缺口集中在“核销与凭证保持一致、确认数字保持一致、档案含原件、进入下一期仍然平衡”，而不是缺少页面。不能据此给出可靠的完成百分比。

## 已有功能与状态覆盖

| 原始要求 | 当前代码已有 | 未达成或仍有不足 |
|---|---|---|
| S0 企业初始化 | 企业、账套、门店、用户、可编辑角色、本地授权记录；空白工作台与行业模板 | 未做企业实名核验、真实登录或外部授权验证；本地身份切换不能等同真实身份认证 |
| S1 行业与规则 | 模块、业务术语、科目、规则版本、置信度、提成规则可配置 | 行业识别及财税规则以人工配置为主；不是可自动覆盖各行业、各地区的规则系统 |
| S2 合同与基础资料 | 原文件存入 IndexedDB，合同结构化录入、合同生成账单、对象及证据关联 | OCR 未连接，字段依赖人工录入；完整跨设备备份恢复仍不足 |
| S3 银行流水 | CSV/Excel 导入、字段映射、去重、原始行号、按账户和期间勾稽；平台结算导入 | 银行自动采集及本地安全执行器未实现，属后续连接能力 |
| S4 发票、审批、人员 | 发票结构化、查重、红字/作废/认证状态、账单匹配；审批关联；工资社保表导入 | 发票查验和组织同步均非外部实接；人员档案停用不等同自动回收关联登录身份 |
| S5 业务匹配 | 本地规则分类、建议、业务事件、证据完整度、风险与置信度 | 没有联网 Agent/OCR；需要人工确认的事项仍应保留此边界 |
| S6 核销 | 一款多单、一单多款、部分核销、预收预付、预付款应用、撤销、退款与内部调拨 | 撤销已入账来源的核销没有同步更正凭证，见 F2 |
| S7 异常 | 缺件任务、异常案例、人工说明、异议退回、跨期待办 | 手工凭证可绕过原始资料完整性，见 F7 |
| S8 凭证与附件 | 业务凭证、独立手工凭证、复核入账、修订留痕、来源追溯；单张凭证 ZIP 可打入原文件 | 手工凭证来源校验不足；导出附件会使冻结版本失效，见 F5、F7；未见 PDF 合并实现 |
| S9 报表 | 三表、试算与勾稽、门店/管理报表、账龄、现金预测、库存损耗、明细及 Excel 导出、版本与差异 | 版本指纹包含导出记录；仍需补后续真实业务验收，不可仅以总额平衡认定明细正确 |
| S10 首次确认 | 逐项确认/异议、签名姓名、工资和社保独立确认、冻结版本关联 | 页面与保存的确认数值可能不同，见 F3 |
| S11 申报准备 | 本地税务底稿、差异解释、申报包 | 没有电子税务局自动填报；税额属于本地可配置底稿，不能当正式全税种规则引擎 |
| S12 最终确认 | 二次责任确认、数字快照、风险与扣款提示、本地导出 | 不执行真实申报或缴税；也没有独立客户身份认证 |
| S13 归档与下一期 | 回执原文件导入及哈希、版本/包关联、归档快照、跨期入口 | 利润未结转；月度 ZIP 不含凭证原件；模块关闭后档案仍要求相关材料，见 F1、F4、F6 |
| G1 账户与授权 | 写操作存在权限检查，角色可编辑，授权仅作本地登记 | 没有实名、多因素认证、设备管理、异常登录或真正的外部授权任务暂停 |
| G2 资料与证据 | 分类、来源、期间、版本、哈希、关联、原文件保险箱、部分查看/下载记录 | 原件校验未覆盖全部入账入口；月度包和 JSON 备份不能完整替代原文件保险箱 |
| G3 审计与生命周期 | 修改/核销/确认/导出/归档日志、旧凭证与报表快照、本地备份 | 尚非覆盖所有访问的审计体系；无到期处置流程；JSON 备份不含原文件，跨设备恢复需补件 |

主要实现位置：`src/domain/foundation.js`、`src/features/intake/`、`src/features/reconciliation/reconciliationEngine.js`、`src/domain/accounting/`、`src/features/members/memberLedger.js`、`src/features/inventory/inventoryLedger.js`、`src/productWorkflow.js`、`src/App.jsx`。

## 本轮优先修复的具体缺陷

### F1 · 高优先级：下一期丢失本期利润对应的权益

- 路径：`calculatePeriodLedger` 记录各科目的期末数；`enterNextPeriod` 只保留资产、负债、权益科目，清零损益，但没有将本期利润转入权益。
- 静态例子：零期初，本期收入 100、现金增加 100，本期报表以“权益 + 本期利润”平衡；进入下一期后现金仍为 100，损益清零，权益仍为 0，下一期产生 100 的差额。
- 依据：[productWorkflow.js:401](/Users/matias/Project/FinanceDesk/src/productWorkflow.js:401)、[productWorkflow.js:1712](/Users/matias/Project/FinanceDesk/src/productWorkflow.js:1712)、[reporting.js:126](/Users/matias/Project/FinanceDesk/src/domain/accounting/reporting.js:126)。
- 对应要求：S9 三表勾稽、S13 下一期初始数据。

### F2 · 高优先级：撤销核销后，已入账凭证仍保留旧结果

- 路径：界面提供有效核销的撤销按钮；`reverseReconciliation` 改变核销状态并恢复流水待处理，没有检查关联凭证是否已经入账，也不生成对应会计更正。
- 影响：账单剩余余额恢复，而账簿仍保留原冲减；重新分配还可能与旧凭证重复。当前期间的写入保护不能阻止同一期内发生此问题。
- 依据：[reconciliationEngine.js:1998](/Users/matias/Project/FinanceDesk/src/features/reconciliation/reconciliationEngine.js:1998)、[AccountingWorkbench.jsx:1803](/Users/matias/Project/FinanceDesk/src/features/accounting/AccountingWorkbench.jsx:1803)。
- 最小处理：已入账来源必须走有留痕的更正路径；草稿来源变化时同步失效/重建相关草稿。不能简单改一个状态后保留旧会计结果。
- 对应要求：S6 未核销保护、S8 核销关系与凭证一致、G3 修改留痕。

### F3 · 高优先级：客户看到的确认数字与保存记录不是同一来源

- 页面从冻结 `snapshot.taxWorkpaper` 显示税额，保存首次确认时却调用 `createCustomerConfirmationPackage` 重新用 `buildTaxWorkpaper` 算数。
- 前者会采用结构化发票汇总，后者采用收入乘配置税率等计算路径；两者不同的情况下，用户看到并确认的金额与确认包保存金额可能不一致。
- 依据：[App.jsx:1154](/Users/matias/Project/FinanceDesk/src/App.jsx:1154)、[App.jsx:1932](/Users/matias/Project/FinanceDesk/src/App.jsx:1932)、[reporting.js:1316](/Users/matias/Project/FinanceDesk/src/domain/accounting/reporting.js:1316)、[reporting.js:1406](/Users/matias/Project/FinanceDesk/src/domain/accounting/reporting.js:1406)。
- 最小处理：确认项目的金额、来源、版本直接绑定用户看到的冻结快照，首次确认、最终确认和导出保持同源。
- 对应要求：S9 可追溯、S10 确认申报数据、S12 最终确认。

### F4 · 高优先级：月度档案 ZIP 没有装入凭证原始附件

- `generateMonthlyFinancialArchivePackage` 打包 JSON/CSV 清单，并额外装入回执原文件；凭证原件只在 `referencedAttachmentOriginals` 中被引用，没有对应的文件字节。
- 即使包名显示“完整财务档案”，离开当前浏览器后仍不能仅靠该 ZIP 打开凭证原始附件。单张凭证 ZIP 已有读取原件、核验哈希和打包的实现，可以复用。
- 依据：[documentIntake.js:3108](/Users/matias/Project/FinanceDesk/src/features/intake/documentIntake.js:3108)、[documentIntake.js:3639](/Users/matias/Project/FinanceDesk/src/features/intake/documentIntake.js:3639)。
- 对应要求：S8 原始文件与附件包、S13 全套财务资料归档、G2 证据保存。

### F5 · 高优先级：下载凭证附件会使冻结/归档版本失效

- 凭证附件导出会给凭证追加 `attachmentPackages` 并更新 `updatedAt`；`workflowSourceFingerprint` 将整个 `vouchers` 集合纳入计算。
- 因此只做一次导出也会被认作财务源数据变化。冻结后导出会导致需重新冻结；归档后导出则可能被 `enterNextPeriod` 拒绝，提示必须更正归档。
- 依据：[documentIntake.js:3222](/Users/matias/Project/FinanceDesk/src/features/intake/documentIntake.js:3222)、[productWorkflow.js:1124](/Users/matias/Project/FinanceDesk/src/productWorkflow.js:1124)、[productWorkflow.js:1149](/Users/matias/Project/FinanceDesk/src/productWorkflow.js:1149)、[productWorkflow.js:1716](/Users/matias/Project/FinanceDesk/src/productWorkflow.js:1716)。
- 最小处理：导出记录不改变财务源指纹；金额、分录、原始证据及业务关系的真实变化仍应使旧确认失效。
- 对应要求：S9 冻结与差异、S13 归档与后续访问。

### F6 · 中优先级：关闭的模块仍被月度档案当作必填

- 主流程会按模块开关排除税务、工资社保确认；月度档案计划却仍无条件要求工资、社保确认时间和版本，并检查申报包、最终确认和回执。
- 结果：未启用工资社保或税务的普通工作台，可以完成自身关账条件，却持续得到“不完整档案”。
- 依据：[productWorkflow.js:1366](/Users/matias/Project/FinanceDesk/src/productWorkflow.js:1366)、[documentIntake.js:3410](/Users/matias/Project/FinanceDesk/src/features/intake/documentIntake.js:3410)、[documentIntake.js:3488](/Users/matias/Project/FinanceDesk/src/features/intake/documentIntake.js:3488)。
- 对应要求：第一阶段可用性；用户后来明确的通用工作台、模块可配置决定。

### F7 · 高优先级：手工凭证没有来源资料也能入账

- 手工凭证允许 `sourceIds`、`evidenceIds` 为空。`ensurePostingAllowed` 主要检查来源银行流水；当手工凭证没有来源银行流水时，这组检查没有对象。
- 界面只要求复核意见即可调用入账。因而“借贷平衡 + 一句说明”可以形成没有原始资料的已入账凭证；附件包功能以后提示缺件，并不等同在入账前补齐了证据。
- 依据：[vouchers.js:742](/Users/matias/Project/FinanceDesk/src/domain/accounting/vouchers.js:742)、[vouchers.js:1063](/Users/matias/Project/FinanceDesk/src/domain/accounting/vouchers.js:1063)、[ManualVoucherPanel.jsx:306](/Users/matias/Project/FinanceDesk/src/features/accounting/ManualVoucherPanel.jsx:306)。
- 最小处理：允许保存待补件草稿；入账须有可验证的当前工作台来源和证据。合法的结转/更正凭证应能追溯原凭证或计算依据，不能被一刀切要求银行流水。
- 对应要求：S7 不强制猜账、S8 来源业务与原始资料、第 9 节“每张凭证可追溯”。

## 第一版 12 条指标的静态结论

| 原文指标 | 结论 |
|---|---|
| 按账户银行勾稽 | 已有计算与关账约束；本轮未运行验证 |
| 一款拆多单 | 已有分配、合计与剩余额校验；本轮未运行验证 |
| 一单多次收付款 | 已有累计核销计算；本轮未运行验证 |
| 未核销不错误冲减往来 | 正向路径已有；已入账后撤销路径未达成（F2） |
| 预收预付不进普通账龄 | 已有独立余额与账龄过滤；本轮未运行验证 |
| 每张凭证可追溯原资料 | 未完全达成（F4、F7） |
| 缺件异常自动成任务 | 已有规则与资料缺件任务；覆盖不完整（F7） |
| 低置信度不自动入账 | 已有自动/人工分支和阈值限制；本轮未运行验证 |
| 三大报表可勾稽 | 本期有勾稽；连续账期未达成（F1），撤销后业务与账簿一致性有缺口（F2） |
| 工资社保单独确认 | 已有版本/数据指纹绑定；档案未遵守模块开关（F6） |
| 税务提交前客户确认 | 本地包有两次确认；首次记录数值存在 F3，真实提交尚未实现 |
| 所有修改确认提交有日志 | 主要本地动作已有；不等于完整访问审计，也没有真实外部提交日志 |

## 尚未实现的完整产品能力

微信小程序、银行/税务/经营系统真实授权与同步、本地安全执行器、UKey/CA、电子税务局自动填报与真实提交、财务软件回写、自动回执下载、联网 AI/OCR、PDF 合并、真实实名/MFA/设备管理等尚未实现。其中税务自动填报、财务软件写入等在原文已明确放到第二阶段，不作为本轮优先补齐项。

完整备份恢复仍需后续补充：现有 JSON 备份包含业务状态和资料元数据，不包含 IndexedDB 原文件；换设备恢复不能还原完整原件证据库。

## 本轮三个优化任务的边界

三者都直接使用 `/Users/matias/Project/FinanceDesk` 的当前 `main`。不创建分支或 worktree，不提交、不推送、不部署；不使用 Computer Use。检查前必须说明范围，卡住即报告，不机械重试。本轮执行源代码修改及事前说明的静态核对；测试、构建、服务与浏览器验收由总控后续汇报安排。

| 任务 | 本轮结果 | 允许修改的主要文件 |
|---|---|---|
| 资料与档案优化 | 修复 F4、F6：月度包真正带原件，校验实际文件；可选模块关闭时不误报缺件 | `src/features/intake/documentIntake.js`、`src/features/intake/DocumentIntakePanel.jsx`；必要时 `browserFileVault.js` |
| 核销与凭证优化 | 修复 F2、F7：来源变更与凭证一致，手工凭证证据完整性覆盖入账入口 | `src/features/reconciliation/reconciliationEngine.js`、`src/features/evidence/evidenceEngine.js`、`src/domain/accounting/vouchers.js`、`src/features/accounting/AccountingWorkbench.jsx`、`src/features/accounting/ManualVoucherPanel.jsx` |
| 报表与跨期优化 | 修复 F1、F3、F5：利润正确结转、确认数字同源、导出不使冻结失效 | `src/productWorkflow.js`、`src/domain/accounting/reporting.js`、`src/App.jsx` |

涉及其他任务所有的文件，先向总控说明最小接口要求，不直接修改。总控保留 `AGENTS.md`、本报告、全局样式、包配置与发布文件的编辑权。本轮不要把任务扩成整站重写或新基础设施。

旧「总控」已归档；本任务 `01a06f58-c143-7271-9178-dc127f858264` 是当前总控。此报告记录修改前的发现，不因优化任务开始就将缺陷标成已修复。
