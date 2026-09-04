import {
  addWorkspace,
  clearWorkspace,
  deleteWorkspace,
  getWorkspace,
  linkEvidence,
  recordLocalAuthorization,
  removeWorkspaceEntity,
  renameWorkspace,
  setWorkspaceEntityStatus,
  switchWorkspace,
  updateCompanyProfile,
  upsertWorkspaceEntity,
} from "../domain/foundation.js";
import { createLocalFoundationRepository, exportBackupJson, importBackupJson } from "../storage/localFoundationRepository.js";

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

  const actions = {
    createWorkspace(input) {
      const result = addWorkspace(state, input);
      commit(result.state);
      return result.workspace;
    },
    duplicateWorkspace(workspaceId, input = {}) {
      return actions.createWorkspace({ ...input, sourceWorkspaceId: workspaceId });
    },
    renameWorkspace(workspaceId, name, actionOptions) {
      return commit(renameWorkspace(state, workspaceId, name, actionOptions));
    },
    switchWorkspace(workspaceId, actionOptions) {
      return commit(switchWorkspace(state, workspaceId, actionOptions));
    },
    deleteWorkspace(workspaceId, actionOptions) {
      return commit(deleteWorkspace(state, workspaceId, actionOptions));
    },
    clearWorkspace(workspaceId, actionOptions) {
      return commit(clearWorkspace(state, workspaceId, actionOptions));
    },
    updateCompanyProfile(workspaceId, patch, actionOptions) {
      return commit(updateCompanyProfile(state, workspaceId, patch, actionOptions));
    },
    upsertEntity(workspaceId, collection, values, actionOptions) {
      const result = upsertWorkspaceEntity(state, workspaceId, collection, values, actionOptions);
      commit(result.state);
      return result.item;
    },
    removeEntity(workspaceId, collection, itemId, actionOptions) {
      return commit(removeWorkspaceEntity(state, workspaceId, collection, itemId, actionOptions));
    },
    setEntityStatus(workspaceId, collection, itemId, status, actionOptions) {
      return commit(setWorkspaceEntityStatus(state, workspaceId, collection, itemId, status, actionOptions));
    },
    recordAuthorization(workspaceId, values, actionOptions) {
      const result = recordLocalAuthorization(state, workspaceId, values, actionOptions);
      commit(result.state);
      return result.item;
    },
    linkEvidence(workspaceId, values, actionOptions) {
      const result = linkEvidence(state, workspaceId, values, actionOptions);
      commit(result.state);
      return result.item;
    },
    exportBackup(exportOptions) {
      return exportBackupJson(state, exportOptions);
    },
    importBackup(text, importOptions = {}) {
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
