// Pest Insider fact cards: every card's words are copied exactly from its
// fact, every lead fact has one, and its picture ships with the portal.
const fs = require('fs');
const path = require('path');
const {
  CARDS, CARD_DIR, CARD_BASE_URL, LAYOUTS, TAGS, WAVES_COLORS, SCHEMES, cardFor, validateCards, pieceText, sourceLine, monthsNamed,
} = require('../services/pest-insider/cards');
const { HERO_BASE_URL } = require('../services/pest-insider/heroes');
const { newsletterPalette } = require('../services/email-template');
const { FACTS, factById } = require('../services/pest-insider/facts');
const { POSTS } = require('../services/pest-insider/posts');

const MAIN = FACTS.filter((f) => !f.reserve);
const A01 = { layout: 'number', tag: 'Ants', scheme: 'light', pieces: [{ before: 'White-footed ant colonies range from', big: '8,000 to 3 million ants' }] };
const L05 = { layout: 'number', tag: 'Lawn', scheme: 'gold', pieces: [{ before: 'Most St. Augustine should be cut at', big: '3.5 to 4 inches' }] };
const refuse = (cards, message) => expect(() => validateCards({ cards })).toThrow(message);

describe('the reviewed card list', () => {
  test('every fact with a reviewed post has a card, so every issue shows one', () => {
    expect(Object.keys(POSTS).filter((id) => !cardFor(id))).toEqual([]);
    expect(cardFor('Z99')).toBeNull();
    expect(cardFor('__proto__')).toBeNull();
    expect(Object.isFrozen(CARDS) && Object.isFrozen(CARDS.A01) && Object.isFrozen(CARDS.A01.pieces[0])).toBe(true);
  });

  test("each card's words are one stretch of its fact's title or a lead sentence, copied exactly", () => {
    const flat = (t) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
    for (const [id, card] of Object.entries(CARDS)) {
      const fact = factById(id);
      const reviewed = [fact.title, ...fact.lead.map((s) => (typeof s === 'string' ? s : s.text))].map(flat);
      for (const piece of card.pieces) {
        const words = flat(pieceText(piece));
        const found = reviewed.some((s) => new RegExp(`(^|[^a-z0-9])${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(s));
        expect({ id, found }).toEqual({ id, found: true });
      }
      expect(card.source).toBe(sourceLine(fact));
      expect(card.alt).toBe(card.pieces.map(pieceText).join(' / '));
    }
  });

  test('a card is drawn in a picture that ships with the portal; an older picture may stay for sent emails', () => {
    const dir = path.join(__dirname, '../..', CARD_DIR);
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    expect(Object.values(CARDS).map((c) => c.file).filter((f) => !files.includes(f))).toEqual([]);
    // every file is a card picture by name (<fact>-<hash>.png); a retired fact's pictures may stay
    expect(files.filter((f) => !/^[a-z]\d\d-[0-9a-f]{10}\.png$/.test(f))).toEqual([]);
    for (const [id, card] of Object.entries(CARDS)) {
      expect(card.file).toMatch(new RegExp(`^${id.toLowerCase()}-[0-9a-f]{10}\\.png$`));
      expect(card.url).toBe(`${CARD_BASE_URL}${card.file}`);
      const png = fs.readFileSync(path.join(dir, card.file));
      // a PNG, 1164x600 (582x300 at 2x)
      expect(png.readUInt32BE(0)).toBe(0x89504e47);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1164, 600]);
    }
  });

  test('a change to any drawn word gives the card a new file name', () => {
    const base = validateCards({ cards: { A01 } }).A01;
    const changed = validateCards({ cards: { A01: { ...A01, pieces: [{ ...A01.pieces[0], before: 'colonies range from' }] } } }).A01;
    const retagged = validateCards({ cards: { A01: { ...A01, layout: 'statement' } } }).A01;
    const recolored = validateCards({ cards: { A01: { ...A01, scheme: 'navy' } } }).A01;
    expect(new Set([base.file, changed.file, retagged.file, recolored.file]).size).toBe(4);
    expect(base.file).toBe(CARDS.A01.file);
  });

  test('a months card lights the months its big words name', () => {
    expect(monthsNamed('December through May')).toEqual([12, 5]);
    expect(monthsNamed('April 1 through Sept. 30')).toEqual([4, 9]);
    expect(CARDS.T03.months).toEqual([12, 5]);
    for (const card of Object.values(CARDS).filter((c) => c.layout === 'months')) {
      const named = monthsNamed(card.pieces[0].big);
      expect([named[0], named[named.length - 1]]).toEqual(card.months);
    }
  });

  test.each([
    ['an unknown fact', { Z99: A01 }, /Z99: is not a main fact/],
    ['a reserve fact', { [FACTS.find((f) => f.reserve).id]: A01 }, /is not a main fact/],
    ['words not in the fact', { A01: { ...A01, pieces: [{ big: '5 million ants' }] } }, /not copied exactly/],
    ['words from another fact', { A01: { ...A01, pieces: [{ big: 'up to 8 months' }] } }, /not copied exactly/],
    ['words out of order', { A01: { ...A01, pieces: [{ before: 'range from white-footed ant colonies', big: '8,000' }] } }, /not copied exactly/],
    ['a piece that skips words', { A01: { ...A01, pieces: [{ before: 'White-footed ant colonies range', big: '3 million ants' }] } }, /not copied exactly/],
    ['a piece cut inside a word', { A01: { ...A01, pieces: [{ big: 'illion ants' }] } }, /as whole words/],
    ['a piece that ends inside a word', { A01: { ...A01, pieces: [{ big: '8,000 to 3 mill' }] } }, /as whole words/],
    ['a piece cut after a decimal point', { L05: { ...L05, pieces: [{ big: '5 to 4 inches' }] } }, /as whole words/],
    ['a piece that ends before a decimal point', { L05: { ...L05, pieces: [{ before: 'Most St. Augustine should be cut at', big: '3' }] } }, /as whole words/],
    ['a piece cut inside grouped thousands', { A01: { ...A01, pieces: [{ big: '000 to 3 million ants' }] } }, /as whole words/],
    ['no big words', { A01: { ...A01, pieces: [{ before: 'White-footed ant colonies range from' }] } }, /big words/],
    ['big words over 40 characters', { A01: { ...A01, pieces: [{ big: 'UF/IFAS says white-footed ant colonies range from 8,000 to 3 million ants' }] } }, /big words/],
    ['markup in the words', { A01: { ...A01, pieces: [{ big: '<b>8,000</b>' }] } }, /big words/],
    ['an unknown layout', { A01: { ...A01, layout: 'chart' } }, /layout must be/],
    ['an unknown tag', { A01: { ...A01, tag: 'Bugs' } }, /tag must be/],
    ['a color set that is not a Waves set', { A01: { ...A01, scheme: 'red' } }, /scheme must be one of navy, gold, light/],
    ['no color set', { A01: { ...A01, scheme: undefined } }, /scheme must be/],
    ['a prototype key as the color set', { A01: { ...A01, scheme: 'constructor' } }, /scheme must be/],
    ['a versus card with one piece', { A01: { ...A01, layout: 'versus' } }, /two pieces/],
    ['two pieces on a number card', { A01: { ...A01, pieces: [A01.pieces[0], A01.pieces[0]] } }, /two pieces/],
    ['a months card with no months', { T03: { layout: 'months', tag: 'Termites', scheme: 'gold', pieces: [{ big: 'December through May' }] } }, /months: \[first, last\]/],
    ['a months card lighting other months', { T03: { layout: 'months', tag: 'Termites', scheme: 'gold', months: [1, 5], pieces: [{ big: 'December through May' }] } }, /name its first and last month/],
    ['months on a number card', { A01: { ...A01, months: [1, 2] } }, /only a months card/],
  ])('refuses %s', (_label, cards, message) => refuse(cards, message));

  test('mail apps on other origins may load the cards and top pictures: the portal answers them with CORP cross-origin', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const at = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };
    const start = at("app.use(['/pest-insider/cards', '/pest-insider/heroes'], (req, res, next) => {");
    // after helmet sets same-origin, before both static mounts that serve the folder
    expect(start).toBeGreaterThan(at('return strictHelmet(req, res, next);'));
    expect(start).toBeLessThan(at("app.use(express.static(path.join(__dirname, '..', 'client', 'public'), {"));
    expect(start).toBeLessThan(at('app.use(express.static(clientBuild, {'));
    expect(CARD_BASE_URL).toBe('https://portal.wavespestcontrol.com/pest-insider/cards/');
    expect(HERO_BASE_URL).toBe('https://portal.wavespestcontrol.com/pest-insider/heroes/');
    // run the real statement against a fake app
    const statement = src.slice(start, src.indexOf('\n});\n', start) + 4);
    const mounts = [];
    new Function('app', statement)({ use: (mountPath, handler) => mounts.push({ mountPath, handler }) });
    expect(mounts.map((m) => m.mountPath)).toEqual([['/pest-insider/cards', '/pest-insider/heroes']]);
    const headers = {};
    const next = jest.fn();
    mounts[0].handler({}, { set: (k, v) => { headers[k] = v; } }, next);
    expect(headers).toEqual({ 'Cross-Origin-Resource-Policy': 'cross-origin' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('refuses a file with no cards map', () => {
    expect(() => validateCards({})).toThrow(/no cards map/);
    expect(() => validateCards({ cards: [] })).toThrow(/no cards map/);
  });

  test('the layouts and tags are fixed lists', () => {
    expect(LAYOUTS).toEqual(['number', 'statement', 'months', 'versus']);
    expect(Object.isFrozen(TAGS)).toBe(true);
    for (const card of Object.values(CARDS)) expect(TAGS).toContain(card.tag);
    expect(Object.keys(SCHEMES)).toEqual(['navy', 'gold', 'light']);
    // all three color sets are in use
    expect(new Set(Object.values(CARDS).map((c) => c.scheme))).toEqual(new Set(['navy', 'gold', 'light']));
    // every card belongs to a main fact
    Object.keys(CARDS).forEach((id) => expect(MAIN.map((f) => f.id)).toContain(id));
  });
});

// Owner 2026-11-19: "the graphics created should be waves brand/colors".
describe('Waves colors only', () => {
  const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  test("every color is one of the Waves email's own newsletter colors, or white", () => {
    const p = newsletterPalette();
    const brand = new Set([p.navy, p.gold, p.rule, p.sectionHeaders[0].background, p.sectionHeaders[0].accent, '#FFFFFF'].map((c) => c.toUpperCase()));
    expect(Object.values(WAVES_COLORS).filter((c) => !brand.has(c))).toEqual([]);
    for (const scheme of Object.values(SCHEMES)) expect(Object.values(scheme).filter((c) => !Object.values(WAVES_COLORS).includes(c))).toEqual([]);
  });

  test('every word passes 4.5:1 on its background; Waves Blue carries no words', () => {
    for (const s of Object.values(SCHEMES)) {
      expect(ratio(s.big, s.background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(s.small, s.background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(s.tagText, s.tag)).toBeGreaterThanOrEqual(4.5);
      expect([s.big, s.small, s.tag, s.tagText]).not.toContain(WAVES_COLORS.wavesBlue);
    }
    // the top picture: a gold title and a white kicker on navy, navy words on the gold tag
    expect(ratio(WAVES_COLORS.gold, WAVES_COLORS.navy)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(WAVES_COLORS.white, WAVES_COLORS.navy)).toBeGreaterThanOrEqual(4.5);
  });

  test('the drawing scripts write no color of their own: every color comes from WAVES_COLORS', () => {
    for (const file of ['ops/agents/pest-insider-cards.js', 'ops/agents/pest-insider-heroes.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
      expect({ file, colors: src.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]/gi) }).toEqual({ file, colors: null });
    }
  });
});
