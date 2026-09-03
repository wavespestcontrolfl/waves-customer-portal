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

// Copy key for a one-time breakdown row, or null. The pricer's service key
// (server/services/pricing-engine/service-pricing.js) is AUTHORITATIVE:
// a recognized key maps directly, a key on the no-copy list returns null,
// and any other present key returns null too — label/detail text is only
// consulted for legacy rows that carry NO service key at all (a
// one_time_pest row whose detail mentions fleas must never inherit the
// flea package's scope or guarantee — codex pre-push P1).
const SERVICE_KEY_TO_COPY = {
  german_roach: 'german_roach',
  flea_package: 'flea',
  flea_knockdown_single: 'flea',
  bed_bug: 'bed_bug',
  bed_bug_chemical: 'bed_bug',
  bed_bug_heat: 'bed_bug',
  wasp: 'wasp',
  stinging_insect: 'wasp',
  trap_only_setup: 'trap_only',
  trap_only_retainer: 'trap_only',
  trap_only_extra_callback: 'trap_only',
  rodent_trapping: 'rodent_trapping',
  rodent_trapping_followup: 'rodent_trapping',
  rodent_exclusion: 'rodent_exclusion',
  exclusion: 'rodent_exclusion',
  rodent_plugging: 'rodent_exclusion',
  rodent_wire_mesh: 'rodent_exclusion',
  termite_foam: 'termite_foam',
  foam_drill: 'termite_foam',
  trenching: 'termite_trenching',
  termite_trenching: 'termite_trenching',
  one_time_pest: 'one_time_pest',
  pest_initial_cleanout: 'one_time_pest',
  initial_pest_cleanout: 'one_time_pest',
  pest_cleanout: 'one_time_pest',
  one_time_mosquito: 'one_time_mosquito',
  one_time_lawn: 'one_time_lawn',
};

// Label-only fallback for legacy rows with no service key. WDO is
// deliberately absent everywhere: a regulated FDACS certificate surface
// stays narrative-free (AGENTS.md), so it never resolves to a pack.
function copyKeyFromText(item = {}) {
  const nameText = [item.name, item.label, item.displayName].filter(Boolean).join(' ').toLowerCase();
  const text = searchText(item);
  if (nameText.includes('roach') && nameText.includes('cleanout')) return 'german_roach';
  if (/initial german roach|roach knockdown/.test(nameText)) return null;
  if (/\bflea/.test(nameText)) return 'flea';
  if (/\bbed bugs?\b/.test(nameText)) return 'bed_bug';
  if (/\bwasps?\b|\bhornets?\b|yellow ?jackets?|stinging insect/.test(nameText)) return 'wasp';
  if (/\btrap only\b/.test(text)) return 'trap_only';
  if (/\btrapping\b/.test(nameText)) return 'rodent_trapping';
  if (/\bexclusion\b|entry point plugging|wire mesh/.test(nameText)) return 'rodent_exclusion';
  if (/\bfoam\b/.test(nameText) && /termite|termidor/.test(text)) return 'termite_foam';
  if (/\btrench/.test(nameText)) return 'termite_trenching';
  if (/one ?time pest|initial pest cleanout|general pest cleanout/.test(nameText)) return 'one_time_pest';
  if (/one ?time mosquito/.test(nameText)) return 'one_time_mosquito';
  if (/one ?time lawn/.test(nameText)) return 'one_time_lawn';
  return null;
}

function oneTimeCopyKeyFor(item = {}) {
  if (!item || typeof item !== 'object') return null;
  if (item.kind === 'discount' || item.kind === 'included' || item.quoteRequired === true || item.kind === 'quote_required') return null;
  const service = String(item.service || '').toLowerCase().trim();
  if (service) return SERVICE_KEY_TO_COPY[service] || null;
  return copyKeyFromText(item);
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

// Page-level copy for a ONE-TIME-ONLY estimate — hero eyebrow/headline/
// subline, and (where the pack carries them) the Waves AI card + Ask Waves
// chips. The billable rows must all resolve to ONE key (mixed one-time
// quotes keep the category-derived copy). Returns
//   { key, hero: { eyebrow, h1, sub }, aiTitle?, aiBody?, askChips } or null.
// Hero strings keep {first}/{city} for the renderer; {Visits} is filled
// here from the row's visit count.
function oneTimeOnlyIntelligenceCopy(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item
    && item.kind !== 'discount' && item.kind !== 'included'
    && item.quoteRequired !== true && item.kind !== 'quote_required');
  if (!rows.length) return null;
  const keys = new Set(rows.map(oneTimeCopyKeyFor));
  if (keys.size !== 1) return null;
  const [key] = [...keys];
  const entry = key ? PACK[key] : null;
  if (!entry || !entry.hero) return null;
  const visits = Number(rows[0].visits) || (key === 'flea' && String(rows[0].offerKey || '').includes('two_visit') ? 2 : 0);
  return {
    key,
    hero: {
      eyebrow: entry.hero.eyebrow,
      h1: fillVisits(entry.hero.h1, visits),
      sub: fillVisits(entry.hero.sub, visits),
    },
    ...(entry.aiTitle ? { aiTitle: entry.aiTitle, aiBody: entry.aiBody } : {}),
    askChips: Array.isArray(entry.askChips) ? [...entry.askChips] : [],
  };
}

module.exports = {
  ONE_TIME_SERVICE_COPY: PACK,
  oneTimeCopyKeyFor,
  resolveOneTimeServiceCopy,
  oneTimeOnlyIntelligenceCopy,
};
