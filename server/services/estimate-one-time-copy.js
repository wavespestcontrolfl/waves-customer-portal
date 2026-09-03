'use strict';

// ============================================================
// estimate-one-time-copy.js — customer-facing copy for ONE-TIME services
// on the estimate page (owner directive 2026-09-03: a one-time row must
// read like the recurring plan cards — what the visit involves, what the
// customer gets back, and the terms — not one sentence).
//
// One pack (estimate-one-time-copy.json), resolved SERVER-SIDE only. The
// server-rendered page reads it directly; the React page receives the
// resolved copy on the /data contract (`item.copy` per breakdown row and
// `pricing.oneTimeServiceCopy` for the Waves AI card + Ask Waves chips), so
// the two paths cannot drift. Every bullet is grounded in the matching
// wavespestcontrol.com service page or the tech protocol
// (server/config/protocols.json); guarantee terms per owner ruling
// 2026-09-03: roach cleanout + flea = 100% Waves Guarantee, one-time pest =
// 30-day callback, termite/WDO carry no guarantee line (waves-content
// termite ruling), bed bug = the website's written 30-day guarantee.
//
// A row that resolves to no key renders exactly as before (fail-safe: no
// pack entry means no new claims). Pre-slab and Bora-Care keep their
// existing dedicated copy in estimate-public.js and are deliberately absent.
// ============================================================

const PACK = require('./estimate-one-time-copy.json');

function searchText(item = {}) {
  return [item.service, item.offerKey, item.label, item.name, item.displayName, item.detail, item.det]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
}

// Copy key for a one-time breakdown row, or null. Service keys are the
// pricer's (server/services/pricing-engine/service-pricing.js); name
// matching is the fallback for legacy rows that carry no service key. Order
// matters: the recurring plan's first-visit roach knockdown
// (pest_initial_roach) is NOT the standalone cleanout, and a trap-only
// retainer is not interior trapping.
function oneTimeCopyKeyFor(item = {}) {
  if (!item || typeof item !== 'object') return null;
  if (item.kind === 'discount' || item.kind === 'included' || item.quoteRequired === true || item.kind === 'quote_required') return null;
  const service = String(item.service || '').toLowerCase();
  const text = searchText(item);
  if (service === 'pest_initial_roach' || service === 'german_roach_initial') return null;
  const nameText = [item.name, item.label, item.displayName].filter(Boolean).join(' ').toLowerCase();
  if (service === 'german_roach' || (nameText.includes('roach') && nameText.includes('cleanout'))) return 'german_roach';
  if (service.startsWith('flea') || /\bflea/.test(text)) return 'flea';
  if (service.startsWith('bed_bug') || /\bbed bugs?\b/.test(text)) return 'bed_bug';
  if (service === 'wasp' || service === 'stinging_insect' || /\bwasps?\b|\bhornets?\b|yellow ?jackets?|stinging insect/.test(text)) return 'wasp';
  if (service.startsWith('trap_only') || /\btrap only\b/.test(text)) return 'trap_only';
  if (service.startsWith('rodent_trapping') || /\btrapping\b/.test(text)) return 'rodent_trapping';
  if (['rodent_exclusion', 'exclusion', 'rodent_plugging', 'rodent_wire_mesh'].includes(service)
    || /\bexclusion\b|entry point plugging|wire mesh/.test(text)) return 'rodent_exclusion';
  if (service === 'termite_foam' || service === 'foam_drill' || (/\bfoam\b/.test(text) && /termite|termidor/.test(text))) return 'termite_foam';
  if (service === 'trenching' || service.includes('termite_trench') || /\btrench/.test(text)) return 'termite_trenching';
  if (service === 'wdo' || service === 'wdo_inspection' || /\bwdo\b|wood destroying/.test(text)) return 'wdo_inspection';
  if (['one_time_pest', 'pest_initial_cleanout', 'initial_pest_cleanout', 'pest_cleanout'].includes(service)
    || /one ?time pest|initial pest cleanout|general pest cleanout/.test(text)) return 'one_time_pest';
  if (service === 'one_time_mosquito' || /one ?time mosquito/.test(text)) return 'one_time_mosquito';
  if (service === 'one_time_lawn' || /one ?time lawn/.test(text)) return 'one_time_lawn';
  return null;
}

function visitWord(n) {
  const words = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four' };
  return words[n] || String(n);
}

function fillVisits(str, visits) {
  if (!str) return str;
  const n = Number(visits) || 0;
  return String(str)
    .replace(/\{Visits\}/g, n > 0 ? visitWord(n) : 'Multiple')
    .replace(/\{visits\}/g, n > 0 ? `${visitWord(n).toLowerCase()} visits` : 'multiple visits');
}

function bedBugMethod(item = {}) {
  const text = searchText(item);
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\bheat\b/.test(text)) return 'heat';
  if (/\bchemical\b|\bliquid\b/.test(text)) return 'chemical';
  return 'default';
}

// Resolved row copy for a one-time breakdown row:
//   { key, outcome, includes: [...], assurance|null, terms }
// `includes` carries the assurance as its last bullet when present, so the
// renderers list it exactly like the recurring card's guarantee bullet.
function resolveOneTimeServiceCopy(item = {}) {
  const key = oneTimeCopyKeyFor(item);
  if (!key) return null;
  const entry = PACK[key];
  if (!entry) return null;
  const visits = Number(item.visits) || (key === 'flea' && String(item.offerKey || '').includes('two_visit') ? 2 : 0);
  const includes = [...(entry.includes || [])];
  if (entry.includesByVisits) {
    const variant = entry.includesByVisits[String(visits)] || entry.includesByVisits.default || [];
    includes.push(...variant);
  }
  if (entry.includesByMethod) {
    const variant = entry.includesByMethod[bedBugMethod(item)] || entry.includesByMethod.default || [];
    // Method bullet leads the list (it is the treatment itself).
    includes.unshift(...variant);
  }
  const assurance = entry.assurance || null;
  return {
    key,
    outcome: fillVisits(entry.outcome, visits),
    includes: includes.map((line) => fillVisits(line, visits)).concat(assurance ? [assurance] : []),
    assurance,
    terms: entry.terms || null,
  };
}

// Page-level Waves AI card + Ask Waves chips for a ONE-TIME-ONLY estimate:
// the billable rows must all resolve to ONE key that carries AI copy
// (mixed one-time quotes keep the category-derived copy). Returns
//   { key, aiTitle, aiBody, askChips } or null.
function oneTimeOnlyIntelligenceCopy(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item
    && item.kind !== 'discount' && item.kind !== 'included'
    && item.quoteRequired !== true && item.kind !== 'quote_required');
  if (!rows.length) return null;
  const keys = new Set(rows.map(oneTimeCopyKeyFor));
  if (keys.size !== 1) return null;
  const [key] = [...keys];
  const entry = key ? PACK[key] : null;
  if (!entry || !entry.aiTitle) return null;
  return {
    key,
    aiTitle: entry.aiTitle,
    aiBody: entry.aiBody,
    askChips: Array.isArray(entry.askChips) ? [...entry.askChips] : [],
  };
}

module.exports = {
  ONE_TIME_SERVICE_COPY: PACK,
  oneTimeCopyKeyFor,
  resolveOneTimeServiceCopy,
  oneTimeOnlyIntelligenceCopy,
};
