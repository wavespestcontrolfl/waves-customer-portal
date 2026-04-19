/**
 * Intelligence Bar localStorage — persistent recents + favorites per context.
 * client/src/utils/ibStorage.js
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

export function getFavorites(context) {
  return read(key('favorites', context));
}

export function toggleFavorite(context, prompt) {
  const k = key('favorites', context);
  const existing = read(k);
  const isFav = existing.includes(prompt);
  const next = isFav
    ? existing.filter((p) => p !== prompt)
    : [prompt, ...existing].slice(0, MAX_FAVORITES);
  write(k, next);
  return next;
}
