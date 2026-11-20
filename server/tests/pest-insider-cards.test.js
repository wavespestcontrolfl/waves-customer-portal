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
const A01 = { layout: 'number', tag: 'Ants', scheme: 'light', pieces: [{ before: 'UF/IFAS says white-footed ant colonies range from', big: '8,000 to 3 million ants' }] };
const L05 = { layout: 'number', tag: 'Lawn', scheme: 'gold', pieces: [{ before: 'Most St. Augustine should be cut at', big: '3.5 to 4 inches' }] };
const T03_PIECE = { before: "Florida's native subterranean termites swarm in winter and spring,", big: 'December through May' };
const refuse = (cards, message) => expect(() => validateCards({ cards })).toThrow(message);

describe('the reviewed card list', () => {
  test('every fact with a reviewed post has a card, so every issue shows one', () => {
    expect(Object.keys(POSTS).filter((id) => !cardFor(id))).toEqual([]);
    expect(cardFor('Z99')).toBeNull();
    expect(cardFor('__proto__')).toBeNull();
    expect(Object.isFrozen(CARDS) && Object.isFrozen(CARDS.A01) && Object.isFrozen(CARDS.A01.pieces[0])).toBe(true);
  });

  test("each card's words are its fact's title or one lead sentence, whole and copied exactly", () => {
    const flat = (t) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[.!?]$/, '').toLowerCase();
    for (const [id, card] of Object.entries(CARDS)) {
      const fact = factById(id);
      const reviewed = [fact.title, ...fact.lead.map((s) => (typeof s === 'string' ? s : s.text))].map(flat);
      for (const piece of card.pieces) expect({ id, whole: reviewed.includes(flat(pieceText(piece))) }).toEqual({ id, whole: true });
      expect(card.source).toBe(sourceLine(fact));
      expect(card.alt).toBe(card.pieces.map(pieceText).join(' / '));
    }
  });

  test('a card is drawn in a whole picture that ships with the portal; an older picture may stay for sent emails', async () => {
    const sharp = require('sharp');
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
      // the whole picture decodes: a file cut short by a failed write does not
      await expect(sharp(png).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    }
  });

  test('a change to any drawn word gives the card a new file name', () => {
    const base = validateCards({ cards: { A01 } }).A01;
    const changed = validateCards({ cards: { A01: { ...A01, pieces: [{ before: 'UF/IFAS says white-footed ant colonies range from 8,000 to', big: '3 million ants' }] } } }).A01;
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
    ['a piece cut inside a word', { A01: { ...A01, pieces: [{ big: 'illion ants' }] } }, /not copied exactly/],
    ['a piece that ends inside a word', { A01: { ...A01, pieces: [{ big: '8,000 to 3 mill' }] } }, /not copied exactly/],
    ['a piece cut after a decimal point', { L05: { ...L05, pieces: [{ big: '5 to 4 inches' }] } }, /not copied exactly/],
    ['a piece that ends before a decimal point', { L05: { ...L05, pieces: [{ before: 'Most St. Augustine should be cut at', big: '3' }] } }, /not copied exactly/],
    ['a piece cut inside grouped thousands', { A01: { ...A01, pieces: [{ big: '000 to 3 million ants' }] } }, /not copied exactly/],
    ['a piece that drops "never"', { D03: { layout: 'statement', tag: 'Rodents', scheme: 'navy', pieces: [{ big: 'Sweep rodent droppings' }] } }, /not copied exactly/],
    ['a piece that drops "most"', { L05: { ...L05, pieces: [{ before: 'St. Augustine should be cut at', big: '3.5 to 4 inches' }] } }, /not copied exactly/],
    ['a rule without its dates', { O02: { layout: 'statement', tag: 'Fertilizer', scheme: 'light', pieces: [{ before: 'Most of Sarasota County bans', big: 'nitrogen and phosphorus lawn fertilizer' }] } }, /not copied exactly/],
    ['a rule without its end date', { O04: { layout: 'number', tag: 'Watering', scheme: 'gold', pieces: [{ before: 'The Southwest Florida Water Management District limits lawn watering to', big: 'one day a week' }] } }, /not copied exactly/],
    ['a piece without its source ("UF/IFAS says")', { A01: { ...A01, pieces: [{ before: 'White-footed ant colonies range from', big: '8,000 to 3 million ants' }] } }, /not copied exactly/],
    ['a piece that stops inside its sentence', { L09: { layout: 'months', tag: 'Lawn', scheme: 'light', months: [11, 5], pieces: [{ before: 'Large patch is most likely to show up from', big: 'November through May' }] } }, /not copied exactly/],
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
    ['a months card with no months', { T03: { layout: 'months', tag: 'Termites', scheme: 'gold', pieces: [T03_PIECE] } }, /months: \[first, last\]/],
    ['a months card lighting other months', { T03: { layout: 'months', tag: 'Termites', scheme: 'gold', months: [1, 5], pieces: [T03_PIECE] } }, /name its first and last month/],
    ['months on a number card', { A01: { ...A01, months: [1, 2] } }, /only a months card/],
  ])('refuses %s', (_label, cards, message) => refuse(cards, message));

  test('mail apps on other origins may load the cards and top pictures: both static mounts answer them with CORP cross-origin', () => {
    const { pictureHeaders } = require('../services/pest-insider/picture-headers');
    const headersFor = (filePath) => { const headers = {}; pictureHeaders({ set: (k, v) => { headers[k] = v; } }, filePath); return headers; };
    const CORP = { 'Cross-Origin-Resource-Policy': 'cross-origin' };
    expect(headersFor('/app/client/dist/pest-insider/cards/a01-0123456789.png')).toEqual(CORP);
    expect(headersFor('/app/client/public/pest-insider/heroes/t03-0123456789.jpg')).toEqual(CORP);
    expect(headersFor('C:\\app\\client\\dist\\pest-insider\\cards\\a01-0123456789.png')).toEqual(CORP);
    // nothing else the static mounts serve changes
    for (const other of ['/app/client/dist/index.html', '/app/client/dist/assets/app.js', '/app/client/public/pest-insider/x.png',
      '/app/client/public/pest-insider/cards/notes.txt', '/app/client/public/brand/pest-insider/cards.png']) {
      expect({ other, headers: headersFor(other) }).toEqual({ other, headers: {} });
    }
    // both mounts that serve the folders call it, and no route or middleware of its own exists for them
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const local = src.slice(src.indexOf("app.use(express.static(path.join(__dirname, '..', 'client', 'public'), {"));
    expect(local.slice(0, local.indexOf('}));'))).toContain('setHeaders: pictureHeaders,');
    const built = src.slice(src.indexOf('app.use(express.static(clientBuild, {'));
    expect(built.slice(0, built.indexOf('}));'))).toContain('pictureHeaders(res, filePath);');
    expect(src).not.toMatch(/app\.(use|get)\(\s*\[?\s*'\/pest-insider/);
    expect(CARD_BASE_URL).toBe('https://portal.wavespestcontrol.com/pest-insider/cards/');
    expect(HERO_BASE_URL).toBe('https://portal.wavespestcontrol.com/pest-insider/heroes/');
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
