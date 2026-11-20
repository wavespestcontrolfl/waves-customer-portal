// Pest Insider top pictures: one per lead fact, its words drawn by code from
// the fact's own title and card tag, its art checked in the repo, and its
// picture shipped with the portal.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HEROES, HERO_DESIGN, HERO_DIR, HERO_BASE_URL, ART_DIR, heroFor, validateHeroes,
} = require('../services/pest-insider/heroes');
const { cardFor } = require('../services/pest-insider/cards');
const { FACTS, factById } = require('../services/pest-insider/facts');
const { POSTS } = require('../services/pest-insider/posts');

const ROOT = path.join(__dirname, '../..');
const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const listed = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : []);

// A JPEG's [width, height], read from its frame header.
function jpegSize(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

describe('the top picture list', () => {
  test('every fact with a reviewed post has a top picture, so every issue opens with one', () => {
    expect(Object.keys(POSTS).filter((id) => !heroFor(id))).toEqual([]);
    expect(heroFor('Z99')).toBeNull();
    expect(heroFor('__proto__')).toBeNull();
    expect(heroFor(undefined)).toBeNull();
    expect(Object.isFrozen(HEROES) && Object.isFrozen(HEROES.T03)).toBe(true);
  });

  test("its words are the fact's own title, its card's tag and the fixed Waves name; its alt text is the title", () => {
    for (const [id, hero] of Object.entries(HEROES)) {
      expect(hero.title).toBe(factById(id).title);
      expect(hero.tag).toBe(cardFor(id).tag);
      expect(hero.kicker).toBe('Waves Pest Insider');
      expect(hero.alt).toBe(hero.title);
    }
  });

  test('its file name is the hash of everything drawn on it, so a new title, tag or art gets a new file', () => {
    for (const [id, h] of Object.entries(HEROES)) {
      const drawn = { design: HERO_DESIGN, title: h.title, tag: h.tag, kicker: h.kicker, art: h.art };
      const hash = crypto.createHash('sha256').update(JSON.stringify(drawn)).digest('hex').slice(0, 10);
      expect(h.file).toBe(`${id.toLowerCase()}-${hash}.jpg`);
      expect(h.url).toBe(`${HERO_BASE_URL}${h.file}`);
    }
    const plain = validateHeroes({ heroes: { T03: { art: null } } }).T03;
    const withArt = validateHeroes({ heroes: { T03: { art: '0123456789abcdef' } } }).T03;
    expect(plain.file).not.toBe(withArt.file);
    expect([plain.artFile, withArt.artFile]).toEqual([null, 't03-0123456789abcdef.webp']);
    expect(HERO_BASE_URL).toBe('https://portal.wavespestcontrol.com/pest-insider/heroes/');
  });

  test('each picture ships with the portal as a 1164x652 JPEG (582x326 at 2x); an older picture may stay for sent emails', () => {
    const dir = path.join(ROOT, HERO_DIR);
    const files = listed(dir);
    expect(Object.values(HEROES).map((h) => h.file).filter((f) => !files.includes(f))).toEqual([]);
    for (const hero of Object.values(HEROES)) expect(jpegSize(fs.readFileSync(path.join(dir, hero.file)))).toEqual([1164, 652]);
    // every file is a top picture by name (<fact>-<hash>.jpg); a retired fact's pictures may stay
    expect(files.filter((f) => !/^[a-z]\d\d-[0-9a-f]{10}\.jpg$/.test(f))).toEqual([]);
  });

  test('the drawing scripts never change or remove a published picture, and write only with --execute', () => {
    for (const file of ['ops/agents/pest-insider-heroes.js', 'ops/agents/pest-insider-cards.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect({ file, removes: /\b(unlinkSync|rmSync|rmdirSync|unlink|rm|renameSync)\(/.test(src) }).toEqual({ file, removes: false });
      // a picture file is created once (flag wx), never overwritten
      const pictureWrites = src.match(/fs\.writeFileSync\(path\.join\(outDir[^\n]*/g) || [];
      expect(pictureWrites.length).toBe(1);
      expect(pictureWrites[0]).toContain("{ flag: 'wx' }");
      expect(src).toContain("const execute = args.includes('--execute');");
      expect(src).toContain('MUTATES (dry-run default');
    }
  });

  test('the art a picture names is the art file in the repo, and no other art file stays', () => {
    const named = Object.values(HEROES).filter((h) => h.art);
    expect(listed(path.join(ROOT, ART_DIR))).toEqual(named.map((h) => h.artFile).sort());
    for (const hero of named) expect(sha16(fs.readFileSync(path.join(ROOT, ART_DIR, hero.artFile)))).toBe(hero.art);
  });

  const noCard = FACTS.find((f) => !f.reserve && !cardFor(f.id));
  test.each([
    ['an unknown fact', { Z99: { art: null } }, /Z99: is not a main fact/],
    ['a reserve fact', { [FACTS.find((f) => f.reserve).id]: { art: null } }, /is not a main fact/],
    ['a fact with no card', { [noCard.id]: { art: null } }, /has no card/],
    ['an entry with no art field', { T03: {} }, /art must be null or/],
    ['art that is a link, not a hash', { T03: { art: 'https://www.example.com/x.png' } }, /art must be null or/],
    ['an entry that is not an object', { T03: 'x' }, /not an object/],
  ])('refuses %s', (_label, heroes, message) => expect(() => validateHeroes({ heroes })).toThrow(message));

  test('refuses a file with no heroes map', () => {
    expect(() => validateHeroes({})).toThrow(/no heroes map/);
    expect(() => validateHeroes({ heroes: [] })).toThrow(/no heroes map/);
  });
});

describe('taking new art', () => {
  const IMPORT = path.join(ROOT, 'ops/agents/pest-insider-art-import.js');
  const run = (dir, ...more) => spawnSync(process.execPath, [IMPORT, dir, ...more], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const snapshot = () => [fs.readFileSync(path.join(ROOT, 'server/data/pest-insider-heroes-v1.json'), 'utf8'), listed(path.join(ROOT, ART_DIR)).join()];

  test('checks the whole batch before it writes: a fact with no card or a broken picture stops it, and nothing is written', async () => {
    const sharp = require('sharp');
    const noCard = FACTS.find((f) => !f.reserve && !cardFor(f.id)).id;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-art-'));
    try {
      const png = await sharp(path.join(ROOT, ART_DIR, HEROES.T03.artFile)).png().toBuffer();
      fs.writeFileSync(path.join(dir, 't03.png'), png);
      const before = snapshot();
      const dry = run(dir);
      expect([dry.status, dry.stdout]).toEqual([0, expect.stringMatching(/Dry run: 1 art file\(s\) checked; nothing written/)]);

      fs.writeFileSync(path.join(dir, `${noCard.toLowerCase()}.png`), png);
      const refused = run(dir, '--execute');
      expect([refused.status, refused.stderr]).toEqual([1, expect.stringContaining(`${noCard}: has no card`)]);
      fs.rmSync(path.join(dir, `${noCard.toLowerCase()}.png`));

      fs.writeFileSync(path.join(dir, 't02.png'), 'not a picture');
      expect(run(dir, '--execute').status).toBe(1);
      expect(snapshot()).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test('runs one import at a time: while another holds the lock, it stops and writes nothing', async () => {
    const sharp = require('sharp');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-art-'));
    const lock = path.join(ROOT, 'server/data/pest-insider-heroes-v1.json.lock');
    try {
      fs.writeFileSync(path.join(dir, 't03.png'), await sharp(path.join(ROOT, ART_DIR, HEROES.T03.artFile)).flop().png().toBuffer());
      fs.writeFileSync(lock, '1\n', { flag: 'wx' });
      const before = snapshot();
      const held = run(dir, '--execute');
      expect([held.status, held.stderr]).toEqual([1, expect.stringContaining('Another import holds server/data/pest-insider-heroes-v1.json.lock')]);
      expect(snapshot()).toEqual(before);
    } finally {
      fs.rmSync(lock, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
