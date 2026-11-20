/**
 * pest-insider-art-import.js — MUTATES (dry-run default; no database, no send): takes new art for the Pest Insider top pictures
 *
 * Each <dir>/<fact>.png (lower-case fact id, a wide picture) is cut to
 * 1164x652 and saved as ops/agents/pest-insider-art/<fact>.webp, and the
 * first 16 hex of its sha256 goes into server/data/pest-insider-heroes-v1.json.
 * Then draw the top pictures: node ops/agents/pest-insider-heroes.js --execute
 *
 *   node ops/agents/pest-insider-art-import.js <dir> [--execute] [--only T03,R01]
 *
 *     (none)       dry run: cuts every picture and checks the batch; nothing written
 *     --execute    write the art files and the heroes file
 *     --only ids   only these facts
 *
 * All or nothing. Step 1 writes nothing: every picture is cut, and the new
 * heroes file must pass heroes.js validateHeroes (a main fact with a card),
 * so a fact with no card, a reserve fact or a broken PNG stops the whole
 * batch. Step 2 writes each new file under a temporary name next to its
 * target, then renames the art into place and the heroes file last (each
 * rename is atomic). If a step fails, the art this run replaced is put back,
 * art it added is removed, and its temporary files are removed, so the
 * heroes file and the art files never disagree.
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
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const repoRoot = path.resolve(__dirname, '../..');
const HEROES_FILE = path.join(repoRoot, 'server/data/pest-insider-heroes-v1.json');
const dir = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
const execute = args.includes('--execute');
const only = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : null;

const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

// The heroes file with one fact per line, as it is kept.
function heroesFileText(raw) {
  const lines = Object.entries(raw.heroes).map(([id, h]) => `    ${JSON.stringify(id)}: { "art": ${JSON.stringify(h.art)} }`);
  return `{\n  "version": ${raw.version},\n  "notes": ${JSON.stringify(raw.notes)},\n  "heroes": {\n${lines.join(',\n')}\n  }\n}\n`;
}

// Step 1: cut every picture and check the new heroes file. Writes nothing.
async function stage() {
  const raw = JSON.parse(fs.readFileSync(HEROES_FILE, 'utf8'));
  const artDir = path.join(repoRoot, ART_DIR);
  const batch = [];
  for (const name of fs.readdirSync(dir).filter((f) => /^[a-z]\d\d\.png$/.test(f)).sort()) {
    const id = name.slice(0, 3).toUpperCase();
    if (only && !only.has(id)) continue;
    const webp = await sharp(path.join(dir, name))
      .resize(HERO_WIDTH * 2, HERO_HEIGHT * 2, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82, effort: 6 })
      .toBuffer();
    batch.push({ id, target: path.join(artDir, `${id.toLowerCase()}.webp`), webp, art: sha16(webp) });
  }
  const next = { ...raw, heroes: { ...raw.heroes } };
  for (const item of batch) next.heroes[item.id] = { art: item.art };
  validateHeroes(next);
  return { batch, artDir, text: heroesFileText(next) };
}

// Step 2: temporary files first, then atomic renames, the heroes file last.
function publish({ batch, artDir, text }) {
  fs.mkdirSync(artDir, { recursive: true });
  const tag = `${process.pid}.${Date.now()}`;
  const temp = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${tag}.tmp`);
  const temps = [];
  const placed = [];
  try {
    for (const item of batch) {
      temps.push(temp(item.target));
      fs.writeFileSync(temp(item.target), item.webp, { flag: 'wx' });
    }
    temps.push(temp(HEROES_FILE));
    fs.writeFileSync(temp(HEROES_FILE), text, { flag: 'wx' });
    for (const item of batch) {
      placed.push({ target: item.target, old: fs.existsSync(item.target) ? fs.readFileSync(item.target) : null });
      fs.renameSync(temp(item.target), item.target);
    }
    fs.renameSync(temp(HEROES_FILE), HEROES_FILE);
  } catch (err) {
    // The heroes file is renamed last, so it still names the old art: put the old art back.
    for (const { target, old } of placed.reverse()) {
      if (old) {
        fs.writeFileSync(`${temp(target)}.back`, old);
        fs.renameSync(`${temp(target)}.back`, target);
      } else {
        fs.rmSync(target, { force: true });
      }
    }
    for (const file of temps) fs.rmSync(file, { force: true });
    console.error('Import failed; the art files and the heroes file are as they were.');
    throw err;
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
