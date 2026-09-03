#!/usr/bin/env node
/**
 * listen-transcripts.js — MUTATES (dry-run default; `seed --execute` writes)
 *
 * "/listen": mines the operator's OWN Claude Code + Codex session transcripts
 * on this machine for blog-topic ideas and hands them to the existing content
 * engine as category-seed briefs parked at `pending_review` — never claimable
 * until the operator approves them in the review queue (requeue → pending).
 *
 * Two modes, so the LLM pass and the DB write are separate, inspectable steps:
 *
 *   extract   reads ~/.claude/projects/** and ~/.codex/sessions/** transcripts
 *             modified in the last --hours (default 24), keeps ONLY user /
 *             assistant prose (never tool results, never thinking blocks),
 *             runs pii-redactor over every chunk BEFORE it leaves the process,
 *             asks the FAST text policy for candidate topics, applies the
 *             waves-content topic-targeting rules, and writes a category-seed
 *             MANIFEST (same schema as server/data/category-seed-topics-v1.json)
 *             to --out. No DB. Prints the candidates.
 *
 *   seed      --file=<manifest> [--only=id,id] [--execute]: validates the
 *             manifest through category-seed-seeder.loadManifest, flags rows
 *             already in opportunity_queue / already a live blog_posts title,
 *             prints what would be written, and on --execute calls
 *             categorySeeder.seedAll({ initialStatus: 'pending_review' }).
 *             Needs DATABASE_PUBLIC_URL (railway run --service Postgres).
 *
 * Privacy contract (tested in server/tests/listen-transcripts.test.js):
 *   - tool_result / tool_use / thinking content is dropped, not redacted —
 *     that is where customer rows, tokens, and file dumps live.
 *   - redact() runs on every chunk before dispatch; phones, emails, cards,
 *     addresses, FL zips and names are tokenised.
 *   - the manifest stores the LLM's summary + a ≤200-char REDACTED evidence
 *     snippet, never raw transcript text.
 *   - strictly outbound blog content: this lane never drafts or sends
 *     customer communications.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--')) || 'extract';
const flag = (name, dflt) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const CHUNK_CHARS = 14000;
const MAX_CHUNKS = Number(flag('max-chunks', 20));
const EVIDENCE_MAX = 200;

// ── transcript readers ───────────────────────────────────────────────

function listRecentFiles(root, sinceMs) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.jsonl')) {
        const mtimeMs = fs.statSync(full).mtimeMs;
        if (mtimeMs >= sinceMs) out.push({ file: full, mtimeMs });
      }
    }
  };
  walk(root);
  // Newest first, so a --max-chunks cap keeps today's sessions, not the
  // oldest file the directory walk happened to reach.
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).map((o) => o.file);
}

function textBlocks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  // ONLY prose blocks. tool_use / tool_result / thinking are dropped whole —
  // they carry file dumps, DB rows and tokens that must never be summarised.
  return content
    .filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string')
    .map((c) => c.text);
}

// Claude Code: one JSON object per line; conversation turns are
// {type:'user'|'assistant', message:{role, content}}. Everything else
// (mode, attachment, file-history-snapshot, …) is harness bookkeeping.
function readClaudeTranscript(file) {
  const turns = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || !o.message) continue;
    if (o.isMeta) continue;
    const texts = textBlocks(o.message.content);
    // A user turn whose only content is tool_result yields nothing here.
    for (const t of texts) {
      if (t.startsWith('<system-reminder>') || t.startsWith('<command-')) continue;
      turns.push({ role: o.message.role || o.type, text: t });
    }
  }
  return turns;
}

// Codex: {type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
// plus {type:'event_msg', payload:{type:'agent_message', message}}. Developer /
// system roles (base instructions) are skipped.
function readCodexTranscript(file) {
  const turns = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    const p = o.payload || {};
    if (o.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      for (const t of textBlocks(p.content)) turns.push({ role: p.role, text: t });
    } else if (o.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') {
      turns.push({ role: 'assistant', text: p.message });
    }
  }
  return turns;
}

function collectTurns({ hours, now = Date.now() }) {
  const sinceMs = now - hours * 3600_000;
  const sources = [];
  for (const f of listRecentFiles(CLAUDE_PROJECTS, sinceMs)) sources.push({ file: f, kind: 'claude', mtimeMs: fs.statSync(f).mtimeMs, turns: readClaudeTranscript(f) });
  for (const f of listRecentFiles(CODEX_SESSIONS, sinceMs)) sources.push({ file: f, kind: 'codex', mtimeMs: fs.statSync(f).mtimeMs, turns: readCodexTranscript(f) });
  return sources.filter((s) => s.turns.length).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ── redaction + chunking ─────────────────────────────────────────────

function redactedChunks(sources, { redact }) {
  const chunks = [];
  let buf = '';
  let stats = { turns: 0, findings: {} };
  const flush = () => { if (buf.trim()) chunks.push(buf); buf = ''; };
  for (const src of sources) {
    for (const turn of src.turns) {
      const clean = redact(turn.text);
      for (const f of clean.findings) stats.findings[f.type] = (stats.findings[f.type] || 0) + (f.count || 1);
      stats.turns += 1;
      const piece = `[${turn.role}] ${clean.text.trim()}\n\n`;
      if (buf.length + piece.length > CHUNK_CHARS) flush();
      // A single oversized turn is truncated, not split — an idea rarely
      // needs more than the first 14k chars of a turn.
      buf += piece.slice(0, CHUNK_CHARS);
    }
  }
  flush();
  return { chunks: chunks.slice(0, MAX_CHUNKS), truncated: chunks.length > MAX_CHUNKS, stats };
}

// ── LLM extraction ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You read redacted engineering-session transcripts from a small pest-control and lawn-care company in Southwest Florida (Manatee / Sarasota / Charlotte counties) and extract IDEAS FOR INFORMATIONAL BLOG POSTS aimed at homeowners.

An idea qualifies only when the transcript contains a genuine homeowner-relevant insight: an incident that reveals a common misunderstanding, a seasonal pest or lawn pattern, a pricing or scheduling rule worth explaining, a treatment-timing nuance, a design decision that reflects how the company actually operates. Internal tooling, code, review rounds, PR mechanics, and customer-specific situations are NOT ideas.

Hard rules (drop an idea rather than bend these):
- Informational lane only: no "near me", no transactional "hire us" framing, no door-to-door sales content.
- Geo: only Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port, Lakewood Ranch, Port Charlotte or generic SWFL. Never target Tampa, Fort Myers, Naples, Orlando, or statewide "in Florida" framing.
- Pesticide idiom: never call a product "safe" (incl. pet-safe / family-safe); say "EPA-registered"; never give a fixed re-entry / drying time in minutes or hours.
- Never invent statistics, customer quotes, or years of experience.
- Slug must start with /pest-control/, /lawn-care/, /tree-shrub/ or /mosquito/. If the slug ends in -<city>-fl/, set "city" to that city name; otherwise leave city null.
- Sources: only URLs on edis.ifas.ufl.edu, gardeningsolutions.ifas.ufl.edu, entnemdept.ufl.edu, epa.gov, fdacs.gov, cdc.gov, or a "Pull the current UF/IFAS EDIS publication on … and verify …" instruction. Never a made-up URL.

Return ONLY JSON: {"ideas":[{"working_title":string,"slug":string,"city":string|null,"primary_kw":string,"secondary_kws":[string],"thesis":string,"outline":[string,...],"sources":[string,...],"why_now":string,"evidence":string(<=200 chars, quoted or paraphrased from the transcript),"confidence":0.0-1.0}]}. Return {"ideas":[]} when nothing qualifies. At most 4 ideas per transcript.`;

const NEAR_ME_RE = /\bnear me\b|\bnearby\b/i;
const OUT_OF_FOOTPRINT_RE = /\b(tampa|fort myers|ft\.? myers|naples|orlando|cape coral|st\.? pete(rsburg)?|clearwater|miami|jacksonville)\b/i;
const STATEWIDE_RE = /\b(in|across|throughout)\s+(florida|fl)\b/i;
const DOOR_TO_DOOR_RE = /door[\s-]to[\s-]door/i;
const SAFE_CLAIM_RE = /\b(pet|family|child|kid|people)[\s-]?safe\b|\bsafe for (pets|dogs|cats|kids|children|family)\b/i;
const REENTRY_MINUTES_RE = /\b\d+\s*(minutes?|mins?|hours?|hrs?)\b.*\b(re-?entry|dry|drying|come back|go back)\b|\b(re-?entry|dry|drying|come back|go back)\b.*\b\d+\s*(minutes?|mins?|hours?|hrs?)\b/i;
const SOURCE_HOSTS = ['edis.ifas.ufl.edu', 'gardeningsolutions.ifas.ufl.edu', 'entnemdept.ufl.edu', 'epa.gov', 'fdacs.gov', 'cdc.gov'];
const FOOTPRINT_CITIES = ['bradenton', 'parrish', 'palmetto', 'sarasota', 'venice', 'north port', 'lakewood ranch', 'port charlotte'];

function ideaText(idea) {
  return [idea.working_title, idea.slug, idea.primary_kw, ...(idea.secondary_kws || []), idea.thesis, ...(idea.outline || [])].filter(Boolean).join(' \n ');
}

function sourceAllowed(src) {
  const s = String(src || '');
  if (/^pull the current/i.test(s) || /^facts-bank:/i.test(s)) return true;
  const m = s.match(/^https?:\/\/([^/]+)/i);
  return !!m && SOURCE_HOSTS.some((h) => m[1] === h || m[1].endsWith(`.${h}`));
}

// Returns null when the idea passes, else the reason it was dropped.
// Mirrors the owner rulings in the waves-content skill so a bad idea never
// reaches the manifest, even if the model ignored the system prompt.
function targetingViolation(idea) {
  const text = ideaText(idea);
  const title = String(idea.working_title || '');
  const slug = String(idea.slug || '');
  if (!title || !slug || !idea.thesis || !Array.isArray(idea.outline) || !idea.outline.length) return 'incomplete';
  if (!/^\/(pest-control|lawn-care|tree-shrub|mosquito)\//.test(slug)) return 'slug_prefix';
  if (NEAR_ME_RE.test(text)) return 'near_me_phrasing';
  if (DOOR_TO_DOOR_RE.test(text)) return 'door_to_door';
  if (OUT_OF_FOOTPRINT_RE.test(`${title} ${slug} ${idea.primary_kw || ''}`)) return 'out_of_footprint_geo';
  if (STATEWIDE_RE.test(`${title} ${slug} ${idea.primary_kw || ''}`) && !FOOTPRINT_CITIES.some((c) => text.toLowerCase().includes(c)) && !/\bswfl\b|southwest florida/i.test(text)) return 'statewide_only';
  if (SAFE_CLAIM_RE.test(text)) return 'safe_claim';
  if (REENTRY_MINUTES_RE.test(text)) return 'reentry_minutes';
  const sources = Array.isArray(idea.sources) ? idea.sources.filter(sourceAllowed) : [];
  if (!sources.length) return 'no_allowed_source';
  const citySuffix = slug.match(/-(bradenton|sarasota|venice|parrish|palmetto|north-port|lakewood-ranch|port-charlotte)-fl\/$/);
  if (citySuffix && String(idea.city || '').trim().toLowerCase() !== citySuffix[1].replace(/-/g, ' ')) return 'city_slug_mismatch';
  return null;
}

function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function briefFor(idea, { now }) {
  const sources = idea.sources.filter(sourceAllowed);
  const id = `listen-${crypto.createHash('sha1').update(normalizeTitle(idea.working_title)).digest('hex').slice(0, 10)}`;
  return {
    id,
    action: 'new_supporting_blog',
    slug: idea.slug,
    city: idea.city || null,
    working_title: idea.working_title,
    primary_kw: idea.primary_kw || null,
    secondary_kws: Array.isArray(idea.secondary_kws) ? idea.secondary_kws.slice(0, 6) : [],
    intent: 'informational',
    window: now.toISOString().slice(0, 10),
    byline: 'adam',
    cta: ['QUOTE'],
    schema_types: ['Article'],
    thesis: idea.thesis,
    outline: idea.outline.slice(0, 10),
    sources,
    verify_notes: [
      'Session-listen idea: every claim in thesis/outline must be re-verified against the listed sources at draft — the transcript is the PROMPT, not a source.',
      `Why now: ${String(idea.why_now || '').slice(0, 300)}`,
      `Evidence (redacted): ${String(idea.evidence || '').slice(0, EVIDENCE_MAX)}`,
    ],
    internal_links: [],
    listen: { confidence: Number(idea.confidence) || 0, extracted_at: now.toISOString() },
  };
}

async function extractIdeas(chunks, { dispatch, policy }) {
  const ideas = [];
  const failures = [];
  for (const [i, chunk] of chunks.entries()) {
    const res = await dispatch(policy, { system: SYSTEM_PROMPT, text: chunk, jsonMode: true, maxTokens: 2500 });
    if (!res.ok || !res.json || !Array.isArray(res.json.ideas)) { failures.push({ chunk: i, reason: res.reason || 'bad_json' }); continue; }
    for (const idea of res.json.ideas) ideas.push(idea);
  }
  return { ideas, failures };
}

function dedupeIdeas(ideas) {
  const seen = new Map();
  for (const idea of ideas) {
    const key = normalizeTitle(idea.working_title);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || (Number(idea.confidence) || 0) > (Number(prev.confidence) || 0)) seen.set(key, idea);
  }
  return [...seen.values()];
}

function buildManifest(ideas, { now }) {
  const kept = [];
  const dropped = [];
  for (const idea of dedupeIdeas(ideas)) {
    const why = targetingViolation(idea);
    if (why) dropped.push({ title: idea.working_title, reason: why });
    else kept.push(briefFor(idea, { now }));
  }
  // Duplicate slugs would fail loadManifest — keep the higher-confidence one.
  const bySlug = new Map();
  for (const b of kept) {
    const prev = bySlug.get(b.slug);
    if (!prev || b.listen.confidence > prev.listen.confidence) bySlug.set(b.slug, b);
  }
  return {
    manifest: {
      version: 1,
      set: 'session-listen',
      owner: 'adam',
      notes: 'Ideas mined from the operator\'s own engineering-session transcripts by ops/agents/listen-transcripts.js. Seeded at pending_review; the operator approves each one in the content review queue before the engine may claim it.',
      cta_codes: {},
      briefs: [...bySlug.values()],
    },
    dropped,
  };
}

// ── seed mode ────────────────────────────────────────────────────────

async function seedFlags(db, briefs) {
  const keys = briefs.map((b) => `catseed:v1:${b.id}`);
  const queued = keys.length ? await db('opportunity_queue').whereIn('dedupe_key', keys).select('dedupe_key', 'status') : [];
  const byKey = new Map(queued.map((r) => [r.dedupe_key, r.status]));
  const titles = briefs.map((b) => normalizeTitle(b.working_title));
  const liveTitles = new Set(
    (await db('blog_posts').select('title')).map((r) => normalizeTitle(r.title)),
  );
  const queuedTitles = new Set(
    (await db('opportunity_queue')
      .whereNotIn('status', ['skipped', 'expired'])
      .whereRaw("signal_metadata->'category_brief'->>'working_title' IS NOT NULL")
      .select(db.raw("signal_metadata->'category_brief'->>'working_title' AS title")))
      .map((r) => normalizeTitle(r.title)),
  );
  return briefs.map((b, i) => ({
    id: b.id,
    title: b.working_title,
    already_queued: byKey.get(keys[i]) || null,
    title_in_queue: !byKey.has(keys[i]) && queuedTitles.has(titles[i]),
    title_is_live_post: liveTitles.has(titles[i]),
  }));
}

async function runSeed({ file, only, execute }) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/listen-transcripts.js seed --file=<manifest>');
    process.exit(2);
  }
  // Route knex at the public proxy BEFORE any require touches the knexfile.
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  const db = require(path.join(REPO_ROOT, 'server/models/db'));
  const seeder = require(path.join(REPO_ROOT, 'server/services/content/category-seed-seeder'));

  const manifest = seeder.loadManifest(file);
  const onlyIds = only ? new Set(String(only).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const briefs = manifest.briefs.filter((b) => !onlyIds || onlyIds.has(b.id));
  if (!briefs.length) { console.error('no briefs selected'); process.exit(2); }

  const flags = await seedFlags(db, briefs);
  const skip = new Set(flags.filter((f) => f.already_queued || f.title_in_queue || f.title_is_live_post).map((f) => f.id));
  console.log(`\n${execute ? 'EXECUTE' : 'DRY RUN'} — ${briefs.length} selected, ${briefs.length - skip.size} to seed at pending_review\n`);
  for (const f of flags) {
    const why = f.already_queued ? `already queued (${f.already_queued})` : f.title_is_live_post ? 'live post with this title' : f.title_in_queue ? 'same title already in queue' : 'seed';
    console.log(`  ${skip.has(f.id) ? 'SKIP' : 'SEED'}  ${f.id}  ${f.title}  — ${why}`);
  }
  const toSeed = briefs.filter((b) => !skip.has(b.id));
  if (!execute || !toSeed.length) { await db.destroy(); return; }

  const tmp = path.join(os.tmpdir(), `listen-seed-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ ...manifest, briefs: toSeed }, null, 2));
  try {
    const result = await seeder.seedAll({ file: tmp, initialStatus: 'pending_review' });
    console.log(`\nseeded ${result.count} row(s) at pending_review — approve in /admin content review (requeue) to release to the engine`);
  } finally {
    fs.unlinkSync(tmp);
    await db.destroy();
  }
}

// ── extract mode ─────────────────────────────────────────────────────

async function runExtract({ hours, out }) {
  const { redact } = require(path.join(REPO_ROOT, 'server/services/content/pii-redactor'));
  const MODELS = require(path.join(REPO_ROOT, 'server/config/models'));
  const { dispatchWithFallback } = require(path.join(REPO_ROOT, 'server/services/llm/call'));
  const now = new Date();

  const sources = collectTurns({ hours, now: now.getTime() });
  const { chunks, truncated, stats } = redactedChunks(sources, { redact });
  console.log(`transcripts: ${sources.length} file(s), ${stats.turns} prose turn(s), ${chunks.length} chunk(s)${truncated ? ` (capped at --max-chunks=${MAX_CHUNKS})` : ''}`);
  console.log(`redacted: ${Object.entries(stats.findings).map(([k, v]) => `${k}×${v}`).join(', ') || 'nothing matched'}`);
  if (!chunks.length) { console.log('nothing to listen to'); return; }

  const { ideas, failures } = await extractIdeas(chunks, { dispatch: dispatchWithFallback, policy: MODELS.TEXT_POLICIES.fastStructured });
  const { manifest, dropped } = buildManifest(ideas, { now });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));

  console.log(`\nideas: ${ideas.length} raw → ${manifest.briefs.length} kept, ${dropped.length} dropped${failures.length ? `, ${failures.length} chunk(s) failed (${failures.map((f) => f.reason).join(', ')})` : ''}`);
  for (const b of manifest.briefs) {
    console.log(`\n  ${b.id}  [${b.listen.confidence.toFixed(2)}]  ${b.working_title}\n    ${b.slug}\n    ${b.thesis}\n    why now: ${b.verify_notes[1].slice(9)}`);
  }
  if (dropped.length) {
    console.log('\ndropped:');
    for (const d of dropped) console.log(`  - ${d.reason}: ${d.title}`);
  }
  console.log(`\nmanifest → ${out}\nnext: railway run --service Postgres node ops/agents/listen-transcripts.js seed --file=${out} [--only=id,id] [--execute]`);
}

if (require.main === module) {
  (async () => {
    if (mode === 'extract') {
      const out = flag('out', path.join(os.tmpdir(), `listen-${new Date().toISOString().slice(0, 10)}.json`));
      await runExtract({ hours: Number(flag('hours', 24)), out });
    } else if (mode === 'seed') {
      const file = flag('file');
      if (!file || file === true) { console.error('seed needs --file=<manifest.json>'); process.exit(2); }
      await runSeed({ file: path.resolve(file), only: flag('only'), execute: flag('execute', false) === true });
    } else {
      console.error(`unknown mode "${mode}" — use extract | seed`);
      process.exit(2);
    }
  })().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = {
  _internals: {
    textBlocks, readClaudeTranscript, readCodexTranscript, redactedChunks, extractIdeas,
    targetingViolation, buildManifest, briefFor, normalizeTitle, sourceAllowed, SYSTEM_PROMPT,
  },
};
