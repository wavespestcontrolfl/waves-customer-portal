import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  ADMIN_TABLE_VIEW_STORAGE_ERROR,
  adminTableViewCatalogKey,
  createAdminTableViewScope,
  normalizeAdminTableViewState,
  readAdminTableViewCurrent,
  writeAdminTableViewCurrent,
} from "../lib/adminTableViewStorage";
import {
  mutateSavedViewCatalog,
  readSavedViewCatalog,
} from "../lib/adminTableViewCatalog";

const MAX_VIEWS = 20;
const MAX_NAME_LENGTH = 64;
const CATALOG_CHANNEL = "waves-admin-table-view-catalog";

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
    record: { current: initial, views: [] },
    currentError: loadedCurrent.error,
    catalogError: null,
    actionError: null,
    catalogLoading: scope.available,
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

function catalogOptions(runtime, defaults, normalize) {
  return {
    storageKey: runtime.storageKey,
    storage: browserStorage(),
    defaults,
    normalize,
  };
}

export function useAdminTableViews({ tableId, enabled, defaults, normalize, initialState }) {
  const user = useOutletContext()?.user;
  const scope = createAdminTableViewScope({ enabled, tableId, user });
  const runtimeRef = useRef(null);
  const renderIdRef = useRef(0);
  const catalogRequestRef = useRef(0);
  const applyRequestRef = useRef(0);
  const scopeGenerationRef = useRef(0);
  const channelRef = useRef(null);
  const [, render] = useState(0);

  if (!runtimeRef.current || runtimeRef.current.token !== scope.token) {
    catalogRequestRef.current += 1;
    applyRequestRef.current += 1;
    scopeGenerationRef.current += 1;
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
      currentError: saved ? null : ADMIN_TABLE_VIEW_STORAGE_ERROR,
    });
  }, [defaults, normalize, publish, scope.token]);

  const refreshViews = useCallback(async () => {
    const captured = runtimeRef.current;
    if (!captured?.available || captured.token !== scope.token) return false;
    const requestId = ++catalogRequestRef.current;
    publish({ ...captured, catalogLoading: true });
    const options = catalogOptions(captured, defaults, normalize);
    const loaded = await readSavedViewCatalog(options);
    const active = runtimeRef.current;
    if (!active || active.token !== captured.token
      || active.storageKey !== captured.storageKey
      || catalogRequestRef.current !== requestId) return false;
    if (loaded.error) {
      publish({ ...active, catalogLoading: false, catalogError: ADMIN_TABLE_VIEW_STORAGE_ERROR });
      return false;
    }
    publish({
      ...active,
      record: { ...active.record, views: loaded.views },
      catalogLoading: false,
      catalogError: null,
    });
    return true;
  }, [defaults, normalize, publish, scope.token]);

  const mutateCatalog = useCallback(async (captured, mutation) => {
    const scopeGeneration = scopeGenerationRef.current;
    const requestId = ++catalogRequestRef.current;
    const options = catalogOptions(captured, defaults, normalize);
    const result = await mutateSavedViewCatalog(options, (views) => {
      const active = runtimeRef.current;
      if (!active || active.token !== captured.token
        || active.storageKey !== captured.storageKey
        || scopeGenerationRef.current !== scopeGeneration) return { cancelled: true };
      return mutation(views);
    });
    const committed = !result.error && !result.cancelled;
    if (committed) {
      try { channelRef.current?.postMessage({ storageKey: captured.storageKey }); } catch { /* optional notification */ }
    }
    const active = runtimeRef.current;
    if (scopeGenerationRef.current !== scopeGeneration
      || !active || active.token !== captured.token
      || active.storageKey !== captured.storageKey) return false;
    if (catalogRequestRef.current !== requestId) {
      if (result.error === ADMIN_TABLE_VIEW_STORAGE_ERROR) {
        publish({ ...active, catalogError: result.error, actionError: null });
      } else if (result.error) {
        publish({ ...active, actionError: result.error });
      } else if (committed) {
        publish({ ...active, actionError: null });
      }
      return committed;
    }
    if (result.cancelled) return false;
    if (result.error) {
      const views = result.error === ADMIN_TABLE_VIEW_STORAGE_ERROR
        ? active.record.views : result.views;
      publish({
        ...active,
        record: { ...active.record, views },
        catalogLoading: false,
        catalogError: result.error === ADMIN_TABLE_VIEW_STORAGE_ERROR ? result.error : null,
        actionError: result.error === ADMIN_TABLE_VIEW_STORAGE_ERROR ? null : result.error,
      });
      return false;
    }
    publish({
      ...active,
      record: { ...active.record, views: result.views },
      catalogLoading: false,
      catalogError: null,
      actionError: null,
    });
    return true;
  }, [defaults, normalize, publish]);

  const saveView = useCallback(async (value) => {
    const current = runtimeRef.current;
    if (!current?.available || current.token !== scope.token) return false;
    const name = typeof value === "string" ? value.trim() : "";
    const state = normalizeAdminTableViewState(
      { ...current.record.current, page: 1, scrollTop: 0 }, defaults, normalize,
    );
    return mutateCatalog(current, (views) => {
      if (!name || name.length > MAX_NAME_LENGTH) {
        return { error: "Enter a view name between 1 and 64 characters." };
      }
      if (views.some((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return { error: "A saved view with this name already exists." };
      }
      if (views.length >= MAX_VIEWS) return { error: "You can save up to 20 views." };
      return { views: [...views, { id: createViewId(views), name, state }] };
    });
  }, [defaults, mutateCatalog, normalize, scope.token]);

  const removeView = useCallback(async (id) => {
    const current = runtimeRef.current;
    if (!current?.available || current.token !== scope.token) return false;
    return mutateCatalog(current, (views) => {
      const nextViews = views.filter((view) => view.id !== id);
      return nextViews.length === views.length
        ? { error: "That saved view is no longer available." }
        : { views: nextViews };
    });
  }, [mutateCatalog, scope.token]);

  const applyView = useCallback(async (id) => {
    const current = runtimeRef.current;
    if (!current?.available || current.token !== scope.token) return null;
    const applyId = ++applyRequestRef.current;
    const catalogRequestId = ++catalogRequestRef.current;
    publish({ ...current, catalogLoading: true });
    const options = catalogOptions(current, defaults, normalize);
    const loaded = await readSavedViewCatalog(options);
    const active = runtimeRef.current;
    if (!active || active.token !== current.token
      || active.storageKey !== current.storageKey
      || applyRequestRef.current !== applyId) return null;
    const ownsCatalogPublication = catalogRequestRef.current === catalogRequestId;
    if (loaded.error) {
      if (ownsCatalogPublication) {
        publish({ ...active, catalogLoading: false, catalogError: ADMIN_TABLE_VIEW_STORAGE_ERROR });
      }
      return null;
    }
    const view = loaded.views.find((candidate) => candidate.id === id);
    if (!view) {
      publish({
        ...active,
        record: {
          ...active.record,
          views: ownsCatalogPublication ? loaded.views : active.record.views,
        },
        catalogLoading: ownsCatalogPublication ? false : active.catalogLoading,
        catalogError: ownsCatalogPublication ? null : active.catalogError,
        actionError: "That saved view is no longer available.",
      });
      return null;
    }
    const state = normalizeAdminTableViewState({ ...view.state, page: 1, scrollTop: 0 }, defaults, normalize);
    const saved = writeAdminTableViewCurrent(browserStorage(), active.storageKey, state);
    publish({
      ...active,
      record: {
        ...active.record,
        current: state,
        views: ownsCatalogPublication ? loaded.views : active.record.views,
      },
      catalogLoading: ownsCatalogPublication ? false : active.catalogLoading,
      currentError: saved ? null : ADMIN_TABLE_VIEW_STORAGE_ERROR,
      catalogError: ownsCatalogPublication ? null : active.catalogError,
      actionError: null,
    });
    return state;
  }, [defaults, normalize, publish, scope.token]);

  const clearError = useCallback(() => {
    const current = runtimeRef.current;
    if (current?.token === scope.token
      && (current.currentError || current.catalogError || current.actionError)) {
      publish({ ...current, currentError: null, catalogError: null, actionError: null });
    }
  }, [publish, scope.token]);

  useEffect(() => {
    if (!scope.available) return undefined;
    const requestRefresh = () => { void refreshViews(); };
    const onStorage = (event) => {
      if (event.key === adminTableViewCatalogKey(scope.storageKey)) requestRefresh();
    };
    const onMessage = (event) => {
      if (event.data?.storageKey === scope.storageKey) requestRefresh();
    };
    let channel = null;
    try {
      if (typeof globalThis.BroadcastChannel === "function") {
        channel = new globalThis.BroadcastChannel(CATALOG_CHANNEL);
        channel.addEventListener("message", onMessage);
      }
    } catch { /* focus and dialog refresh remain available */ }
    channelRef.current = channel;
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", requestRefresh);
    requestRefresh();
    return () => {
      catalogRequestRef.current += 1;
      applyRequestRef.current += 1;
      scopeGenerationRef.current += 1;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", requestRefresh);
      if (channelRef.current === channel) channelRef.current = null;
      try { channel?.removeEventListener("message", onMessage); } catch { /* ignore */ }
      try { channel?.close(); } catch { /* ignore */ }
    };
  }, [refreshViews, scope.available, scope.storageKey]);

  return {
    state: runtime.record.current,
    setState,
    views: runtime.record.views,
    saveView,
    removeView,
    applyView,
    refreshViews,
    error: runtime.actionError || runtime.catalogError || runtime.currentError,
    clearError,
    catalogLoading: runtime.catalogLoading,
    available: runtime.available,
    storageKey: runtime.storageKey,
  };
}

export default useAdminTableViews;
