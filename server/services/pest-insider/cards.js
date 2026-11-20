/**
 * Pest Insider fact cards: one code-drawn picture per lead fact, with the
 * fact's number or key phrase in big type (owner 2026-11-19: "more pictures
 * ... draw attention, use text in some of them, or facts, numbers").
 *
 * Loaded from server/data/pest-insider-cards-v1.json. A card states nothing
 * new: its words are one whole clause of a reviewed sentence, copied exactly
 * (the fact's title or one of its lead sentences), cut into a small line
 * before, the big words, and a small line after. It may leave out a source's
 * name or a lead-in clause, never a word that turns it around or limits it
 * (isClauseOf). A "versus" card has two such
 * pieces. Besides those, a card shows only fixed parts: a topic tag from a
 * fixed list, the month strip's letters, the fact's source names (the same
 * line the email prints) and the "Waves Pest Insider" name. A "months" card
 * lights the months its big words name, and the check holds the two to each
 * other. Each card is drawn in one of three Waves color sets (SCHEMES; owner
 * 2026-11-19: "the graphics created should be waves brand/colors").
 *
 * The pictures are drawn on a Mac by ops/agents/pest-insider-cards.js and
 * ship with the portal (client/public/pest-insider/cards/). Each file name
 * carries a hash of everything drawn on it, so a card whose words change
 * gets a new file, and a test fails until it is drawn.
 */
'use strict';

const crypto = require('crypto');
const data = require('../../data/pest-insider-cards-v1.json');
const { factById, sourceLabel } = require('./facts');

/** Bump when the drawing changes: every card gets a new file name. */
const CARD_DESIGN = 2;
const CARD_WIDTH = 582;
const CARD_HEIGHT = 300;
const CARD_BASE_URL = 'https://portal.wavespestcontrol.com/pest-insider/cards/';
const CARD_DIR = 'client/public/pest-insider/cards';

const LAYOUTS = Object.freeze(['number', 'statement', 'months', 'versus']);

/**
 * The only colors a drawn Pest Insider picture uses (the cards here, the top
 * pictures in heroes.js): the Waves email's own newsletter tokens
 * (email-template.js: navy, gold, rule, and the waves-blue section header's
 * light blue and Waves Blue) and white. Owner 07-29: Waves Newsletter headers
 * in Waves blue and gold only.
 */
const WAVES_COLORS = Object.freeze({
  navy: '#04395E', gold: '#F4B014', wavesBlue: '#009CDE', lightBlue: '#E3F5FD', rule: '#D8E4EF', white: '#FFFFFF',
});
const C = WAVES_COLORS;
/**
 * The three card color sets. Every word passes 4.5:1 on its background (gold
 * on navy 6.3:1, white on navy 12:1, navy on gold 6.3:1, navy on light blue
 * 10.7:1). Waves Blue carries no words (white on it is 3.1:1): it is only the
 * wave band. `edge` is a thin line inside the card's border, so a navy card
 * keeps its shape on a dark-mode page.
 */
const SCHEMES = Object.freeze({
  navy: Object.freeze({ background: C.navy, big: C.gold, small: C.white, tag: C.gold, tagText: C.navy, wave: C.wavesBlue, edge: C.white }),
  gold: Object.freeze({ background: C.gold, big: C.navy, small: C.navy, tag: C.navy, tagText: C.white, wave: C.white, edge: C.navy }),
  light: Object.freeze({ background: C.lightBlue, big: C.navy, small: C.navy, tag: C.navy, tagText: C.white, wave: C.wavesBlue, edge: C.rule }),
});
const TAGS = Object.freeze(['Ants', 'Roaches', 'Rodents', 'Spiders', 'Wasps', 'Termites', 'Mosquitoes', 'Lawn', 'Watering', 'Fertilizer', 'Palms']);
const MONTH_WORDS = Object.freeze([
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'], ['may'], ['june', 'jun'],
  ['july', 'jul'], ['august', 'aug'], ['september', 'sept', 'sep'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec'],
]);

// Lowercase, straight quotes, one space: the form two texts are compared in.
const normalize = (text) => String(text)
  .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** A piece's words in reading order; a part that opens with a comma or stop joins with no space. */
function pieceText({ before = '', big = '', after = '' }) {
  return [before, big, after].map((p) => String(p).trim()).filter(Boolean)
    .reduce((text, part) => (/^[,.;:!?]/.test(part) ? `${text}${part}` : `${text} ${part}`));
}

/** "Source: UF/IFAS": the publishers of the fact's quotes, by the names its sentences use. */
function sourceLine(fact) {
  if (!fact) return '';
  const labels = [...new Set(fact.quote_sources.map((i) => sourceLabel(fact.sources[i])))];
  if (!labels.length) return '';
  const names = labels.length < 3 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `${labels.length > 1 ? 'Sources' : 'Source'}: ${names}`;
}

// The months a text names, in order (month words only, so "May" the month).
function monthsNamed(text) {
  const found = [];
  for (const word of normalize(text).split(/[^a-z]+/)) {
    const i = MONTH_WORDS.findIndex((names) => names.includes(word));
    if (i >= 0) found.push(i + 1);
  }
  return found;
}

// Where a piece may start: the sentence start, after clause punctuation
// (and a joining word: "so", "but"), or after a source's verb ("UF/IFAS
// says"). A full stop is not one: "St. Augustine" is one name.
const CLAUSE_START = /(?:^|[,;:–—]\s+(?:(?:so|and|but|yet|or|then|because|while)\s+)?|\b(?:says|said|adds|added|reports|reported|notes|noted|finds|found|saw|shows|showed)\s+(?:that\s+)?)$/;
// Where a piece may end: the sentence end or clause punctuation, never a
// mark inside a number ("3.5", "8,000") or a word ("can't").
const CLAUSE_END = /^(?:$|[.!?](?![a-z0-9])|[,;:)–—](?!\d))/;
// Words that turn a statement around or limit it.
const TURNS = /\b(?:never|not|no|nor|none|neither|nobody|nothing|nowhere|without|cannot|avoid\w*|stop\w*|if|unless|except|only|\w+n't)\b/;

// The piece is a whole clause of the sentence, so a card never says what
// the sentence did not: no cut inside a word or a number ("5 to 4 inches"
// never passes for "3.5 to 4 inches"), no clause cut short, and the words
// left out before it hold nothing that turns it around or limits it
// ("Sweep rodent droppings" never passes for "Never sweep rodent droppings").
function isClauseOf(sentence, piece) {
  for (let i = sentence.indexOf(piece); i >= 0; i = sentence.indexOf(piece, i + 1)) {
    const left = sentence.slice(0, i);
    if (CLAUSE_START.test(left) && !TURNS.test(left) && CLAUSE_END.test(sentence.slice(i + piece.length))) return true;
  }
  return false;
}

const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n<>]/.test(v);
const isOptional = (v, max) => v === undefined || v === '' || isText(v, max);

// The card's words: one piece (two on a versus card), each one whole clause
// of the fact's title or a lead sentence, copied exactly.
function piecesProblem(card, fact) {
  const pieces = Array.isArray(card.pieces) ? card.pieces : [];
  if (pieces.length !== (card.layout === 'versus' ? 2 : 1)) return 'a versus card has two pieces, every other card one';
  const reviewed = [fact.title, ...fact.lead.map((s) => (typeof s === 'string' ? s : s.text))].map(normalize);
  for (const piece of pieces) {
    if (!piece || !isText(piece.big, 40) || !isOptional(piece.before, 90) || !isOptional(piece.after, 90)) {
      return 'each piece needs big words (up to 40 characters) and optional before / after lines (up to 90)';
    }
    if (!reviewed.some((sentence) => isClauseOf(sentence, normalize(pieceText(piece))))) {
      return `"${pieceText(piece)}" is not copied exactly, as a whole clause, from the fact's title or a lead sentence`;
    }
  }
  return null;
}

// A months card lights the months its big words name; no other card has months.
function monthsProblem(card) {
  if (card.layout !== 'months') return card.months === undefined ? null : 'only a months card has months';
  const { months } = card;
  if (!Array.isArray(months) || months.length !== 2 || !months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) {
    return 'a months card needs months: [first, last], each 1 to 12';
  }
  const named = monthsNamed(card.pieces[0].big);
  if (named[0] !== months[0] || named[named.length - 1] !== months[1]) return 'its big words must name its first and last month';
  return null;
}

function cardProblem(id, card) {
  const fact = factById(id);
  if (!fact || fact.reserve) return 'is not a main fact in the fact bank';
  if (!card || typeof card !== 'object') return 'card is not an object';
  if (!LAYOUTS.includes(card.layout)) return `layout must be one of ${LAYOUTS.join(', ')}`;
  if (!TAGS.includes(card.tag)) return `tag must be one of ${TAGS.join(', ')}`;
  if (!Object.prototype.hasOwnProperty.call(SCHEMES, card.scheme)) return `scheme must be one of ${Object.keys(SCHEMES).join(', ')}`;
  return piecesProblem(card, fact) || monthsProblem(card);
}

// Everything drawn on the card, in a fixed order: the hash names the file.
function drawn(id, card) {
  return {
    design: CARD_DESIGN,
    layout: card.layout,
    tag: card.tag,
    scheme: card.scheme,
    months: card.layout === 'months' ? [...card.months] : null,
    pieces: card.pieces.map((p) => ({ before: (p.before || '').trim(), big: p.big.trim(), after: (p.after || '').trim() })),
    source: sourceLine(factById(id)),
  };
}

function validateCards(raw) {
  if (!raw || typeof raw.cards !== 'object' || raw.cards === null || Array.isArray(raw.cards)) {
    throw new Error('pest-insider cards: the file has no cards map');
  }
  const cards = {};
  for (const [id, card] of Object.entries(raw.cards)) {
    const problem = cardProblem(id, card);
    if (problem) throw new Error(`pest-insider cards: ${id}: ${problem}`);
    const shown = drawn(id, card);
    const hash = crypto.createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 10);
    const file = `${id.toLowerCase()}-${hash}.png`;
    cards[id] = Object.freeze({
      ...shown,
      months: shown.months && Object.freeze(shown.months),
      pieces: Object.freeze(shown.pieces.map((p) => Object.freeze(p))),
      file,
      url: `${CARD_BASE_URL}${file}`,
      // What the picture says, for its alt text.
      alt: shown.pieces.map(pieceText).join(' / '),
    });
  }
  return Object.freeze(cards);
}

/** Fact id -> its card: { layout, tag, scheme, months, pieces, source, file, url, alt }. Frozen. */
const CARDS = validateCards(data);

const cardFor = (factId) => (typeof factId === 'string' && Object.prototype.hasOwnProperty.call(CARDS, factId) ? CARDS[factId] : null);

module.exports = {
  CARDS, CARD_DESIGN, CARD_WIDTH, CARD_HEIGHT, CARD_BASE_URL, CARD_DIR, LAYOUTS, TAGS, WAVES_COLORS, SCHEMES,
  cardFor, validateCards, pieceText, sourceLine, monthsNamed,
};
