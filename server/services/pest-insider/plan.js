/**
 * Pest Insider issue plan: which fact leads, which identifier species fills
 * "What's this?" and which tool fills "A tool we'd use". Pure and
 * deterministic: the same inputs give the same plan (no clock, no
 * randomness), so tests and sample runs are repeatable.
 */
'use strict';

const crypto = require('crypto');
const { listEntries, isApproved } = require('../species-catalog');
const { factsForSend, factById, sendDateET } = require('./facts');
const { loadTools } = require('./tools');

/** How many past issues count as "recent": the caller passes the last six. */
const RECENT_WINDOW = 6;
/** A tool skips only the last two issues' tools: there are five tools, so six would leave none. */
const TOOL_RECENT_WINDOW = 2;

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

// Lead fact: only a fact whose blog post is live this send can lead (the
// issue links it). Then the previous issue's service is skipped when another
// fits, the best tier (pest kind, seasonal, high confidence) wins, and the
// send date picks inside that tier, so equal facts rotate instead of the same
// id always winning. A fact whose post is down drops out, and the next fact
// leads in its place.
function pickLeadFact(dateET, recentFactIds, recheckedFactIds, livePostFactIds) {
  const fitting = factsForSend(dateET, { excludeIds: recentFactIds, recheckedIds: recheckedFactIds });
  const candidates = fitting.filter((f) => livePostFactIds.includes(f.id));
  if (!candidates.length) return { fact: null, reason: fitting.length ? 'no_live_post_for_month' : 'no_fact_for_month' };
  const previous = recentFactIds.length ? factById(recentFactIds[recentFactIds.length - 1]) : null;
  const fresh = previous ? candidates.filter((f) => f.service !== previous.service) : candidates;
  const pool = fresh.length ? fresh : candidates;
  let best = tier(pool[0]);
  for (const f of pool) if (tierBefore(tier(f), best)) best = tier(f);
  const top = pool.filter((f) => sameTier(tier(f), best));
  return { fact: top[pickIndex(`${dateET}:lead`, top.length)], reason: null };
}

// "A tool we'd use": only a tool that is usable in the registry now and
// whose link, as it is now, passed this send's live check (the check reads a
// page, so its proof is the link, not the product: pre-push PR 3 r4), and
// not one of the last two issues' tools. A tool for the lead fact's service
// comes first, then any such tool; the send date picks inside that pool.
// None: the issue has no tool item (it still builds).
function pickTool({ dateET, fact, recentToolIds, liveToolUrls }) {
  const used = new Set(recentToolIds.slice(-TOOL_RECENT_WINDOW));
  const live = loadTools().tools.filter((t) => liveToolUrls.includes(t.url) && !used.has(t.productId));
  const forService = live.filter((t) => t.services.includes(fact.service));
  const pool = forService.length ? forService : live;
  return pool.length ? pool[pickIndex(`${dateET}:${fact.id}:tool`, pool.length)] : null;
}

/**
 * @param {{ sendDate: string|Date, livePostFactIds: string[], recentFactIds?: string[],
 *   recentSpeciesSlugs?: string[], recheckedFactIds?: string[], liveToolUrls?: string[],
 *   recentToolIds?: (string|null)[] }} input
 *   livePostFactIds names the facts whose blog post answered as live for
 *   this send (posts.checkLivePosts); no other fact can lead. It is
 *   required: a plan with no post check would lead with an unlinked fact.
 *   recent* lists hold the last six issues' picks (RECENT_WINDOW), oldest
 *   first; every id in them is excluded, so a fact or species used there
 *   never repeats, and the last fact id names the previous issue's service.
 *   recheckedFactIds names the recheck_before_send facts a person re-read
 *   for this send; any other flagged fact is never picked.
 *   liveToolUrls names the tool links whose product page passed this send's
 *   live check; a tool counts only while its link is one of them, and with
 *   none the issue has no tool item. recentToolIds holds one entry for each
 *   past issue, oldest first: its tool's product id, or null when it had no
 *   tool. The last two issues' tools are skipped.
 * @returns {{ leadFact: object|null, idItem: object|null, tool?: object|null, reason?: string }}
 */
function planIssue({ sendDate, livePostFactIds, recentFactIds = [], recentSpeciesSlugs = [], recheckedFactIds = [], liveToolUrls = [], recentToolIds = [] }) {
  if (!Array.isArray(livePostFactIds)) throw new Error('pest-insider plan: livePostFactIds must list the facts whose post is live');
  if (!Array.isArray(liveToolUrls) || !Array.isArray(recentToolIds)) throw new Error('pest-insider plan: liveToolUrls and recentToolIds must be lists');
  const dateET = sendDateET(sendDate);
  const { fact: leadFact, reason } = pickLeadFact(dateET, recentFactIds, recheckedFactIds, livePostFactIds);
  if (!leadFact) return { leadFact: null, idItem: null, reason };
  const idItem = pickSpecies({ dateET, fact: leadFact, recentSpeciesSlugs });
  if (!idItem) return { leadFact, idItem: null, reason: 'no_species' };
  return { leadFact, idItem, tool: pickTool({ dateET, fact: leadFact, recentToolIds, liveToolUrls }) };
}

module.exports = { planIssue, identifierSpecies, SPECIES, RECENT_WINDOW, TOOL_RECENT_WINDOW, CATEGORY_SERVICES, SEASONAL_MAX_MONTHS };
