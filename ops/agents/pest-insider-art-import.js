/**
 * pest-insider-art-import.js — MUTATES (dry-run default; no database, no send): takes new art for the Pest Insider top pictures
 *
 * Each <dir>/<fact>.png (lower-case fact id, a wide picture) is cut to
 * 1164x652 and saved as ops/agents/pest-insider-art/<fact>-<art>.webp, where
 * <art> is the first 16 hex of its sha256, and <art> goes into
 * server/data/pest-insider-heroes-v1.json. Then draw the top pictures:
 * node ops/agents/pest-insider-heroes.js --execute
 *
 *   node ops/agents/pest-insider-art-import.js <dir> [--execute] [--only T03,R01]
 *
 *     (none)       dry run: cuts every picture and checks the batch; nothing written
 *     --execute    write the art files and the heroes file
 *     --only ids   only these facts
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

const args = process.argv.slice(2);
// A flag's value. A flag with no value stops the run, so "--only" alone
// never means "all".
function opt(name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1];
  if (typeof value !== 'string' || value.startsWith('--') || !value.trim()) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}
const repoRoot = path.resolve(__dirname, '../..');
const HEROES_FILE = path.join(repoRoot, 'server/data/pest-insider-heroes-v1.json');
const dir = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
const execute = args.includes('--execute');
const only = opt('--only') === null ? null : new Set(opt('--only').split(',').map((s) => s.trim()).filter(Boolean));
if (only && !only.size) { console.error('--only needs fact ids, such as --only T03,R01'); process.exit(2); }

const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

// The heroes file with one fact per line, as it is kept.
function heroesFileText(raw) {
  const lines = Object.entries(raw.heroes).map(([id, h]) => `    ${JSON.stringify(id)}: { "art": ${JSON.stringify(h.art)} }`);
  return `{\n  "version": ${raw.version},\n  "notes": ${JSON.stringify(raw.notes)},\n  "heroes": {\n${lines.join(',\n')}\n  }\n}\n`;
}

const tempName = (file, tag) => path.join(path.dirname(file), `.${path.basename(file)}.${tag}.tmp`);
const readHeroes = () => JSON.parse(fs.readFileSync(HEROES_FILE, 'utf8'));

// The heroes file with this batch's art, checked by heroes.js.
function merged(raw, batch) {
  const next = { ...raw, heroes: { ...raw.heroes } };
  for (const item of batch) next.heroes[item.id] = { art: item.art };
  validateHeroes(next);
  return next;
}

// Step 1: cut every picture and check the new heroes file. Writes nothing.
async function stage() {
  const artDir = path.join(repoRoot, ART_DIR);
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
  merged(readHeroes(), batch);
  return { batch, artDir };
}

// After the swap: the old art of each changed fact, once no fact names it.
// A file that cannot be removed only gets a warning (the import is done).
function removeOldArt(raw, next, batch, artDir) {
  const named = new Set(Object.entries(next.heroes).filter(([, h]) => h.art).map(([id, h]) => `${id.toLowerCase()}-${h.art}.webp`));
  for (const item of batch) {
    const old = raw.heroes[item.id] && raw.heroes[item.id].art;
    const oldFile = old ? `${item.id.toLowerCase()}-${old}.webp` : null;
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
    if (err.code === 'EEXIST') throw new Error(`Another import holds ${path.relative(repoRoot, lock)}. If none is running, remove that file.`);
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
    console.error('Usage: node ops/agents/pest-insider-art-import.js <dir> [--execute] [--only T03,R01]');
    process.exit(2);
  }
  const staged = await stage();
  for (const item of staged.batch) console.log(`${item.id}  art ${item.art}  ${Math.round(item.webp.length / 1024)} KB`);
  if (!staged.batch.length) { console.log(`No <fact>.png in ${dir}; nothing to take.`); return; }
  if (!execute) { console.log(`Dry run: ${staged.batch.length} art file(s) checked; nothing written. Add --execute.`); return; }
  publish(staged);
  console.log(`${staged.batch.length} art file(s) taken; now draw: node ops/agents/pest-insider-heroes.js --execute`);
})().catch((e) => { console.error(e); process.exit(1); });
