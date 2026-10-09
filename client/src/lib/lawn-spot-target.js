// client/src/lib/lawn-spot-target.js
//
// The target of a spot fungicide or insecticide row on the lawn Fast Complete sheet (owner 2026-10-09). The server sends the closed
// lists (the context's `spotTargets`, from lawn-spot-target.js, with the guide) and decides what is stored (it checks the target against
// the row's trouble type); this file only reads that block and lists what a row may offer. A whole-lawn row never asks.
//
// With no `spotTargets` in the context (the guide is off, or an older server) every function answers "no target" and the sheet
// renders and submits exactly as before.
import { normalizeApplicationMethod } from './product-rate-prefill';

const lowerId = (value) => String(value ?? '').toLowerCase();
const names = (list) => (Array.isArray(list) ? list.filter((name) => typeof name === 'string' && name.trim()) : []);

/** The context's spotTargets block, normalized, or null (no target control). */
export function spotTargetsOf(data) {
  const block = data?.spotTargets;
  if (!block || block.v !== 1) return null;
  const fungicide = names(block.fungicide);
  const insecticide = names(block.insecticide);
  if (!fungicide.length && !insecticide.length) return null;
  return { fungicide, insecticide, chinch: typeof block.chinch === 'string' ? block.chinch : '', takeAll: typeof block.takeAll === 'string' ? block.takeAll : '' };
}

const categoryOf = (row) => String(row?.product?.category || '').trim().toLowerCase();
const isSpot = (row) => normalizeApplicationMethod(row?.method) === 'spot_treatment';

// The row is for a chinch find: the chinch entry or card opened it, or the server says the product is a chinch-only rung.
const isChinchRow = (row, chinch) => row.guided === 'chinch' || !!row.chinchRow || (Array.isArray(chinch?.chinchOnlyIds) && chinch.chinchOnlyIds.some((id) => lowerId(id) === lowerId(row.productId)));

/**
 * What the row's target control offers: `{ kind: 'auto', target }` (a chinch find: stored with no tap), `{ kind: 'choose', choices }`
 * (one tap, optional), or null (a whole-lawn row, a product of another category, no lists). The take-all product offers only its own
 * name; the chinch name is never offered by tap (the chinch entry is the way to a chinch find).
 */
export function spotTargetOffer(row, { config, chinch = null, takeAll = null }) {
  if (!config || !row || !isSpot(row) || !['fungicide', 'insecticide'].includes(categoryOf(row))) return null;
  if (categoryOf(row) === 'insecticide' && isChinchRow(row, chinch)) return config.chinch ? { kind: 'auto', target: config.chinch } : null;
  if (categoryOf(row) === 'fungicide' && takeAll?.has(lowerId(row.productId))) return config.takeAll ? { kind: 'choose', choices: [config.takeAll] } : null;
  const list = config[categoryOf(row)].filter((name) => name !== config.takeAll && name !== config.chinch);
  return list.length ? { kind: 'choose', choices: list } : null;
}

/**
 * The /complete row's target fields: the tag the tech picked (one tag; the server checks it against the row's type and stores it, or
 * drops it) and, for a chinch find, the hint that the chinch entry opened the row. Always carries `targets` (an empty list when none).
 */
export function targetBodyFields(row) {
  const picked = typeof row?.spotTarget === 'string' && row.spotTarget ? [row.spotTarget] : [];
  return { targets: picked, ...(row?.guided === 'chinch' ? { targetFind: 'chinch' } : {}) };
}
