# Prototype Instructions

## Mandatory execution discipline

- Prioritize the user's explicitly requested real functionality and the shortest usable end-to-end path.
- Absolutely prohibit unnecessary review, audit, approval gates, engineering infrastructure, fallbacks, compatibility work, abstraction, refactoring, and expansion. Do none of them unless they are genuinely indispensable to the current explicit requirement, preventing real data loss, or the minimum verification needed to prove that requirement works.
- Never use those activities to replace, delay, or dilute functional construction. If one is truly necessary, explain its concrete necessity and smallest possible scope to the user before doing it.
- Before running any test, check, or listener, tell the user exactly what will run and why. If work is blocked, report the concrete blocker once instead of retrying mechanically.
- 每轮以已分派的明确问题为边界；收尾中新发现但非本轮必需的问题列入待办，不持续加项。完成必要定点验证后，由总控及时提交并 push，确认发布状态后报告已发布版本、剩余项与完成度。

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Durable FinanceDesk decisions

- 本批实际浏览器验收复现：手动展开资料文件后切换完整版丢失当前文件定位。事项衔接任务补充负责 DocumentIntakePanel.jsx 的最小可选文档定位回调，供 AiResources 保存/恢复当前 documentId，沿用原权限、编辑离开保护和旧调用行为，不建设通用视图状态框架。

- 2026-09-12 用户最新明确：直接打开网站默认进入 AI 对话入口，无参数首页属于 AI 模式，保留 `?mode=ai` 兼容简版链接；完整版改用明确 `?mode=full` 入口。两版每个页面在合适页角提供直接模式切换，不能只藏在账户菜单；简版资料/报表弹窗也有当前事项的切换出口。保持简洁和原业务功能，切换保留共享账本、账期、临时 Key、草稿与当前事项，沿用 dirty/busy 保护。会话任务补充负责 AiDialog.jsx 的最小可选 headerAction 接口；事项任务在资源弹窗中接入该接口；统一样式任务处理切换按钮响应式。此条取代此前无参数打开完整版的约定，本批发布前完成。

- 本批事项衔接任务 `01a0944f-07c0-7f00-9314-afd15d725680` 补充负责 `AiReports.jsx` 中报表页签状态与返回恢复的最小适配（可选 initialSection/onSectionChange），用于现金流/资产负债表下钻凭证后返回原报表；不扩展报表业务或导出范围。

- 本批六个执行任务通讯录：FinanceDesk｜模型选择与使用标识 `01a0944f-02f4-7af0-9ff4-2ffb83c43a9c`；FinanceDesk｜DeepSeek 多模型协议 `01a0944f-04a5-7042-a2dc-d776d96e0ac4`；FinanceDesk｜两版切换与会话保留 `01a0944f-0634-70c3-aca8-62a34616979d`；FinanceDesk｜事项定位与返回衔接 `01a0944f-07c0-7f00-9314-afd15d725680`；FinanceDesk｜完整工作台蓝色统一 `01a0944f-095c-7091-892f-f152b154adea`；FinanceDesk｜模型与双入口流程验证 `01a0944f-0af0-7051-9685-10a812063c47`。按下一条的角色文件边界执行，跨任务接口通过任务消息直接协调，总控统一整合。

- 2026-09-12 用户确认开始第二批 AI 简版建设，旧五个执行任务已归档，允许新开六个 GPT-6 Astra / Ultra 任务，沿用默认非 Fast，不重复询问。总控为 `01a093ec-605f-7560-98fc-f950f25f2bb3`，同一目录、同一 main，不建分支/worktree。本批范围：DeepSeek 官方可用模型选择、实际使用模型显示与思考模式适配；简版/完整工作台共用本地账本，在同一标签页切换并保留 Key、草稿、当前工作台账期及事项返回路径；完整工作台统一白色/浅蓝灰底及蓝色控件，保留现有财务功能和语义状态色。首页继续极简蓝色渐变。Key 只在标签页内存，不能写入本地持久化、源码、日志或云端配置；真实 DeepSeek 联调暂不作为开发前提，模拟协议验证与真实调用必须分开报告。不建设云同步、多供应商框架或通用路由框架。
- 本批六任务文件边界取代下方旧轮次分工：模型界面任务负责 AiSettings/AiComposer/AiConversation、仅消息模型元数据所需的 aiFinanceService.js 及独立模型界面 helper；模型后端任务负责 deepseekClient.js、server/financeAssistant.js、api/finance-assistant.js、新增模型列表代理与模型协议 helper、必要 Vite 接口配置及 DeepSeek 定点测试；会话切换任务负责 main.jsx、新入口 shell、AiSimpleApp.jsx、新共享标签页会话 context 与切换 helper；事项衔接任务负责 App.jsx、AiResources.jsx、aiWorkflow.js 及确有必要的原版事项定位适配；统一界面任务独占所有 CSS 与主题样式，不改其他任务 JSX；流程验证任务负责本批独立集成测试源码、受控接口响应夹具和简短验收说明，不改应用代码。共享接口先直接协调；越界修改交所属任务，不抢文件。六任务均立即实施已分派范围，可读取代码和官方文档，不自行执行测试、构建、服务、浏览器或提交，不再拆代理。总控负责 AGENTS、统一测试执行、浏览器验收、构建、main 提交 push 与发布核对，运行前先向用户说明。非本批必需问题列待办，不扩项。

- 2026-09-12 用户再次明确要求增派并行任务，本轮补充 `01a0942e-1464-78c1-8c55-6d3d26c80bcc` 负责 AiReports.jsx、简版报表来源及导出相关文件；`01a0942e-1603-79e3-bbac-4bd91b0c23e8` 负责独立完整流程测试源码。用户已明确确认两个新任务原本就未开 Fast，现均按 Astra / Ultra / Fast关闭正式启动，不再重复确认。原流程任务不再改 AiReports.jsx；原三个任务继续既定范围。新增任务也不自行运行测试、服务、浏览器或提交发布，统一由总控执行。

- 2026-09-12 用户授权对 AI 简版首版继续自主细化功能、操作流程、界面和响应式体验，优先复用三个已有 Astra / Ultra 且 Fast 关闭的任务，必要时可增派独立任务。本轮具体范围：上传与识别进度和恢复、待确认建议的人工修正及重新预览、对话可读性与滚动、可搜索的本期流水及资源定位、工作台/输入/弹窗的蓝色简洁视觉与手机操作。保持首页极简、原版入口和财务核心；不建设注册收费、云同步或通用代理框架。新分工取代首版文件边界：界面任务 `01a09404-9ec3-7992-8905-f63bd8a53871` 负责 AiSimpleApp/AiComposer/AiDialog/AiSettings、简版CSS及输入helper；流程任务 `01a09404-a046-7382-98b4-4cd56e5a4cf2` 负责 AiConversation/AiResources/AiProposalPreview/AiReports 及相关组件；业务任务 `01a08149-3faf-7b31-8761-466eda506f53` 负责 AI财务服务、工具定义、DeepSeek客户端与代理和必要核心修改。三方编写各自必要测试，不自行执行；总控统一验证、浏览器、依赖变更、构建、main提交与发布。密钥继续只在当前标签页临时使用，真实API联调证据须与模拟测试分开报告。

- 2026-09-12 用户进一步授权多会话并行构建简版，全部使用 GPT-6 Astra / Ultra，不开启 Fast。本批分工更新：`01a09404-9ec3-7992-8905-f63bd8a53871` 负责 `src/features/ai-simple/`、`src/main.jsx` 与简版界面；`01a09404-a046-7382-98b4-4cd56e5a4cf2` 负责 `src/application/deepseekClient.js`、`server/financeAssistant.js`、`api/finance-assistant.js`、两份 Vite 配置及 DeepSeek 定点测试/文档；原实施任务 `01a08149-3faf-7b31-8761-466eda506f53` 仅负责 `src/application/aiFinanceService.js`、首批必要财务核心修改及业务测试/文档。三方只写各自文件，接口直接协调；所有测试执行、服务、浏览器、AGENTS、图片资产、构建和提交发布仍由当前简版总控负责。同一 main、同一目录，不分支/worktree，不继续拆内部子代理。本条取代下面单实施任务的文件分工。

- 2026-09-12 用户确认新增 DeepSeek AI 简版并开始实施：先供本人和同事试用，首批做通“上传流水和票据 → AI 整理核对 → 查看凭证和报表”。保留现有完整版与原入口，新增 `?mode=ai` 入口，两版共用现有工作台、账期、财务核心和本地原件；本批允许为这条真实流程接 DeepSeek，取代下方旧轮次“暂不接 AI、不做简版”的范围限制。首页按 `docs/ai-simple/reference-home.png`，工作台按 `docs/ai-simple/reference-workbench.png` 实现：蓝色渐变、首页仅输入框和右上角账户入口；工作台以当前对话及必要确认事项为中心，资料与报表按需进入，不加常驻侧栏、步骤条或快捷卡片墙。右上角先作为内部试用工作台入口，本批不建设外部客户注册、会员收费或云同步。用户已有 DeepSeek API；密钥由用户在专门的配置位置填写，不写入源码、构建产物、业务数据或日志，不要求在聊天中发送。业务写入沿用原有权限、原件和入账确认，AI 结果须由业务程序校验；不建设通用代理框架。
- 2026-09-12 简版批次由当前简版任务担任总控，沿用 `01a08149-3faf-7b31-8761-466eda506f53` 实施任务负责本批源代码、简版专用样式、必要测试和接入文档；总控负责本文件、参考图与背景资产、所有测试执行、浏览器视觉和真实操作验收、构建、main 提交 push 及部署核对。沿用当前 main 和同一目录，不创建分支、worktree 或内部子代理。旧修复轮次已在 e83c7fa 收尾，不重新扩展旧范围。

- 2026-09-12 用户授权继续自主优化、迭代，避免非必要门禁与工程化。本轮聚焦已复现的误操作恢复链路：业务凭证草稿取消后可重建、未入账预收/预付冲销可撤回、撤销或更正原资金核销后仍须覆盖有效冲销。沿用现有页面与共享业务入口，保留必要原件、权限、归档和已入账边界，不建设通用历史调账系统。继续由原实施任务负责本范围源代码、必要测试与文档，总控负责二次复核、所有测试执行、浏览器验收、构建及 main 提交发布；本批内自主修复验证发现的问题，其他发现列待办。

- 2026-09-09 用户授权本轮先全链路排查、逐项二次复核，再交原实施任务修复已确认问题，由总控独立复查并在本轮内迭代发布。本轮冻结范围：库存跨月数量成本、账单历史及结算关系保护、未入账草稿取消、凭证共享入账及异步最新状态提交、回执固定申报包及原件、文件生成与浏览器下载分离、识别结果持久化与前台/引擎解耦，并修正失配的相关测试。继续由 `01a080dc-f0ec-7ad2-ac79-70e0d04ca603` 总控、`01a08149-3faf-7b31-8761-466eda506f53` 实施；实施任务可写本范围应用代码、必要测试与接口/排查文档，总控负责本文件、所有测试执行、浏览器、构建和发布。页面布局保持现状，补齐真实操作出口；不接真实 AI、不新建简版页面、通用事务/任务引擎或历史差额调整系统。发现非本轮必需问题列待办，不持续加项；下方旧轮次和分批待确认记录以本条新授权为准。

- 2026-09-08 用户确认采用一套共享财务核心，供现有手动页面及未来 AI 简版页面调用；当前保持页面视觉和正常操作流程，不接 DeepSeek API、不建设简版页面。业务接口明确工作台、账期与对象，复用现有财务规则、原件证据和必要确认，避免增加无必要的审批、框架和抽象。分批给出方案，经用户确认后实施；已确认批次内允许自主迭代。
- 2026-09-08 本轮总控为 `01a080dc-f0ec-7ad2-ac79-70e0d04ca603`，实施任务为 `01a08149-3faf-7b31-8761-466eda506f53`（共享业务接口第一批实施）。首批共享银行入口与存储修复已在 `ef2e548` 完成；用户继续确认银行接口修整：交易对手归属及必要参数校验、导入历史快照与当前勾稽结果分离、银行异常按账期隔离。实施任务负责银行业务与服务代码、必要页面适配、接口文档和定点回归；总控独立复查并在本批内迭代，负责本文件、统一验证、服务、浏览器验收、构建产物、commit、push 和部署核对。其他业务接口、后台续跑及结构重构仍待各批方案确认。沿用当前目录及 main，不开分支、worktree 或内部子代理；下方旧轮次分工仅为历史记录。
- 2026-09-07 用户确认：活动账期可选择年月，未归档月份允许往返操作，新建工作台可选起始账期，各月分别保存期初余额、银行余额、税务与申报进度；已归档月份只读，余额冲突保留原值并核对。
- 2026-09-07 用户要求优化活动账期的整体界面：入口统一放在标题区域，清理重复日期与日历图标；使用符合现有米白、深棕、陶土色风格的年份与月份面板，保持宽窄屏对齐，避免使用风格不一致的原生月份弹窗。
- 2026-09-07 用户确认按会计日常工作顺序优化整个项目：每页明确正在处理的对象、当前缺项和下一步；导入完成能继续处理本批，待办直达具体对象，补齐资料后回到原任务，当前账期进度与归档条件使用一致口径。沿用现有业务能力与视觉风格，减少重复状态和过深入口，保留必要业务确认、权限、原件证据和未保存输入保护。
- 2026-09-07 本轮会计流程优化由当前任务 `01a079da-11e9-7e20-8f94-4573c8465d00` 担任总控，按用户要求新开一个 GPT-5.6 Sol / max 实施任务，完成已确认方案。实施任务可修改方案涉及的应用代码、公共样式和必要测试文件；总控负责 `AGENTS.md`、统一测试、服务与浏览器验收、构建产物、commit、push 和部署核对。以下八项修复的任务分工属于上一轮记录，本轮文件职责以本条为准。仍共享当前 `main` 与目录，不新建分支或 worktree，不再分内部子代理。

- The only valid project path is `/Users/matias/Project/FinanceDesk`; do not recreate or use `FinanceSystem`.
- 2026-09-05 用户明确要求：继续本地开发与必要验证，保持 localhost 原型和单文件 HTML 可用；用户主要通过 https://financedesk.cn 正式网页版验收。每轮已完成并通过必要验证的优化，由总控及时 commit 并 push `main`，核对生产部署成功后才报告已上线，不再等待用户专门确认本地预览而积压改动。三个实现任务继续共享 `main`，仅总控执行 commit、push 和 Computer Use。
- 当前只把本地服务与功能做精；微信小程序、真实银行/税务/其他业务系统连接、外部账号密码、联网 API 和上传外部平台均延后，不纳入当前完成度。开发时允许研究 GitHub、下载开源依赖；产品资料处理应在本地，不依赖联网识别。
- 网页版须统筹页面间异步加载、OCR/PDF 资源下载与调用的运行成本：大型识别依赖和语言资源按需加载并本地缓存，不进入普通页面首屏，也不膨胀单文件 HTML；逐文件、逐页处理并限制资源占用，支持取消，切页时避免重复任务和旧结果误写；长识别正文留在本地资料存储，工作台 JSON 只保留必要状态和字段。
- Support normal responsive browser layouts on macOS, Windows, iPad, and mobile. The earlier 4:3 request was accidental and was explicitly withdrawn.
- Use the selected Claude-like visual language: warm off-white, terracotta, deep brown, and sage; keep the UI concise, attractive, and practical, without filler copy.
- 全项目卡片保持清楚一致的文字层级：普通标题 16px/600、正文 14px、辅助说明 12px、字段标签 13px，标题与必要图标独立一行并留 8px 间距，说明另起一行，删除重复角标和装饰性前缀，长名称与窄屏靠合理换行和间距处理，不靠缩小字号或堆叠说明。
- Preserve capability while keeping the interface simple and clear. Show only information and actions needed for the current decision; remove unnecessary buttons, repeated status blocks, filler explanations, and implementation terminology from existing screens as well as new work. Reuse existing entry points, reveal necessary low-frequency details on demand, and do not default to adding more tabs, panels, or controls. Simplification must not discard financial evidence, required confirmations, or unsaved input.
- 每轮整合后按当前本地功能范围汇报完成度区间、实际新增能力、验证层级和主要剩余项，第一阶段单列；旧的“完整 Markdown”比例仅作历史，不将延后范围或测试通过率纳入当前完成度。
- 功能建设优先；新增功能仅做必要验证，每轮整合集中验收一次；已通过且未变更的部分不重复核验，只因新变化、失败或明确风险补查。
- The selected product anatomy combines three views in one workflow: monthly close overview, batch reconciliation workspace, and single-transaction evidence review.
- Visible controls must produce meaningful state changes and complete real local data flows; do not present a decorative shell as finished functionality. External bank, tax, and AI integrations must be labeled as later-stage capabilities rather than simulated as connected.
- UI quality and functional completeness are the highest product priorities. Keep large-screen layouts polished and responsive, align foundation-data forms precisely, and remove rough, doubled, fuzzy, or cheap-looking borders and spacing.
- A newly created workspace must start as a neutral financial workspace. Fitness-specific modules such as members, coaches, packages, and verification may appear only when the user selects an applicable template or enables them; workspace modules must be configurable rather than locked in.
- Charts of accounts, accounting roles, business terminology, and industry rules must be editable per workspace instead of being permanently tied to the fitness-studio example.
- For visual acceptance, use the user's current single-screen browser setup; the earlier iPad split-screen setup has been closed. Only this control task may use Computer Use, and implementation tasks must never use it.
- 总控专注任务分工、进度、Computer Use 验收和整合；代码与文档写入优先分配给实施任务，避免总控上下文膨胀。
- Keep the repository on the single `main` branch. Do not create or retain additional branches or worktrees; parallel implementation tasks share the current checkout, and the control task alone commits and pushes their completed changes.
- 2026-09-07 用户指定本轮总控为 `01a079e5-9ead-77d0-b053-f35d431e06a4`（`FinanceDesk｜修复总控`），授权新开以下三个项目任务修复已复核的八项功能问题，并由本轮总控统一验证、commit、push。沿用现有 `main` 和同一目录，不创建分支或 worktree，不再分内部子代理；旧账期任务已在 `3365270` 完成交接。
- `01a079f8-7577-7ab3-89c9-4821c64c3175`（`FinanceDesk｜存储与确认权限修复`）独占 `src/storage/localFoundationRepository.js`、`src/store/`、`src/domain/foundation.js`、`src/App.jsx`，负责多窗口保存保护及确认权限。
- `01a079f9-12cf-74a3-b7e7-ceb00092cf5c`（`FinanceDesk｜凭证与业务来源修复`）独占 `vouchers.js`、`evidenceEngine.js`、会员/库存功能文件、`ManualVoucherPanel.jsx`、`documentIntake.js`，负责会员来源去重、库存金额更正及入账原件核验。
- `01a079f9-146e-7bc0-bb73-7cc748bd3e14`（`FinanceDesk｜往来账单与报表修复`）独占 `reporting.js`、`model.js`、`reconciliationEngine.js`、`AccountingWorkbench.jsx`、`productWorkflow.js`、`FoundationRecordsPanel.jsx`，负责账单确认衔接、现金流分类和账龄。各任务只改自己分派的测试文件；跨边界改动先交总控协调，由文件所属任务执行。`AGENTS.md`、公共样式、构建产物、统一测试/服务/浏览器验收及提交发布均由总控负责。
