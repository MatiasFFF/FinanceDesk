import test from "node:test";
import assert from "node:assert/strict";
import { aiSessionContextKey, createAiTabSession, createModeHistoryController, financeDeskModeUrl, getFinanceDeskMode } from "../src/features/ai-simple/aiModeSession.js";

const defaults = { model: "example-model", thinking: "disabled", reasoningEffort: "high" };
const newSession = () => createAiTabSession({ defaultModelSettings: defaults });

test("a tab session retains credentials across view changes without placing them in its snapshot", () => {
  const session = newSession();
  let notifications = 0;
  const stop = session.subscribe(() => { notifications += 1; });
  session.setApiKey("  sk-private-tab-only  ");
  session.updateContext("workspace-1", "2026-09", "screen", "workbench");
  session.setModelSettings({ model: "selected-model", thinking: "enabled", apiKey: "must-not-be-copied" });
  assert.equal(session.readKey(), "sk-private-tab-only");
  assert.equal(session.getSnapshot().configured, true);
  assert.deepEqual(session.getSnapshot().modelSettings, { model: "selected-model", thinking: "enabled", reasoningEffort: "high" });
  assert.equal(JSON.stringify(session.getSnapshot()).includes("sk-private-tab-only"), false);
  assert.equal(JSON.stringify(session.getSnapshot()).includes("must-not-be-copied"), false);
  assert.equal(newSession().readKey(), "");
  session.clearApiKey();
  assert.equal(session.readKey(), "");
  assert.equal(session.getSnapshot().configured, false);
  assert.equal(notifications, 4);
  stop();
  session.setApiKey("another-key");
  assert.equal(notifications, 4);
});

test("draft files and view snapshots stay with their originating workspace and period", () => {
  const session = newSession();
  const file = new Blob(["date,amount\n2026-09-01,100"], { type: "text/csv" });
  const draft = { text: "核对本期", files: [{ id: "attachment-1", file }] };
  session.updateContext("workspace-1", "2026-09", "draft", draft);
  session.updateContext("workspace-1", "2026-09", "resources", { initialTab: "transactions", resourceState: { query: "房租", listScroll: 175 } });
  session.updateContext("workspace-2", "2026-09", "draft", { text: "另一家公司", files: [] });
  session.updateContext("workspace-1", "2026-10", "draft", { text: "下期", files: [] });
  const writeOriginalDraft = (update) => session.updateContext("workspace-1", "2026-09", "draft", update);
  writeOriginalDraft((current) => ({ ...current, text: current.text + "资料" }));
  const contexts = session.getSnapshot().contexts;
  assert.equal(contexts[aiSessionContextKey("workspace-1", "2026-09")].draft.text, "核对本期资料");
  assert.equal(contexts[aiSessionContextKey("workspace-1", "2026-09")].draft.files[0].file, file);
  assert.equal(contexts[aiSessionContextKey("workspace-2", "2026-09")].draft.text, "另一家公司");
  assert.equal(contexts[aiSessionContextKey("workspace-1", "2026-10")].draft.text, "下期");
  assert.equal(contexts[aiSessionContextKey("workspace-1", "2026-09")].resources.resourceState.listScroll, 175);
  assert.notEqual(aiSessionContextKey("a:b", "c"), aiSessionContextKey("a", "b:c"));
});

test("the root defaults to AI and only an explicit full mode opens the complete workbench", () => {
  assert.equal(getFinanceDeskMode("https://financedesk.test/"), "ai");
  assert.equal(getFinanceDeskMode("https://financedesk.test/?preview=1#ledger"), "ai");
  assert.equal(getFinanceDeskMode("https://financedesk.test/?mode=ai"), "ai");
  assert.equal(getFinanceDeskMode("https://financedesk.test/?mode=unknown"), "ai");
  assert.equal(getFinanceDeskMode("https://financedesk.test/?mode=full"), "full");
  assert.equal(financeDeskModeUrl("https://financedesk.test/", "full"), "https://financedesk.test/?mode=full");
  assert.equal(financeDeskModeUrl("https://financedesk.test/?mode=full", "ai"), "https://financedesk.test/");
});

test("mode URLs keep unrelated parameters and work for the standalone file entry", () => {
  const url = "file:///Users/example/FinanceDesk.html?mode=ai&preview=1#ledger";
  assert.equal(getFinanceDeskMode(url), "ai");
  const full = financeDeskModeUrl(url, "full");
  assert.equal(full, "file:///Users/example/FinanceDesk.html?mode=full&preview=1#ledger");
  assert.equal(getFinanceDeskMode(full), "full");
  const ai = financeDeskModeUrl(full, "ai");
  assert.equal(ai, "file:///Users/example/FinanceDesk.html?preview=1#ledger");
  assert.equal(getFinanceDeskMode(ai), "ai");
});

function fakeBrowser(url) {
  let index = 0;
  const entries = [{ url, state: { retained: "host-state" } }];
  const listeners = new Set();
  const pending = [];
  const browser = {
    location: { href: url },
    addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); },
    history: {
      get state() { return entries[index].state; },
      replaceState(state, _title, nextUrl) { entries[index] = { state, url: nextUrl }; browser.location.href = nextUrl; },
      pushState(state, _title, nextUrl) { entries.splice(index + 1); entries.push({ state, url: nextUrl }); index += 1; browser.location.href = nextUrl; },
      go(delta) {
        pending.push(() => {
          const next = index + delta;
          if (next < 0 || next >= entries.length) return;
          index = next;
          browser.location.href = entries[index].url;
          [...listeners].forEach((listener) => listener({ state: entries[index].state }));
        });
      },
    },
    flush() { while (pending.length) pending.shift()(); },
    getIndex: () => index,
    listenerCount: () => listeners.size,
  };
  return browser;
}

for (const entryUrl of ["https://financedesk.test/?view=preview", "https://financedesk.test/?mode=ai&view=preview"]) test(`mode history preserves requests from ${entryUrl}`, () => {
  const browser = fakeBrowser(entryUrl);
  const changes = [];
  const controller = createModeHistoryController({ window: browser, onChange: (state) => changes.push(state) });
  const request = { page: "reports", options: { section: "opening-balances" }, workspaceId: "workspace-1", period: "2026-09", nonce: "request-1" };
  assert.equal(controller.navigate("full", request), true);
  assert.equal(getFinanceDeskMode(browser.location.href), "full");
  assert.equal(new URL(browser.location.href).searchParams.get("mode"), "full");
  assert.equal(browser.history.state.retained, "host-state");
  assert.deepEqual(changes.at(-1), { mode: "full", navigationRequest: request });
  browser.history.go(-1); browser.flush();
  assert.deepEqual(changes.at(-1), { mode: "ai", navigationRequest: null });
  assert.equal(browser.location.href, entryUrl);
  browser.history.go(1); browser.flush();
  assert.deepEqual(changes.at(-1), { mode: "full", navigationRequest: request });
  assert.equal(new URL(browser.location.href).searchParams.get("view"), "preview");
  assert.equal(controller.navigate("ai"), true);
  assert.equal(browser.location.href, "https://financedesk.test/?view=preview");
  browser.history.go(-1); browser.flush();
  assert.deepEqual(changes.at(-1), { mode: "full", navigationRequest: request });
  controller.dispose();
  assert.equal(browser.listenerCount(), 0);
});

test("busy or declined dirty guards block buttons and restore the actual Back/Forward entry", () => {
  const browser = fakeBrowser("https://financedesk.test/");
  let allowed = true;
  let guardCalls = 0;
  const changes = [];
  const controller = createModeHistoryController({ window: browser, onChange: (state) => changes.push(state), beforeChange: () => { guardCalls += 1; return allowed; } });
  controller.navigate("full");
  allowed = false;
  assert.equal(controller.navigate("ai"), false);
  assert.equal(browser.getIndex(), 1);
  browser.history.go(-1); browser.flush();
  assert.equal(browser.getIndex(), 1);
  assert.equal(getFinanceDeskMode(browser.location.href), "full");
  assert.equal(changes.length, 1);
  assert.equal(guardCalls, 3, "restoring a blocked history entry must not ask again");
  allowed = true;
  browser.history.go(-1); browser.flush();
  assert.equal(controller.getSnapshot().mode, "ai");
  allowed = false;
  browser.history.go(1); browser.flush();
  assert.equal(browser.getIndex(), 0);
  assert.equal(controller.getSnapshot().mode, "ai");
  allowed = true;
  browser.history.go(1); browser.flush();
  assert.equal(controller.getSnapshot().mode, "full");
  assert.equal(guardCalls, 6);
  controller.dispose();
});
