#!/usr/bin/env node
/**
 * uniform-image-regenerate.js — regenerate ONLY the blog images that
 * uniform-image-audit.js flagged (a technician out of uniform), through the
 * publisher's own generatePlannedImage path (same plan/style/setting per
 * slug+slot, now with WAVES_UNIFORM_LINE in the prompt), compress to webp, and
 * write them into an astro WORKTREE (never the bare checkout). Alt text is
 * re-derived from the new picture (hero-alt-vision) so the shipped alt never
 * describes the old blue shirt.
 *
 * DRY RUN by default — prints what would be generated and the cost. --live spends.
 *
 *   cd ~/waves-customer-portal && railway run --service waves-customer-portal -- \
 *     node <portal wt>/ops/agents/uniform-image-regenerate.js \
 *       --report uniform-audit.json --astro ~/wt-astro-uniform [--only <file>] [--live]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REPORT = opt('--report'); const ASTRO = opt('--astro'); const ONLY = opt('--only', null);
const LIVE = args.includes('--live');
if (!REPORT || !ASTRO) { console.error('usage: --report <audit.json> --astro <astro worktree> [--only <file>] [--live]'); process.exit(1); }
if (!fs.existsSync(path.join(ASTRO, '.git'))) { console.error(`${ASTRO} is not a git worktree/checkout`); process.exit(1); }

const HERO_WIDTH = 1600; const BODY_WIDTH = 1200; const EST_COST = 0.17;

// audit file name → repo path: "termite__wdo-inspection-bradenton-fl__hero.webp"
function repoPathFor(auditFile) {
  const parts = auditFile.replace(/\.webp$/, '').split('__');
  const file = parts.pop();
  return { dir: parts.join('/'), file, kind: file === 'hero' ? 'hero' : 'body', index: file === 'hero' ? 0 : Number(file.replace('body-', '')) };
}
function findPostFile(dir) {
  const stem = dir.split('/').pop();
  const roots = [path.join(ASTRO, 'src/content/blog', dir), path.join(ASTRO, 'src/content/blog', stem)];
  for (const r of roots) for (const ext of ['.mdx', '.md']) if (fs.existsSync(r + ext)) return r + ext;
  // legacy flat images under a category-less dir: search by stem
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  return walk(path.join(ASTRO, 'src/content/blog')).find((f) => /\.mdx?$/.test(f) && path.basename(f).replace(/\.mdx?$/, '') === stem) || null;
}
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/); const fm = {};
  if (!m) return fm;
  for (const line of m[1].split('\n')) { const k = line.match(/^([a-z_]+):\s*(.*)$/i); if (k) fm[k[1]] = k[2].replace(/^['"]|['"]$/g, ''); }
  return fm;
}
// The H2 heading + first prose paragraph of the section that holds the image.
function sectionFor(text, imagePath) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes(`](${imagePath})`));
  if (at < 0) return null;
  let h = at; while (h >= 0 && !/^##\s/.test(lines[h])) h--;
  const heading = h >= 0 ? lines[h].replace(/^##\s+/, '').trim() : null;
  let lead = '';
  for (let i = h + 1; i < at; i++) { const l = lines[i].trim(); if (l && !l.startsWith('!') && !l.startsWith('<') && !l.startsWith('#') && !l.startsWith('import')) { lead = l; break; } }
  return { heading, lead, line: at };
}
function cityFrom(fm) {
  const m = String(fm.title || '').match(/\b(Sarasota|Bradenton|Venice|Parrish|Lakewood Ranch|Palmetto|North Port|Manatee County)\b/i);
  return m ? m[1] : '';
}

(async () => {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  let targets = report.toFix || [];
  if (ONLY) targets = targets.filter((t) => t === ONLY);
  const publisher = require('../../server/services/content-astro/astro-publisher');
  const { compressToWebp, BODY_IMAGE_SHOTS } = publisher._internals;
  const { generatePlannedImage } = publisher;
  const { describeHeroForAlt, sanitizeAlt } = require('../../server/services/content/hero-alt-vision');

  const plan = [];
  for (const t of targets) {
    const { dir, file, kind, index } = repoPathFor(t);
    const postFile = findPostFile(dir);
    if (!postFile) { plan.push({ t, skip: 'post file not found' }); continue; }
    const text = fs.readFileSync(postFile, 'utf8');
    const fm = frontmatter(text);
    const imagePath = `/images/blog/${dir}/${file}.webp`;
    const target = path.join(ASTRO, 'public/images/blog', dir, `${file}.webp`);
    if (!fs.existsSync(target)) { plan.push({ t, skip: `image not in worktree: ${target}` }); continue; }
    const slug = String(fm.slug || dir).replace(/^\/|\/$/g, '');
    const item = { t, postFile: path.relative(ASTRO, postFile), imagePath, target, kind, index, slug, title: fm.title, keyword: fm.primary_keyword || fm.keyword || '', topic: fm.meta_description || '', city: cityFrom(fm) };
    if (kind === 'body') {
      const sec = sectionFor(text, imagePath);
      if (!sec) { plan.push({ t, skip: 'image reference not found in post body' }); continue; }
      item.keyword = sec.heading || item.keyword; item.topic = sec.lead || item.topic;
      item.shot = BODY_IMAGE_SHOTS[(index - 1) % BODY_IMAGE_SHOTS.length];
      item.avoid = fm.hero_image_alt || fm.title;
    }
    plan.push(item);
  }

  const doable = plan.filter((p) => !p.skip);
  console.log(`${targets.length} flagged · ${doable.length} regenerable · ${plan.length - doable.length} skipped · est. $${(doable.length * EST_COST).toFixed(2)} (${LIVE ? 'LIVE' : 'DRY RUN'})\n`);
  for (const p of plan) console.log(p.skip ? `  skip ${p.t}: ${p.skip}` : `  ${p.kind === 'hero' ? 'HERO' : 'BODY' + p.index} ${p.slug} — subject "${p.keyword || p.title}"${p.shot ? ` (${p.shot})` : ''}${p.city ? ` [${p.city}]` : ''}`);
  if (!LIVE) return;

  let done = 0; const results = [];
  for (const p of doable) {
    try {
      const gen = await generatePlannedImage({ title: p.title, topic: p.topic, keyword: p.keyword, city: p.city, mode: p.kind === 'hero' ? 'blog-hero' : 'blog-body', shot: p.shot, avoid: p.avoid, slug: p.slug, index: p.index });
      const webp = await compressToWebp(gen.buffer, { width: p.kind === 'hero' ? HERO_WIDTH : BODY_WIDTH });
      fs.writeFileSync(p.target, webp);
      const vision = await describeHeroForAlt({ buffer: webp, mimeType: 'image/webp', title: p.title, keyword: p.keyword });
      const alt = sanitizeAlt(vision) || gen.alt || null;
      if (alt) {
        let text = fs.readFileSync(p.postFile.startsWith('/') ? p.postFile : path.join(ASTRO, p.postFile), 'utf8');
        if (p.kind === 'hero') {
          if (/^hero_image_alt:.*$/m.test(text)) text = text.replace(/^hero_image_alt:.*$/m, `hero_image_alt: ${JSON.stringify(alt)}`);
        } else {
          const re = new RegExp(`!\\[[^\\]]*\\]\\(${p.imagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`);
          text = text.replace(re, `![${alt.replace(/\]/g, '')}](${p.imagePath})`);
        }
        fs.writeFileSync(path.join(ASTRO, p.postFile), text);
      }
      done++; results.push({ t: p.t, ok: true, model: gen.model, style: gen.plan.style, screen: gen.screen && gen.screen.ok, alt });
      console.log(`  ✓ ${p.t} via ${gen.model} (${gen.plan.style}) — alt: ${alt ? alt.slice(0, 80) : '(kept)'}`);
    } catch (err) {
      results.push({ t: p.t, ok: false, error: err.message }); console.log(`  ✗ ${p.t}: ${err.message}`);
    }
  }
  fs.writeFileSync(REPORT.replace(/\.json$/, '') + '.regen.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${done}/${doable.length} regenerated · results beside the report`);
})();
