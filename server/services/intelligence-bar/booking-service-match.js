// Close-name resolution of a service for create_appointment.
//
// The owner dictates a service the way he says it ("a pre-slab termite
// treatment"), not as the catalog spells it ("Slab Pre-Treat Termite
// Service"). The exact-name resolver in tools.js (resolveBookingCatalogRow)
// stays the first and only authority for an exact name; this module is its
// fallback, asked ONLY when the exact resolver found nothing. It never
// guesses between services: one clear winner resolves, anything else comes
// back as a short list the bar can ask the owner to choose from.
//
// Scoring reuses the sound-alike / close-spelling ranker the customer name
// search already uses (name-match.js rankNameMatches). Pure: no I/O.

const { rankNameMatches, tokenize, wordSimilarity, phoneticKey } = require('./name-match');

// A candidate must clear the ranker's own bar (every dictated word has to
// match a word of the name) and the winner must lead the runner-up by this
// much, or the call is ambiguous and returns the choices instead.
const MIN_SCORE = 0.75;
const WINNER_MARGIN = 0.05;
const MAX_CANDIDATES = 5;
// A short phrase must name the WHOLE service ("Pest Control" must not price
// one of the several "... Pest Control Service" rows); a phrase of this many
// words may leave out the generic words of the name ("pre-slab termite
// treatment" for "Slab Pre-Treat Termite Service").
const MIN_WORDS_PARTIAL = 3;
const GENERIC_NAME_WORDS = new Set(['service', 'services']);

// "a pre-slab termite treatment" -> "pre-slab termite treatment": a leading
// article is no part of a service name, and the ranker has no stopword for it.
function stripLeadingArticle(text) {
  return String(text || '').trim().replace(/^(?:a|an|the)\s+/i, '');
}

// One ranker candidate per name a row answers to (its name and its short
// name); the row id rides in the candidate id so scores fold back to rows.
function nameCandidates(services) {
  const candidates = [];
  for (const row of services) {
    if (row.name) candidates.push({ id: `${row.id}|name`, company_name: row.name });
    if (row.short_name) candidates.push({ id: `${row.id}|short`, company_name: row.short_name });
  }
  return candidates;
}

// True when every distinguishing word of one name has a counterpart among the
// dictated words.
function coversName(searchTokens, name) {
  const nameTokens = tokenize(name).filter((t) => !GENERIC_NAME_WORDS.has(t));
  return nameTokens.every((t) => searchTokens.some((w) => wordSimilarity(w, t, phoneticKey) >= MIN_SCORE));
}

function rowQualifies(row, searchTokens) {
  if (searchTokens.length >= MIN_WORDS_PARTIAL) return true;
  return [row.name, row.short_name].filter(Boolean).some((name) => coversName(searchTokens, name));
}

// Best score per catalog row, best first.
function scoreRows(services, search) {
  const ranked = rankNameMatches(search, nameCandidates(services), { minScore: MIN_SCORE, limit: services.length * 2 || 1 });
  const bestByRow = new Map();
  for (const { id, score } of ranked) {
    const rowId = String(id).split('|')[0];
    if (!bestByRow.has(rowId) || bestByRow.get(rowId) < score) bestByRow.set(rowId, score);
  }
  return [...bestByRow.entries()]
    .map(([rowId, score]) => ({ row: services.find((s) => String(s.id) === rowId), score }))
    .filter((hit) => hit.row)
    .sort((a, b) => b.score - a.score);
}

// Returns { row } for one clear match, { candidates: [row, ...] } when
// several services are close, or { row: null } when none is.
function resolveCloseCatalogService(services, serviceType) {
  const search = stripLeadingArticle(serviceType);
  if (!search || !Array.isArray(services) || !services.length) return { row: null };
  const searchTokens = tokenize(search);
  const hits = scoreRows(services, search).filter((hit) => rowQualifies(hit.row, searchTokens));
  if (!hits.length) return { row: null };
  if (hits.length === 1 || hits[0].score - hits[1].score >= WINNER_MARGIN) return { row: hits[0].row };
  return { candidates: hits.slice(0, MAX_CANDIDATES).map((hit) => hit.row) };
}

module.exports = { resolveCloseCatalogService, stripLeadingArticle, MIN_SCORE, WINNER_MARGIN, MAX_CANDIDATES, MIN_WORDS_PARTIAL };
