import {
  addWorkspace,
  activeWorkspaceUser,
  assertWorkspacePermission,
  clearWorkspace,
  deleteWorkspace,
  getWorkspace,
  linkEvidence,
  recordLocalAuthorization,
  removeWorkspaceEntity,
  renameWorkspace,
  setWorkspacePeriod,
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
import { applyBankImport } from "../features/intake/bankStatementImport.js";

export function createFinanceDeskStore(options = {}) {
  const repository = options.repository || createLocalFoundationRepository(options.repositoryOptions);
  const loaded = repository.load();
  let state = loaded.state;
  const listeners = new Set();

  function emit() {
    listeners.forEach((listener) => listener(state));
  }

  function commit(nextState) {
    state = repository.save(nextState);
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
    const archived = workspace?.delivery?.archives?.some((item) => item.period === workspace.currentPeriod);
    if (archived || workspace?.delivery?.filing?.archivedAt) {
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
    if (!workspace?.users?.some((user) => user.status === "active")) return null;
    return assertWorkspacePermission(state, workspaceId, permission);
  }

  function withActor(workspaceId, actionOptions = {}) {
    const actor = activeWorkspaceUser(state, workspaceId)?.name || "本地用户";
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
      assertWorkspaceAccess(workspaceId, "data.read");
      return commit(switchWorkspace(state, workspaceId, withActor(workspaceId, actionOptions)));
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
    setStageStatus(workspaceId, stage, status, actionOptions) {
      assertWorkspaceAccess(workspaceId, "data.write");
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(setWorkspaceStageStatus(state, workspaceId, stage, status, withActor(workspaceId, actionOptions)));
    },
    setPeriod(workspaceId, period, actionOptions) {
      assertWorkspaceAccess(workspaceId, "data.write");
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(setWorkspacePeriod(state, workspaceId, period, withActor(workspaceId, actionOptions)));
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
      assertActivePeriodWritable(workspaceId, actionOptions);
      return commit(applyBankImport(state, workspaceId, plan, withActor(workspaceId, actionOptions)));
    },
    exportBackup(exportOptions) {
      assertWorkspaceAccess(state.activeWorkspaceId, "data.read");
      return exportBackupJson(state, exportOptions);
    },
    importBackup(text, importOptions = {}) {
      assertWorkspaceAccess(state.activeWorkspaceId, "workspace.manage");
      return commit(importBackupJson(text, { ...importOptions, currentState: state }));
    },
  };

  return {
    getState: () => state,
    getActiveWorkspace: () => getWorkspace(state),
    getLoadReport: () => ({ ...loaded, state: undefined }),
    subscribe,
    actions,
  };
}
