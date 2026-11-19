/**
 * Pest Insider issue plan: which fact leads and which identifier species
 * fills "What's this?". Pure and deterministic: the same inputs give the same
 * plan (no clock, no randomness), so tests and sample runs are repeatable.
 */
'use strict';

const crypto = require('crypto');
const { listEntries, isApproved } = require('../species-catalog');
const { factsForSend, factById, sendDateET } = require('./facts');

/** How many past issues count as "recent": the caller passes the last six. */
const RECENT_WINDOW = 6;

// "What's this?" species come from the portal's species catalog: each entry
// with a page in the website's pest identifier, while the owner's approval
// still matches it (isApproved: the approval hash covers every authored
// field). The issue prints the catalog's reviewed copy (copy.fact, with
// copy.blurb as its evidence), not the website's own identifier text, which
// states some facts more broadly ("the only spider that does this", "never
// lives outdoors"; pre-push round 12). Each entry is frozen, so no caller
// can change the copy a later build prints (pre-push round 13).
function identifierSpecies(entries) {
  const species = entries
    .filter((e) => e.links && e.links.site_page === `/pest-identifier/${e.slug}/` && isApproved(e))
    .map((e) => Object.freeze({ slug: e.slug, name: e.common_name, category: e.site_category, fact: e.copy && e.copy.fact, note: e.copy && e.copy.blurb }));
  if (!species.length) throw new Error('pest-insider species: the catalog has no approved identifier species');
  for (const s of species) {
    const missing = ['name', 'category', 'fact', 'note'].find((k) => typeof s[k] !== 'string' || !s[k].trim());
    if (missing) throw new Error(`pest-insider species: ${s.slug} lacks ${missing}`);
  }
  return Object.freeze(species);
}

const SPECIES = identifierSpecies(listEntries());

// Identifier category -> the bank services it relates to. A category absent
// here (wildlife) relates to nothing and is only used as the "any unused" fallback.
const CATEGORY_SERVICES = {
  Ants: ['pest'],
  Termites: ['termite'],
  Roaches: ['pest'],
  'Mosquitoes & biters': ['mosquito'],
  Lawn: ['lawn'],
  Spiders: ['pest'],
  Rodents: ['rodent'],
  Biting: ['pest'],
  Stingers: ['pest'],
  'Occasional invaders': ['pest'],
  'Plant pests': ['tree_shrub', 'lawn'],
};

const relatesTo = (species, service) => (CATEGORY_SERVICES[species.category] || []).includes(service);

// A species whose name words appear in the fact ("carpenter" and "ant" in a
// carpenter ant fact) is the species the lead is about.
function nameScore(species, fact) {
  const text = `${fact.title} ${fact.statement}`.toLowerCase();
  const words = species.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  return words.filter((w) => new RegExp(`\\b${w}(?:s|es)?\\b`).test(text)).length;
}

function pickIndex(seed, length) {
  const n = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  return n % length;
}

// "What's this?" is a second topic, not an echo of the lead: a species the
// lead fact names is never picked, and a category unrelated to the lead's
// service comes first so one issue covers two corners of the house and yard.
function pickSpecies({ dateET, fact, recentSpeciesSlugs }) {
  const used = new Set(recentSpeciesSlugs);
  const unused = SPECIES.filter((s) => !used.has(s.slug));
  const unnamed = unused.filter((s) => nameScore(s, fact) === 0);
  const otherCorner = unnamed.filter((s) => !relatesTo(s, fact.service));
  const pool = [otherCorner, unnamed, unused].find((p) => p.length) || [];
  if (!pool.length) return null;
  return pool[pickIndex(`${dateET}:${fact.id}`, pool.length)];
}

// Seasonal facts (6 months or fewer) are more timely than year-round ones.
const SEASONAL_MAX_MONTHS = 6;
const tier = (f) => [f.kind === 'pest' ? 0 : 1, f.months.length <= SEASONAL_MAX_MONTHS ? 0 : 1, f.confidence === 'high' ? 0 : 1];
const sameTier = (a, b) => a.every((v, i) => v === b[i]);
const tierBefore = (a, b) => { const i = a.findIndex((v, k) => v !== b[k]); return i >= 0 && a[i] < b[i]; };

// Lead fact: the previous issue's service is skipped when another fits, then
// the best tier (pest kind, seasonal, high confidence) wins, and the send
// date picks inside that tier, so equal facts rotate instead of the same id
// always winning.
function pickLeadFact(dateET, recentFactIds, recheckedFactIds) {
  const candidates = factsForSend(dateET, { excludeIds: recentFactIds, recheckedIds: recheckedFactIds });
  if (!candidates.length) return null;
  const previous = recentFactIds.length ? factById(recentFactIds[recentFactIds.length - 1]) : null;
  const fresh = previous ? candidates.filter((f) => f.service !== previous.service) : candidates;
  const pool = fresh.length ? fresh : candidates;
  let best = tier(pool[0]);
  for (const f of pool) if (tierBefore(tier(f), best)) best = tier(f);
  const top = pool.filter((f) => sameTier(tier(f), best));
  return top[pickIndex(`${dateET}:lead`, top.length)];
}

/**
 * @param {{ sendDate: string|Date, recentFactIds?: string[], recentSpeciesSlugs?: string[], recheckedFactIds?: string[] }} input
 *   recent* lists hold the last six issues' picks (RECENT_WINDOW), oldest
 *   first; every id in them is excluded, so a fact or species used there
 *   never repeats, and the last fact id names the previous issue's service.
 *   recheckedFactIds names the recheck_before_send facts a person re-read
 *   for this send; any other flagged fact is never picked.
 * @returns {{ leadFact: object|null, idItem: object|null, reason?: string }}
 */
function planIssue({ sendDate, recentFactIds = [], recentSpeciesSlugs = [], recheckedFactIds = [] }) {
  const dateET = sendDateET(sendDate);
  const leadFact = pickLeadFact(dateET, recentFactIds, recheckedFactIds);
  if (!leadFact) return { leadFact: null, idItem: null, reason: 'no_fact_for_month' };
  const idItem = pickSpecies({ dateET, fact: leadFact, recentSpeciesSlugs });
  if (!idItem) return { leadFact, idItem: null, reason: 'no_species' };
  return { leadFact, idItem };
}

module.exports = { planIssue, identifierSpecies, SPECIES, RECENT_WINDOW, CATEGORY_SERVICES, SEASONAL_MAX_MONTHS };
