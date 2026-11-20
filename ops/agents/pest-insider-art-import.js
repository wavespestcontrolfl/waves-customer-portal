/**
 * pest-insider-art-import.js — MUTATES (dry-run default; no database, no send): takes new art for the Pest Insider top pictures
 *
 * Each <dir>/<fact>.png (lower-case fact id, a wide picture) is cut to
 * 1164x652 and saved as ops/agents/pest-insider-art/<fact>-<art>.webp, where
 * <art> is the first 16 hex of its sha256, and <art> goes into
 * server/data/pest-insider-heroes-v1.json. Then draw the top pictures:
 * node ops/agents/pest-insider-heroes.js --execute
 *
 *   node ops/agents/pest-insider-art-import.js <dir> [--execute] [--only T03,R01] [--root <dir>]
 *
 *     (none)        dry run: cuts every picture and checks the batch; nothing written
 *     --execute     write the art files and the heroes file
 *     --only ids    only these facts
 *     --root <dir>  the folder that holds server/data/ and
 *                   ops/agents/pest-insider-art/ (default: this repo; the
 *                   tests import into a copy)
 *
 * All or nothing, one import at a time:
 * - Step 1 writes nothing: every picture is cut, and the new heroes file must
 *   pass heroes.js validateHeroes (a main fact with a card), so a fact with
 *   no card, a reserve fact or a broken PNG stops the whole batch.
 * - Step 2 holds a lock file, so a second import stops until the first one
 *   is done. It reads
 *   the heroes file again, writes each new art file under its own hash name
 *   (never over art the heroes file names), then swaps in the new heroes
 *   file with one atomic rename. That rename is the only switch: until it,
 *   the heroes file names the old art, which is still there; after it, the
 *   new art. The old art of the facts it changed is removed last.
 * - If step 2 fails before the switch, the art it added is removed. A run
 *   that is killed leaves at most an art file no fact names (the heroes test
 *   names it) and its lock file (remove it once no import runs).
 *
 * The art: ChatGPT on the owner's plan (owner 2026-11-19: "just use
 * chatgpt"), through Codex on the Mac with Codex's built-in image tool, never
 * a paid image API. One picture per fact, wide, with no words, bugs only as
 * cartoons, no body parts, and the subject in the right half (the title
 * panel covers the left). A person checks every picture against its fact
 * before it is imported.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

for (const name of Object.keys(process.env)) {
  if (/^(DATABASE_|POSTGRES_|PG[A-Z]+$)/.test(name)) delete process.env[name];
}
process.env.WAVES_LOCAL_DEV = '1';

const sharp = require('sharp');
const { HERO_WIDTH, HERO_HEIGHT, ART_DIR, validateHeroes } = require('../../server/services/pest-insider/heroes');

// The command line, checked whole: an unknown flag, a flag with no value,
// a flag given twice or an extra word stops the run (exit 2), so a typo
// such as "--olny" never widens what it touches.
function readArgs(argv, valueFlags, words) {
  const out = { execute: false, values: {}, words: [] };
  const stop = (why) => { console.error(`${why}. See the top of ${path.basename(__filename)}.`); process.exit(2); };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') out.execute = true;
    else if (valueFlags.includes(arg)) {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('-') || !value.trim()) stop(`${arg} needs a value`);
      if (Object.prototype.hasOwnProperty.call(out.values, arg)) stop(`${arg} is given twice`);
      out.values[arg] = value;
      i += 1;
    } else if (!arg.startsWith('-') && out.words.length < words) out.words.push(arg);
    else stop(`Unknown argument: ${arg}`);
  }
  return out;
}
const cli = readArgs(process.argv.slice(2), ['--only', '--root'], 1);
const root = cli.values['--root'] === undefined ? path.resolve(__dirname, '../..') : path.resolve(cli.values['--root']);
const HEROES_FILE = path.join(root, 'server/data/pest-insider-heroes-v1.json');
const dir = cli.words[0] ? path.resolve(cli.words[0]) : null;
const execute = cli.execute;
const only = cli.values['--only'] === undefined ? null : new Set(cli.values['--only'].split(',').map((s) => s.trim()).filter(Boolean));
if (only && !only.size) { console.error('--only needs fact ids, such as --only T03,R01'); process.exit(2); }

const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

// The heroes file with one fact per line, as it is kept. The text is read
// back before it is used: it must parse to the same file and pass heroes.js.
function heroesFileText(raw) {
  const top = Object.entries(raw).filter(([key, value]) => key !== 'heroes' && value !== undefined)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`).join('');
  const lines = Object.entries(raw.heroes).map(([id, h]) => `    ${JSON.stringify(id)}: { "art": ${JSON.stringify(h.art)} }`);
  const text = `{\n${top}  "heroes": {\n${lines.join(',\n')}\n  }\n}\n`;
  const back = JSON.parse(text);
  validateHeroes(back);
  if (JSON.stringify(back.heroes) !== JSON.stringify(raw.heroes)) throw new Error('the heroes file text does not hold the heroes it was built from');
  return text;
}

const tempName = (file, tag) => path.join(path.dirname(file), `.${path.basename(file)}.${tag}.tmp`);
const readHeroes = () => JSON.parse(fs.readFileSync(HEROES_FILE, 'utf8'));

// The heroes file with this batch's art, checked by heroes.js. The current
// file is checked first: its old art hashes name the files removed later.
function merged(raw, batch) {
  validateHeroes(raw);
  const next = { ...raw, heroes: { ...raw.heroes } };
  for (const item of batch) next.heroes[item.id] = { art: item.art };
  validateHeroes(next);
  return next;
}

// Step 1: cut every picture and check the new heroes file. Writes nothing.
async function stage() {
  const artDir = path.join(root, ART_DIR);
  const batch = [];
  for (const name of fs.readdirSync(dir).filter((f) => /^[a-z]\d\d\.png$/.test(f)).sort()) {
    const id = name.slice(0, 3).toUpperCase();
    if (only && !only.has(id)) continue;
    const webp = await sharp(path.join(dir, name))
      .resize(HERO_WIDTH * 2, HERO_HEIGHT * 2, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82, effort: 6 })
      .toBuffer();
    const art = sha16(webp);
    batch.push({ id, art, webp, target: path.join(artDir, `${id.toLowerCase()}-${art}.webp`) });
  }
  const missing = only ? [...only].filter((id) => !batch.some((item) => item.id === id)) : [];
  if (missing.length) throw new Error(`No picture for ${missing.join(', ')} in ${dir} (expected <fact>.png, such as ${missing[0].toLowerCase()}.png); nothing taken.`);
  merged(readHeroes(), batch);
  return { batch, artDir };
}

// After the swap: the old art of each changed fact, once no fact names it.
// A file that cannot be removed only gets a warning (the import is done).
function removeOldArt(raw, next, batch, artDir) {
  const named = new Set(Object.entries(next.heroes).filter(([, h]) => h.art).map(([id, h]) => `${id.toLowerCase()}-${h.art}.webp`));
  for (const item of batch) {
    const old = raw.heroes[item.id] && raw.heroes[item.id].art;
    // only a checked hash names a file: 16 hex, no path in it
    const oldFile = /^[0-9a-f]{16}$/.test(String(old)) ? `${item.id.toLowerCase()}-${old}.webp` : null;
    if (!oldFile || named.has(oldFile)) continue;
    try {
      fs.rmSync(path.join(artDir, oldFile), { force: true });
    } catch (err) {
      console.warn(`Imported, but ${oldFile} could not be removed (${err.code || err.message}); remove it by hand.`);
    }
  }
}

// Step 2, under the lock: new art under hash names, then one atomic swap of
// the heroes file, then the old art of the changed facts is removed.
function publish({ batch, artDir }) {
  fs.mkdirSync(artDir, { recursive: true });
  const lock = `${HEROES_FILE}.lock`;
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`Another import holds ${path.relative(root, lock)}. If none is running, remove that file.`);
    throw err;
  }
  const tag = `${process.pid}.${Date.now()}`;
  const added = [];
  let swapped = false;
  try {
    const raw = readHeroes();
    const next = merged(raw, batch);
    for (const item of batch) {
      const existed = fs.existsSync(item.target);
      if (existed && sha16(fs.readFileSync(item.target)) === item.art) continue;
      fs.writeFileSync(tempName(item.target, tag), item.webp, { flag: 'wx' });
      fs.renameSync(tempName(item.target, tag), item.target);
      if (!existed) added.push(item.target);
    }
    fs.writeFileSync(tempName(HEROES_FILE, tag), heroesFileText(next), { flag: 'wx' });
    fs.renameSync(tempName(HEROES_FILE, tag), HEROES_FILE);
    swapped = true;
    removeOldArt(raw, next, batch, artDir);
  } catch (err) {
    if (!swapped) {
      for (const file of added) fs.rmSync(file, { force: true });
      console.error('Import failed; the heroes file and the art it names are as they were.');
    }
    throw err;
  } finally {
    for (const file of [...batch.map((item) => tempName(item.target, tag)), tempName(HEROES_FILE, tag)]) fs.rmSync(file, { force: true });
    fs.rmSync(lock, { force: true });
  }
}

(async () => {
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: node ops/agents/pest-insider-art-import.js <dir> [--execute] [--only T03,R01] [--root <dir>]');
    process.exit(2);
  }
  const staged = await stage();
  for (const item of staged.batch) console.log(`${item.id}  art ${item.art}  ${Math.round(item.webp.length / 1024)} KB`);
  if (!staged.batch.length) { console.log(`No <fact>.png in ${dir}; nothing to take.`); return; }
  if (!execute) { console.log(`Dry run: ${staged.batch.length} art file(s) checked; nothing written. Add --execute.`); return; }
  publish(staged);
  console.log(`${staged.batch.length} art file(s) taken; now draw: node ops/agents/pest-insider-heroes.js --execute`);
})().catch((e) => { console.error(e); process.exit(1); });
