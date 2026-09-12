import test from "node:test";
import assert from "node:assert/strict";
import {
  FINANCE_DESK_BACKUP_KEY, FINANCE_DESK_STORAGE_KEY,
  createInitialState, createLocalFoundationRepository, createMemoryStorage,
} from "../src/foundation.js";

const now = () => new Date("2026-09-12T08:00:00Z");

test("quota-constrained saves prioritize the primary, retain the existing backup and leave both copies intact on primary failure", () => {
  const storage = createMemoryStorage();
  const setItem = storage.setItem.bind(storage);
  let capacity = Infinity;
  storage.setItem = (key, value) => {
    const next = { ...storage.dump(), [key]: String(value) };
    if (Object.values(next).reduce((total, item) => total + item.length, 0) > capacity) {
      throw new DOMException("模拟本地容量不足", "QuotaExceededError");
    }
    setItem(key, value);
  };
  const repository = createLocalFoundationRepository({ storage, now });
  const initial = createInitialState({ now });
  const state = (size) => {
    const next = structuredClone(initial);
    next.workspaces[0].company.legalName = "虚".repeat(size);
    return next;
  };
  const first = state(1000);
  repository.save(first);
  repository.save(state(2000));
  const originalBackup = storage.getItem(FINANCE_DESK_BACKUP_KEY);
  const calibration = createMemoryStorage();
  const third = state(3000);
  createLocalFoundationRepository({ storage: calibration, now }).save(third);
  capacity = originalBackup.length + calibration.getItem(FINANCE_DESK_STORAGE_KEY).length + 128;
  assert.equal(repository.save(third).workspaces[0].company.legalName.length, 3000);
  assert.equal(repository.load().state.workspaces[0].company.legalName.length, 3000);
  assert.equal(storage.getItem(FINANCE_DESK_BACKUP_KEY), originalBackup, "an oversized backup rotation keeps the earlier valid backup");
  const savedCopies = storage.dump();
  assert.throws(() => repository.save(state(capacity)), { name: "QuotaExceededError" });
  assert.deepEqual(storage.dump(), savedCopies, "failed primary writes do not alter the primary or its backup");
  assert.equal(repository.save(first).workspaces[0].company.legalName.length, 1000, "a failed write does not advance the repository baseline");
});
