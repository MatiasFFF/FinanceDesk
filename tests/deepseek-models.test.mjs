import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DEFAULT_DEEPSEEK_MODEL_SETTINGS, KNOWN_DEEPSEEK_MODELS, getDeepSeekModelCapabilities,
  normalizeDeepSeekModels, normalizeDeepSeekModelSettings } from "../src/application/deepseekModels.js";
import { listDeepSeekModels, DEEPSEEK_MODELS_REQUEST_TIMEOUT_MS } from "../src/application/deepseekClient.js";
import { requestDeepSeekModels, deepseekModelsHandler, DEEPSEEK_MODELS_TIMEOUT_MS } from "../server/deepseekModels.js";
import modelsHandler, { config } from "../api/deepseek-models.js";
import { financeAssistantPlugin } from "../server/financeAssistant.js";

// Fixtures only. These tests must never contact a real account or the network.
const key = "test_financedesk_models_12345";
const authorization = `Bearer ${key}`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const officialList = () => ({ object: "list", data: [
  { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
  { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
  { id: "deepseek-next-model", object: "model", owned_by: "deepseek" },
] });
function request({ method = "GET", headers = {} } = {}) {
  return Object.assign(new EventEmitter(), { method, headers: { authorization, ...headers } });
}
function response() {
  const res = Object.assign(new EventEmitter(), { headers: {}, writableEnded: false, destroyed: false });
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.end = (body) => { res.body = body; res.writableEnded = true; };
  return res;
}

test("official current models and legacy aliases share documented capabilities; unknown models stay unknown", () => {
  assert.deepEqual(DEFAULT_DEEPSEEK_MODEL_SETTINGS, { model: "deepseek-flash", thinking: "disabled", reasoningEffort: "high" });
  assert.deepEqual(KNOWN_DEEPSEEK_MODELS.map((model) => model.id), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.match(KNOWN_DEEPSEEK_MODELS[0].label, /V4\.1 Flash/);
  assert.match(KNOWN_DEEPSEEK_MODELS[1].label, /V4 Pro/);
  for (const id of ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    assert.deepEqual(getDeepSeekModelCapabilities(id), { known: true, thinking: true, reasoningEfforts: ["low", "high", "max"], toolCalls: true });
  }
  for (const id of ["deepseek-next-model", "deepseek-chat", "deepseek-reasoner"]) {
    assert.deepEqual(getDeepSeekModelCapabilities(id), { known: false, thinking: false, reasoningEfforts: [], toolCalls: null });
  }
});

test("model settings reject malformed or unverified thinking without silently changing model or effort", () => {
  assert.deepEqual(normalizeDeepSeekModelSettings(), DEFAULT_DEEPSEEK_MODEL_SETTINGS);
  assert.equal(normalizeDeepSeekModelSettings({ model: "deepseek-next-model" }).model, "deepseek-next-model");
  for (const reasoningEffort of ["low", "high", "max"]) {
    assert.deepEqual(normalizeDeepSeekModelSettings({ model: "deepseek-v4-pro", thinking: "enabled", reasoningEffort }), { model: "deepseek-v4-pro", thinking: "enabled", reasoningEffort });
  }
  for (const settings of [null, [], { model: "" }, { model: "https://example.invalid/model" }, { model: "sk-fake_secret_123456789" },
    { thinking: true }, { thinking: { type: "enabled" } }, { reasoningEffort: "ultra" }, { model: "deepseek-next-model", thinking: "enabled" }]) {
    assert.throws(() => normalizeDeepSeekModelSettings(settings), { code: "ASSISTANT_INVALID_MODEL_SETTINGS" });
  }
});

test("normalization preserves new available IDs and never treats list metadata as capability proof", () => {
  const raw = officialList();
  raw.data.push({ ...raw.data[2], capabilities: { known: true, thinking: true }, label: "伪造标签" });
  const models = normalizeDeepSeekModels(raw);
  assert.equal(models.length, 3);
  assert.equal(models[2].id, "deepseek-next-model");
  assert.equal(models[2].label, "deepseek-next-model");
  assert.equal(models[2].capabilities.known, false);
  assert.deepEqual(normalizeDeepSeekModels(models), models);
  assert.deepEqual(normalizeDeepSeekModels({ object: "list", data: [] }), []);
  for (const payload of [null, {}, { data: [] }, { object: "list", data: [{}] }, { object: "list", data: [{ id: "valid", owned_by: {} }] }]) {
    assert.throws(() => normalizeDeepSeekModels(payload), { code: "ASSISTANT_INVALID_MODELS" });
  }
});

test("model list client and proxy use the fixed official endpoint, current Authorization, and no cache", async () => {
  let requests = 0;
  const models = await listDeepSeekModels({ apiKey: key,
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/deepseek-models");
      assert.equal(options.method, "GET");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "error");
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, authorization);
      return json({ models: await requestDeepSeekModels({ authorization: options.headers.Authorization, signal: options.signal,
        fetchImpl: async (target, init) => {
          requests += 1;
          assert.equal(target, "https://api.deepseek.com/models");
          assert.equal(init.headers.Authorization, authorization);
          assert.equal(init.method, "GET");
          assert.equal(init.cache, "no-store");
          assert.equal(init.redirect, "error");
          assert.equal(init.body, undefined);
          return json(officialList());
        },
      }) });
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(models.map((model) => model.id), officialList().data.map((model) => model.id));
  assert.equal(JSON.stringify(models).includes(key), false);
});

test("list errors never echo credentials, retry, or return a static list disguised as live", async () => {
  for (const status of [401, 402, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(requestDeepSeekModels({ authorization, fetchImpl: async () => {
      calls += 1;
      return { ok: false, status, json: () => assert.fail("do not read upstream error") };
    } }), (error) => error.status === (status === 500 ? 502 : status) && !error.message.includes(key));
    assert.equal(calls, 1);
    await assert.rejects(listDeepSeekModels({ apiKey: key, fetchImpl: async () => ({ ok: false, status, json: () => assert.fail("do not read proxy error") }) }),
      (error) => !error.message.includes(key));
  }
  for (const result of [{ object: "list", data: [{ id: key, owned_by: "deepseek" }] }, { object: "list", data: [{ id: "deepseek-flash", owned_by: key }] }]) {
    await assert.rejects(requestDeepSeekModels({ authorization, fetchImpl: async () => json(result) }), (error) => error.status === 502 && !error.message.includes(key));
  }
  await assert.rejects(listDeepSeekModels({ apiKey: key, fetchImpl: async () => { throw new Error(key); } }),
    (error) => error.code === "ASSISTANT_MODELS_UNAVAILABLE" && !error.message.includes(key));
  await assert.rejects(listDeepSeekModels({ apiKey: key, fetchImpl: async () => json({ models: [{ id: "deepseek-flash", ownedBy: key }] }) }),
    (error) => error.code === "ASSISTANT_INVALID_MODELS" && !error.message.includes(key));
  await assert.rejects(listDeepSeekModels({ apiKey: "", fetchImpl: () => assert.fail("no key must not fetch") }), { code: "KEY_REQUIRED" });
  await assert.rejects(requestDeepSeekModels({ authorization: "", fetchImpl: () => assert.fail("no key must not forward") }), { status: 401 });
});

test("model list cancellation aborts work and a late response cannot win", async () => {
  const controller = new AbortController();
  await assert.rejects(listDeepSeekModels({ apiKey: key, signal: controller.signal,
    fetchImpl: async (_url, options) => {
      controller.abort();
      assert.equal(options.signal.aborted, true);
      return json({ models: normalizeDeepSeekModels(officialList()) });
    },
  }), { code: "ASSISTANT_CANCELLED" });
  await assert.rejects(requestDeepSeekModels({ authorization, signal: controller.signal, fetchImpl: () => assert.fail("already aborted") }), { status: 504 });
});

test("model list client has a bounded independent timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = listDeepSeekModels({ apiKey: key, fetchImpl: async (_url, options) => {
    const result = new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(key)), { once: true }));
    t.mock.timers.tick(DEEPSEEK_MODELS_REQUEST_TIMEOUT_MS);
    return result;
  } });
  await assert.rejects(pending, (error) => error.code === "ASSISTANT_TIMEOUT" && /模型列表超时/.test(error.message) && !error.message.includes(key));
});

test("model list handler uses no-store, no CORS and cleans up cancellation listeners", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json(officialList()));
  const req = request();
  const res = response();
  await deepseekModelsHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).models.length, 3);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.body.includes(key), false);
});

test("model list handler rejects wrong method, cross-site use and missing credentials locally", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("invalid request must not forward"));
  for (const [req, status] of [[request({ method: "POST" }), 405], [request({ headers: { "sec-fetch-site": "cross-site" } }), 403], [request({ headers: { authorization: "" } }), 401]]) {
    const res = response();
    await deepseekModelsHandler(req, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.includes(key), false);
  }
});

test("model list handler deadline cancels upstream body reading without changing the deployment deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url, options) => ({ ok: true, json: async () => {
    const pending = new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(key)), { once: true }));
    t.mock.timers.tick(DEEPSEEK_MODELS_TIMEOUT_MS);
    return pending;
  } }));
  const res = response();
  await deepseekModelsHandler(request(), res);
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.includes(key), false);
  assert.equal(config.maxDuration, 20);
  assert.equal(modelsHandler, deepseekModelsHandler);
});

test("Vite development and preview share both exact API routes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json(officialList()));
  const plugin = financeAssistantPlugin();
  assert.equal(plugin.configureServer, plugin.configurePreviewServer);
  let route;
  plugin.configureServer({ middlewares: { use: (handler) => { route = handler; } } });
  const req = request();
  req.url = "/api/deepseek-models?refresh=1";
  const res = response();
  await route(req, res, () => assert.fail("model route should be handled"));
  assert.equal(res.statusCode, 200);
  let passed = false;
  route({ url: "/api/deepseek-models/other" }, {}, () => { passed = true; });
  assert.equal(passed, true);
});
