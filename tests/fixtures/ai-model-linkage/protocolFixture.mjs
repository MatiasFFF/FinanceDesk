import assert from "node:assert/strict";
import { runFinanceAssistant } from "../../../src/application/deepseekClient.js";
import { requestDeepSeek } from "../../../server/financeAssistant.js";
import { AI_FINANCE_SYSTEM } from "../../../src/application/aiFinanceTools.js";
import { createModeHistoryController } from "../../../src/features/ai-simple/aiModeSession.js";
import { JOURNEY_KEY } from "../../helpers/aiSimpleJourneyFixture.mjs";

// All values and provider responses in this folder are synthetic. No network,
// browser storage, real API credential, or user's financial data is accessed.
export const SYNTHETIC_KEY = JOURNEY_KEY;
export const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
export const providerReply = ({ model = "deepseek-v4-pro", content = "已读取本地资料", calls = [], reasoning = "" } = {}) => ({
  ...(model == null ? {} : { model }),
  choices: [{ message: { role: "assistant", content,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(reasoning == null ? {} : { reasoning_content: reasoning }),
  }, finish_reason: calls.length ? "tool_calls" : "stop" }],
});
export const initialMessages = () => [{ role: "system", content: AI_FINANCE_SYSTEM }, { role: "user", content: "读取当前工作台本期资料" }];

// Only browser history transport is synthetic. Mode/URL/navigation-request
// behavior comes from the same controller used by FinanceDeskShell.
export function tabNavigationFixture() {
  const events = new EventTarget();
  const browser = { location: { href: "https://financedesk.example.invalid/?mode=ai" },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  };
  browser.history = { state: null,
    replaceState(state, _title, url) { this.state = state; browser.location.href = url; },
    pushState(state, _title, url) { this.state = state; browser.location.href = url; },
  };
  const changes = [];
  const controller = createModeHistoryController({ window: browser, onChange: (value) => changes.push(value) });
  return { controller, browser, changes };
}

/** Real client -> real proxy -> injected external response -> real finance tool.
 * The adapter never substitutes a business result or reimplements a tool.
 * Headers are asserted in transit, deliberately omitted from retained traces.
 */
export function linkedAssistant(fixture, steps, options = {}) {
  const trace = { clientRequests: [], providerRequests: [], messages: [], executed: [], toolResults: [] };
  return {
    trace,
    run() {
      return runFinanceAssistant({
        ...options, apiKey: options.apiKey || SYNTHETIC_KEY,
        messages: options.messages || initialMessages(),
        executeTool: ({ name, arguments: input, signal }) => {
          trace.executed.push({ name, input });
          return fixture.service.invokeTool(name, input, { signal });
        },
        onMessage: async (message) => {
          trace.messages.push(message);
          if (options.persistMessages !== false && message.role === "assistant" && message.content.trim()) fixture.service.appendMessage(message);
          await options.onMessage?.(message);
        },
        onToolResult: async (entry) => { trace.toolResults.push(entry); await options.onToolResult?.(entry); },
        fetchImpl: async (url, init) => {
          assert.equal(url, "/api/finance-assistant");
          assert.equal(init.headers.Authorization, `Bearer ${options.apiKey || SYNTHETIC_KEY}`);
          assert.equal(init.cache, "no-store");
          const body = JSON.parse(init.body);
          trace.clientRequests.push({ url, body });
          try {
            return jsonResponse(await requestDeepSeek({ authorization: init.headers.Authorization,
              body, signal: init.signal,
              fetchImpl: async (providerUrl, providerInit) => {
                assert.equal(providerUrl, "https://api.deepseek.com/chat/completions");
                assert.equal(providerInit.headers.Authorization, init.headers.Authorization);
                assert.equal(providerInit.redirect, "error");
                const payload = JSON.parse(providerInit.body);
                const index = trace.providerRequests.length;
                trace.providerRequests.push({ url: providerUrl, payload });
                const step = steps[index];
                assert.notEqual(step, undefined, "unexpected extra provider request (script exhausted)");
                const reply = typeof step === "function" ? await step({ payload, signal: providerInit.signal }) : step;
                return reply instanceof Response ? reply : jsonResponse(reply);
              },
            }));
          } catch (error) {
            // Same transport status mapping as the handler, without starting HTTP.
            if (error.code === "ERR_ASSERTION") throw error;
            return jsonResponse({ error: error.message }, error.status || 500);
          }
        },
      });
    },
  };
}
