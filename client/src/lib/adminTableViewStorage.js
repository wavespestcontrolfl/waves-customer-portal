export const ADMIN_TABLE_VIEW_VERSION = 1;
export const ADMIN_TABLE_VIEW_STORAGE_ERROR = "Changes could not be saved in this browser.";

const MAX_VIEWS = 20;
const MAX_NAME_LENGTH = 64;
const MAX_ID_LENGTH = 128;
const MAX_PAGE = 1_000_000;
const MAX_SCROLL_TOP = 10_000_000;
const MAX_STORED_LENGTH = 128_000;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function boundedNumber(value, fallback, maximum, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(maximum, Math.max(integer ? 1 : 0, value));
  return integer ? Math.floor(bounded) : bounded;
}

export function normalizeAdminTableViewState(value, defaults, normalize) {
  const candidate = isObject(value) ? value : {};
  let normalized = {};
  try {
    const result = normalize({ ...defaults, ...candidate });
    if (isObject(result)) normalized = result;
  } catch {
    try {
      const result = normalize({ ...defaults });
      if (isObject(result)) normalized = result;
    } catch { /* caller defaults remain available for common fields */ }
  }
  return {
    ...normalized,
    page: boundedNumber(candidate.page, boundedNumber(defaults.page, 1, MAX_PAGE, true), MAX_PAGE, true),
    scrollTop: boundedNumber(candidate.scrollTop, boundedNumber(defaults.scrollTop, 0, MAX_SCROLL_TOP), MAX_SCROLL_TOP),
  };
}

export function normalizeTableColumns(value, columns) {
  const definitions = Array.isArray(columns) ? columns : [];
  const requested = Array.isArray(value) ? new Set(value.filter((id) => typeof id === "string")) : null;
  const seen = new Set();
  const result = [];
  for (const column of definitions) {
    const id = typeof column === "string" ? column : column?.id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    if (requested === null || column?.required === true || requested.has(id)) result.push(id);
  }
  return result;
}

function scopePart(value, maximum) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text && text.length <= maximum ? text : "";
}

export function createAdminTableViewScope({ enabled, tableId, user }) {
  const id = scopePart(user?.id, MAX_ID_LENGTH);
  const role = scopePart(user?.role, MAX_NAME_LENGTH);
  const table = scopePart(tableId, MAX_NAME_LENGTH);
  const available = Boolean(enabled && id && role && table);
  const storageKey = available
    ? `waves_admin_table_views:v${ADMIN_TABLE_VIEW_VERSION}:${encodeURIComponent(id)}:${encodeURIComponent(role)}:${encodeURIComponent(table)}`
    : null;
  return {
    available,
    storageKey,
    token: JSON.stringify([Boolean(enabled), id, role, table]),
  };
}

export function adminTableViewCatalogKey(storageKey) {
  return `${storageKey}:views`;
}

function readStoredValue(storage, storageKey) {
  let raw;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return { value: null, error: ADMIN_TABLE_VIEW_STORAGE_ERROR };
  }
  if (!raw || raw.length > MAX_STORED_LENGTH) return { value: null, error: null };
  try {
    const saved = JSON.parse(raw);
    return isObject(saved) && saved.version === ADMIN_TABLE_VIEW_VERSION
      ? { value: saved, error: null }
      : { value: null, error: null };
  } catch { return { value: null, error: null }; }
}

function sanitizeText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maximum);
}

function sanitizeViews(value, defaults, normalize) {
  if (!Array.isArray(value)) return [];
  const views = [];
  const ids = new Set();
  const names = new Set();
  for (const candidate of value) {
    if (views.length >= MAX_VIEWS) break;
    if (!isObject(candidate)) continue;
    const id = sanitizeText(candidate.id, MAX_ID_LENGTH);
    const name = sanitizeText(candidate.name, MAX_NAME_LENGTH);
    const foldedName = name.toLocaleLowerCase();
    if (!id || !name || ids.has(id) || names.has(foldedName)) continue;
    ids.add(id);
    names.add(foldedName);
    views.push({ id, name, state: normalizeAdminTableViewState(candidate.state, defaults, normalize) });
  }
  return views;
}

export function normalizeAdminTableViewCatalog(record, defaults, normalize) {
  return {
    version: ADMIN_TABLE_VIEW_VERSION,
    views: isObject(record) && record.version === ADMIN_TABLE_VIEW_VERSION
      ? sanitizeViews(record.views, defaults, normalize)
      : [],
  };
}

export function readAdminTableViewCurrent(storage, storageKey, defaults, normalize) {
  const loaded = readStoredValue(storage, storageKey);
  return {
    current: normalizeAdminTableViewState(loaded.value?.current ?? defaults, defaults, normalize),
    error: loaded.error,
  };
}

export function readAdminTableViewCatalog(storage, storageKey, defaults, normalize) {
  const loaded = readStoredValue(storage, adminTableViewCatalogKey(storageKey));
  return {
    views: normalizeAdminTableViewCatalog(loaded.value, defaults, normalize).views,
    error: loaded.error,
  };
}

function writeStoredValue(storage, storageKey, value) {
  try {
    storage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function writeAdminTableViewCurrent(storage, storageKey, current) {
  return writeStoredValue(storage, storageKey, { version: ADMIN_TABLE_VIEW_VERSION, current });
}

export function writeAdminTableViewCatalog(storage, storageKey, views) {
  return writeStoredValue(storage, adminTableViewCatalogKey(storageKey), { version: ADMIN_TABLE_VIEW_VERSION, views });
}
