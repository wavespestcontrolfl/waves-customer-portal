import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_TABLE_VIEW_STORAGE_ERROR,
  adminTableViewCatalogKey,
  createAdminTableViewScope,
  normalizeAdminTableViewState,
  normalizeTableColumns,
  readAdminTableViewCatalog,
  readAdminTableViewCurrent,
  writeAdminTableViewCatalog,
  writeAdminTableViewCurrent,
} from "./adminTableViewStorage";

const COLUMNS = [
  { id: "name", required: true },
  { id: "status" },
  { id: "amount" },
];
const DEFAULTS = {
  query: "",
  status: "open",
  columns: ["name", "status", "amount"],
  pageSize: 25,
  page: 1,
  scrollTop: 0,
};

function normalize(value) {
  return {
    query: typeof value.query === "string" ? value.query.slice(0, 80) : "",
    status: ["open", "closed"].includes(value.status) ? value.status : DEFAULTS.status,
    columns: normalizeTableColumns(value.columns, COLUMNS),
    pageSize: [25, 50].includes(value.pageSize) ? value.pageSize : DEFAULTS.pageSize,
  };
}

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    value: (key) => values.get(key) ?? null,
  };
}

describe("admin table view normalization", () => {
  it("allowlists table fields and bounds common position fields", () => {
    expect(normalizeAdminTableViewState({
      query: 17,
      status: "hostile",
      columns: ["amount", "unknown", "amount"],
      pageSize: 999,
      page: Number.MAX_SAFE_INTEGER,
      scrollTop: -40,
      rawApiRows: [{ id: "not-stored" }],
    }, DEFAULTS, normalize)).toEqual({
      query: "",
      status: "open",
      columns: ["name", "amount"],
      pageSize: 25,
      page: 1_000_000,
      scrollTop: 0,
    });
  });

  it("keeps required columns in canonical order and defaults all for non-arrays", () => {
    expect(normalizeTableColumns(null, COLUMNS)).toEqual(["name", "status", "amount"]);
    expect(normalizeTableColumns(["amount", "unknown", "amount"], COLUMNS)).toEqual(["name", "amount"]);
  });
});

describe("admin table view storage scope", () => {
  it("builds a versioned account, role, and table key only when enabled and verified", () => {
    expect(createAdminTableViewScope({
      enabled: true,
      tableId: "customer list",
      user: { id: "staff/1", role: "admin" },
    })).toEqual({
      available: true,
      storageKey: "waves_admin_table_views:v1:staff%2F1:admin:customer%20list",
      token: JSON.stringify([true, "staff/1", "admin", "customer list"]),
    });
    expect(createAdminTableViewScope({ enabled: false, tableId: "customers", user: { id: "staff-1", role: "admin" } }).storageKey).toBeNull();
    expect(createAdminTableViewScope({ enabled: true, tableId: "customers", user: { role: "admin" } }).available).toBe(false);
  });
});

describe("admin table view record storage", () => {
  it("writes separate current and catalog records and reads both back", () => {
    const storage = memoryStorage();
    const key = "fixture-key";
    const current = { ...DEFAULTS, query: "ridge", page: 4, scrollTop: 200 };
    const views = [{ id: "view-1", name: "Ridge", state: { ...current, page: 1, scrollTop: 0 } }];
    expect(writeAdminTableViewCurrent(storage, key, current)).toBe(true);
    expect(writeAdminTableViewCatalog(storage, key, views)).toBe(true);

    expect(JSON.parse(storage.value(key))).toEqual({ version: 1, current });
    expect(JSON.parse(storage.value(adminTableViewCatalogKey(key)))).toEqual({ version: 1, views });
    expect(readAdminTableViewCurrent(storage, key, DEFAULTS, normalize).current).toEqual(current);
    expect(readAdminTableViewCatalog(storage, key, DEFAULTS, normalize).views).toEqual(views);
  });

  it("sanitizes and deduplicates hostile catalog entries", () => {
    const key = "fixture-key";
    const rows = [
      { id: " one ", name: " First ", state: { query: "safe", status: "closed", columns: ["status"], rawApiRows: [1], page: -2 } },
      { id: "two", name: "first", state: { query: "duplicate name" } },
      { id: "one", name: "Duplicate id", state: {} },
      { id: "", name: "Invalid", state: {} },
      ...Array.from({ length: 25 }, (_, index) => ({ id: `extra-${index}`, name: `Extra ${index}`, state: {} })),
    ];
    const storage = memoryStorage({
      [adminTableViewCatalogKey(key)]: JSON.stringify({ version: 1, views: rows }),
    });
    const loaded = readAdminTableViewCatalog(storage, key, DEFAULTS, normalize);
    expect(loaded.error).toBeNull();
    expect(loaded.views).toHaveLength(20);
    expect(loaded.views[0]).toEqual({
      id: "one",
      name: "First",
      state: {
        query: "safe",
        status: "closed",
        columns: ["name", "status"],
        pageSize: 25,
        page: 1,
        scrollTop: 0,
      },
    });
  });

  it.each([
    ["corrupt", "{not-json"],
    ["oversized", "x".repeat(128_001)],
    ["unknown version", JSON.stringify({ version: 2, current: { query: "future" } })],
  ])("defaults a %s current record", (_label, raw) => {
    const storage = memoryStorage({ key: raw });
    expect(readAdminTableViewCurrent(storage, "key", DEFAULTS, normalize)).toEqual({
      current: DEFAULTS,
      error: null,
    });
  });

  it("reports unavailable storage reads and returns false for failed writes", () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error("blocked"); }),
      setItem: vi.fn(() => { throw new Error("quota"); }),
    };
    expect(readAdminTableViewCurrent(storage, "key", DEFAULTS, normalize).error).toBe(ADMIN_TABLE_VIEW_STORAGE_ERROR);
    expect(readAdminTableViewCatalog(storage, "key", DEFAULTS, normalize).error).toBe(ADMIN_TABLE_VIEW_STORAGE_ERROR);
    expect(writeAdminTableViewCurrent(storage, "key", DEFAULTS)).toBe(false);
    expect(writeAdminTableViewCatalog(storage, "key", [])).toBe(false);
  });
});
