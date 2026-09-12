import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { runFinanceAssistant, ASSISTANT_MAX_ROUNDS, ASSISTANT_REQUEST_TIMEOUT_MS, ASSISTANT_TOOL_RESULT_LIMIT } from "../src/application/deepseekClient.js";
import { requestDeepSeek, financeAssistantHandler, financeAssistantPlugin,
  FINANCE_ASSISTANT_BODY_LIMIT, FINANCE_ASSISTANT_TIMEOUT_MS } from "../server/financeAssistant.js";
import vercelHandler, { config } from "../api/finance-assistant.js";

// Deliberately fake fixture, never a real credential and never a network request.
const key = "test_financedesk_key_12345";
const authorization = `Bearer ${key}`;
const initial = () => [{ role: "system", content: "读取真实资料，仅提出建议" }, { role: "user", content: "整理本期票据" }];
const call = (id = "call_1", name = "get_context", args = { section: "overview" }) => ({
  id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const message = (content = "已整理，请核对待确认事项", calls) => ({ role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const completion = (content, calls, finishReason = calls?.length ? "tool_calls" : "stop") => json({ message: message(content, calls), finishReason });
const upstream = (content, calls, finishReason = calls?.length ? "tool_calls" : "stop") => json({ choices: [{ message: message(content, calls), finish_reason: finishReason }] });

function responseStub() {
  const res = new EventEmitter();
  res.headers = {};
  res.writableEnded = false;
  res.destroyed = false;
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.end = (body) => { res.body = body; res.writableEnded = true; };
  return res;
}

function requestStub({ body = { messages: initial() }, method = "POST", headers = {}, chunks = [] } = {}) {
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = { authorization, "content-type": "application/json", ...headers };
  if (body !== undefined) req.body = body;
  return req;
}

test("client and fixed proxy complete a real messages/tool_calls/tool-result loop", async () => {
  const requests = [];
  const executed = [];
  const events = [];
  const results = [];
  const original = initial();
  const answer = await runFinanceAssistant({ apiKey: key, messages: original,
    executeTool: async ({ name, arguments: args }) => {
      executed.push({ name, args });
      return name === "get_context" ? { documentIds: ["doc_1"] } : { text: "发票金额100元", status: "待确认" };
    },
    onMessage: (item) => events.push(item), onToolResult: (item) => results.push(item),
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/finance-assistant");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      const result = await requestDeepSeek({ authorization: options.headers.Authorization, body: JSON.parse(options.body), signal: options.signal,
        fetchImpl: async (target, init) => {
          assert.equal(target, "https://api.deepseek.com/chat/completions");
          assert.equal(init.redirect, "error");
          assert.equal(init.headers.Authorization, authorization);
          const payload = JSON.parse(init.body);
          requests.push(payload);
          assert.equal(payload.model, "deepseek-flash");
          assert.deepEqual(payload.thinking, { type: "disabled" });
          assert.equal(payload.stream, false);
          assert.equal(payload.tools.length, 5);
          assert.equal(payload.tools.some((tool) => /confirm|post_voucher/.test(tool.function.name)), false);
          if (requests.length === 1) return upstream("先查询当前账期", [call()]);
          if (requests.length === 2) return upstream("读取票据", [call("call_2", "read_document", { documentId: "doc_1" })]);
          return upstream("doc_1 的100元金额仍待确认");
        } });
      return json(result);
    } });
  assert.equal(requests.length, 3);
  assert.deepEqual(executed, [{ name: "get_context", args: { section: "overview" } }, { name: "read_document", args: { documentId: "doc_1" } }]);
  assert.equal(requests[1].messages.at(-1).tool_call_id, "call_1");
  assert.deepEqual(JSON.parse(requests[2].messages.at(-1).content), { text: "发票金额100元", status: "待确认" });
  assert.deepEqual(events.map((item) => item.role), ["assistant", "tool", "assistant", "tool", "assistant"]);
  assert.equal(results.length, 2);
  assert.equal(answer.message.content, "doc_1 的100元金额仍待确认");
  assert.equal(answer.messages.length, 7);
  assert.deepEqual(original, initial());
});

test("missing key stops before HTTP and never echoes an invalid value", async () => {
  for (const apiKey of ["", "bad key\r\nAuthorization: injected"]) {
    await assert.rejects(runFinanceAssistant({ apiKey, messages: initial(), fetchImpl: () => assert.fail("must not fetch") }),
      (error) => error.code === "KEY_REQUIRED" && !error.message.includes("injected"));
  }
});

test("proxy rejects arbitrary targets, tools, model overrides and oversized UTF-8 bodies before forwarding", async () => {
  const bodies = [
    { messages: initial(), url: "https://example.invalid" },
    { messages: initial(), model: "another-model" },
    { messages: initial(), tools: [] },
    [], { messages: [] }, { messages: Array(81).fill(initial()[1]) },
    { messages: [{ role: "user", content: { image: "x" } }] },
    { messages: [{ role: "user", content: "票".repeat(Math.ceil(FINANCE_ASSISTANT_BODY_LIMIT / 3)) }] },
  ];
  for (const body of bodies) await assert.rejects(requestDeepSeek({ authorization, body, fetchImpl: () => assert.fail("must not forward") }),
    (error) => [400, 413].includes(error.status));
});

test("proxy rejects orphan results, missing results and repeated tool-call IDs", async () => {
  const histories = [
    [...initial(), { role: "tool", tool_call_id: "orphan", content: "{}" }],
    [...initial(), message("", [call()])],
    [...initial(), message("", [call()]), { role: "user", content: "继续" }],
    [...initial(), message("", [call()]), { role: "tool", tool_call_id: "call_1", content: "{}" }, message("", [call()])],
  ];
  for (const messages of histories) await assert.rejects(requestDeepSeek({ authorization, body: { messages }, fetchImpl: () => assert.fail("must not forward") }), { status: 400 });
});

test("credentials are redacted from content, tool results, callbacks and provider responses", async () => {
  let count = 0;
  const events = [];
  const answer = await runFinanceAssistant({ apiKey: key, messages: [{ role: "user", content: `误贴 ${key}` }],
    executeTool: () => ({ text: key, other: "sk-not_a_real_key_123456789" }), onMessage: (item) => events.push(item),
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.includes(key), false);
      count += 1;
      return count === 1 ? completion(key, [call(key)]) : completion(`已完成 ${key}`);
    } });
  assert.equal(JSON.stringify(answer).includes(key), false);
  assert.equal(JSON.stringify(events).includes(key), false);
  assert.equal(JSON.stringify(answer).includes("sk-not_a_real_key"), false);
  const proxied = await requestDeepSeek({ authorization, body: { messages: [{ role: "user", content: key }] },
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.includes(key), false);
      return upstream(key, [call(key)]);
    } });
  assert.equal(JSON.stringify(proxied).includes(key), false);
});

test("HTTP and network errors never relay provider secrets or automatically retry", async () => {
  for (const status of [400, 401, 402, 403, 429, 500]) {
    let count = 0;
    await assert.rejects(requestDeepSeek({ authorization, body: { messages: initial() }, fetchImpl: async () => {
      count += 1;
      return { ok: false, status, json: () => assert.fail("must not read upstream error") };
    } }), (error) => error.status === (status === 500 ? 502 : status) && !error.message.includes(key));
    assert.equal(count, 1);
  }
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(), fetchImpl: async () => {
    throw Object.assign(new Error(`network ${key}`), { code: key });
  } }), (error) => error.code === "ASSISTANT_NETWORK" && !JSON.stringify(error).includes(key) && !error.message.includes(key));
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(), fetchImpl: async () => json({ error: key }, 401) }),
    (error) => error.code === "KEY_REQUIRED" && !error.message.includes(key));
});

test("unknown, repeated or truncated tool batches perform no business operation", async () => {
  const replies = [
    () => completion("", [call("call_1", "execute_js")]),
    () => completion("", [call(), call()]),
    () => completion("", [call()], "length"),
    () => completion("", [call()], "stop"),
    () => completion("", undefined, "tool_calls"),
  ];
  for (const reply of replies) await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(),
    executeTool: () => assert.fail("must not execute"), fetchImpl: async () => reply() }),
    (error) => ["ASSISTANT_INVALID_TOOL", "ASSISTANT_INCOMPLETE", "ASSISTANT_INVALID_RESPONSE"].includes(error.code));
  await assert.rejects(requestDeepSeek({ authorization, body: { messages: initial() }, fetchImpl: async () => upstream("partial", [call()], "length") }), { status: 422 });
});

test("malformed arguments return a nonexecuted tool result and the model can correct the next call", async () => {
  for (const malformed of ["{", "[]", "null"]) {
    const requests = [];
    const executed = [];
    const answer = await runFinanceAssistant({ apiKey: key, messages: initial(),
      executeTool: (entry) => { executed.push(entry); return { period: "2026-09", counts: { transactions: 2 } }; },
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push(request);
        if (requests.length === 1) return completion("", [call("bad-input", "get_context", malformed)]);
        if (requests.length === 2) {
          const error = JSON.parse(request.messages.at(-1).content);
          assert.equal(error.status, "needs_input");
          assert.equal(error.error.recoverable, true);
          return completion("", [call("corrected-input", "get_context", { section: "overview" })]);
        }
        return completion("本期有2笔流水，尚需核对入账状态。");
      } });
    assert.equal(executed.length, 1);
    assert.equal(executed[0].id, "corrected-input");
    assert.equal(answer.toolResults.length, 2);
    assert.equal(answer.toolResults[0].result.error.code, "AI_ARGUMENTS_INVALID");
    assert.equal(requests.length, 3);
  }
});

test("recoverable business omissions stay in the model loop but permission and original failures stop it", async () => {
  let requests = 0;
  const answer = await runFinanceAssistant({ apiKey: key, messages: initial(),
    executeTool: () => ({ ok: false, status: "needs_input", error: { code: "BUSINESS_EVENT_REFERENCE_REQUIRED", recoverable: true, message: "请补采购订单编号" } }),
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) return completion("", [call("missing-input", "propose_bank_business", {})]);
      assert.equal(JSON.parse(JSON.parse(options.body).messages.at(-1).content).error.code, "BUSINESS_EVENT_REFERENCE_REQUIRED");
      return completion("这笔费用还缺采购订单编号，请核对原件后补充。");
    } });
  assert.equal(answer.finishReason, "stop");
  assert.equal(requests, 2);
  for (const code of ["AI_ACCESS_DENIED", "AI_ORIGINAL_UNAVAILABLE", "AI_SOURCE_CHANGED", "AI_PERIOD_ARCHIVED"]) {
    let invoked = 0;
    let fetched = 0;
    await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(),
      executeTool: () => { invoked += 1; throw Object.assign(new Error("需要停止的实际业务错误"), { code }); },
      fetchImpl: async () => { fetched += 1; return completion("", [call(), call("second-call")]); },
    }), { code });
    assert.equal(fetched, 1);
    assert.equal(invoked, 1);
  }
});

test("large tool previews are bounded without losing the saved proposal status or exposing credentials", async () => {
  let requests = 0;
  const proposal = { id: "proposal-real", kind: "bank_import", status: "pending", title: "核对银行流水", summary: "3笔待确认", sourceIds: ["original-real"],
    preview: { transactions: Array.from({ length: 150 }, (_, i) => ({ id: `row-${i}`, summary: `真实长字段${key}`.repeat(2000), amount: i })) } };
  const result = await runFinanceAssistant({ apiKey: key, messages: initial(), executeTool: () => ({ status: "pending_confirmation", proposal }),
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) return completion("", [call("large-preview", "prepare_bank_import", { documentId: "original-real", accountId: "bank-real" })]);
      const body = JSON.parse(options.body);
      const content = body.messages.at(-1).content;
      assert.ok(new TextEncoder().encode(content).byteLength <= ASSISTANT_TOOL_RESULT_LIMIT);
      const summary = JSON.parse(content);
      assert.equal(summary.status, "pending_confirmation");
      assert.equal(summary.resultTruncated, true);
      assert.equal(summary.proposal.id, "proposal-real");
      assert.equal(summary.proposal.status, "pending");
      assert.equal(content.includes(key), false);
      return completion("银行原件已保存，导入建议待确认；长预览请在页面查看。");
    } });
  assert.equal(result.toolResults[0].result.proposal.status, "pending");
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("tool failure stops the batch, keeps completed results and fills unanswered protocol messages", async () => {
  let fetched = 0;
  const executed = [];
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(),
    fetchImpl: async () => { fetched += 1; return completion("", [call(), call("call_2"), call("call_3")]); },
    executeTool: ({ id }) => { executed.push(id); if (id === "call_2") throw new Error(`本地校验未通过 ${key}`); return { saved: true }; },
  }), (error) => {
    assert.equal(error.code, "ASSISTANT_TOOL_FAILED");
    assert.equal(error.message.includes(key), false);
    assert.equal(error.toolResults.length, 1);
    assert.equal(error.messages.filter((item) => item.role === "tool").length, 3);
    assert.match(error.messages.at(-1).content, /未取得完成结果/);
    return true;
  });
  assert.equal(fetched, 1);
  assert.deepEqual(executed, ["call_1", "call_2"]);
});

test("workspace or period change stops without running another tool", async () => {
  let executed = 0;
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(), fetchImpl: async () => completion("", [call(), call("call_2")]),
    executeTool: () => { executed += 1; throw Object.assign(new Error("账期已改变"), { code: "AI_TARGET_CHANGED" }); },
  }), { code: "AI_TARGET_CHANGED" });
  assert.equal(executed, 1);
});

test("cancel aborts HTTP and prevents later tools while retaining completed business results", async () => {
  const controller = new AbortController();
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(), signal: controller.signal,
    fetchImpl: async (_url, options) => {
      const waiting = new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(key)), { once: true }));
      controller.abort();
      return waiting;
    } }), { code: "ASSISTANT_CANCELLED" });
  const afterTool = new AbortController();
  let count = 0;
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(), signal: afterTool.signal,
    fetchImpl: async () => completion("", [call(), call("call_2")]),
    executeTool: () => { count += 1; afterTool.abort(); return { proposalId: "saved_proposal" }; },
  }), (error) => error.code === "ASSISTANT_CANCELLED" && error.toolResults[0].result.proposalId === "saved_proposal");
  assert.equal(count, 1);
});

test("client timeout aborts a pending request with a Chinese error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runFinanceAssistant({ apiKey: key, messages: initial(), fetchImpl: async (_url, options) => {
    const promise = new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(key)), { once: true }));
    t.mock.timers.tick(ASSISTANT_REQUEST_TIMEOUT_MS);
    return promise;
  } });
  await assert.rejects(pending, (error) => error.code === "ASSISTANT_TIMEOUT" && /超时/.test(error.message) && !error.message.includes(key));
});

test("model round cap stops before executing another batch", async () => {
  let requests = 0;
  let executed = 0;
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(),
    executeTool: () => { executed += 1; return { ok: true }; },
    fetchImpl: async () => { requests += 1; return completion("", [call(`round_${requests}`)]); },
  }), { code: "ASSISTANT_ROUND_LIMIT" });
  assert.equal(requests, ASSISTANT_MAX_ROUNDS);
  assert.equal(executed, ASSISTANT_MAX_ROUNDS - 1);
});

test("a repeated model call ID is not executed twice", async () => {
  let executed = 0;
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial(),
    executeTool: () => { executed += 1; return {}; }, fetchImpl: async () => completion("", [call()]),
  }), { code: "ASSISTANT_INVALID_TOOL" });
  assert.equal(executed, 1);
});

test("Node handler accepts parsed JSON and split UTF-8 input and does not cache or enable CORS", async (t) => {
  const input = { messages: [{ role: "user", content: "票据中文" }] };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).messages, input.messages);
    return upstream("收到票据");
  });
  const bytes = Buffer.from(JSON.stringify(input));
  const split = bytes.indexOf(Buffer.from("票")) + 1;
  const raw = requestStub({ chunks: [bytes.subarray(0, split), bytes.subarray(split)] });
  delete raw.body;
  for (const req of [requestStub({ body: input }), requestStub({ body: JSON.stringify(input) }), raw]) {
    const res = responseStub();
    await financeAssistantHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).message.content, "收到票据");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
  }
});

test("Node handler rejects bad methods, content types, cross-site requests and oversized input locally", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not forward"));
  const cases = [
    [requestStub({ method: "GET" }), 405],
    [requestStub({ headers: { "content-type": "text/plain" } }), 415],
    [requestStub({ headers: { "sec-fetch-site": "cross-site" } }), 403],
    [requestStub({ headers: { "content-length": String(FINANCE_ASSISTANT_BODY_LIMIT + 1) } }), 413],
    [requestStub({ body: "{" }), 400],
    [requestStub({ headers: { authorization: "" } }), 401],
  ];
  const raw = requestStub({ chunks: [Buffer.alloc(FINANCE_ASSISTANT_BODY_LIMIT + 1)] });
  delete raw.body;
  cases.push([raw, 413]);
  for (const [req, status] of cases) {
    const res = responseStub();
    await financeAssistantHandler(req, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.includes(key), false);
  }
});

test("server deadline cancels upstream body reading and returns a safe timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url, options) => ({ ok: true, json: async () => {
    const pending = new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(key)), { once: true }));
    t.mock.timers.tick(FINANCE_ASSISTANT_TIMEOUT_MS);
    return pending;
  } }));
  const res = responseStub();
  await financeAssistantHandler(requestStub(), res);
  assert.equal(res.statusCode, 504);
  assert.match(JSON.parse(res.body).error, /超时/);
  assert.equal(res.body.includes(key), false);
});

test("Vite dev and preview use the exact same route; Vercel exports the shared handler", () => {
  assert.equal(vercelHandler, financeAssistantHandler);
  assert.equal(config.maxDuration, 60);
  const plugin = financeAssistantPlugin();
  assert.equal(plugin.configureServer, plugin.configurePreviewServer);
  let handler;
  const connectApp = () => assert.fail("Connect app must not become a Vite post-hook");
  const server = { middlewares: { use: (value) => { handler = value; return connectApp; } } };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  let passed = false;
  handler({ url: "/api/finance-assistant/other" }, {}, () => { passed = true; });
  assert.equal(passed, true);
});
