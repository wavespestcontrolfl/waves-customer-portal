#!/usr/bin/env node
/**
 * uniform-image-audit.js — READ-ONLY vision pass over generated blog images.
 *
 * Owner directive 2026-09-23: Waves techs wear a red long-sleeve polo, a light-blue
 * or red cap, and black/dark-navy pants. This script flags every live image that
 * shows a person dressed otherwise, so ONLY those get regenerated (not all 112).
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
const MODELS = require('../../server/config/models');
const { dispatchWithFallback } = require('../../server/services/llm/call');

const PROMPT = `You are auditing a company blog image. Answer ONLY with JSON:
{"person": true|false, "role": "technician"|"homeowner"|"other"|"none", "shirt": "<color and sleeve length or none>", "cap": "<color or none>", "head": "capped"|"bare"|"hidden", "pants": "<color or none>", "uniform_ok": true|false, "note": "<one short line>"}
Rules: "person" is true only if a human figure (even partial: hands, torso) is visible. A technician is anyone doing pest-control or lawn-care work or wearing work clothes/gloves. "head" is "capped" when the technician wears any cap or hat, "bare" when their head is clearly in frame with no cap or hat, and "hidden" when the head is out of frame, cut off, or hidden. uniform_ok is FALSE when a technician's garment is actually visible AND wrong: a shirt that is not red, a cap that is not light blue or red, pants that are not black/dark navy — or when head is "bare" (a Waves technician always wears a cap). If only hands, gloves or tools are visible (no shirt/cap/pants/head to judge), uniform_ok=true. A homeowner or an image with no person also gets uniform_ok=true (nothing to fix).`;

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
  return { ok: true, parsed };
}
// A technician who is out of uniform — the only case the sweep regenerates. A
// visible bare head counts (the uniform line requires a cap) even when the
// model left uniform_ok true.
function outOfUniform(parsed) {
  if (!parsed || !parsed.person || parsed.role !== 'technician') return false;
  return parsed.uniform_ok === false || String(parsed.head || '').toLowerCase() === 'bare';
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
      const res = await classifyUniform({ buffer: buf, mimeType: MIME[path.extname(rel).toLowerCase()] });
      if (!res.ok) { rows.push({ file: key, path: rel, error: res.reason, raw: res.raw }); process.stdout.write(`? ${key} (${res.reason})\n`); continue; }
      const parsed = res.parsed;
      rows.push({ file: key, path: rel, ...parsed });
      const flag = outOfUniform(parsed);
      process.stdout.write(`${flag ? 'FIX' : ' ok'} ${key}${parsed.person ? ` — ${parsed.role}: ${parsed.shirt}; cap ${parsed.cap} (${parsed.head || '?'}); pants ${parsed.pants}` : ' — no person'}\n`);
    } finally {
      writeReport(); // incremental, on error rows too: a crash mid-sweep never loses the paid calls so far
    }
  }
  const fix = writeReport();
  function writeReport() {
    const fixRows = rows.filter((r) => !r.error && outOfUniform(r));
    fs.writeFileSync(OUT, JSON.stringify({ auditedAt: new Date().toISOString(), dir: DIR, total: rows.length, toFix: fixRows.map((r) => r.file), rows }, null, 2));
    return fixRows;
  }
  console.log(`\n${rows.length} images audited · ${fix.length} need regeneration · ${rows.filter((r) => r.error).length} errors · report: ${OUT}`);
}

module.exports = { classifyUniform, outOfUniform, PROMPT, MIME };
if (require.main === module) main();
