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
 *     node <worktree>/ops/agents/uniform-image-audit.js --dir <folder of images> --out report.json
 *
 * Writes nothing but the report. Fail-open per image (an unreadable image is
 * reported as `error`, never silently dropped).
 */
const fs = require('fs');
const path = require('path');
const MODELS = require('../../server/config/models');
const { dispatchWithFallback } = require('../../server/services/llm/call');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('--dir'); const OUT = opt('--out', 'uniform-audit.json'); const LIMIT = Number(opt('--limit', '0'));
if (!DIR) { console.error('usage: --dir <folder> [--out report.json] [--limit N]'); process.exit(1); }

const PROMPT = `You are auditing a company blog image. Answer ONLY with JSON:
{"person": true|false, "role": "technician"|"homeowner"|"other"|"none", "shirt": "<color and sleeve length or none>", "cap": "<color or none>", "pants": "<color or none>", "uniform_ok": true|false, "note": "<one short line>"}
Rules: "person" is true only if a human figure (even partial: hands, torso) is visible. A technician is anyone doing pest-control or lawn-care work or wearing work clothes/gloves. uniform_ok is FALSE only when a technician's garment is actually visible AND wrong: a shirt that is not red, a cap that is not light blue or red, or pants that are not black/dark navy. If only hands, gloves or tools are visible (no shirt/cap/pants to judge), uniform_ok=true. A homeowner or an image with no person also gets uniform_ok=true (nothing to fix).`;

const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

(async () => {
  const files = fs.readdirSync(DIR).filter((f) => MIME[path.extname(f).toLowerCase()]).sort();
  const todo = LIMIT > 0 ? files.slice(0, LIMIT) : files;
  const rows = [];
  for (const f of todo) {
    const buf = fs.readFileSync(path.join(DIR, f));
    try {
      const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
        text: PROMPT, images: [{ data: buf.toString('base64'), mimeType: MIME[path.extname(f).toLowerCase()] }],
        jsonMode: true, maxTokens: 300, timeoutMs: 60000,
      });
      if (!res.ok) { rows.push({ file: f, error: res.reason || 'vision failed' }); process.stdout.write(`? ${f} (${res.reason})\n`); continue; }
      let parsed = null;
      try { parsed = JSON.parse(String(res.text).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (e) { parsed = null; }
      if (!parsed) { rows.push({ file: f, error: 'unparseable', raw: String(res.text).slice(0, 200) }); process.stdout.write(`? ${f} (unparseable)\n`); continue; }
      rows.push({ file: f, ...parsed });
      const flag = parsed.person && parsed.role === 'technician' && !parsed.uniform_ok;
      process.stdout.write(`${flag ? 'FIX' : ' ok'} ${f}${parsed.person ? ` — ${parsed.role}: ${parsed.shirt}; cap ${parsed.cap}; pants ${parsed.pants}` : ' — no person'}\n`);
    } catch (err) {
      rows.push({ file: f, error: err.message }); process.stdout.write(`? ${f} (${err.message})\n`);
    }
  }
  const fix = rows.filter((r) => r.person && r.role === 'technician' && !r.uniform_ok);
  fs.writeFileSync(OUT, JSON.stringify({ auditedAt: new Date().toISOString(), total: rows.length, toFix: fix.map((r) => r.file), rows }, null, 2));
  console.log(`\n${rows.length} images audited · ${fix.length} need regeneration · ${rows.filter((r) => r.error).length} errors · report: ${OUT}`);
})();
