// Pest Insider top pictures: one per lead fact, its words drawn by code from
// the fact's own title and card tag, its art checked in the repo, and its
// picture shipped with the portal.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HEROES, HERO_DESIGN, HERO_DIR, HERO_BASE_URL, ART_DIR, HERO_MOTION_DESIGN, HERO_ART_LEFT, MOTION_KINDS, MOTION_COLORS, heroFor, validateHeroes,
} = require('../services/pest-insider/heroes');
const { cardFor, WAVES_COLORS } = require('../services/pest-insider/cards');
const { motionSvg, MOTION_FRAMES } = require('../../ops/agents/pest-insider-motion');
const { FACTS, factById } = require('../services/pest-insider/facts');
const { POSTS } = require('../services/pest-insider/posts');

const ROOT = path.join(__dirname, '../..');
const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const listed = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : []);

const hash10 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);
const MOVING = Object.entries(HEROES).filter(([, h]) => h.motion);
// One valid motion of each kind, for the checks below.
const SAMPLE = {
  swarm: { x: 0.7, y: 0.3 },
  rise: { x: 0.7, y: 0.8, x2: 0.8, y2: 0.4 },
  drop: { x: 0.7, y: 0.2, to: 0.5, size: 5 },
  rain: { x: 0.6 },
  march: { x: 0.6, y: 0.6, cx: 0.7, cy: 0.8, x2: 0.9, y2: 0.9 },
  pulse: { x: 0.7, y: 0.7, r0: 10, r1: 30 },
  spray: { x: 0.8, y: 0.6, angle: 120, spread: 40, reach: 120, fall: 30, size: 2 },
  heat: { x: 0.9, y: 0.6 },
};
const withMotion = (motion) => ({ T03: { art: '0123456789abcdef', motion } });

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

  test("a moving picture's GIF is named by the picture and its motion: new motion gets a new GIF, and the still keeps its name", () => {
    expect(MOVING.length).toBeGreaterThan(0);
    for (const [id, h] of MOVING) {
      const drawn = { design: HERO_DESIGN, title: h.title, tag: h.tag, kicker: h.kicker, art: h.art };
      expect(h.gifFile).toBe(`${id.toLowerCase()}-${hash10({ ...drawn, motion: h.motion, motionDesign: HERO_MOTION_DESIGN })}.gif`);
      expect(h.gifUrl).toBe(`${HERO_BASE_URL}${h.gifFile}`);
      expect(Object.isFrozen(h.motion)).toBe(true);
      // the checked motion keeps a fixed key order: kind, color, then its numbers
      expect(Object.keys(h.motion)).toEqual(['kind', 'color', ...MOTION_KINDS[h.motion.kind]]);
    }
    for (const [, h] of Object.entries(HEROES).filter(([, x]) => !x.motion)) expect([h.motion, h.gifFile, h.gifUrl]).toEqual([null, null, null]);
    const base = validateHeroes({ heroes: withMotion({ kind: 'pulse', color: 'navy', ...SAMPLE.pulse }) }).T03;
    const moved = validateHeroes({ heroes: withMotion({ kind: 'pulse', color: 'navy', ...SAMPLE.pulse, x: 0.71 }) }).T03;
    const recolored = validateHeroes({ heroes: withMotion({ kind: 'pulse', color: 'gold', ...SAMPLE.pulse }) }).T03;
    // the same motion with its keys in another order is the same GIF
    const reordered = validateHeroes({ heroes: withMotion({ r1: 30, r0: 10, y: 0.7, x: 0.7, color: 'navy', kind: 'pulse' }) }).T03;
    expect(new Set([base.gifFile, moved.gifFile, recolored.gifFile]).size).toBe(3);
    expect(reordered.gifFile).toBe(base.gifFile);
    expect(new Set([base.file, moved.file, recolored.file])).toEqual(new Set([validateHeroes({ heroes: { T03: { art: '0123456789abcdef' } } }).T03.file]));
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
    // every file is a top picture by name (<fact>-<hash>.jpg or .gif); a retired fact's pictures may stay
    expect(files.filter((f) => !/^[a-z]\d\d-[0-9a-f]{10}\.(?:jpg|gif)$/.test(f))).toEqual([]);
  });

  test('each moving picture ships as a whole 1164x652 GIF of 16 frames that plays 3 times, under 400 KB', async () => {
    const sharp = require('sharp');
    const dir = path.join(ROOT, HERO_DIR);
    for (const [id, hero] of MOVING) {
      const file = path.join(dir, hero.gifFile);
      expect({ id, there: fs.existsSync(file) }).toEqual({ id, there: true });
      const gif = fs.readFileSync(file);
      expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
      expect({ id, kb: Math.ceil(gif.length / 1024) <= 400 }).toEqual({ id, kb: true });
      const meta = await sharp(gif, { animated: true }).metadata();
      expect({ id, size: [meta.width, meta.pageHeight], frames: meta.pages, loop: meta.loop, delay: meta.delay })
        .toEqual({ id, size: [1164, 652], frames: MOTION_FRAMES, loop: 3, delay: Array(MOTION_FRAMES).fill(100) });
      // every frame decodes: a file cut short by a failed write does not
      await expect(sharp(gif, { animated: true }).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    }
  }, 60000);

  test('motion is drawn over the art only, right of the title panel, in Waves colors, for every kind', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(Object.keys(MOTION_KINDS).sort());
    expect(HERO_ART_LEFT * 582).toBeGreaterThan(24 + 250); // the title box ends at 274px
    const waves = new Set(Object.values(WAVES_COLORS));
    const motions = [
      ...MOVING.map(([, h]) => h.motion),
      ...MOTION_COLORS.flatMap((color) => Object.entries(SAMPLE).map(([kind, numbers]) => validateHeroes({ heroes: withMotion({ kind, color, ...numbers }) }).T03.motion)),
    ];
    for (const motion of motions) {
      for (let frame = 0; frame < MOTION_FRAMES; frame += 1) {
        const svg = motionSvg(motion, frame, 1164, 652);
        const body = /^<svg [^>]*><defs>(.*)<clipPath id="art"><rect x="([\d.]+)" y="0" width="([\d.]+)" height="652"\/><\/clipPath><\/defs><g clip-path="url\(#art\)">(.*)<\/g><\/svg>$/.exec(svg);
        expect({ kind: motion.kind, clipped: Boolean(body) }).toEqual({ kind: motion.kind, clipped: true });
        // the clip starts at the panel's edge (to the drawing's 0.1px)
        expect([Number(body[2]), Number(body[3])]).toEqual([Number((HERO_ART_LEFT * 1164).toFixed(1)), Number((1164 - HERO_ART_LEFT * 1164).toFixed(1))]);
        // nothing is drawn outside the clipped group: its inner groups balance and never close it early
        let depth = 0;
        for (const [, close] of body[4].matchAll(/<(\/?)g[\s>]/g)) {
          depth += close ? -1 : 1;
          expect({ kind: motion.kind, early: depth < 0 }).toEqual({ kind: motion.kind, early: false });
        }
        expect({ kind: motion.kind, depth }).toEqual({ kind: motion.kind, depth: 0 });
        const colors = [...svg.matchAll(/(?:fill|stroke|stop-color)="([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== 'none' && c !== 'url(#glow)');
        expect({ kind: motion.kind, other: colors.filter((c) => !waves.has(c)) }).toEqual({ kind: motion.kind, other: [] });
      }
    }
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
      // only --execute writes; the whole command line is checked first
      expect(src).toContain("if (arg === '--execute') out.execute = true;");
      expect(src).toContain('const execute = cli.execute;');
      expect(src).toContain('MUTATES (dry-run default');
    }
  });

  test('a drawing script stops on a fact it has no picture for, a flag with no value, or a typo', () => {
    for (const [file, what] of [['ops/agents/pest-insider-heroes.js', 'top picture'], ['ops/agents/pest-insider-cards.js', 'card']]) {
      const draw = (...more) => spawnSync(process.execPath, [path.join(ROOT, file), ...more], { cwd: ROOT, encoding: 'utf8', env: process.env });
      const unknown = draw('--only', 'T03,R99');
      expect([file, unknown.status, unknown.stderr]).toEqual([file, 2, expect.stringContaining(`No ${what} for R99`)]);
      expect([file, draw('--only').status, draw('--out').status, draw('--olny', 'T03').status, draw('T03').status]).toEqual([file, 2, 2, 2, 2]);
    }
  }, 60000);

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
    ['an entry with a field of its own', { T03: { art: null, note: 'x' } }, /art and motion only, not note/],
    ['motion on a picture with no art', { T03: { art: null, motion: { kind: 'rain', color: 'white', x: 0.6 } } }, /no art has no motion/],
    ['motion that is not an object', withMotion('rain'), /motion must be an object/],
    ['a kind of motion not on the list', withMotion({ kind: 'spin', color: 'navy', x: 0.7 }), /motion kind must be one of swarm, rise/],
    ['a prototype key as the kind', withMotion({ kind: 'constructor', color: 'navy' }), /motion kind must be one of/],
    ['a kind given as a list', withMotion({ kind: ['rain'], color: 'white', x: 0.6 }), /motion kind must be one of/],
    ['a color that is not a Waves color', withMotion({ kind: 'rain', color: 'red', x: 0.6 }), /motion color must be one of navy, gold, wavesBlue, white/],
    ['a number the kind needs, missing', withMotion({ kind: 'drop', color: 'navy', x: 0.7, y: 0.2, to: 0.5 }), /drop motion needs size from 1 to 8/],
    ['a number given as text', withMotion({ kind: 'rain', color: 'white', x: '0.6' }), /rain motion needs x from 0.52 to 1/],
    ['a spot over the title panel', withMotion({ kind: 'pulse', color: 'navy', ...SAMPLE.pulse, x: 0.3 }), /pulse motion needs x from 0.52 to 1/],
    ['a spot off the picture', withMotion({ kind: 'heat', color: 'gold', x: 0.9, y: 1.2 }), /heat motion needs y from 0 to 1/],
    ['a number the kind does not take', withMotion({ kind: 'rain', color: 'white', x: 0.6, y: 0.5 }), /rain motion takes no y/],
    ['rings that shrink', withMotion({ kind: 'pulse', color: 'navy', ...SAMPLE.pulse, r1: 10 }), /r1 larger than r0/],
    ['a drop that falls up', withMotion({ kind: 'drop', color: 'navy', ...SAMPLE.drop, to: 0.1 }), /must be below its y/],
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
    // "--only" with no fact ids, or a typo of it, never means "all"; every fact it names needs its picture
    expect(run('--execute', '--only').status).toBe(2);
    expect(run('--execute', '--only', ',').status).toBe(2);
    expect(run('--execute', '--olny', 'T03').status).toBe(2);
    fs.rmSync(path.join(input, 't02.png'));
    const missing = run('--execute', '--only', 'T03,R01');
    expect([missing.status, missing.stderr]).toEqual([1, expect.stringContaining('No picture for R01')]);
    // a picture named any other way stops the batch instead of being skipped
    fs.writeFileSync(path.join(input, 'R01.png'), await t03png(false));
    const misnamed = run('--execute');
    expect([misnamed.status, misnamed.stderr]).toEqual([1, expect.stringContaining('Misnamed pictures: R01.png')]);
    expect(state()).toEqual(before);
  }, 60000);

  test('swaps in new art under its hash name, then removes the art it replaced, and leaves no temporary file or lock', async () => {
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    // a heroes file with no notes still comes back as valid JSON
    const file = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    delete file.notes;
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(file, null, 2));
    const old = file.heroes;
    const done = run('--execute');
    expect(done.status).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    expect(Object.keys(after)).toEqual(['version', 'heroes']);
    const now = after.heroes;
    expect(now.T03.art).not.toBe(old.T03.art);
    expect({ ...now, T03: null }).toEqual({ ...old, T03: null });
    expect(everything(path.join(root, ART_DIR))).toEqual([`t03-${now.T03.art}.webp`]);
    expect(sha16(fs.readFileSync(path.join(root, ART_DIR, `t03-${now.T03.art}.webp`)))).toBe(now.T03.art);
    expect(everything(path.join(root, 'server/data'))).toEqual(['pest-insider-heroes-v1.json']);
    expect(validateHeroes(JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'))).T03.artFile).toBe(`t03-${now.T03.art}.webp`);
  }, 60000);

  test('refuses a heroes file that is already broken, and removes nothing (an old art value never names a path)', async () => {
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    const raw = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    raw.heroes.T03 = { art: '../../canary' };
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(raw));
    fs.writeFileSync(path.join(root, 'canary.webp'), 'keep me');
    const before = state();
    const refused = run('--execute');
    expect([refused.status, refused.stderr]).toEqual([1, expect.stringContaining('T03: art must be null or')]);
    expect(state()).toEqual(before);
    expect(fs.readFileSync(path.join(root, 'canary.webp'), 'utf8')).toBe('keep me');
  }, 60000);

  test('never replaces a file: a file already at the new art name must hold that art, or the import stops and changes nothing', async () => {
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    const art = /T03 {2}art ([0-9a-f]{16})/.exec(run().stdout)[1];
    fs.writeFileSync(path.join(root, ART_DIR, `t03-${art}.webp`), 'a hand edit');
    const before = state();
    const stopped = run('--execute');
    expect([stopped.status, stopped.stderr]).toEqual([1, expect.stringContaining(`t03-${art}.webp is there but does not hold the art its name says`)]);
    expect(state()).toEqual(before);
    expect(fs.readFileSync(path.join(root, ART_DIR, `t03-${art}.webp`), 'utf8')).toBe('a hand edit');
  }, 60000);

  // The tests place their own motion: which facts move is data, and an art import may drop it.
  const placeMotion = (id, motion) => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    raw.heroes[id] = { art: raw.heroes[id].art, motion };
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(raw, null, 2));
  };
  const RAIN = { kind: 'rain', color: 'white', ...SAMPLE.rain };

  test('new art drops the motion placed on the old art, and says so; the same art again keeps its motion', async () => {
    placeMotion('T03', RAIN);
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    // the dry run says what the import would drop, and drops nothing
    const before = state();
    const preview = run();
    expect([preview.status, preview.stdout]).toEqual([0, expect.stringContaining('New art would drop the motion of T03: place it again')]);
    expect(state()).toEqual(before);
    const first = run('--execute');
    expect([first.status, first.stdout]).toEqual([0, expect.stringContaining('New art dropped the motion of T03: place it again')]);
    const raw = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    expect(Object.keys(raw.heroes.T03)).toEqual(['art']);
    // a person places the motion again on the new art; importing that same art keeps it
    placeMotion('T03', RAIN);
    const again = run('--execute');
    expect([again.status, again.stdout]).toEqual([0, expect.not.stringContaining('the motion of')]);
    const kept = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).heroes.T03;
    expect(kept).toEqual({ art: raw.heroes.T03.art, motion: RAIN });
    expect(validateHeroes({ heroes: { T03: kept } }).T03.gifFile).toMatch(/^t03-[0-9a-f]{10}\.gif$/);
  }, 60000);

  test("an entry a person wrote with its motion before its art does not block another fact's import", async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    // another fact with art, written motion first
    const other = Object.keys(raw.heroes).find((id) => id !== 'T03' && raw.heroes[id].art);
    const { art } = raw.heroes[other];
    raw.heroes[other] = { motion: RAIN, art };
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(raw, null, 2));
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    const taken = run('--execute');
    expect([taken.status, taken.stderr]).toEqual([0, expect.not.stringContaining('does not hold the heroes')]);
    // the file is written back one fact per line, art first; the other fact keeps its art and motion
    const text = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
    expect(text).toContain(`${JSON.stringify(other)}: { "art": ${JSON.stringify(art)}, "motion": ${JSON.stringify(RAIN)} }`);
    expect(JSON.parse(text).heroes[other]).toEqual({ art, motion: RAIN });
  }, 60000);

  test('runs one import at a time: while another holds the lock, it stops and writes nothing', async () => {
    placeMotion('T03', RAIN);
    fs.writeFileSync(path.join(input, 't03.png'), await t03png(true));
    fs.writeFileSync(path.join(root, `${MANIFEST}.lock`), '1\n');
    const before = state();
    const stopped = run('--execute');
    expect([stopped.status, stopped.stderr]).toEqual([1, expect.stringContaining('Another import holds server/data/pest-insider-heroes-v1.json.lock')]);
    expect(state()).toEqual(before);
    // T03 moves here, but an import that stops drops no motion, so it says nothing of it
    expect(stopped.stdout).not.toContain('the motion of');
  }, 60000);
});
