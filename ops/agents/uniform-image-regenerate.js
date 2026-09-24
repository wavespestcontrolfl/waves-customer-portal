#!/usr/bin/env node
/**
 * uniform-image-regenerate.js — MUTATES (the astro worktree it is pointed at; nothing in
 * this repo and nothing in prod). Regenerates ONLY the blog images that
 * uniform-image-audit.js flagged (a technician out of uniform), through the
 * publisher's own generatePlannedImage path (same plan/style/setting/caption
 * per slug+slot, now with WAVES_UNIFORM_LINE in the prompt), compress to webp,
 * and write them into an astro WORKTREE (never the bare checkout). Alt text is
 * re-derived from the new picture (hero-alt-vision) and vetted by the same
 * content guardrails the publisher applies, so the shipped alt never describes
 * the old blue shirt and never carries a prohibited claim.
 *
 * DRY RUN by default — prints what would be generated and the cost. --execute spends.
 *
 *   cd ~/waves-customer-portal && railway run --service waves-customer-portal -- \
 *     node <portal wt>/ops/agents/uniform-image-regenerate.js \
 *       --report uniform-audit.json --astro ~/wt-astro-uniform [--only <file>] [--avoid "a; b"] [--execute]
 *
 * Every replacement is checked BEFORE anything is written — the uniform
 * classifier (the audit's), the publisher's text/logo screen verdict, and the
 * publisher's near-duplicate check against the post's other images. A failed
 * candidate retries ONCE (fresh seed, next framing) and is otherwise left
 * untouched: the flagged original stays, listed as a failure in the results.
 * `--avoid` carries a post's brief-level `image_avoid` exclusions (semicolon
 * separated) — a published post does not record them, so pass them by hand
 * for the comparison / no-repair posts that have any. Only `.webp` assets are
 * regenerated (the publisher writes nothing else); other formats are skipped
 * with a reason.
 */
const fs = require('fs');
const path = require('path');
const { etDateString } = require('../../server/utils/datetime-et');
const { classifyUniform, outOfUniform } = require('./uniform-image-audit');
const contentGuardrails = require('../../server/services/content/content-guardrails');
const fmParser = require('../../server/services/content-astro/frontmatter');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REPORT = opt('--report'); const ASTRO = opt('--astro'); const ONLY = opt('--only', null);
const AVOID = String(opt('--avoid', '') || '').split(';').map((v) => v.trim()).filter(Boolean);
const LIVE = args.includes('--execute');
if (!REPORT || !ASTRO) { console.error('usage: --report <audit.json> --astro <astro worktree> [--only <file>] [--avoid "a; b"] [--execute]'); process.exit(1); }
// A linked worktree's `.git` is a FILE (`gitdir: .../worktrees/<name>`); the main
// checkout's is a directory. Refuse the main checkout — another session may have
// it on its own branch with staged work, and a --live run would write into it.
const dotGit = path.join(ASTRO, '.git');
const isLinkedWorktree = fs.existsSync(dotGit) && fs.statSync(dotGit).isFile() && /^gitdir:.*[\/]worktrees[\/]/m.test(fs.readFileSync(dotGit, 'utf8'));
if (!isLinkedWorktree) { console.error(`${ASTRO} is not a linked git worktree (a .git FILE pointing into .../worktrees/) — refusing to write into a main checkout`); process.exit(1); }

const HERO_WIDTH = 1600; const BODY_WIDTH = 1200; const EST_COST = 0.17;
const MAX_ATTEMPTS = 2; // one retry, like the publisher's screen/near-duplicate retry
const CAPTION_MAX = 40; // astro-publisher: an infographic slot carries the heading when it is this short

// audit key → repo path: "termite__wdo-inspection-bradenton-fl__hero.webp".
// The extension is preserved (the audit also lists jpg/png); `body-N` is a
// FILE NAME, not the generation slot — the slot comes from the post body.
function repoPathFor(auditKey) {
  const parts = auditKey.split('__');
  const fileName = parts.pop();
  const ext = path.extname(fileName); const file = fileName.slice(0, -ext.length || undefined);
  return { dir: parts.join('/'), file, ext, kind: file === 'hero' ? 'hero' : 'body' };
}
function findPostFile(dir) {
  const stem = dir.split('/').pop();
  const roots = [path.join(ASTRO, 'src/content/blog', dir), path.join(ASTRO, 'src/content/blog', stem)];
  for (const r of roots) for (const ext of ['.mdx', '.md']) if (fs.existsSync(r + ext)) return r + ext;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  return walk(path.join(ASTRO, 'src/content/blog')).find((f) => /\.mdx?$/.test(f) && path.basename(f).replace(/\.mdx?$/, '') === stem) || null;
}
function splitPost(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return { fmText: m ? m[0] : '', body: m ? text.slice(m[0].length) : text };
}
// Astro rule: bump the lastmod field on any content edit (sitemap lastmod).
function bumpModified(text) {
  const today = etDateString(new Date()); // Eastern calendar day, never UTC
  if (/^updated:.*$/m.test(text)) return text.replace(/^updated:.*$/m, `updated: "${today}"`);
  if (/^modified:.*$/m.test(text)) return text.replace(/^modified:.*$/m, `modified: "${today}"`);
  if (/^published:.*$/m.test(text)) return text.replace(/^(published:.*)$/m, `$1\nupdated: "${today}"`);
  return text.replace(/^---\n([\s\S]*?)\n---/, (_, fm) => `---\n${fm}\nupdated: "${today}"\n---`);
}
// The H2 heading + first prose paragraph of the section that holds the image
// (`at` = the image's line within the body, from the publisher's parser).
function sectionFor(body, at) {
  const lines = body.split('\n');
  let h = at; while (h >= 0 && !/^##\s/.test(lines[h])) h--;
  const heading = h >= 0 ? lines[h].replace(/^##\s+/, '').trim() : null;
  let lead = '';
  for (let i = h + 1; i < at; i++) { const l = lines[i].trim(); if (l && !l.startsWith('!') && !l.startsWith('<') && !l.startsWith('#') && !l.startsWith('import')) { lead = l; break; } }
  return { heading, lead };
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
  return fmText + body.slice(0, s.labelStart + 1) + alt.replace(/[[\]]/g, '') + body.slice(s.labelEnd);
}
function replaceHeroAlt(text, alt) {
  const next = text.replace(/^(hero_image:\n(?:[ \t]+\w+:.*\n)*?[ \t]+alt:[ \t]*).*$/m, (_, head) => `${head}${JSON.stringify(alt)}`);
  return next === text ? null : next;
}

// ── plan ────────────────────────────────────────────────────────────
// One audit key → the exact generatePlannedImage inputs the publisher used
// for that slot (frontmatter via the publisher's YAML reader; city from the
// authoritative service_areas_tag; body slot + caption from the rendered
// body-image order), or { skip } with the reason.
function planItem(t, publisher) {
  const { dir, file, ext, kind } = repoPathFor(t);
  if (ext !== '.webp') return { t, skip: `only .webp assets are regenerated (got ${ext}) — convert by hand` };
  const postFile = findPostFile(dir);
  if (!postFile) return { t, skip: 'post file not found' };
  const text = fs.readFileSync(postFile, 'utf8');
  const fm = fmParser.parse(text).data || {};
  const { body } = splitPost(text);
  const imagePath = `/images/blog/${dir}/${file}${ext}`;
  const target = path.join(ASTRO, 'public/images/blog', dir, `${file}${ext}`);
  if (!fs.existsSync(target)) return { t, skip: `image not in worktree: ${target}` };
  const item = { t, kind, postFile: path.relative(ASTRO, postFile), imagePath, target, index: 0, captions: [], ...postFields(fm, dir), siblings: siblingAssets(dir, `${file}${ext}`) };
  if (kind === 'hero') return item;
  const refs = publisher._internals.bodyImageRefs(body).map((r, i) => ({ ...r, ordinal: i, src: String(r.src || '').split(/[?#]/)[0] }));
  const hits = refs.filter((r) => r.src === imagePath);
  if (hits.length !== 1) return { t, skip: hits.length ? `image referenced ${hits.length}× in post body (need exactly one)` : 'image reference not found in post body' };
  const ref = hits[0]; const sec = sectionFor(body, ref.line);
  const heading = String(sec.heading || '').trim();
  return {
    ...item, index: ref.ordinal + 1, ordinal: ref.ordinal,
    keyword: heading || item.keyword, topic: sec.lead || item.topic,
    captions: heading && heading.length <= CAPTION_MAX ? [heading] : [],
    avoid: item.heroAlt || fm.title,
  };
}
// The generation inputs a post's frontmatter supplies (the publisher's own
// YAML reader; city = the authoritative first service_areas_tag, never title copy).
function postFields(fm, dir) {
  const first = (v) => (Array.isArray(v) && v.length ? v[0] : null);
  return {
    slug: String(fm.slug || dir).replace(/^\/|\/$/g, ''),
    title: fm.title, keyword: fm.primary_keyword || fm.keyword || '', topic: fm.meta_description || '',
    city: String(first(fm.service_areas_tag) || ''),
    domains: Array.isArray(fm.domains) ? fm.domains : null,
    heroAlt: typeof fm.hero_image?.alt === 'string' ? fm.hero_image.alt : null,
  };
}
// The post's OTHER images on disk, for the near-duplicate check.
function siblingAssets(dir, exceptFile) {
  const d = path.join(ASTRO, 'public/images/blog', dir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f !== exceptFile && /\.(webp|jpe?g|png)$/i.test(f)).map((f) => ({ label: f, file: path.join(d, f) }));
}
function describe(p) {
  if (p.skip) return `  skip ${p.t}: ${p.skip}`;
  const shot = p.kind === 'body' ? ` (${shotFor(p, 0)})` : '';
  return `  ${p.kind === 'hero' ? 'HERO' : 'BODY' + p.index} ${p.slug} — subject "${p.keyword || p.title}"${shot}${p.captions.length ? ` caption "${p.captions[0]}"` : ''}${p.city ? ` [${p.city}]` : ''}`;
}

// ── generate + verify ───────────────────────────────────────────────
let BODY_IMAGE_SHOTS = [];
function shotFor(p, attempt) { return p.kind === 'body' ? BODY_IMAGE_SHOTS[(p.ordinal + attempt) % BODY_IMAGE_SHOTS.length] : undefined; }

// Why a candidate must not be written, or null when it passes every guard.
async function candidateProblem(p, gen, webp, siblings, publisher) {
  if (gen.screen && gen.screen.checked && !gen.screen.ok) return `failed the text/logo screen: ${(gen.screen.reasons || []).join('; ')}`;
  const verdict = await classifyUniform({ buffer: webp, mimeType: 'image/webp' });
  if (!verdict.ok) throw new Error(`uniform check unavailable (${verdict.reason}) — original left untouched`);
  if (outOfUniform(verdict.parsed)) return `out of uniform: ${verdict.parsed.shirt}; cap ${verdict.parsed.cap} (${verdict.parsed.head || '?'}); pants ${verdict.parsed.pants}`;
  const dup = await publisher._internals.nearDuplicateOf(webp, siblings);
  if (dup.label) return `near-duplicate of the post's ${dup.label}`;
  gen.uniform = verdict.parsed;
  return null;
}
// One generation per attempt; the publisher's +100 index = fresh seed, and a
// body slot also steps to the next framing (its own retry convention).
async function generateVerified(p, ctx) {
  const siblings = [];
  for (const s of p.siblings) siblings.push({ label: s.label, hash: await ctx.publisher._internals.imageDHash(fs.readFileSync(s.file)) });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const gen = await ctx.generatePlannedImage({ title: p.title, topic: p.topic, keyword: p.keyword, city: p.city, mode: p.kind === 'hero' ? 'blog-hero' : 'blog-body', shot: shotFor(p, attempt), avoid: p.avoid, slug: p.slug, index: p.index + attempt * 100, captions: p.captions, avoidDepicting: AVOID });
    const webp = await ctx.compressToWebp(gen.buffer, { width: p.kind === 'hero' ? HERO_WIDTH : BODY_WIDTH });
    const problem = await candidateProblem(p, gen, webp, siblings, ctx.publisher);
    if (!problem) return { gen, webp };
    console.log(`    candidate ${attempt + 1}/${MAX_ATTEMPTS} ${problem}${attempt + 1 < MAX_ATTEMPTS ? ' — retrying with a fresh seed' : ''}`);
  }
  throw new Error(`no compliant replacement after ${MAX_ATTEMPTS} attempts — original left untouched`);
}
// Vision alt over the prompt-derived one, both sanitized, then vetted by the
// publisher's guardrails (prices, product names, brand leaks, compliance
// claims) exactly as the hero/body paths vet theirs. Null = leave the alt.
async function deriveAlt(p, gen, webp, ctx) {
  let vision = null;
  try { vision = await ctx.describeHeroForAlt({ buffer: webp, mimeType: 'image/webp', title: p.title, keyword: p.keyword }); } catch (err) { console.log(`    (vision alt failed: ${err.message} — using generator alt)`); }
  return ctx.publisher._internals.vetGeneratedAlt(ctx.sanitizeAlt(vision), ctx.sanitizeAlt(gen.alt), p.domains);
}
// The image is on disk first; nothing below may leave the post untouched —
// lastmod is bumped regardless so the sitemap sees the changed image.
function writeReplacement(p, webp, alt) {
  fs.writeFileSync(p.target, webp);
  const postPath = path.join(ASTRO, p.postFile);
  const text = fs.readFileSync(postPath, 'utf8');
  const next = alt ? (p.kind === 'hero' ? replaceHeroAlt(text, alt) : replaceBodyAlt(text, p.imagePath, alt)) : null;
  if (!alt) console.log(`    WARNING ${p.t}: no alt passed the guardrails — image swapped, alt left as-is (fix by hand)`);
  else if (next === null) console.log(`    WARNING ${p.t}: image reference could not be rewritten in place — image swapped, alt left as-is (fix by hand)`);
  fs.writeFileSync(postPath, bumpModified(next || text));
  return Boolean(next);
}

(async () => {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  let targets = report.toFix || [];
  if (ONLY) targets = targets.filter((t) => t === ONLY);
  const publisher = require('../../server/services/content-astro/astro-publisher');
  const { describeHeroForAlt, sanitizeAlt } = require('../../server/services/content/hero-alt-vision');
  BODY_IMAGE_SHOTS = publisher._internals.BODY_IMAGE_SHOTS;
  const ctx = { publisher, generatePlannedImage: publisher.generatePlannedImage, compressToWebp: publisher._internals.compressToWebp, describeHeroForAlt, sanitizeAlt };

  const plan = targets.map((t) => planItem(t, publisher));
  const doable = plan.filter((p) => !p.skip);
  console.log(`${targets.length} flagged · ${doable.length} regenerable · ${plan.length - doable.length} skipped · est. $${(doable.length * EST_COST).toFixed(2)} (${LIVE ? 'LIVE' : 'DRY RUN'})\n`);
  for (const p of plan) console.log(describe(p));
  if (!LIVE) return;

  const results = [];
  for (const p of doable) {
    try {
      const { gen, webp } = await generateVerified(p, ctx);
      const alt = await deriveAlt(p, gen, webp, ctx);
      const altUpdated = writeReplacement(p, webp, alt);
      results.push({ t: p.t, ok: true, altUpdated, model: gen.model, style: gen.plan.style, screen: gen.screen && gen.screen.ok, uniform: gen.uniform, alt });
      console.log(`  ✓ ${p.t} via ${gen.model} (${gen.plan.style}) — alt: ${alt ? alt.slice(0, 80) : '(kept)'}`);
    } catch (err) {
      results.push({ t: p.t, ok: false, error: err.message }); console.log(`  ✗ ${p.t}: ${err.message}`);
    }
  }
  fs.writeFileSync(REPORT.replace(/\.json$/, '') + '.regen.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const done = results.filter((r) => r.ok).length;
  console.log(`\n${done}/${doable.length} regenerated · results beside the report`);
})();
