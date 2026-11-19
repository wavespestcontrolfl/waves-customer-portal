/**
 * Pest Insider issue plan: which fact leads and which identifier species
 * fills "What's this?". Pure and deterministic: the same inputs give the same
 * plan (no clock, no randomness), so tests and sample runs are repeatable.
 */
'use strict';

const crypto = require('crypto');
const snapshot = require('../../data/pest-identifier-species-v1.json');
const { factsForSend, sendDateET } = require('./facts');

/** How many past issues count as "recent": the caller passes the last six. */
const RECENT_WINDOW = 6;

const VERDICTS = new Set(['ally', 'harmless', 'watch', 'call']);

function validateSpecies(data) {
  if (!data || !Array.isArray(data.species) || !data.species.length) throw new Error('pest-insider species: snapshot has no species');
  if (!data.source_file || !data.source_commit) throw new Error('pest-insider species: snapshot must name its astro source file and commit');
  const seen = new Set();
  for (const s of data.species) {
    const missing = ['slug', 'name', 'category', 'fact', 'verdict', 'note']
      .find((k) => typeof s[k] !== 'string' || !s[k].trim());
    if (missing) throw new Error(`pest-insider species: ${s && s.slug ? s.slug : 'entry'} lacks ${missing}`);
    if (!VERDICTS.has(s.verdict) || !Array.isArray(s.looks) || !Array.isArray(s.where)) throw new Error(`pest-insider species: ${s.slug} has a malformed field`);
    if (seen.has(s.slug)) throw new Error(`pest-insider species: duplicate slug ${s.slug}`);
    seen.add(s.slug);
  }
  return data.species;
}

const SPECIES = validateSpecies(snapshot);

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
// carpenter ant fact) is the closest match inside the related category: the
// pool is every species sharing the best score.
function nameScore(species, fact) {
  const text = `${fact.title} ${fact.statement}`.toLowerCase();
  const words = species.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  return words.filter((w) => new RegExp(`\\b${w}(?:s|es)?\\b`).test(text)).length;
}

function bestNamed(candidates, fact) {
  const scored = candidates.map((s) => ({ s, score: nameScore(s, fact) }));
  const top = Math.max(0, ...scored.map((x) => x.score));
  return top ? scored.filter((x) => x.score === top).map((x) => x.s) : [];
}

function pickIndex(seed, length) {
  const n = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  return n % length;
}

function pickSpecies({ dateET, fact, recentSpeciesSlugs }) {
  const used = new Set(recentSpeciesSlugs);
  const unused = SPECIES.filter((s) => !used.has(s.slug));
  const related = unused.filter((s) => relatesTo(s, fact.service));
  const named = bestNamed(related, fact);
  const pool = [named, related, unused].find((p) => p.length) || [];
  if (!pool.length) return null;
  return pool[pickIndex(`${dateET}:${fact.id}`, pool.length)];
}

/**
 * @param {{ sendDate: string|Date, recentFactIds?: string[], recentSpeciesSlugs?: string[] }} input
 *   recent* lists hold the last six issues' picks (RECENT_WINDOW); every id in
 *   them is excluded, so a fact or species used there never repeats.
 * @returns {{ leadFact: object|null, idItem: object|null, reason?: string }}
 */
function planIssue({ sendDate, recentFactIds = [], recentSpeciesSlugs = [] }) {
  const dateET = sendDateET(sendDate);
  const [leadFact] = factsForSend(dateET, { excludeIds: recentFactIds });
  if (!leadFact) return { leadFact: null, idItem: null, reason: 'no_fact_for_month' };
  const idItem = pickSpecies({ dateET, fact: leadFact, recentSpeciesSlugs });
  if (!idItem) return { leadFact, idItem: null, reason: 'no_species' };
  return { leadFact, idItem };
}

module.exports = { planIssue, SPECIES, RECENT_WINDOW, CATEGORY_SERVICES };
