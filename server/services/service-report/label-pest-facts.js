/**
 * Label pest facts for the pest report writer (owner 2026-10-24, "labels go":
 * "one reviewed line per product: what its label says it kills. The writer
 * uses it only for a pest you name in the note"). Dark behind
 * GATE_PEST_LABEL_FACTS.
 *
 * Each reviewed product in config/report-product-copy.js may carry
 * `labelPests`: the pests its current EPA label names, as the fixed terms
 * below. The writer gets a pest only when the technician named it today (the
 * note, an observation, or a pest tagged on a product row) AND the product's
 * label names it. A species the label names is said as the species ("German
 * cockroaches"); a species the label covers only as a group is said as the
 * group ("cockroaches"). Never a list of other label pests and never a count:
 * the card keeps the count (owner 2026-09-29).
 *
 * Termites, mosquitoes, bed bugs, fleas, ticks and rodents never become a
 * fact: a label alone must not imply a termite, mosquito or other specialty
 * service (the writer rules' own line on product labels).
 */

const { PEST_TARGET_SUGGESTIONS } = require('../../config/treatment-target-vocabulary');

function normalized(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The groups a note can name and a label can list. `words` are the singular
// and plural forms read in free text.
const PEST_GROUPS = Object.freeze([
  { term: 'ants', words: ['ant', 'ants'] },
  { term: 'cockroaches', words: ['cockroach', 'cockroaches', 'roach', 'roaches'] },
  { term: 'spiders', words: ['spider', 'spiders'] },
  { term: 'wasps', words: ['wasp', 'wasps', 'mud dauber', 'mud daubers', 'yellowjacket', 'yellowjackets', 'yellow jacket', 'yellow jackets', 'hornet', 'hornets'] },
  { term: 'silverfish', words: ['silverfish'] },
  { term: 'earwigs', words: ['earwig', 'earwigs'] },
  { term: 'crickets', words: ['cricket', 'crickets'] },
  { term: 'millipedes', words: ['millipede', 'millipedes'] },
  { term: 'centipedes', words: ['centipede', 'centipedes'] },
  { term: 'scorpions', words: ['scorpion', 'scorpions'] },
  { term: 'springtails', words: ['springtail', 'springtails'] },
  { term: 'booklice', words: ['booklouse', 'booklice', 'psocid', 'psocids'] },
  { term: 'flies', words: ['fly', 'flies'] },
]);
const GROUP_TERMS = new Set(PEST_GROUPS.map((group) => group.term));

// A label never earns one of these, whatever the note says.
const EXCLUDED = /termite|mosquito|bed ?bug|flea|tick|\brat\b|\brats\b|mice|mouse|rodent/i;

function groupOfSpecies(species) {
  const text = normalized(species);
  if (/\bants?\b/.test(text)) return 'ants';
  if (/cockroach/.test(text)) return 'cockroaches';
  if (/spider/.test(text)) return 'spiders';
  if (/wasp|dauber|yellowjacket/.test(text)) return 'wasps';
  if (/\bflies\b/.test(text)) return 'flies';
  return null;
}

// The vocabulary's species that belong to a group ("German cockroaches"), with
// the singular a note may use ("German cockroach").
const SPECIES = Object.freeze(PEST_TARGET_SUGGESTIONS
  .filter((term) => groupOfSpecies(term) && !GROUP_TERMS.has(normalized(term)) && !EXCLUDED.test(term))
  .map((term) => {
    const key = normalized(term);
    const singular = key.replace(/cockroaches$/, 'cockroach').replace(/ies$/, 'y').replace(/s$/, '');
    return { term, key, group: groupOfSpecies(term), forms: [...new Set([key, singular])] };
  }));

function hasPhrase(text, phrase) {
  return new RegExp(`(?:^| )${phrase.replace(/ /g, ' ')}(?: |$)`).test(text);
}

// The pests the technician named today, as fixed terms: species first, then
// groups. `texts` is the note and the observations; `targets` the pests
// tagged on the visit's product rows. A group counts only where its own word
// stands apart: the "ants" in "Pharaoh ants" belongs to the species.
function pestsNamedToday({ texts = [], targets = [] } = {}) {
  let text = ` ${[...texts, ...targets].map(normalized).filter(Boolean).join(' . ')} `;
  const found = SPECIES.filter((entry) => entry.forms.some((form) => hasPhrase(text, form)));
  for (const entry of found) {
    for (const form of [...entry.forms].sort((x, y) => y.length - x.length)) {
      text = text.replace(new RegExp(`(^| )${form}(?= |$)`, 'g'), '$1.');
    }
  }
  const groups = PEST_GROUPS.filter((group) => group.words.some((word) => hasPhrase(text, word))).map((group) => group.term);
  return { species: found.map((entry) => entry.term), groups };
}

// What one product's label lets the writer say for the pests named today:
// species first, in the vocabulary's order, then groups. `labelPests` holds
// the label's species and group terms (report-product-copy.js); a group is
// there only when the label names the group itself, not a closed list of its
// members. `except` holds species the label leaves out by name ("Ants
// (excluding Pharaoh)"): they never fall back to their group.
function labelFactPests(labelPests, named, except = []) {
  const label = new Set((Array.isArray(labelPests) ? labelPests : []).map(normalized));
  if (!label.size || !named) return [];
  const excepted = new Set((Array.isArray(except) ? except : []).map(normalized));
  const out = [];
  const add = (term) => { if (!EXCLUDED.test(term) && !out.includes(term)) out.push(term); };
  for (const term of named.species || []) {
    const entry = SPECIES.find((candidate) => candidate.term === term);
    if (!entry || excepted.has(entry.key)) continue;
    if (label.has(entry.key)) add(entry.term);
    else if (label.has(entry.group)) add(entry.group);
  }
  for (const group of named.groups || []) {
    // A group named in the note is said only when the label lists the group
    // itself: a label that names only German cockroaches is not "labeled for
    // cockroaches".
    if (label.has(group) && !out.some((term) => term === group || groupOfSpecies(term) === group)) add(group);
  }
  return out;
}

// "German cockroaches" keeps its capital; "Ghost ants" reads "ghost ants".
const PROPER_FIRST_WORDS = new Set(['german', 'american', 'australian', 'florida', 'argentine', 'pharaoh']);
function displayTerm(term) {
  const text = String(term || '');
  const first = normalized(text).split(' ')[0];
  return PROPER_FIRST_WORDS.has(first) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function joinTerms(terms) {
  if (terms.length <= 1) return terms[0] || '';
  return `${terms.slice(0, -1).join(', ')} and ${terms.at(-1)}`;
}

module.exports = {
  PEST_GROUPS,
  SPECIES,
  pestsNamedToday,
  labelFactPests,
  displayTerm,
  joinTerms,
};
