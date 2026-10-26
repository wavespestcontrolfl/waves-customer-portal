import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  ADMIN_TABLE_VIEW_STORAGE_ERROR,
  adminTableViewCatalogKey,
  createAdminTableViewScope,
  normalizeAdminTableViewState,
  readAdminTableViewCatalog,
  readAdminTableViewCurrent,
  writeAdminTableViewCatalog,
  writeAdminTableViewCurrent,
} from "../lib/adminTableViewStorage";

export { normalizeTableColumns } from "../lib/adminTableViewStorage";

const MAX_VIEWS = 20;
const MAX_NAME_LENGTH = 64;

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function initializeRuntime(scope, defaults, normalize, initialState) {
  const loadedCurrent = scope.available
    ? readAdminTableViewCurrent(browserStorage(), scope.storageKey, defaults, normalize)
    : { current: normalizeAdminTableViewState(defaults, defaults, normalize), error: null };
  const loadedCatalog = scope.available
    ? readAdminTableViewCatalog(browserStorage(), scope.storageKey, defaults, normalize)
    : { views: [], error: null };
  let initial = loadedCurrent.current;
  if (typeof initialState === "function") {
    try {
      const override = initialState(initial);
      if (override && typeof override === "object" && !Array.isArray(override)) {
        initial = normalizeAdminTableViewState({ ...initial, ...override }, defaults, normalize);
      }
    } catch { /* malformed URL-derived state falls back to the loaded state */ }
  }
  return {
    token: scope.token,
    available: scope.available,
    storageKey: scope.storageKey,
    record: { current: initial, views: loadedCatalog.views },
    error: loadedCurrent.error || loadedCatalog.error,
  };
}

function createViewId(views) {
  const used = new Set(views.map(({ id }) => id));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = globalThis.crypto?.randomUUID?.()
      || `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (!used.has(id)) return id;
  }
  return `view-${Date.now().toString(36)}-${views.length}`;
}

export function useAdminTableViews({ tableId, enabled, defaults, normalize, initialState }) {
  const user = useOutletContext()?.user;
  const scope = createAdminTableViewScope({ enabled, tableId, user });
  const runtimeRef = useRef(null);
  const renderIdRef = useRef(0);
  const [, render] = useState(0);

  if (!runtimeRef.current || runtimeRef.current.token !== scope.token) {
    runtimeRef.current = initializeRuntime(scope, defaults, normalize, initialState);
  }
  const runtime = runtimeRef.current;

  const publish = useCallback((next) => {
    if (runtimeRef.current?.token !== scope.token) return false;
    runtimeRef.current = next;
    renderIdRef.current += 1;
    render(renderIdRef.current);
    return true;
  }, [scope.token]);

  const setState = useCallback((value) => {
    const current = runtimeRef.current;
    if (!current || current.token !== scope.token) return;
    const proposed = typeof value === "function" ? value(current.record.current) : value;
    const nextState = normalizeAdminTableViewState(proposed, defaults, normalize);
    const saved = !current.available
      || writeAdminTableViewCurrent(browserStorage(), current.storageKey, nextState);
    publish({
      ...current,
      record: { ...current.record, current: nextState },
      error: saved
        ? (current.error === ADMIN_TABLE_VIEW_STORAGE_ERROR ? null : current.error)
        : ADMIN_TABLE_VIEW_STORAGE_ERROR,
    });
  }, [defaults, normalize, publish, scope.token]);

  const saveView = useCallback((value) => {
    const current = runtimeRef.current;
    if (!current?.available || current.token !== scope.token) return false;
    const loaded = readAdminTableViewCatalog(browserStorage(), current.storageKey, defaults, normalize);
    if (loaded.error) {
      publish({ ...current, error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
      return false;
    }
    const name = typeof value === "string" ? value.trim() : "";
    const reconciled = { ...current.record, views: loaded.views };
    if (!name || name.length > MAX_NAME_LENGTH) {
      publish({ ...current, record: reconciled, error: "Enter a view name between 1 and 64 characters." });
      return false;
    }
    if (loaded.views.some((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      publish({ ...current, record: reconciled, error: "A saved view with this name already exists." });
      return false;
    }
    if (loaded.views.length >= MAX_VIEWS) {
      publish({ ...current, record: reconciled, error: "You can save up to 20 views." });
      return false;
    }
    const state = normalizeAdminTableViewState({ ...current.record.current, page: 1, scrollTop: 0 }, defaults, normalize);
    const views = [...loaded.views, { id: createViewId(loaded.views), name, state }];
    if (!writeAdminTableViewCatalog(browserStorage(), current.storageKey, views)) {
      publish({ ...current, record: reconciled, error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
      return false;
    }
    publish({ ...current, record: { ...current.record, views }, error: null });
    return true;
  }, [defaults, normalize, publish, scope.token]);

  const removeView = useCallback((id) => {
    const current = runtimeRef.current;
    if (!current?.available || current.token !== scope.token) return false;
    const loaded = readAdminTableViewCatalog(browserStorage(), current.storageKey, defaults, normalize);
    if (loaded.error) {
      publish({ ...current, error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
      return false;
    }
    const views = loaded.views.filter((view) => view.id !== id);
    if (views.length === loaded.views.length) {
      publish({ ...current, record: { ...current.record, views: loaded.views }, error: "That saved view is no longer available." });
      return false;
    }
    if (!writeAdminTableViewCatalog(browserStorage(), current.storageKey, views)) {
      publish({ ...current, record: { ...current.record, views: loaded.views }, error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
      return false;
    }
    publish({ ...current, record: { ...current.record, views }, error: null });
    return true;
  }, [defaults, normalize, publish, scope.token]);

  const applyView = useCallback((id) => {
    const current = runtimeRef.current;
    if (!current?.available || current.token !== scope.token) return null;
    const loaded = readAdminTableViewCatalog(browserStorage(), current.storageKey, defaults, normalize);
    if (loaded.error) {
      publish({ ...current, error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
      return null;
    }
    const view = loaded.views.find((candidate) => candidate.id === id);
    if (!view) {
      publish({ ...current, record: { ...current.record, views: loaded.views }, error: "That saved view is no longer available." });
      return null;
    }
    const state = normalizeAdminTableViewState({ ...view.state, page: 1, scrollTop: 0 }, defaults, normalize);
    const saved = writeAdminTableViewCurrent(browserStorage(), current.storageKey, state);
    publish({
      ...current,
      record: { ...current.record, current: state, views: loaded.views },
      error: saved ? null : ADMIN_TABLE_VIEW_STORAGE_ERROR,
    });
    return state;
  }, [defaults, normalize, publish, scope.token]);

  const clearError = useCallback(() => {
    const current = runtimeRef.current;
    if (current?.token === scope.token && current.error) publish({ ...current, error: null });
  }, [publish, scope.token]);

  useEffect(() => {
    if (!scope.available) return undefined;
    const onStorage = (event) => {
      if (event.key !== adminTableViewCatalogKey(scope.storageKey)) return;
      const current = runtimeRef.current;
      if (!current || current.token !== scope.token) return;
      const loaded = readAdminTableViewCatalog(browserStorage(), scope.storageKey, defaults, normalize);
      publish({
        ...current,
        record: { ...current.record, views: loaded.views },
        error: loaded.error || current.error,
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [defaults, normalize, publish, scope.available, scope.storageKey, scope.token]);

  return {
    state: runtime.record.current,
    setState,
    views: runtime.record.views,
    saveView,
    removeView,
    applyView,
    error: runtime.error,
    clearError,
    available: runtime.available,
    storageKey: runtime.storageKey,
  };
}

export default useAdminTableViews;
