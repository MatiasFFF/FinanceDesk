# AI 简版共享财务服务

本批将 AI 简版接到现有工作台、本地原件和财务核心。模型只能读取当前对象或提出待确认建议；导入、字段变更、业务归属及凭证入账分别由用户在页面确认。默认完整版入口保持可用。

## 文件与调用边界

- `src/application/aiFinanceTools.js`：五个模型工具及中文系统提示。
- `src/application/aiFinanceService.js`：固定目标的业务适配、对话和待确认事项。
- `src/application/financeDeskService.js`：既有银行导入及凭证入账服务。宿主参数 `sourceDocumentId` 复用已保存原件，`exactMapping` 使人工提供的完整映射真正清除未选列；默认完整版仍自动识别列名。
- `tests/ai-finance-service.test.mjs`：本批业务定点测试；由总控执行。

创建服务：

```js
const service = createAiFinanceService({ store, fileVault, workspaceId, period });
```

`store`、`fileVault` 均取自现有 `FinanceDeskProvider`。服务捕获创建时的工作台、账期和本地操作人；任何一项切换后，页面必须取消旧任务并重建服务。异步流程会在最终写入前再次核对目标、权限和取消信号；目标变化返回 `AI_TARGET_CHANGED`。归档和权限仍使用既有 store 规则。

## 页面接口

| 方法 | 返回与作用 |
| --- | --- |
| `getContext(section = 'overview', {offset = 0} = {})` | 当前账期真实信息；列表每页最多50项，返回 `items,total,offset,nextOffset`。 |
| `getAssistantContext(section = 'overview', {offset = 0} = {})` | 给模型的精简当前上下文，含最近用户需求、文件、流水和建议状态；列表每页最多20项。 |
| `uploadFiles(files, {signal,onProgress} = {})` | 顺序保存真实 Blob 原件；返回附件数组。CSV/XLSX/XLS 为银行资料，PDF/图片作为发票资料进入本地识别。 |
| `getConversation()` | `{messages,proposals}`，公开建议不含内部执行载荷和来源快照。 |
| `appendMessage({role,content,attachments})` | 只保存实际发送的 user/assistant 消息及已存原件ID；返回保存后的消息。 |
| `invokeTool(name,input,{signal} = {})` | 执行五个允许的模型工具；可修正参数错误返回 `needs_input`，未知工具、权限或来源失效等立即抛错停止。 |
| `reviseProposal(id,updates,{signal} = {})` | 人工修改后重新计算预览；成功新建修订建议并在同一次保存中替换旧建议。 |
| `confirmProposal(id,{reason,signal} = {})` | 页面明确确认后执行，返回 `{proposal,result,message,voucherId?}`。 |
| `dismissProposal(id)` | 将待确认事项标记为暂不采用。 |
| `postVoucher({voucherId,reviewNote,signal})` | 调用已有 `postWorkspaceVoucher`，核验真实原件和最新业务来源后入账。 |
| `readOriginal(documentId,{signal} = {})` | 返回 `{documentId,name,mimeType,blob,...原件记录}`，仅供页面预览/下载。 |
| `createBankAccount({name,accountNumber = ''})` | 经现有基础资料入口新增真实银行账户，账号仅填后4位，可空。 |

附件格式为 `{documentId,name,kind:'bank'|'document',recognitionStatus}`。上传失败抛出的 `error.uploaded` 包含此前已保存的附件；页面应保留这些附件，显示具体失败原因。相同账期、类别和内容的再次上传会复用既有原件，未完成的识别可以由用户重试。一次最多20个文件，每个最多30MB；本地识别引擎按需加载，不启动后台监听。

OCR正文仍存于 IndexedDB 的原件记录中，工作台JSON仅保存既有识别元数据和必要字段。识别失败保留原件并记录失败状态和简短原因，不会把空内容当作成功；银行CSV/Excel不会自动导入。

## 模型工具

1. `get_context`：读取 overview/documents/transactions/tasks/vouchers/reports/accounts。overview 提供实际银行账户、可用会计科目、业务类型、税务属性和发票状态。报表采用已有 `buildFinancialStatements`、`buildTaxWorkpaper`；未入账资料不计入已入账总账。
2. `read_document`：核验当前账期资料的本地原件，返回本地识别文字、真实字段和 `allowedFields`。文字最多24000字符并注明是否截断；原始正文保留在本地原件存储。
3. `prepare_bank_import`：从已有银行原件解析并调用现有导入预处理。列映射缺失时返回 `needs_mapping`，包括真实表头、样例行和可用映射字段；有错误行返回 `needs_correction`。可以确认的计划才生成 `bank_import` 建议。
4. `propose_bank_business`：使用真实流水和现有财务规则形成业务建议；必填项按工具定义。可选 `relatedBillId/referenceNo/counterparty/relatedTransactionId` 用于现有业务要求的账单、编号、对手和关联流水。关联流水及显式选择的资料限本期；账单不得来自未来账期。不会执行入账或代替风险事项复核。
5. `propose_document_fields`：当前支持发票号码、日期、对手、价税合计、税额和税率；保存前执行现有字段类型、金额和日期校验。模型不能更改查验、红字、作废、认证或审批状态。

模型无法调用确认、入账、新建账户、任意JS、网络地址或工作台JSON替换。传输层的 `executeTool` 只需映射为：

```js
executeTool: ({ name, arguments: args, signal }) =>
  service.invokeTool(name, args, { signal })
```

API密钥不属于业务服务参数。页面及传输层持有当前标签页的密钥；不得把它放入消息、工具结果或工作台数据。消息入口丢弃未知字段并隐藏常见密钥形式，不保存传输层 `tool_calls`。

## 建议预览与确认

公共建议为 `{id,kind,status,title,summary,preview,sourceIds,createdAt,editableValues}`，处理后增加结果、说明、时间与实际操作人。内部载荷和来源快照保存在同一工作台的 `aiSimple.conversations[period]`，用于刷新后恢复与拒绝过期确认。

| kind | preview |
| --- | --- |
| `bank_import` | `fileName,accountId,accountName,headers,mapping,importedCount,duplicateCount,errorCount,transactions,errors,reconciliation`；预览最多20笔。 |
| `bank_business` | `transaction,businessType,businessTypeLabel,account,accountLabel,taxTreatment,invoiceStatus,reason,evidenceIds,relatedBillId?,referenceNo?,counterparty?,relatedTransactionId?,event,voucher,draftIssue`。 |
| `document_fields` | `documentId,name,category,allowedFields,fields:[{key,before,after}],reason`。 |

`editableValues` 可直接用作 `reviseProposal` 的第二个参数：银行为 `{mapping}`，票据为 `{fields}`，业务为 `{classification}`。银行映射是完整替换，删掉key即可清除对应列；不接受-1或null。票据和业务字段与原建议合并，可选业务编号和关联ID使用空字符串清除。不能修订原流水ID、金额、账期或来源资料ID。

修订成功返回 `{status:'pending_confirmation',proposal}`。新建议记录 `revisesProposalId/revisedBy/revisedAt`，旧建议变成 `superseded` 并保存 `supersededBy`，旧项不能再确认或修订。已处理、原件失效或来源被人工修改的建议不能重新包装成可确认建议。银行新映射不完整时返回 `needs_mapping/needs_correction` 和实际预览，旧建议仍为pending；编辑页面保留用户输入，只有成功生成新预览才开放确认。

工具输入缺项返回 `{ok:false,status:'needs_input',error:{code,message,recoverable:true,requiredFields,allowedFields},nextAction}`。模型只可依据真实资料修正；缺少实际依据时说明需要用户补什么。传输层将JSON格式小错误也作为未执行的工具结果交回模型，不自动执行财务确认。目标变化、权限、归档、取消和原件错误仍立即停止，保留此前已保存结果。

发往模型的单项大工具结果最多约64KB，超出时保留操作状态和建议定位并注明摘要截断。模型不得把近期对象、分页或截断结果描述成全期完整核验。页面仍通过原有服务读取完整资料与预览。

确认银行导入时重新读取已保存原件、重新准备计划并使用现有导入去重。并发或刷新后的重复确认不会再次导入同一批流水。银行服务失败清理只删除本次新建的原件，不删除此前用户上传的原件。

确认业务归属时，由现有核心验证并创建业务事件，再尝试生成凭证草稿。缺件或未完成既有业务复核时，会保留已确认业务并返回 `draftIssue`，不声称凭证已完成。页面应提供前往该笔 `AccountingWorkbench(transactionId)` 的入口，让用户通过现有流程补件、复核、生成和入账。

确认票据字段前重新核验原件与来源快照，再通过现有资料更新函数保存实际字段。人工填写、原件版本或识别结果变化会使旧建议失效，用户需要重新整理。确认记录及前后值保留于建议和现有资料审计中；不会把AI建议标成已完成外部发票查验。

## 必要验证交接

由总控先告知用户再执行：

```sh
node --test tests/ai-finance-service.test.mjs tests/deepseek-assistant.test.mjs tests/foundation-service.test.mjs tests/bank-intake.test.mjs
```

本批测试覆盖真实Blob与内存文件保险箱、刷新恢复、确认后复用原件、去重、部分上传、人工修订与旧确认失效、完整列映射清除、异步切账期与取消、人工字段冲突、工具可修正错误与硬错误边界、业务建议到凭证入账和报表。传输测试只模拟外部fetch，不代表真实DeepSeek调用验收。

这些用例不等于真实浏览器、真实图片OCR或DeepSeek联网验收。真实上传、OCR资源加载、模型调用、页面确认与生产发布由总控统一验收。实施任务没有运行测试、构建、服务器、浏览器或发布操作。
