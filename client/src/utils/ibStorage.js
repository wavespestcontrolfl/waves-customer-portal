/**
 * Intelligence Bar localStorage — persistent recents + favorites per context.
 * client/src/utils/ibStorage.js
 *
 * Recents are deleted when a staff session ends (lib/adminAuth.js
 * clearStaffDeviceData, by the `ib.recents.` prefix). Favorites (the bar's
 * Pinned prompts) are kept per staff account, `ib.pinned.<staff id>.<context>`,
 * and stay; no account, none. The older `ib.favorites.<context>` lists were
 * shared by every login on the device: nothing reads them, and the session
 * end deletes them.
 */

const MAX_RECENTS = 5;
const MAX_FAVORITES = 10;

function key(kind, context) {
  return `ib.${kind}.${context || 'default'}`;
}

function read(k) {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(k, arr) {
  try {
    localStorage.setItem(k, JSON.stringify(arr));
  } catch {
    /* quota exceeded or disabled — silently drop */
  }
}

export function getRecents(context) {
  return read(key('recents', context));
}

export function addRecent(context, prompt) {
  const k = key('recents', context);
  const existing = read(k);
  const filtered = existing.filter((p) => p !== prompt);
  const next = [prompt, ...filtered].slice(0, MAX_RECENTS);
  write(k, next);
  return next;
}

export function getFavorites(context, userId) {
  return userId ? read(key(`pinned.${userId}`, context)) : [];
}

export function toggleFavorite(context, userId, prompt) {
  if (!userId) return [];
  const k = key(`pinned.${userId}`, context);
  const existing = read(k);
  const isFav = existing.includes(prompt);
  const next = isFav
    ? existing.filter((p) => p !== prompt)
    : [prompt, ...existing].slice(0, MAX_FAVORITES);
  write(k, next);
  return next;
}
