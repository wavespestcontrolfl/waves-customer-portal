// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAdminTableViews from "./useAdminTableViews";
import { normalizeTableColumns } from "../lib/adminTableViewStorage";

const COLUMNS = [
  { id: "name", required: true },
  { id: "status" },
  { id: "amount" },
];
const DEFAULTS = {
  query: "",
  status: "open",
  sort: "name",
  columns: ["name", "status", "amount"],
  pageSize: 25,
  page: 1,
  scrollTop: 0,
};
const STATUS = new Set(["open", "closed", "all"]);
const SORTS = new Set(["name", "amount"]);
const PAGE_SIZES = new Set([25, 50, 100]);

function normalize(value) {
  return {
    query: typeof value.query === "string" ? value.query.slice(0, 80) : "",
    status: STATUS.has(value.status) ? value.status : DEFAULTS.status,
    sort: SORTS.has(value.sort) ? value.sort : DEFAULTS.sort,
    columns: normalizeTableColumns(value.columns, COLUMNS),
    pageSize: PAGE_SIZES.has(value.pageSize) ? value.pageSize : DEFAULTS.pageSize,
  };
}

let shellUser;

function Wrapper({ children }) {
  return (
    <MemoryRouter initialEntries={["/admin/table"]}>
      <Routes>
        <Route path="/admin" element={<Outlet context={{ user: shellUser }} />}>
          <Route path="table" element={children} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function hookOptions(overrides = {}) {
  return {
    tableId: "fixture-table",
    enabled: true,
    defaults: DEFAULTS,
    normalize,
    ...overrides,
  };
}

function mountHook(options = hookOptions()) {
  return renderHook(
    ({ hookProps }) => useAdminTableViews(hookProps),
    { wrapper: Wrapper, initialProps: { hookProps: options } },
  );
}

function queuedLocks() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tails = new Map();
  const request = vi.fn((name, options, callback) => {
    const result = (tails.get(name) || gate).catch(() => {})
      .then(() => callback({ name, mode: options.mode }));
    tails.set(name, result);
    return result;
  });
  return { locks: { request }, release };
}

async function mutate(action) {
  let result;
  await act(async () => { result = await action(); });
  return result;
}

async function releaseQueued(coordinator, operations) {
  let outcomes;
  await act(async () => { coordinator.release(); outcomes = await Promise.all(operations); });
  return outcomes;
}

function blockedStorage() {
  throw new DOMException("Access denied", "SecurityError");
}

beforeEach(() => {
  shellUser = { id: "staff-1", role: "admin" };
  localStorage.clear();
  vi.stubGlobal("navigator", { locks: {
    request: vi.fn((name, options, callback) => Promise.resolve().then(() => callback({ name, mode: options.mode }))),
  } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAdminTableViews", () => {
  it("round trips current state and composes synchronous updater calls", () => {
    const first = mountHook();
    act(() => {
      first.result.current.setState((current) => ({ ...current, query: "ridge", page: 4, scrollTop: 250 }));
      first.result.current.setState((current) => ({ ...current, query: `${current.query}-west`, page: current.page + 1 }));
    });
    expect(first.result.current.state).toMatchObject({ query: "ridge-west", page: 5, scrollTop: 250 });
    const storageKey = first.result.current.storageKey;
    expect(JSON.parse(localStorage.getItem(storageKey)).current).toMatchObject({ query: "ridge-west", page: 5, scrollTop: 250 });

    first.unmount();
    const reloaded = mountHook();
    expect(reloaded.result.current.state).toMatchObject({ query: "ridge-west", page: 5, scrollTop: 250 });
  });

  it("runs initialState once per scope and overlays explicit initial values", () => {
    const initialState = vi.fn((loaded) => ({ status: loaded.status, query: "from-url", page: 7 }));
    const view = mountHook(hookOptions({ initialState }));
    expect(view.result.current.state).toMatchObject({ query: "from-url", status: "open", page: 7 });
    expect(initialState).toHaveBeenCalledTimes(1);

    const changedCallback = vi.fn(() => ({ query: "changed-query" }));
    view.rerender({ hookProps: hookOptions({ initialState: changedCallback }) });
    expect(changedCallback).not.toHaveBeenCalled();
    expect(view.result.current.state.query).toBe("from-url");

    view.rerender({ hookProps: hookOptions({ tableId: "second-table", initialState: changedCallback }) });
    expect(changedCallback).toHaveBeenCalledTimes(1);
    expect(view.result.current.state.query).toBe("changed-query");
  });

  it("isolates by user and role and makes an old scope's setter inert", () => {
    const view = mountHook();
    act(() => view.result.current.setState({ ...view.result.current.state, query: "admin-one" }));
    const firstKey = view.result.current.storageKey;
    const staleSetter = view.result.current.setState;

    shellUser = { id: "staff-2", role: "admin" };
    view.rerender({ hookProps: hookOptions() });
    expect(view.result.current.state.query).toBe("");
    const secondKey = view.result.current.storageKey;
    expect(secondKey).not.toBe(firstKey);
    act(() => staleSetter({ ...DEFAULTS, query: "stale-write" }));
    expect(view.result.current.state.query).toBe("");
    expect(localStorage.getItem(secondKey)).toBeNull();
    expect(JSON.parse(localStorage.getItem(firstKey)).current.query).toBe("admin-one");

    shellUser = { id: "staff-1", role: "technician" };
    view.rerender({ hookProps: hookOptions() });
    expect(view.result.current.storageKey).not.toBe(firstKey);
    expect(view.result.current.state.query).toBe("");
  });

  it("does no storage work without the gate and verified identity, while state still works", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "untrusted", role: "admin" }));
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const disabled = mountHook(hookOptions({ enabled: false }));
    expect(disabled.result.current).toMatchObject({ available: false, storageKey: null, views: [] });
    act(() => disabled.result.current.setState({ ...DEFAULTS, query: "memory-only", page: 3 }));
    expect(disabled.result.current.state).toMatchObject({ query: "memory-only", page: 3 });
    expect(await mutate(() => disabled.result.current.saveView("Hidden"))).toBe(false);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();

    disabled.unmount();
    shellUser = { role: "admin" };
    const missing = mountHook();
    expect(missing.result.current.available).toBe(false);
    act(() => missing.result.current.setState({ ...DEFAULTS, status: "closed" }));
    expect(missing.result.current.state.status).toBe("closed");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("snapshots a position-neutral view without moving, then resets position when applying it", async () => {
    const view = mountHook();
    act(() => view.result.current.setState({ ...DEFAULTS, query: "north", status: "closed", page: 9, scrollTop: 640 }));
    expect(await mutate(() => view.result.current.saveView(" North queue "))).toBe(true);
    expect(view.result.current.state).toMatchObject({ query: "north", status: "closed", page: 9, scrollTop: 640 });
    expect(view.result.current.views[0]).toMatchObject({ name: "North queue", state: { query: "north", status: "closed", page: 1, scrollTop: 0 } });
    expect(JSON.parse(localStorage.getItem(view.result.current.storageKey)).current).toMatchObject({ page: 9, scrollTop: 640 });

    act(() => view.result.current.setState({ ...view.result.current.state, query: "south", status: "all", page: 8, scrollTop: 300 }));
    let applied;
    act(() => { applied = view.result.current.applyView(view.result.current.views[0].id); });
    expect(applied).toMatchObject({ query: "north", status: "closed", page: 1, scrollTop: 0 });
    expect(view.result.current.state).toEqual(applied);
    expect(JSON.parse(localStorage.getItem(view.result.current.storageKey)).current).toEqual(applied);
  });

  it("rejects duplicate names and the 21st view, then durably deletes a view", async () => {
    const view = mountHook();
    expect(await mutate(() => view.result.current.saveView("Queue 1"))).toBe(true);
    expect(await mutate(() => view.result.current.saveView(" queue 1 "))).toBe(false);
    expect(view.result.current.error).toMatch(/already exists/i);
    act(() => view.result.current.clearError());

    for (let index = 2; index <= 20; index += 1) {
      expect(await mutate(() => view.result.current.saveView(`Queue ${index}`))).toBe(true);
    }
    expect(await mutate(() => view.result.current.saveView("Queue 21"))).toBe(false);
    expect(view.result.current.views).toHaveLength(20);
    expect(view.result.current.error).toMatch(/up to 20/i);

    const removedId = view.result.current.views[4].id;
    expect(await mutate(() => view.result.current.removeView(removedId))).toBe(true);
    expect(view.result.current.views.some(({ id }) => id === removedId)).toBe(false);
    const key = view.result.current.storageKey;
    view.unmount();
    const reloaded = mountHook();
    expect(reloaded.result.current.storageKey).toBe(key);
    expect(reloaded.result.current.views).toHaveLength(19);
    expect(reloaded.result.current.views.some(({ id }) => id === removedId)).toBe(false);
  });

  it.each([
    ["methods", () => vi.stubGlobal("localStorage", { getItem: blockedStorage, setItem: blockedStorage })],
    ["property getter", () => vi.spyOn(globalThis, "localStorage", "get").mockImplementation(blockedStorage)],
  ])("keeps controls usable and refuses saves when localStorage %s throw", async (_label, blockStorage) => {
    blockStorage();
    const view = mountHook();
    expect(view.result.current.error).toBe("Changes could not be saved in this browser.");
    act(() => view.result.current.setState({ ...DEFAULTS, query: "still-works", page: 4, scrollTop: 80 }));
    expect(view.result.current.state).toMatchObject({ query: "still-works", page: 4, scrollTop: 80 });
    expect(await mutate(() => view.result.current.saveView("Not durable"))).toBe(false);
    expect(view.result.current.views).toEqual([]);
    expect(view.result.current.error).toMatch(/could not be saved in this browser/i);
  });

  it("applies a saved view in memory when its persistence write fails", async () => {
    const seeded = mountHook();
    act(() => seeded.result.current.setState({ ...DEFAULTS, status: "closed" }));
    expect(await mutate(() => seeded.result.current.saveView("Closed"))).toBe(true);
    const id = seeded.result.current.views[0].id;
    seeded.unmount();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const view = mountHook();
    act(() => view.result.current.setState({ ...DEFAULTS, status: "all", page: 9 }));
    expect(view.result.current.state.status).toBe("all");
    let applied;
    act(() => { applied = view.result.current.applyView(id); });
    expect(applied).toMatchObject({ status: "closed", page: 1, scrollTop: 0 });
    expect(view.result.current.state).toEqual(applied);
    expect(view.result.current.error).toMatch(/could not be saved/i);
    expect(setItem).toHaveBeenCalled();
  });

  it("does not let stale settings writes erase or resurrect saved views", async () => {
    const first = mountHook();
    const stale = mountHook();
    act(() => first.result.current.setState({ ...DEFAULTS, query: "first", page: 6, scrollTop: 90 }));
    expect(await mutate(() => first.result.current.saveView("First view"))).toBe(true);
    const id = first.result.current.views[0].id;
    const catalogKey = `${first.result.current.storageKey}:views`;

    act(() => stale.result.current.setState({ ...DEFAULTS, query: "stale tab", page: 3, scrollTop: 40 }));
    expect(JSON.parse(localStorage.getItem(catalogKey)).views.map((view) => view.id)).toEqual([id]);

    expect(await mutate(() => first.result.current.removeView(id))).toBe(true);
    act(() => stale.result.current.setState((current) => ({ ...current, query: "stale tab again", page: 4 })));
    expect(JSON.parse(localStorage.getItem(catalogKey)).views).toEqual([]);
  });

  it("serializes overlapping stale saves and preserves each queued snapshot", async () => {
    const coordinator = queuedLocks();
    vi.stubGlobal("navigator", { locks: coordinator.locks });
    const first = mountHook();
    const second = mountHook();
    act(() => first.result.current.setState({ ...DEFAULTS, query: "alpha", page: 7, scrollTop: 70 }));
    act(() => second.result.current.setState({ ...DEFAULTS, query: "beta", status: "closed", page: 5, scrollTop: 50 }));
    const key = first.result.current.storageKey;
    let saves;
    act(() => {
      saves = [first.result.current.saveView("Alpha"), second.result.current.saveView("Beta")];
    });
    expect(coordinator.locks.request).toHaveBeenCalledTimes(2);
    expect(coordinator.locks.request.mock.calls.map(([name]) => name)).toEqual([
      `waves-admin-table-views:${key}`,
      `waves-admin-table-views:${key}`,
    ]);
    expect(coordinator.locks.request.mock.calls[0][1]).toEqual({ mode: "exclusive" });
    expect(localStorage.getItem(`${key}:views`)).toBeNull();
    act(() => second.result.current.setState({ ...second.result.current.state, query: "newer beta" }));
    const outcomes = await releaseQueued(coordinator, saves);
    expect(outcomes).toEqual([true, true]);

    const rawCatalog = localStorage.getItem(`${key}:views`);
    expect(JSON.parse(rawCatalog).views.map((view) => view.name)).toEqual(["Alpha", "Beta"]);
    expect(JSON.parse(rawCatalog).views[1].state.query).toBe("beta");
    expect(second.result.current.state.query).toBe("newer beta");
    expect(second.result.current.views.map((view) => view.name)).toEqual(["Alpha", "Beta"]);
    expect(first.result.current.views.map((view) => view.name)).toEqual(["Alpha"]);
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: `${key}:views`,
      newValue: JSON.stringify({ version: 1, views: [] }),
    })));
    expect(first.result.current.views.map((view) => view.name)).toEqual(["Alpha", "Beta"]);
    expect(first.result.current.state).toMatchObject({ query: "alpha", page: 7, scrollTop: 70 });
  });

  it("does not resurrect a delete when a stale save queues behind it", async () => {
    const owner = mountHook();
    expect(await mutate(() => owner.result.current.saveView("Temporary"))).toBe(true);
    const removedId = owner.result.current.views[0].id;
    const staleDelete = mountHook();
    const staleSave = mountHook();
    act(() => staleSave.result.current.setState({ ...DEFAULTS, query: "retained" }));
    const coordinator = queuedLocks();
    vi.stubGlobal("navigator", { locks: coordinator.locks });
    let operations;
    act(() => {
      operations = [
        staleDelete.result.current.removeView(removedId),
        staleSave.result.current.saveView("Retained"),
      ];
    });
    const outcomes = await releaseQueued(coordinator, operations);
    expect(outcomes).toEqual([true, true]);
    const views = JSON.parse(localStorage.getItem(`${owner.result.current.storageKey}:views`)).views;
    expect(views.map(({ name }) => name)).toEqual(["Retained"]);
    expect(views.some(({ id }) => id === removedId)).toBe(false);
  });

  it.each([
    ["is missing", () => ({})],
    ["has a throwing getter", () => Object.defineProperty({}, "locks", { get() { throw new Error("blocked"); } })],
    ["rejects the request", () => ({ locks: { request: vi.fn(() => Promise.reject(new Error("broken"))) } })],
  ])("keeps current settings usable when Web Locks %s", async (_label, navigatorValue) => {
    vi.stubGlobal("navigator", navigatorValue());
    const view = mountHook();
    act(() => view.result.current.setState({ ...DEFAULTS, query: "still usable", page: 4 }));
    expect(await mutate(() => view.result.current.saveView("Unsafe save"))).toBe(false);
    expect(view.result.current.state).toMatchObject({ query: "still usable", page: 4 });
    expect(view.result.current.views).toEqual([]);
    expect(view.result.current.error).toBe("Changes could not be saved in this browser.");
    expect(localStorage.getItem(`${view.result.current.storageKey}:views`)).toBeNull();
  });

  it("drops a queued mutation after the verified account scope changes", async () => {
    const coordinator = queuedLocks();
    vi.stubGlobal("navigator", { locks: coordinator.locks });
    const view = mountHook();
    act(() => view.result.current.setState({ ...DEFAULTS, query: "first account" }));
    const firstKey = view.result.current.storageKey;
    let pendingSave;
    act(() => { pendingSave = view.result.current.saveView("Wrong account"); });

    shellUser = { id: "staff-2", role: "admin" };
    view.rerender({ hookProps: hookOptions() });
    const secondKey = view.result.current.storageKey;
    expect(secondKey).not.toBe(firstKey);
    expect(await releaseQueued(coordinator, [pendingSave])).toEqual([false]);
    expect(localStorage.getItem(`${firstKey}:views`)).toBeNull();
    expect(localStorage.getItem(`${secondKey}:views`)).toBeNull();
    expect(view.result.current).toMatchObject({ views: [], error: null });
  });

  it("refuses to apply a view deleted by another instance", async () => {
    const first = mountHook();
    const stale = mountHook();
    expect(await mutate(() => first.result.current.saveView("Temporary"))).toBe(true);
    const id = first.result.current.views[0].id;
    expect(await mutate(() => first.result.current.removeView(id))).toBe(true);

    let applied;
    act(() => { applied = stale.result.current.applyView(id); });
    expect(applied).toBeNull();
    expect(stale.result.current.views).toEqual([]);
    expect(stale.result.current.error).toMatch(/no longer available/i);
  });
});
