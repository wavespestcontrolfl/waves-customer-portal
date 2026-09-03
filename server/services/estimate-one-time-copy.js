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
// existing dedicated hero/legacy-note copy in estimate-public.js; their
// packs here add the row bullets only.
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
  stinging_insect_v2: 'wasp',
  // Only the retainer row carries the monitoring-plan pack — the setup fee
  // and extra-callback component rows stay bare (codex #3823 r1 P2).
  trap_only_retainer: 'trap_only',
  rodent_trapping: 'rodent_trapping',
  rodent_trapping_followup: 'rodent_trapping',
  rodent_exclusion: 'rodent_exclusion',
  exclusion: 'rodent_exclusion',
  // rodent_plugging / rodent_wire_mesh price a component (N entry points,
  // measured linear feet) — never the whole-home exclusion pack (codex
  // #3823 r1 P1); they stay unresolved until they get their own copy.
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
  rodent_inspection: 'rodent_inspection',
  rodent_sanitation: 'rodent_sanitation',
  rodent_bait_setup: 'rodent_bait_setup',
  termite_bait: 'termite_bait',
  pre_slab_termiticide: 'pre_slab_termiticide',
  termite_slab_pretreat: 'pre_slab_termiticide',
  bora_care: 'bora_care',
  boracare: 'bora_care',
  plugging: 'plugging',
  dethatching: 'dethatching',
  top_dressing: 'top_dressing',
  palm_injection: 'palm_injection',
  tree_shrub: 'tree_shrub_one_time',
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
  // Sold-scope adjustments (codex #3823 r1): copy must never promise
  // scope or a guarantee the priced row does not carry.
  let outcome = entry.outcome;
  let assurance = entry.assurance || null;
  let terms = entry.terms || null;
  let lines = includes;
  if (key === 'flea') {
    const exteriorPriced = ['priced', 'requires_confirmation'].includes(String(item.exteriorStatus || ''));
    if (!exteriorPriced) {
      lines = lines.filter((line) => line !== entry.yardBullet);
      outcome = entry.outcomeInteriorOnly || outcome;
    }
    // Fail closed: the guarantee line rides ONLY a row that carries the
    // conditional-retreat warranty; a missing/unknown warrantyType (legacy
    // row) gets no promise (codex pre-push P1).
    if (String(item.warrantyType || '').toLowerCase() !== 'conditional_retreat') {
      assurance = null;
      if (String(item.warrantyType || '').toLowerCase() === 'none') terms = entry.termsNoWarranty || terms;
    }
  }
  // Bed bug: the guarantee line rides a priced (warranty-eligible) result
  // only — quote-required rows fail closed (owner ruling 2026-09-03).
  if (key === 'bed_bug' && item.warrantyEligible !== true) {
    assurance = null;
  }
  if (key === 'wasp' && item.nestRemovalSelected !== true) {
    lines = lines.map((line) => (line === entry.removalBullet ? entry.noRemovalBullet : line));
    outcome = entry.outcomeNoRemoval || outcome;
  }
  // Fail closed: the colony-transfer claim rides ONLY a row whose chemistry
  // is known to be non-repellent; missing chemistry gets the barrier wording.
  if (key === 'termite_trenching' && String(item.chemistryType || '') !== 'non_repellent') {
    outcome = entry.outcomeRepellent || outcome;
  }
  return {
    key,
    outcome: fillVisits(outcome, visits),
    includes: lines.map((line) => fillVisits(line, visits)).concat(assurance ? [assurance] : []),
    assurance,
    terms,
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
  // Raw (un-normalized) rows carry no `kind` — a member-discount row is a
  // negative price, and an adjustment row is never a service.
  const rows = (Array.isArray(items) ? items : []).filter((item) => item
    && item.kind !== 'discount' && item.kind !== 'included'
    && item.quoteRequired !== true && item.kind !== 'quote_required'
    && String(item.service || '').toLowerCase() !== 'one_time_adjustment'
    && !(Number(item.amount ?? item.price) < 0));
  if (!rows.length) return null;
  const keys = new Set(rows.map(oneTimeCopyKeyFor));
  if (keys.size !== 1) return null;
  const [key] = [...keys];
  const entry = key ? PACK[key] : null;
  if (!entry || !entry.hero) return null;
  const visits = Number(rows[0].visits) || (key === 'flea' && String(rows[0].offerKey || '').includes('two_visit') ? 2 : 0);
  const fleaInteriorOnly = key === 'flea'
    && !['priced', 'requires_confirmation'].includes(String(rows[0].exteriorStatus || ''));
  return {
    key,
    hero: {
      eyebrow: entry.hero.eyebrow,
      h1: fillVisits(entry.hero.h1, visits),
      sub: fillVisits(fleaInteriorOnly && entry.heroSubInteriorOnly ? entry.heroSubInteriorOnly : entry.hero.sub, visits),
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
