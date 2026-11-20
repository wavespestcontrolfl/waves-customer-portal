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

  test('each picture ships with the portal as a whole 1164x652 JPEG (582x326 at 2x); an older picture may stay for sent emails', async () => {
    const sharp = require('sharp');
    const dir = path.join(ROOT, HERO_DIR);
    const files = listed(dir);
    expect(Object.values(HEROES).map((h) => h.file).filter((f) => !files.includes(f))).toEqual([]);
    for (const hero of Object.values(HEROES)) {
      expect(jpegSize(fs.readFileSync(path.join(dir, hero.file)))).toEqual([1164, 652]);
      // the whole picture decodes: a file cut short by a failed write does not
      await expect(sharp(path.join(dir, hero.file)).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    }
    // every file is a top picture by name (<fact>-<hash>.jpg); a retired fact's pictures may stay
    expect(files.filter((f) => !/^[a-z]\d\d-[0-9a-f]{10}\.jpg$/.test(f))).toEqual([]);
  });

  test('the drawing scripts never change or remove a published picture, and write only with --execute', () => {
    for (const file of ['ops/agents/pest-insider-heroes.js', 'ops/agents/pest-insider-cards.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // the one file a drawing script removes is its own temporary file
      const removals = src.match(/\b(?:unlinkSync|rmSync|rmdirSync|unlink|rm|renameSync|copyFileSync|cpSync)\([^)]*\)/g) || [];
      expect({ file, removals }).toEqual({ file, removals: ['rmSync(temp, { force: true })'] });
      // a picture is written whole under a temporary name (flag wx), then hard-linked to its name, which never replaces a file
      expect((src.match(/fs\.writeFileSync\([^\n]*/g) || [])).toEqual(["fs.writeFileSync(temp, bytes, { flag: 'wx' });"]);
      expect(src).toContain('fs.linkSync(temp, path.join(outDir, file));');
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
  // Every import here runs in a copy (--root): its own heroes file, art folder and lock.
  const IMPORT = path.join(ROOT, 'ops/agents/pest-insider-art-import.js');
  const MANIFEST = 'server/data/pest-insider-heroes-v1.json';
  const sharp = require('sharp');
  let root;
  let input;
  const run = (...more) => spawnSync(process.execPath, [IMPORT, input, '--root', root, ...more], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const everything = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
  const state = () => [fs.readFileSync(path.join(root, MANIFEST), 'utf8'), ...everything(path.join(root, 'server/data')), '|', ...everything(path.join(root, ART_DIR))];
  const t03png = (flip) => sharp(path.join(ROOT, ART_DIR, HEROES.T03.artFile))[flip ? 'flop' : 'clone']().png().toBuffer();
  const repo = () => [fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'), listed(path.join(ROOT, ART_DIR)).join()];
  let repoBefore;

  beforeAll(() => { repoBefore = repo(); });
  afterAll(() => expect(repo()).toEqual(repoBefore));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-root-'));
    input = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-art-'));
    fs.mkdirSync(path.join(root, 'server/data'), { recursive: true });
    fs.mkdirSync(path.join(root, ART_DIR), { recursive: true });
    fs.copyFileSync(path.join(ROOT, MANIFEST), path.join(root, MANIFEST));
    fs.copyFileSync(path.join(ROOT, ART_DIR, HEROES.T03.artFile), path.join(root, ART_DIR, HEROES.T03.artFile));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(input, { recursive: true, force: true });
  });

  test('checks the whole batch before it writes: a fact with no card, a broken picture or an empty --only stops it, and nothing is written', async () => {
    const noCard = FACTS.find((f) => !f.reserve && !cardFor(f.id)).id;
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(false));
    const before = state();
    const dry = run();
    expect([dry.status, dry.stdout]).toEqual([0, expect.stringMatching(/Dry run: 1 art file\(s\) checked; nothing written/)]);

    fs.writeFileSync(path.join(input, `${noCard.toLowerCase()}.png`), await t03png(false));
    const refused = run('--execute');
    expect([refused.status, refused.stderr]).toEqual([1, expect.stringContaining(`${noCard}: has no card`)]);
    fs.rmSync(path.join(input, `${noCard.toLowerCase()}.png`));

    fs.writeFileSync(path.join(input, 't02.png'), 'not a picture');
    expect(run('--execute').status).toBe(1);
    // "--only" with no fact ids never means "all", and every fact it names needs its picture
    expect(run('--execute', '--only').status).toBe(2);
    expect(run('--execute', '--only', ',').status).toBe(2);
    fs.rmSync(path.join(input, 't02.png'));
    const missing = run('--execute', '--only', 'T03,R01');
    expect([missing.status, missing.stderr]).toEqual([1, expect.stringContaining('No picture for R01')]);
    expect(state()).toEqual(before);
  }, 60000);

  test('swaps in new art under its hash name, then removes the art it replaced, and leaves no temporary file or lock', async () => {
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    const old = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).heroes;
    const done = run('--execute');
    expect(done.status).toBe(0);
    const now = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).heroes;
    expect(now.T03.art).not.toBe(old.T03.art);
    expect({ ...now, T03: null }).toEqual({ ...old, T03: null });
    expect(everything(path.join(root, ART_DIR))).toEqual([`t03-${now.T03.art}.webp`]);
    expect(sha16(fs.readFileSync(path.join(root, ART_DIR, `t03-${now.T03.art}.webp`)))).toBe(now.T03.art);
    expect(everything(path.join(root, 'server/data'))).toEqual(['pest-insider-heroes-v1.json']);
    expect(validateHeroes(JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'))).T03.artFile).toBe(`t03-${now.T03.art}.webp`);
  }, 60000);

  test('runs one import at a time: while another holds the lock, it stops and writes nothing', async () => {
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    fs.writeFileSync(path.join(root, `${MANIFEST}.lock`), '1\n');
    const before = state();
    const stopped = run('--execute');
    expect([stopped.status, stopped.stderr]).toEqual([1, expect.stringContaining('Another import holds server/data/pest-insider-heroes-v1.json.lock')]);
    expect(state()).toEqual(before);
  }, 60000);
});
