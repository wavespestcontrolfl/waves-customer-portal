// client/src/lib/tree-shrub-pest-check.js
//
// The rules behind the Tree & Shrub Fast Complete "Live insects found?" block
// (GATE_TS_PEST_CHECK, owner 2026-10-05). Pure functions: the sheet reads the
// gate through the fast-context `pestCheck` key, and the server validates and
// freezes the answer (server/services/tree-shrub-pest-check.js).
//
// Agronomy: Merit 2F (imidacloprid, IRAC 4A) does not control ARMORED scale; it
// is for soft scale, whitefly and borers. Armored scale takes Distance IGR or
// oil on crawlers, or a Zylam drench; TriStar is not for armored scale (owner
// 2026-10-09). The protocol cards say several products are for live finds
// only; a No answer beside one of them is a note, never a block.
import PEST_CHECK from '../../../shared/tree-shrub-pest-check.json';

export const INSECT_TYPES = PEST_CHECK.insectTypes;

export const MERIT_BLOCK_MESSAGE = 'Merit does not control armored scale. Use Distance or oil on crawlers, or a Zylam drench.';

// Products the protocol says to use on live finds only. Matched on the product
// name, the same text the tech sees on the row.
const LIVE_FINDS_ONLY = [
  { pattern: /\btristar\b/i, label: 'TriStar' },
  { pattern: /\bdistance\b/i, label: 'Distance IGR' },
  { pattern: /\bdipel\b/i, label: 'DiPel PRO DF' },
  { pattern: /\bconserve\b/i, label: 'Conserve' },
  { pattern: /\bmainspring\b/i, label: 'Mainspring' },
  { pattern: /\bfloramite\b/i, label: 'Floramite' },
  // Oil moved to live-find use only (owner 2026-10-09); a sooty-mold wash is
  // the one case with no live insect, and this stays a note, never a block.
  { pattern: /\btritek\b/i, label: 'TriTek' },
];

export const TRISTAR_BLOCK_MESSAGE = 'TriStar does not control armored scale. Use Distance or oil on crawlers, or a Zylam drench.';
export const MERIT_TRISTAR_BLOCK_MESSAGE = 'Merit and TriStar do not control armored scale. Use Distance or oil on crawlers, or a Zylam drench.';

const MERIT_NAME = /\bmerit\b/i;
const IMIDACLOPRID = /imidacloprid/i;

// Merit by name, or any imidacloprid product by its active ingredient.
export function isMeritProduct(row) {
  const product = row?.product || {};
  return MERIT_NAME.test(String(row?.name ?? product.name ?? ''))
    || IMIDACLOPRID.test(String(product.active_ingredient ?? ''));
}

const TRISTAR_NAME = /\btristar\b/i;
const ACETAMIPRID = /acetamiprid/i;

// TriStar by name, or any acetamiprid product by its active ingredient.
export function isTristarProduct(row) {
  const product = row?.product || {};
  return TRISTAR_NAME.test(String(row?.name ?? product.name ?? ''))
    || ACETAMIPRID.test(String(product.active_ingredient ?? ''));
}

export function liveFindsOnlyLabel(row) {
  const name = String(row?.name ?? row?.product?.name ?? '');
  const hit = LIVE_FINDS_ONLY.find((entry) => entry.pattern.test(name));
  return hit ? hit.label : '';
}

// Armored scale picked: which active Merit and TriStar rows hold Complete, and
// which only get a note. Soft scale or whitefly beside armored scale: Merit can
// be right for those. TriStar (owner 2026-10-09) also covers mealybug and
// aphid, which the tech records as Other.
function armoredScaleRule(types, active) {
  const meritRows = active.filter(isMeritProduct);
  const tristarRows = active.filter(isTristarProduct);
  const softTarget = types.has('soft_scale') || types.has('whitefly');
  const meritBlocked = meritRows.length > 0 && !softTarget;
  const tristarBlocked = tristarRows.length > 0 && !softTarget && !types.has('other');
  const noteMessages = [];
  if (meritRows.length && !meritBlocked) noteMessages.push(MERIT_BLOCK_MESSAGE);
  if (tristarRows.length && !tristarBlocked) noteMessages.push(TRISTAR_BLOCK_MESSAGE);
  const blocked = [meritBlocked && 'Merit', tristarBlocked && 'TriStar'].filter(Boolean);
  const messages = { Merit: MERIT_BLOCK_MESSAGE, TriStar: TRISTAR_BLOCK_MESSAGE };
  return {
    blockMessage: blocked.length === 2 ? MERIT_TRISTAR_BLOCK_MESSAGE : (messages[blocked[0]] || ''),
    noteMessages,
    blockedRows: [...(meritBlocked ? meritRows : []), ...(tristarBlocked ? tristarRows : [])],
    blockedLabel: blocked.join(' and '),
  };
}

function liveFindNotes(active) {
  const notes = [];
  const seen = new Set();
  for (const row of active) {
    const label = liveFindsOnlyLabel(row);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    notes.push(`No live insects recorded. ${label} is for live finds only.`);
  }
  return notes;
}

// answer: { found: true | false | null, types: string[] }; rows: the sheet's
// product rows (only the active ones count).
export function evaluatePestCheck(answer, rows) {
  const out = { blockMessage: '', noteMessages: [], blockedRows: [], blockedLabel: '' };
  const active = (rows || []).filter((row) => row?.active);
  if (answer?.found === true) {
    const types = new Set(answer.types || []);
    return types.has('armored_scale') ? armoredScaleRule(types, active) : out;
  }
  if (answer?.found === false) out.noteMessages = liveFindNotes(active);
  return out;
}

// The completion body's answer, or null while unanswered. A No carries no types.
export function pestCheckPayload(answer) {
  if (answer?.found === true) {
    const picked = new Set(answer.types || []);
    return { liveInsectsFound: true, insectTypes: INSECT_TYPES.map((type) => type.key).filter((key) => picked.has(key)) };
  }
  if (answer?.found === false) return { liveInsectsFound: false, insectTypes: [] };
  return null;
}

// Adds the answer to a built completion body as treeShrubReview.pestCheck,
// beside whatever the review already carries. No answer = body unchanged.
export function withPestCheck(body, payload) {
  if (!payload) return body;
  return { ...body, treeShrubReview: { ...(body.treeShrubReview || {}), pestCheck: payload } };
}
