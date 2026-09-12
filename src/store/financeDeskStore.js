import {
  addWorkspace,
  activeWorkspaceUser,
  assertWorkspacePermission,
  clearWorkspace,
  createId,
  deleteWorkspace,
  getWorkspace,
  linkEvidence,
  recordLocalAuthorization,
  removeWorkspaceEntity,
  renameWorkspace,
  setWorkspaceStageStatus,
  setWorkspaceEntityStatus,
  switchWorkspace,
  switchActiveUser,
  updateCompanyProfile,
  updateWorkspaceModules as updateWorkspaceModulesState,
  updateWorkspace,
  upsertWorkspaceEntity,
} from "../domain/foundation.js";
import { createLocalFoundationRepository, exportBackupJson, importBackupJson } from "../storage/localFoundationRepository.js";
import { confirmationWritePermissions } from "../domain/confirmationPermissions.js";
import { applyBankImport } from "../features/intake/bankStatementImport.js";
import { enterAccountingPeriod, recordInitialConfirmationSection, recordFinalConfirmation } from "../productWorkflow.js";
import { activateWorkspacePeriod, isPeriodArchived } from "../domain/periods.js";

export function createFinanceDeskStore(options = {}) {
  const repository = options.repository || createLocalFoundationRepository(options.repositoryOptions);
  const loaded = repository.load();
  let state = loaded.state;
  const listeners = new Set();

  function emit() {
    listeners.forEach((listener) => listener(state));
  }

  function commit(nextState, { restoring = false } = {}) {
    if (!restoring) repository.assertCanWrite?.();
    for (const next of restoring ? [] : nextState.workspaces) {
      const previous = state.workspaces.find((workspace) => workspace.id === next.id);
      if (!previous) continue;
      for (const permission of confirmationWritePermissions(previous, next)) assertWorkspaceAccess(previous.id, permission);
    }
    state = restoring ? repository.restore(nextState) : repository.save(nextState);
    emit();
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function assertActivePeriodWritable(workspaceId, actionOptions = {}) {
    if (actionOptions.allowArchivedTransition) return;
    const workspace = getWorkspace(state, workspaceId);
    if (!workspace) throw new Error(`找不到工作台：${workspaceId}`);
    if (isPeriodArchived(workspace, actionOptions.period || workspace.currentPeriod)) {
      throw new Error("当前账期已经归档，只能查看；如需继续，请先进入下一期，历史更正需走新的更正版流程");
    }
  }

  function permissionForCollection(collection) {
    if (["users", "roles", "authorizations", "books", "stores"].includes(collection)) return "workspace.manage";
    if (collection === "ruleSets") return "rules.manage";
    if (["documents", "evidenceLinks"].includes(collection)) return "documents.add";
    return "data.write";
  }

  function assertWorkspaceAccess(workspaceId, permission) {
    const workspace = getWorkspace(state, workspaceId);
    if (workspace && !workspace.localUsersConfigured && !workspace.users?.length) return null;
    return assertWorkspacePermission(identityState(workspaceId), workspaceId, permission);
  }

  // Identity comes from the local host, never from operation parameters or an
  // audit display name. Other workspaces need an explicitly resolved local user.
  function identityState(workspaceId) {
    return options.resolveWorkspaceUserId
      ? { ...state, activeUserId: options.resolveWorkspaceUserId(workspaceId, state) }
      : state;
  }

  function withActor(workspaceId, actionOptions = {}) {
    const actor = activeWorkspaceUser(identityState(workspaceId), workspaceId)?.name || "本地用户";
    return {
      ...actionOptions,
      actor: actionOptions.actor || actor,
      audit: actionOptions.audit ? { actor, ...actionOptions.audit } : actionOptions.audit,
    };
  }

  const actions = {
    createWorkspace(input = {}) {
      assertWorkspaceAccess(state.activeWorkspaceId, "workspace.manage");
      const actor = activeWorkspaceUser(state)?.name || "本地用户";
      const result = addWorkspace(state, { ...input, actor: input.actor || actor });
      commit(result.state);
      return result.workspace;
    },
    duplicateWorkspace(workspaceId, input = {}) {
      return actions.createWorkspace({ ...input, sourceWorkspaceId: workspaceId });
    },
    renameWorkspace(workspaceId, name, actionOptions) {
      assertWorkspaceAccess(workspaceId, "workspace.manage");
      return commit(renameWorkspace(state, workspaceId, name, withActor(workspaceId, actionOptions)));
    },
    switchWorkspace(workspaceId, actionOptions) {
      const sourceActor = activeWorkspaceUser(state)?.name || "本地用户";
      const next = switchWorkspace(state, workspaceId, {
        ...(actionOptions || {}),
        actor: actionOptions?.actor || sourceActor,
      });
      if (next.activeUserId) assertWorkspacePermission(next, workspaceId, "data.read");
      return commit(next);
    },
    switchUser(workspaceId, userId, actionOptions) {
      return commit(switchActiveUser(state, workspaceId, userId, actionOptions));
    },
    deleteWorkspace(workspaceId, actionOptions) {
      assertWorkspaceAccess(workspaceId, "workspace.manage");
      return commit(deleteWorkspace(state, workspaceId, withActor(workspaceId, actionOptions)));
    },
    clearWorkspace(workspaceId, actionOptions) {
      assertWorkspaceAccess(workspaceId, "workspace.manage");
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(clearWorkspace(state, workspaceId, withActor(workspaceId, actionOptions)));
    },
    updateCompanyProfile(workspaceId, patch, actionOptions) {
      assertWorkspaceAccess(workspaceId, "workspace.manage");
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(updateCompanyProfile(state, workspaceId, patch, withActor(workspaceId, actionOptions)));
    },
    updateWorkspaceModules(workspaceId, modules, actionOptions) {
      assertWorkspaceAccess(workspaceId, "workspace.manage");
      return commit(updateWorkspaceModulesState(state, workspaceId, modules, withActor(workspaceId, actionOptions)));
    },
    replaceWorkspace(workspaceId, workspace, actionOptions = {}) {
      assertWorkspaceAccess(workspaceId, actionOptions.requiredPermission || "data.write");
      assertActivePeriodWritable(workspaceId, actionOptions);
      const resolvedOptions = withActor(workspaceId, actionOptions);
      return commit(updateWorkspace(
        state,
        workspaceId,
        () => workspace,
        resolvedOptions.audit || null,
        resolvedOptions,
      ));
    },
    recordInitialConfirmationSection(workspaceId, input, actionOptions = {}) {
      assertWorkspaceAccess(workspaceId, "confirm.finance");
      assertActivePeriodWritable(workspaceId);
      repository.assertCanWrite?.();
      return actions.replaceWorkspace(workspaceId, recordInitialConfirmationSection(getWorkspace(state, workspaceId), input, withActor(workspaceId, actionOptions)), {
        ...actionOptions, requiredPermission: "confirm.finance", allowArchivedTransition: false,
      });
    },
    recordFinalConfirmation(workspaceId, input, actionOptions = {}) {
      assertWorkspaceAccess(workspaceId, "confirm.owner");
      assertActivePeriodWritable(workspaceId);
      repository.assertCanWrite?.();
      return actions.replaceWorkspace(workspaceId, recordFinalConfirmation(getWorkspace(state, workspaceId), input, withActor(workspaceId, actionOptions)), {
        ...actionOptions, requiredPermission: "confirm.owner", allowArchivedTransition: false,
      });
    },
    setStageStatus(workspaceId, stage, status, actionOptions) {
      assertWorkspaceAccess(workspaceId, "data.write");
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(setWorkspaceStageStatus(state, workspaceId, stage, status, withActor(workspaceId, actionOptions)));
    },
    setPeriod(workspaceId, period, actionOptions) {
      assertWorkspaceAccess(workspaceId, "data.read");
      let writable = true;
      try { assertWorkspaceAccess(workspaceId, "data.write"); } catch { writable = false; }
      const current = getWorkspace(state, workspaceId);
      if (!writable && !(current.periods || []).includes(period) && !current.delivery?.archives?.some((item) => item.period === period)) throw new Error("当前身份只能查看已有账期");
      const resolved = withActor(workspaceId, actionOptions);
      return commit(updateWorkspace(state, workspaceId, (workspace) => writable ? enterAccountingPeriod(workspace, period, resolved.actor) : activateWorkspacePeriod(workspace, period), {
        actor: resolved.actor, action: "切换账期", detail: `当前账期设为 ${period}`,
      }, resolved));
    },
    upsertEntity(workspaceId, collection, values, actionOptions) {
      assertWorkspaceAccess(workspaceId, permissionForCollection(collection));
      assertActivePeriodWritable(workspaceId, actionOptions);
      const result = upsertWorkspaceEntity(state, workspaceId, collection, values, withActor(workspaceId, actionOptions));
      commit(result.state);
      return result.item;
    },
    removeEntity(workspaceId, collection, itemId, actionOptions) {
      assertWorkspaceAccess(workspaceId, permissionForCollection(collection));
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(removeWorkspaceEntity(state, workspaceId, collection, itemId, withActor(workspaceId, actionOptions)));
    },
    setEntityStatus(workspaceId, collection, itemId, status, actionOptions) {
      assertWorkspaceAccess(workspaceId, permissionForCollection(collection));
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(setWorkspaceEntityStatus(state, workspaceId, collection, itemId, status, withActor(workspaceId, actionOptions)));
    },
    recordAuthorization(workspaceId, values, actionOptions) {
      assertWorkspaceAccess(workspaceId, "workspace.manage");
      assertActivePeriodWritable(workspaceId, actionOptions);
      const result = recordLocalAuthorization(state, workspaceId, values, withActor(workspaceId, actionOptions));
      commit(result.state);
      return result.item;
    },
    linkEvidence(workspaceId, values, actionOptions) {
      assertWorkspaceAccess(workspaceId, "documents.add");
      assertActivePeriodWritable(workspaceId, actionOptions);
      const result = linkEvidence(state, workspaceId, values, withActor(workspaceId, actionOptions));
      commit(result.state);
      return result.item;
    },
    applyBankImport(workspaceId, plan, actionOptions) {
      assertWorkspaceAccess(workspaceId, "data.write");
      assertActivePeriodWritable(workspaceId, { period: plan.period });
      const resolved = withActor(workspaceId, actionOptions);
      const displayPeriod = getWorkspace(state, workspaceId).currentPeriod;
      let base = state;
      if (plan.sourceDocumentId) {
        assertWorkspaceAccess(workspaceId, "documents.add");
        const source = getWorkspace(state, workspaceId).documents.find((item) => item.id === plan.sourceDocumentId);
        if (!source || source.hash !== plan.fileHash || source.period !== plan.period
          || !source.storage?.availableLocally || !source.storage?.blobId) throw new Error("银行流水原件已变化，请重新选择文件");
        base = updateWorkspace(state, workspaceId, (workspace) => ({
          ...workspace,
          documents: workspace.documents.map((document) => document.id === source.id ? {
            ...document, relatedObjectIds: [...new Set([...(document.relatedObjectIds || []), plan.accountId])],
          } : document),
          evidenceLinks: [...workspace.evidenceLinks, {
            id: createId("evidence-link"), documentIds: [source.id], objectIds: [plan.accountId],
            relation: "bank-statement-source", note: `银行导入 ${plan.id} 的原始文件`, status: "active",
            createdAt: plan.importedAt, updatedAt: plan.importedAt,
          }],
        }), null, resolved);
      }
      const imported = applyBankImport(base, workspaceId, plan, resolved);
      return commit(updateWorkspace(imported, workspaceId, (workspace) => {
        const next = activateWorkspacePeriod(enterAccountingPeriod(workspace, plan.period, resolved.actor), displayPeriod);
        if (!actionOptions?.finalizeWorkspace) return next;
        const finalized = actionOptions.finalizeWorkspace(next, plan);
        if (!finalized || typeof finalized !== "object" || typeof finalized.then === "function"
          || finalized.id !== next.id || finalized.currentPeriod !== next.currentPeriod) throw new Error("导入结果必须同步保留原工作台与账期");
        return finalized;
      }, null, resolved));
    },
    exportBackup(exportOptions) {
      assertWorkspaceAccess(state.activeWorkspaceId, "data.read");
      return exportBackupJson(state, exportOptions);
    },
    importBackup(text, importOptions = {}) {
      assertWorkspaceAccess(state.activeWorkspaceId, "workspace.manage");
      const restoring = repository.getPersistenceStatus?.().status === "recovery_required";
      if (restoring && importOptions.mode !== "replace") throw new Error("本地数据无法读取，请使用有效备份替换恢复，不能合并初始模板");
      return commit(importBackupJson(text, { ...importOptions, currentState: state }), { restoring });
    },
  };

  return {
    getState: () => state,
    getActiveWorkspace: () => getWorkspace(state),
    getLoadReport: () => ({ ...loaded, state: undefined }),
    assertWorkspaceAccess,
    assertWorkspaceWritable(workspaceId, period, permission = "data.write") {
      const user = assertWorkspaceAccess(workspaceId, permission);
      assertActivePeriodWritable(workspaceId, { period });
      repository.assertCanWrite?.();
      return user;
    },
    getPersistenceStatus: repository.getPersistenceStatus || (() => READY_PERSISTENCE_STATUS),
    subscribePersistence: repository.subscribePersistence || (() => () => {}),
    startPersistenceSession: repository.startSession || (() => () => {}),
    subscribe,
    actions,
  };
}

const READY_PERSISTENCE_STATUS = Object.freeze({ canWrite: true, status: "ready", message: "" });
