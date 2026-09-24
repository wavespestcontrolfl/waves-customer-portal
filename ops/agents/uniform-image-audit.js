#!/usr/bin/env node
/**
 * uniform-image-audit.js — READ-ONLY vision pass over generated blog images.
 *
 * Owner directive 2026-09-23: Waves techs wear a red long-sleeve polo, a light-blue
 * or red cap, and black/dark-navy pants. This script flags every live image that
 * shows a person dressed otherwise, so ONLY those get regenerated (not all 112).
 * 2026-09-24: the cap front and the RIGHT chest carry the Waves logo — a judgeable
 * cap/chest without it (or a left-chest logo) is out of uniform too.
 *
 * Usage (needs the portal env for the vision keys):
 *   cd ~/waves-customer-portal && railway run --service waves-customer-portal -- \
 *     node <worktree>/ops/agents/uniform-image-audit.js --dir <astro>/public/images/blog --out report.json
 *
 * `--dir` is walked RECURSIVELY; every image is keyed by its path relative to
 * `--dir` with `/` → `__` (`termite__wdo-inspection-bradenton-fl__hero.webp`),
 * which is the key uniform-image-regenerate.js maps back to a repo path. Also
 * `require()`-able: exports the classifier so the regenerate script can verify
 * a replacement before it overwrites anything.
 *
 * Writes nothing but the report. Fail-open per image (an unreadable image is
 * reported as `error`, never silently dropped).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MODELS = require('../../server/config/models');
const { dispatchWithFallback } = require('../../server/services/llm/call');

const PROMPT = `You are auditing a company blog image. Answer ONLY with JSON:
{"person": true|false, "role": "technician"|"homeowner"|"other"|"none", "shirt": "<color and sleeve length or none>", "shirt_type": "polo"|"other"|"hidden", "cap": "<color or none>", "cap_type": "baseball"|"other"|"none"|"hidden", "head": "capped"|"bare"|"hidden", "pants": "<color or none>", "logo_cap": "yes"|"no"|"hidden", "logo_chest": "right"|"left"|"both"|"no"|"hidden", "uniform_ok": true|false, "note": "<one short line>"}
Rules: "person" is true only if a human figure (even partial: hands, torso) is visible. A technician is anyone doing pest-control or lawn-care work or wearing work clothes/gloves. "head" is "capped" when the technician wears any cap or hat, "bare" when their head is clearly in frame with no cap or hat, and "hidden" when the head is out of frame, cut off, or hidden. uniform_ok is FALSE when a technician's garment is actually visible AND wrong: a shirt that is not red, a red shirt whose sleeves are visibly SHORT (the uniform is a red LONG-SLEEVE polo; sleeves hidden or out of frame are not judged), a shirt that is visibly not a collared polo (a sweatshirt, t-shirt, hoodie, jacket or coverall — shirt_type "other"), a cap that is not light blue or red, headwear that is visibly not a baseball cap (a bucket hat, hard hat, beanie or visor — cap_type "other"), pants that are not black/dark navy — or when head is "bare" (a Waves technician always wears a baseball cap). shirt_type/cap_type are "hidden" only when that garment cannot be judged. "logo_cap" is "yes" when the Waves company logo (a smiling blue wave mascot in a red-and-blue shield, lettered WAVES / LAWN & PEST) is on the front of the technician's cap, "no" when the cap front is clearly in frame and carries no such logo (a plain cap or gibberish lettering counts as "no"), and "hidden" when the cap front cannot be judged. "logo_chest" is "right" when that logo is on the wearer's RIGHT chest (the side of their right arm), "left" when it is on the wearer's left chest, "both" when on both sides, "no" when the shirt chest is clearly in frame and carries no such logo (a blank badge counts as "no"), and "hidden" when the chest cannot be judged. uniform_ok is ALSO FALSE when logo_cap is "no" or logo_chest is "no", "left" or "both" (since 2026-09-24 the uniform carries the Waves logo on the cap and the RIGHT chest only). If only hands, gloves or tools are visible (no shirt/cap/pants/head to judge), uniform_ok=true. A homeowner or an image with no person also gets uniform_ok=true (nothing to fix).`;

const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// One vision call → { ok, parsed, reason }. Never throws; a provider miss or
// unparseable answer is `ok: false` so a caller can fail closed on it.
async function classifyUniform({ buffer, mimeType }) {
  let res;
  try {
    res = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
      text: PROMPT, images: [{ data: buffer.toString('base64'), mimeType }],
      jsonMode: true, maxTokens: 300, timeoutMs: 60000,
    });
  } catch (err) { return { ok: false, reason: err.message }; }
  if (!res.ok) return { ok: false, reason: res.reason || 'vision failed' };
  let parsed = null;
  try { parsed = JSON.parse(String(res.text).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'unparseable', raw: String(res.text).slice(0, 200) };
  const shape = classifierShapeProblem(parsed);
  if (shape) return { ok: false, reason: `incomplete classifier answer: ${shape}`, raw: String(res.text).slice(0, 200) };
  return { ok: true, parsed };
}
// The fields outOfUniform() decides on must be present and well-typed — a
// valid-JSON answer missing `uniform_ok` must never read as compliant.
const ROLES = new Set(['technician', 'homeowner', 'other', 'none']);
const HEADS = new Set(['capped', 'bare', 'hidden']);
const LOGO_CAP = new Set(['yes', 'no', 'hidden']);
const LOGO_CHEST = new Set(['right', 'left', 'both', 'no', 'hidden']);
function classifierShapeProblem(p) {
  if (typeof p.person !== 'boolean') return 'person is not a boolean';
  if (!ROLES.has(p.role)) return `role "${p.role}" not in ${[...ROLES].join('|')}`;
  if (typeof p.uniform_ok !== 'boolean') return 'uniform_ok is not a boolean';
  if (p.person && p.role === 'technician' && !HEADS.has(String(p.head || '').toLowerCase())) return `head "${p.head}" not in ${[...HEADS].join('|')}`;
  // A technician answer without the logo verdict is incomplete, never
  // compliant (Codex r1 P2 on #4761).
  if (p.person && p.role === 'technician' && !LOGO_CAP.has(String(p.logo_cap || '').toLowerCase())) return `logo_cap "${p.logo_cap}" not in ${[...LOGO_CAP].join('|')}`;
  if (p.person && p.role === 'technician' && !LOGO_CHEST.has(String(p.logo_chest || '').toLowerCase())) return `logo_chest "${p.logo_chest}" not in ${[...LOGO_CHEST].join('|')}`;
  return null;
}
// A technician who is out of uniform — the only case the sweep regenerates. A
// visible bare head counts (the uniform line requires a cap) even when the
// model left uniform_ok true.
function outOfUniform(parsed) {
  if (!parsed || !parsed.person || parsed.role !== 'technician') return false;
  const lc = (v) => String(v || '').toLowerCase();
  // Server-side too, so a model that leaves uniform_ok true on a sweatshirt or
  // bucket hat still lands in toFix: the uniform is a long-sleeve POLO and a
  // BASEBALL cap, not just those colors.
  // Logo (2026-09-24): a judgeable cap front without it, or a judgeable chest
  // without it on the RIGHT side only, is out of uniform (Codex r3 P2 on #4761).
  return parsed.uniform_ok === false || lc(parsed.head) === 'bare' || lc(parsed.shirt_type) === 'other' || lc(parsed.cap_type) === 'other'
    || lc(parsed.logo_cap) === 'no' || ['no', 'left', 'both'].includes(lc(parsed.logo_chest));
}
function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const DIR = opt('--dir'); const OUT = opt('--out', 'uniform-audit.json'); const LIMIT = Number(opt('--limit', '0'));
  if (!DIR) { console.error('usage: --dir <folder> [--out report.json] [--limit N]'); process.exit(1); }
  const files = walk(DIR).filter((f) => MIME[path.extname(f).toLowerCase()]).map((f) => path.relative(DIR, f)).sort();
  const todo = LIMIT > 0 ? files.slice(0, LIMIT) : files;
  const rows = [];
  for (const rel of todo) {
    const key = rel.split(path.sep).join('__');
    try {
      let buf;
      try { buf = fs.readFileSync(path.join(DIR, rel)); } catch (err) { rows.push({ file: key, path: rel, error: `unreadable: ${err.message}` }); process.stdout.write(`? ${key} (unreadable)\n`); continue; }
      // The verdict is bound to these exact bytes: the regenerate script
      // refuses to overwrite a file whose sha256 no longer matches.
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const res = await classifyUniform({ buffer: buf, mimeType: MIME[path.extname(rel).toLowerCase()] });
      if (!res.ok) { rows.push({ file: key, path: rel, sha256, error: res.reason, raw: res.raw }); process.stdout.write(`? ${key} (${res.reason})\n`); continue; }
      const parsed = res.parsed;
      rows.push({ file: key, path: rel, sha256, ...parsed });
      const flag = outOfUniform(parsed);
      process.stdout.write(`${flag ? 'FIX' : ' ok'} ${key}${parsed.person ? ` — ${parsed.role}: ${parsed.shirt}; cap ${parsed.cap} (${parsed.head || '?'}); pants ${parsed.pants}; logo cap ${parsed.logo_cap || '?'} / chest ${parsed.logo_chest || '?'}` : ' — no person'}\n`);
    } finally {
      writeReport(); // incremental, on error rows too: a crash mid-sweep never loses the paid calls so far
    }
  }
  const fix = writeReport();
  const errors = rows.filter((r) => r.error).length;
  function writeReport() {
    const fixRows = rows.filter((r) => !r.error && outOfUniform(r));
    fs.writeFileSync(OUT, JSON.stringify({ auditedAt: new Date().toISOString(), dir: DIR, total: rows.length, toFix: fixRows.map((r) => r.file), rows }, null, 2));
    return fixRows;
  }
  console.log(`\n${rows.length} images audited · ${fix.length} need regeneration · ${errors} errors · report: ${OUT}`);
  // An unclassified image is an incomplete sweep, not a clean one: exit 1 so
  // a wrapper cannot treat the report as complete (the partial report is on disk).
  if (errors) process.exitCode = 1;
}

module.exports = { classifyUniform, outOfUniform, classifierShapeProblem, PROMPT, MIME };
if (require.main === module) main();
