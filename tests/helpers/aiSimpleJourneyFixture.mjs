import { createFinanceDeskStore } from "../../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../../src/features/intake/browserFileVault.js";
import { createAiFinanceService } from "../../src/application/aiFinanceService.js";
import { AI_FINANCE_SYSTEM } from "../../src/application/aiFinanceTools.js";
import { runFinanceAssistant } from "../../src/application/deepseekClient.js";
import { requestDeepSeek } from "../../server/financeAssistant.js";

// Deliberately fake transport credential. No real provider or browser storage is used.
export const JOURNEY_KEY = "test_financedesk_journey_key_12345";
export const JOURNEY_PERIOD = "2026-09";
export const BANK_CSV = "日期,对方,摘要,余额,发生额,流水号\n2026-09-01,测试银行,账户管理手续费,975,-25,J001\n2026-09-02,测试银行,短信服务费,960,-15,J002";
export const BANK_MAPPING = { date: 0, counterparty: 1, summary: 2, amount: 4, serial: 5 };
const now = () => new Date("2026-09-12T08:00:00.000Z");

export const namedBlob = (text, name = "流程银行流水.csv", type = "text/csv") => Object.assign(new Blob([text], { type }), { name });

export function createJourneyFixture() {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  const store = createFinanceDeskStore({ repository });
  const workspace = store.actions.createWorkspace({ id: "ai-journey", name: "流程验收工作台", currentPeriod: JOURNEY_PERIOD,
    initialUserName: "流程复核人", initialUserRoleId: "role-owner" });
  const fileVault = createMemoryFileVault();
  const target = { workspaceId: workspace.id, period: JOURNEY_PERIOD };
  const service = createAiFinanceService({ store, fileVault, ...target });
  const account = service.createBankAccount({ name: "流程验收账户", accountNumber: "1234" });
  return { store, storage, fileVault, service, account, ...target };
}

export function reloadJourney(fixture) {
  const store = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: fixture.storage, now }) });
  return { ...fixture, store, service: createAiFinanceService({ ...fixture, store }) };
}

export const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
export const assistantReply = (content, calls) => ({ choices: [{ message: { role: "assistant", content,
  ...(calls?.length ? { tool_calls: calls } : {}) }, finish_reason: calls?.length ? "tool_calls" : "stop" }] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** In-process HTTP adapter; client, proxy validation and all business tools remain real.
 * Only the external DeepSeek fetch receives scripted responses. No global fetch patch.
 */
export function scriptedAssistant(fixture, steps, { messages, userText = "整理本期上传资料，先给我核对建议", signal,
  onToolResult = () => {}, onMessage = () => {} } = {}) {
  const trace = { clientRequests: [], providerRequests: [], messages: [], toolResults: [], executed: [] };
  return {
    trace,
    run() {
      if (!messages) fixture.service.appendMessage({ role: "user", content: userText });
      return runFinanceAssistant({ apiKey: JOURNEY_KEY, signal,
        messages: messages || [{ role: "system", content: AI_FINANCE_SYSTEM },
          { role: "system", content: JSON.stringify(fixture.service.getAssistantContext()) }, { role: "user", content: userText }],
        executeTool: ({ name, arguments: input, signal: toolSignal }) => {
          trace.executed.push({ name, input });
          return fixture.service.invokeTool(name, input, { signal: toolSignal });
        },
        onMessage: async (message) => {
          trace.messages.push(message);
          if (message.role === "assistant" && message.content.trim()) fixture.service.appendMessage({ role: "assistant", content: message.content });
          await onMessage(message);
        },
        onToolResult: async (entry) => { trace.toolResults.push(entry); await onToolResult(entry); },
        fetchImpl: async (url, options) => {
          trace.clientRequests.push({ url, body: JSON.parse(options.body) });
          try {
            const result = await requestDeepSeek({ authorization: options.headers.Authorization,
              body: JSON.parse(options.body), signal: options.signal,
              fetchImpl: async (providerUrl, init) => {
                const index = trace.providerRequests.length;
                const payload = JSON.parse(init.body);
                trace.providerRequests.push({ url: providerUrl, payload });
                const step = steps[index];
                if (step === undefined) throw new Error("Journey provider response script exhausted");
                const reply = typeof step === "function" ? await step({ payload, signal: init.signal }) : step;
                return reply instanceof Response ? reply : json(reply);
              } });
            return json(result);
          } catch (error) {
            return json({ error: error.message }, error.status || 500);
          }
        },
      });
    },
  };
}
