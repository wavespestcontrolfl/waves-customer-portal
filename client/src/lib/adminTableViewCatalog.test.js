import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mutateSavedViewCatalog,
  readSavedViewCatalog,
} from "./adminTableViewCatalog";
import {
  ADMIN_TABLE_VIEW_STORAGE_ERROR,
  adminTableViewCatalogKey,
} from "./adminTableViewStorage";

const DB_NAME = "waves-admin-table-views";
const STORE_NAME = "catalogs";
const STORAGE_KEY = "waves_admin_table_views:v1:staff-1:admin:customers";
const DEFAULTS = { query: "", status: "open", page: 1, scrollTop: 0 };

function normalize(value) {
  return {
    query: typeof value.query === "string" ? value.query.slice(0, 40) : "",
    status: ["open", "closed"].includes(value.status) ? value.status : DEFAULTS.status,
  };
}

function view(id, name = id) {
  return { id, name, state: { ...DEFAULTS, query: name } };
}

function options(extra = {}) {
  return { storageKey: STORAGE_KEY, defaults: DEFAULTS, normalize, ...extra };
}

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    value: (key) => values.get(key) ?? null,
  };
}

function openRawDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawRecord(action, record) {
  const database = await openRawDatabase();
  return new Promise((resolve, reject) => {
    const mode = action === "read" ? "readonly" : "readwrite";
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = action === "read" ? store.get(STORAGE_KEY) : store.put(record, STORAGE_KEY);
    let value;
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => { database.close(); resolve(value); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.restoreAllMocks();
});

describe("saved view catalog transactions", () => {
  it("preserves concurrent updates made through independent database connections", async () => {
    const add = (entry) => mutateSavedViewCatalog(options(), (views) => ({ views: [...views, entry] }));
    const results = await Promise.all([add(view("first")), add(view("second"))]);

    expect(results.every((result) => result.error === null)).toBe(true);
    const catalog = await readSavedViewCatalog(options());
    expect(catalog.views.map(({ id }) => id).sort()).toEqual(["first", "second"]);
  });

  it("runs duplicate and maximum checks against the prior committed catalog", async () => {
    const saveUnique = (entry) => mutateSavedViewCatalog(options(), (views) => {
      if (views.some(({ name }) => name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) {
        return { error: "duplicate" };
      }
      if (views.length >= 20) return { error: "maximum" };
      return { views: [...views, entry] };
    });

    const duplicates = await Promise.all([
      saveUnique(view("one", "Shared")),
      saveUnique(view("two", "shared")),
    ]);
    expect(duplicates.map(({ error }) => error)).toEqual(expect.arrayContaining([null, "duplicate"]));

    await mutateSavedViewCatalog(options(), (views) => ({
      views: [...views, ...Array.from({ length: 18 }, (_, index) => view(`seed-${index}`))],
    }));
    const atLimit = await Promise.all([
      saveUnique(view("last-a")),
      saveUnique(view("last-b")),
    ]);
    expect(atLimit.map(({ error }) => error)).toEqual(expect.arrayContaining([null, "maximum"]));
    expect((await readSavedViewCatalog(options())).views).toHaveLength(20);
  });

  it("serializes a delete with a save without resurrecting the deleted view", async () => {
    await mutateSavedViewCatalog(options(), () => ({ views: [view("delete-me"), view("keep-me")] }));
    await Promise.all([
      mutateSavedViewCatalog(options(), (views) => ({
        views: views.filter(({ id }) => id !== "delete-me"),
      })),
      mutateSavedViewCatalog(options(), (views) => ({ views: [...views, view("new-view")] })),
    ]);

    expect((await readSavedViewCatalog(options())).views.map(({ id }) => id).sort())
      .toEqual(["keep-me", "new-view"]);
  });

  it("does not report success when a put succeeds but its transaction aborts", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function abortAfterPut(...args) {
      const request = originalPut.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });

    const result = await mutateSavedViewCatalog(options(), () => ({ views: [view("lost")] }));
    expect(result).toEqual({ views: [], error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
    vi.restoreAllMocks();
    expect((await readSavedViewCatalog(options())).views).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["throwing", { open: () => { throw new Error("blocked"); } }],
    ["blocked", {
      open: () => {
        const request = {};
        queueMicrotask(() => request.onblocked());
        return request;
      },
    }],
  ])("reports %s IndexedDB without writing to legacy storage", async (_label, factory) => {
    globalThis.indexedDB = factory;
    const storage = memoryStorage();
    expect(await mutateSavedViewCatalog(options({ storage }), () => ({ views: [view("one")] })))
      .toEqual({ views: [], error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("imports legacy storage once and does not resurrect it after deletion", async () => {
    const legacyKey = adminTableViewCatalogKey(STORAGE_KEY);
    const storage = memoryStorage({
      [legacyKey]: JSON.stringify({ version: 1, views: [view("legacy")] }),
    });

    const imported = await mutateSavedViewCatalog(options({ storage }), (views) => ({
      views: [...views, view("new")],
    }));
    expect(imported.views.map(({ id }) => id)).toEqual(["legacy", "new"]);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(await mutateSavedViewCatalog(options({ storage }), () => ({ views: [] })))
      .toEqual({ views: [], error: null });
    expect((await readSavedViewCatalog(options({ storage }))).views).toEqual([]);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.value(legacyKey)).toContain("legacy");
    expect(await rawRecord("read")).toEqual({ version: 1, views: [] });
  });

  it.each([
    ["unsupported", { version: 2, views: [view("future")] }],
    ["corrupted", { version: 1, views: "not-an-array" }],
  ])("normalizes an %s IndexedDB record", async (_label, record) => {
    await rawRecord("write", record);
    expect(await readSavedViewCatalog(options())).toEqual({ views: [], error: null });
    expect(await rawRecord("read")).toEqual({ version: 1, views: [] });
  });

  it("returns a protected legacy read failure instead of hiding it with an empty record", async () => {
    const storage = { getItem: () => { throw new Error("denied"); } };
    expect(await readSavedViewCatalog(options({ storage })))
      .toEqual({ views: [], error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
    expect(await rawRecord("read")).toBeUndefined();
  });

  it("imports preserved legacy views after denied storage access recovers", async () => {
    const storage = memoryStorage({
      [adminTableViewCatalogKey(STORAGE_KEY)]: JSON.stringify({ version: 1, views: [view("preserved")] }),
    });

    expect(await readSavedViewCatalog(options({ storage: null })))
      .toEqual({ views: [], error: ADMIN_TABLE_VIEW_STORAGE_ERROR });
    expect(await rawRecord("read")).toBeUndefined();
    expect((await readSavedViewCatalog(options({ storage }))).views.map(({ id }) => id))
      .toEqual(["preserved"]);
    expect(await readSavedViewCatalog(options({ storage: null })))
      .toEqual(expect.objectContaining({ error: null, views: [expect.objectContaining({ id: "preserved" })] }));
  });

  it("does not write when the synchronous scope guard cancels the mutation", async () => {
    await mutateSavedViewCatalog(options(), () => ({ views: [view("existing")] }));
    const before = await rawRecord("read");

    expect(await mutateSavedViewCatalog(options(), (views) => {
      expect(views.map(({ id }) => id)).toEqual(["existing"]);
      return { cancelled: true };
    })).toEqual({ views: before.views, error: null, cancelled: true });
    expect(await rawRecord("read")).toEqual(before);
  });
});
