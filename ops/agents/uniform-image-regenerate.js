#!/usr/bin/env node
/**
 * uniform-image-regenerate.js — MUTATES (the astro worktree it is pointed at; nothing in
 * this repo and nothing in prod). Regenerates ONLY the blog images that
 * uniform-image-audit.js flagged (a technician out of uniform), through the
 * publisher's own generatePlannedImage path (same plan/style/setting per
 * slug+slot, now with WAVES_UNIFORM_LINE in the prompt), compress to webp, and
 * write them into an astro WORKTREE (never the bare checkout). Alt text is
 * re-derived from the new picture (hero-alt-vision) so the shipped alt never
 * describes the old blue shirt.
 *
 * DRY RUN by default — prints what would be generated and the cost. --execute spends.
 *
 *   cd ~/waves-customer-portal && railway run --service waves-customer-portal -- \
 *     node <portal wt>/ops/agents/uniform-image-regenerate.js \
 *       --report uniform-audit.json --astro ~/wt-astro-uniform [--only <file>] [--avoid "a; b"] [--execute]
 *
 * Before any write the replacement is run through the same uniform classifier
 * the audit uses; a still-wrong picture retries ONCE with a fresh seed and is
 * otherwise left untouched (the flagged original stays, listed as a failure).
 * `--avoid` carries a post's brief-level `image_avoid` exclusions (semicolon
 * separated) — a published post does not record them, so pass them by hand
 * for the comparison / no-repair posts that have any.
 */
const fs = require('fs');
const path = require('path');
const { etDateString } = require('../../server/utils/datetime-et');
const { classifyUniform, outOfUniform } = require('./uniform-image-audit');
const contentGuardrails = require('../../server/services/content/content-guardrails');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REPORT = opt('--report'); const ASTRO = opt('--astro'); const ONLY = opt('--only', null);
const AVOID = String(opt('--avoid', '') || '').split(';').map((v) => v.trim()).filter(Boolean);
const LIVE = args.includes('--execute');
if (!REPORT || !ASTRO) { console.error('usage: --report <audit.json> --astro <astro worktree> [--only <file>] [--execute]'); process.exit(1); }
// A linked worktree's `.git` is a FILE (`gitdir: .../worktrees/<name>`); the main
// checkout's is a directory. Refuse the main checkout — another session may have
// it on its own branch with staged work, and a --live run would write into it.
const dotGit = path.join(ASTRO, '.git');
const isLinkedWorktree = fs.existsSync(dotGit) && fs.statSync(dotGit).isFile() && /^gitdir:.*[\/]worktrees[\/]/m.test(fs.readFileSync(dotGit, 'utf8'));
if (!isLinkedWorktree) { console.error(`${ASTRO} is not a linked git worktree (a .git FILE pointing into .../worktrees/) — refusing to write into a main checkout`); process.exit(1); }

const HERO_WIDTH = 1600; const BODY_WIDTH = 1200; const EST_COST = 0.17;

// audit file name → repo path: "termite__wdo-inspection-bradenton-fl__hero.webp"
function repoPathFor(auditFile) {
  const parts = auditFile.replace(/\.webp$/, '').split('__');
  const file = parts.pop();
  // `body-N` is a FILE NAME, not the generation slot: the publisher allocates
  // the next free N and plans framing/style from the image's placement (section
  // index) — the slot is recovered below from the post body's image order.
  return { dir: parts.join('/'), file, kind: file === 'hero' ? 'hero' : 'body' };
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
  // hero alt is nested: hero_image:\n  src: ...\n  alt: ...
  const alt = m[1].match(/^hero_image:\n(?:[ \t]+\w+:.*\n)*?[ \t]+alt:[ \t]*(.*)$/m);
  if (alt) fm.hero_image_alt = alt[1].trim().replace(/^['"]|['"]$/g, '');
  return fm;
}
// Astro rule: bump the lastmod field on any content edit (sitemap lastmod).
function bumpModified(text) {
  // Eastern calendar day, never UTC (an evening run must not stamp tomorrow).
  const today = etDateString(new Date());
  if (/^updated:.*$/m.test(text)) return text.replace(/^updated:.*$/m, `updated: "${today}"`);
  if (/^modified:.*$/m.test(text)) return text.replace(/^modified:.*$/m, `modified: "${today}"`);
  // Neither key: insert `updated:` right after `published:` (v2 schema) or as
  // the last frontmatter line, so no swapped image ships with a stale lastmod.
  if (/^published:.*$/m.test(text)) return text.replace(/^(published:.*)$/m, `$1\nupdated: "${today}"`);
  return text.replace(/^---\n([\s\S]*?)\n---/, (_, fm) => `---\n${fm}\nupdated: "${today}"\n---`);
}
function splitPost(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return { fmText: m ? m[0] : '', body: m ? text.slice(m[0].length) : text };
}
// The post's rendered body images in order, through the publisher's own
// parser (inline, titled, angle-bracket and reference-style forms alike).
function bodyRefs(body, publisher) {
  const { bodyImageRefs } = publisher._internals;
  return bodyImageRefs(body).map((r) => ({ ...r, src: String(r.src || '').split(/[?#]/)[0] }));
}
// The H2 heading + first prose paragraph of the section that holds the image
// (`at` = the image's line within the body, from the parser).
function sectionFor(body, at) {
  const lines = body.split('\n');
  let h = at; while (h >= 0 && !/^##\s/.test(lines[h])) h--;
  const heading = h >= 0 ? lines[h].replace(/^##\s+/, '').trim() : null;
  let lead = '';
  for (let i = h + 1; i < at; i++) { const l = lines[i].trim(); if (l && !l.startsWith('!') && !l.startsWith('<') && !l.startsWith('#') && !l.startsWith('import')) { lead = l; break; } }
  return { heading, lead, line: at };
}
// Rewrite the alt of the ONE body image reference whose destination is
// `imagePath`, by span (the shared balanced parser — titled, angle-bracket
// and reference-style forms included), never by a hand regex. Returns the
// new post text, or null when there is not exactly one such reference.
function replaceBodyAlt(text, imagePath, alt) {
  const { fmText, body } = splitPost(text);
  const defs = new Map();
  for (const m of body.matchAll(/^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(\S+)/gm)) defs.set(contentGuardrails.normalizeReferenceLabel(m[1]), m[2].replace(/^<|>$/g, ''));
  const spans = [];
  for (const span of contentGuardrails.eachMarkdownLink(body)) {
    if (!span.isImage) continue;
    let dest = null;
    if (span.kind === 'inline') dest = contentGuardrails.parseLinkDestination(body.slice(span.destStart, span.destEnd + 1), { allowEmpty: true });
    else if (span.kind === 'reference') dest = defs.get(contentGuardrails.normalizeReferenceLabel(body.slice(span.refStart + 1, span.refEnd))) || defs.get(contentGuardrails.normalizeReferenceLabel(body.slice(span.labelStart + 1, span.labelEnd))) || null;
    if (dest !== null && String(dest).split(/[?#]/)[0] === imagePath) spans.push(span);
  }
  if (spans.length !== 1) return null;
  const s = spans[0];
  return fmText + body.slice(0, s.labelStart + 1) + alt.replace(/[\[\]]/g, '') + body.slice(s.labelEnd);
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
    const { dir, file, kind } = repoPathFor(t);
    const postFile = findPostFile(dir);
    if (!postFile) { plan.push({ t, skip: 'post file not found' }); continue; }
    const text = fs.readFileSync(postFile, 'utf8');
    const fm = frontmatter(text);
    const { body } = splitPost(text);
    let index = 0;
    const imagePath = `/images/blog/${dir}/${file}.webp`;
    const target = path.join(ASTRO, 'public/images/blog', dir, `${file}.webp`);
    if (!fs.existsSync(target)) { plan.push({ t, skip: `image not in worktree: ${target}` }); continue; }
    const slug = String(fm.slug || dir).replace(/^\/|\/$/g, '');
    const item = { t, postFile: path.relative(ASTRO, postFile), imagePath, target, kind, index, slug, title: fm.title, keyword: fm.primary_keyword || fm.keyword || '', topic: fm.meta_description || '', city: cityFrom(fm) };
    if (kind === 'body') {
      const refs = bodyRefs(body, publisher);
      const hits = refs.map((r, i) => ({ ...r, ordinal: i })).filter((r) => r.src === imagePath);
      if (hits.length !== 1) { plan.push({ t, skip: hits.length ? `image referenced ${hits.length}× in post body (need exactly one)` : 'image reference not found in post body' }); continue; }
      const ref = hits[0];
      index = ref.ordinal + 1; item.index = index; item.refLine = ref.line;
      const sec = sectionFor(body, ref.line);
      item.keyword = sec.heading || item.keyword; item.topic = sec.lead || item.topic;
      item.shot = BODY_IMAGE_SHOTS[ref.ordinal % BODY_IMAGE_SHOTS.length];
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
      // Generate, then VERIFY the uniform before anything is overwritten: the
      // provider can ignore the uniform sentence, and the publisher's own
      // screen only checks text/logos. One retry under a fresh seed (the
      // publisher's +100 convention); a second miss leaves the original.
      let gen = null; let webp = null; let verdict = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        gen = await generatePlannedImage({ title: p.title, topic: p.topic, keyword: p.keyword, city: p.city, mode: p.kind === 'hero' ? 'blog-hero' : 'blog-body', shot: p.shot, avoid: p.avoid, slug: p.slug, index: p.index + attempt * 100, avoidDepicting: AVOID });
        webp = await compressToWebp(gen.buffer, { width: p.kind === 'hero' ? HERO_WIDTH : BODY_WIDTH });
        verdict = await classifyUniform({ buffer: webp, mimeType: 'image/webp' });
        if (!verdict.ok) throw new Error(`uniform check unavailable (${verdict.reason}) — original left untouched`);
        if (!outOfUniform(verdict.parsed)) break;
        console.log(`    replacement ${attempt === 0 ? 'out of uniform, retrying with a fresh seed' : 'STILL out of uniform'}: ${verdict.parsed.shirt}; cap ${verdict.parsed.cap} (${verdict.parsed.head || '?'}); pants ${verdict.parsed.pants}`);
        if (attempt === 1) throw new Error('replacement still out of uniform after retry — original left untouched');
      }
      fs.writeFileSync(p.target, webp);
      // The image is on disk now; nothing below may leave the post untouched.
      // Vision alt is best-effort (fail-open to the generator's prompt-derived
      // alt, which always exists for a non-custom prompt); a miss on both is
      // reported as a WARNING on a successful swap, and lastmod is bumped
      // regardless so the sitemap sees the changed image.
      let vision = null;
      try { vision = await describeHeroForAlt({ buffer: webp, mimeType: 'image/webp', title: p.title, keyword: p.keyword }); } catch (err) { console.log(`    (vision alt failed: ${err.message} — using generator alt)`); }
      const alt = sanitizeAlt(vision) || sanitizeAlt(gen.alt) || null;
      let altUpdated = false;
      {
        let text = fs.readFileSync(path.join(ASTRO, p.postFile), 'utf8');
        if (!alt) {
          console.log(`    WARNING ${p.t}: no alt could be derived — image swapped, alt left as-is (fix by hand)`);
        } else if (p.kind === 'hero') {
          // nested hero_image.alt — replace only the alt line inside that block
          const next = text.replace(/^(hero_image:\n(?:[ \t]+\w+:.*\n)*?[ \t]+alt:[ \t]*).*$/m, (_, head) => `${head}${JSON.stringify(alt)}`);
          altUpdated = next !== text; text = next;
        } else {
          const next = replaceBodyAlt(text, p.imagePath, alt);
          altUpdated = next !== null; if (next !== null) text = next;
        }
        if (alt && !altUpdated) console.log(`    WARNING ${p.t}: image reference could not be rewritten in place — image swapped, alt left as-is (fix by hand)`);
        fs.writeFileSync(path.join(ASTRO, p.postFile), bumpModified(text));
      }
      done++; results.push({ t: p.t, ok: true, altUpdated, model: gen.model, style: gen.plan.style, screen: gen.screen && gen.screen.ok, uniform: verdict.parsed, alt });
      console.log(`  ✓ ${p.t} via ${gen.model} (${gen.plan.style}) — alt: ${alt ? alt.slice(0, 80) : '(kept)'}`);
    } catch (err) {
      results.push({ t: p.t, ok: false, error: err.message }); console.log(`  ✗ ${p.t}: ${err.message}`);
    }
  }
  fs.writeFileSync(REPORT.replace(/\.json$/, '') + '.regen.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${done}/${doable.length} regenerated · results beside the report`);
})();
