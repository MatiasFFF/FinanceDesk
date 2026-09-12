# FinanceDesk 简版 DeepSeek 接入

本批供本人和同事试用。完整版保持原入口，简版入口为 `?mode=ai`，两版使用同一工作台、账期、财务核心和本地原件。AI 读取必要的识别文字与业务字段，提出整理建议；导入、业务确认和入账继续由页面与业务程序完成。

## 密钥与数据

在简版的 DeepSeek 设置中填写自己的 API key，不要粘贴到对话框。密钥只留在当前页面内存，刷新、关闭页面后需重新填写。密钥不进入 localStorage、sessionStorage、工作台状态、对话记录、环境变量、源码或构建产物；服务器也不保存公共密钥。

每次模型请求通过同源 `/api/finance-assistant` 转发至 DeepSeek，使用该次请求的 `Authorization: Bearer ...`。因此本轮对话、被工具读取的识别文字和必要财务字段会发送到 DeepSeek；原文件继续保存在本地文件库，不在本批通过代理上传原始文件。页面保存前也需要进行密钥脱敏，不能仅依赖网络层脱敏。

代理只访问 `https://api.deepseek.com/chat/completions`，禁止客户端指定 URL、模型或工具列表，并禁止跟随 HTTP 重定向。应用代码不记录请求头、密钥或上游原始错误；错误使用固定中文描述。客户端和代理会从内容、工具参数、工具结果与回复中隐藏当前密钥及常见 `sk-*` 字串。

## 客户端契约

唯一传输模块：`src/application/deepseekClient.js`。UI 自己管理内存密钥、消息显示、持久化和当前任务状态。

```js
import { runFinanceAssistant } from "../../application/deepseekClient.js";
import { AI_FINANCE_SYSTEM } from "../../application/aiFinanceTools.js";

const controller = new AbortController();
const result = await runFinanceAssistant({
  apiKey: apiKeyRef.current,
  messages: [
    { role: "system", content: `${AI_FINANCE_SYSTEM}\n当前目标：${JSON.stringify(context)}` },
    ...conversationMessages,
  ],
  executeTool: ({ name, arguments: args, signal }) => service.invokeTool(name, args, { signal }),
  signal: controller.signal,
  onMessage: (message) => { /* assistant/tool 协议消息；按 role 决定显示内容 */ },
  onToolResult: ({ call, result }) => { /* 刷新业务结果与待确认事项 */ },
});
// result = { messages, message: finalAssistantMessage, toolResults, finishReason }
// 停止：controller.abort()
```

- `messages` 使用文本形式的 OpenAI 对话协议：`system/user/assistant/tool`，工具调用保留 `id/type/function`，工具结果保留 `tool_call_id`。不要把 API key 或 UI 配置对象放进消息。
- `executeTool` 只接收 `{id, name, arguments: object, signal}`。客户端只进行协议、工具白名单和 JSON 对象校验；`aiFinanceService` 必须继续校验参数、对象存在性、工作台、账期、权限和领域规则。
- `tools` 可省略，默认使用 `AI_FINANCE_TOOLS`；显式传入时只作为客户端允许执行的子集，不向代理传递自定义工具定义。
- `onMessage` 每收到一个有效模型回复或已完成工具结果就调用一次；`onToolResult` 接收 `{call: {id,name,arguments}, result}`。回调不承担业务执行，也不能代表用户同意入账。
- `fetchImpl` 仅用于定点测试注入；生产省略，使用浏览器 `fetch`。

当前五个模型工具由 `src/application/aiFinanceTools.js` 提供：`get_context`、`read_document`、`prepare_bank_import`、`propose_bank_business`、`propose_document_fields`。它们读取资料或准备待确认建议；人工确认入口不作为模型工具暴露。

## 中断与边界

每次浏览器请求上限 55 秒；代理上限 50 秒；Vercel 函数上限 60 秒。单次请求体不超过 1,000,000 UTF-8 字节，最多 80 条消息，每个模型回复最多 8 个工具调用。一次 `runFinanceAssistant` 最多发起 6 次模型请求，最后一轮若仍要求工具调用，会先停止，不再执行新一批工具。

工具按顺序执行，执行前校验本批所有工具名与 JSON 参数结构；未知工具、不完整 JSON、截断的模型回复和已处理的调用 ID 均停止。业务服务抛错、工作台或账期改变、用户取消、HTTP 失败或超时后，不自动重试模型请求或财务操作。

失败抛出中文 `Error`，包含 `code`、已取得的 `messages` 和 `toolResults`。未取得结果的工具调用会补上“本轮已停止、需重新查询工作台状态”的协议结果，使恢复对话不会把它当作已成功。已完成业务结果不会撤回，也不能将取消解释成回滚。

UI 至少区分：

| code | 页面处理 |
| --- | --- |
| `KEY_REQUIRED` | 打开密钥设置，保留当前输入和附件草稿 |
| `ASSISTANT_CANCELLED` | 停止忙碌状态，保留已保存资料和待确认事项 |
| `AI_TARGET_CHANGED` | 停止当前轮，不把结果显示到另一工作台或账期 |
| `ASSISTANT_TIMEOUT` / `ASSISTANT_NETWORK` | 提示稍后继续，保留已完成结果 |
| `ASSISTANT_ROUND_LIMIT` | 提醒先核对已产生的事项，再继续处理 |
| `ASSISTANT_TOOL_FAILED` | 显示业务校验信息，不自动重放操作 |

用户再次发起整理时，先读取当前真实业务状态再决定后续动作。原件导入与 proposal 的幂等、确认及入账规则仍由共享业务服务负责，客户端不直接修改工作台 JSON。

## 本地与 Vercel

- `server/financeAssistant.js` 是唯一 Node 代理实现。
- `vite.config.js` 和 `vite.config.mjs` 注册 `financeAssistantPlugin()`，本地开发与预览都处理精确路径 `/api/finance-assistant`。
- 根目录 `api/finance-assistant.js` 直接导出共享处理器，`config.maxDuration = 60`。沿用现有 Vercel 的 Vite 项目和 Git 发布，不增加共享 API key 环境变量，也不创建独立部署工程。
- 纯静态文件或单文件 HTML 没有同源 Node 函数，不能独立提供 AI 调用；完整版的本地能力继续使用原流程。Sites 专用文件本批保持不变，不能以本批 Vercel 接入宣称 Sites 代理已接通。

## 总控执行的必要验证

以下步骤由总控先向用户汇报，再统一执行；实施任务仅准备测试源码和清单。

1. 运行 `node --test tests/deepseek-assistant.test.mjs`。测试只用假 fetch、内存请求及虚拟计时器，不读取真实 key、不访问外网、不监听端口。覆盖完整三轮协议、错误与脱敏、大小/格式限制、工具失败与中断、轮数上限、UTF-8 分块和本地/Vercel 共享入口。
2. 启动本地预览，打开简版设置。无 key 时保留输入和附件；填写 key 后走一次真实 DeepSeek 调用；取消后核对已完成事项保留，刷新后 key 不保留。只观察状态，不抓取或输出密钥。
3. Vercel 发布后核对 `/api/finance-assistant` 是 JSON 函数响应：GET 为 405，无授权的合法 JSON POST 为 401；再由用户已填写的密钥完成一次真实业务流程。代理响应、部署成功和假 fetch 测试均不单独证明真实模型或财务流程通过。

## 官方依据

2026-09-12 读取的 [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) 支持 `deepseek-flash`、`thinking: {type: "disabled"}`、`stream: false` 与工具调用；官方明确要求应用程序校验模型生成的工具参数。本批固定这些选项，输出上限 4096 tokens。函数时限使用 [Vercel Node API 路由的 config 配置](https://vercel.com/docs/functions/configuring-functions/duration)。
