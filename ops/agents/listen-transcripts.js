#!/usr/bin/env node
/**
 * listen-transcripts.js — MUTATES (dry-run default; --execute writes: extract → the --out file, seed → the DB)
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
 *             to --out with --execute (without --execute ⇒ printed only, nothing written).
 *             No DB. Prints the candidates.
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
// extract is documented as "no DB": dispatchWithFallback records one
// llm_dispatch_log row per call when GATE_LLM_DISPATCH_METRICS is on and a
// DATABASE_URL happens to be in the shell. feature-gates reads the env at
// require time, so the kill is set here, before any require (Codex r1 P1).
if (mode === 'extract') process.env.GATE_LLM_DISPATCH_METRICS = 'false';
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
const { etDateString } = require(path.join(REPO_ROOT, 'server/utils/datetime-et'));

// pii-redactor knows people, not credentials: a pasted key or token comes
// back unchanged at confidence 'high'. Any turn that still carries one after
// redaction is withheld whole (Codex r2 P1). Deliberately broad — a false
// positive costs one turn of context, a miss ships a secret to a provider.
const SECRET_RES = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,          // Stripe
  /\bwhsec_[A-Za-z0-9]{8,}/,                                // Stripe webhook
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWT
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/,           // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,                         // Slack
  /\bAKIA[0-9A-Z]{16}\b/,                                   // AWS
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,                 // Anthropic / OpenAI
  /\bAIza[0-9A-Za-z_-]{30,}/,                               // Google
  /\bAC[0-9a-f]{32}\b|\bSK[0-9a-f]{32}\b/,                 // Twilio SID / key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|DATABASE_URL)\s*[=:]\s*['"]?[^\s'"]{8,}/, // FOO_TOKEN=…
  /\bpostgres(?:ql)?:\/\/[^\s]+:[^\s@]+@/,                // DSN with password
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}/i,          // Authorization header values
];
function containsSecret(text) {
  return SECRET_RES.some((re) => re.test(text));
}

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

// The --hours window is a PRIVACY contract, not a scan hint: a long-running
// or recently touched session must not carry turns older than the window to
// the LLM. Every transcript line is stamped in both formats; a line with no
// parseable stamp is treated as outside the window (fail closed).
function inWindow(entry, sinceMs) {
  if (!sinceMs) return true;
  const t = Date.parse(entry.timestamp || '');
  return Number.isFinite(t) && t >= sinceMs;
}

// Harness blocks (<system-reminder>, <command-…>) can sit after prose or
// behind leading whitespace, not only at the start of a block; they carry
// injected context and file-derived material the privacy contract says
// never leaves the Mac, so they are stripped wherever they appear and a
// block that was only harness text is dropped (Codex r4 P1).
const HARNESS_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>|<(command-[a-z-]+)>[\s\S]*?<\/\1>/g;
function stripHarnessBlocks(text) {
  let out = String(text || '').replace(HARNESS_BLOCK_RE, ' ');
  // An unterminated block (truncated line) is dropped to its end.
  out = out.replace(/<system-reminder>[\s\S]*$|<command-[a-z-]+>[\s\S]*$/, ' ');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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
function readClaudeTranscript(file, { sinceMs = 0 } = {}) {
  const turns = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || !o.message) continue;
    if (o.isMeta || !inWindow(o, sinceMs)) continue;
    const texts = textBlocks(o.message.content);
    // A user turn whose only content is tool_result yields nothing here.
    for (const raw of texts) {
      const t = stripHarnessBlocks(raw);
      if (t) turns.push({ role: o.message.role || o.type, text: t });
    }
  }
  return turns;
}

// Codex: {type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
// plus {type:'event_msg', payload:{type:'agent_message', message}}. Developer /
// system roles (base instructions) are skipped.
function readCodexTranscript(file, { sinceMs = 0 } = {}) {
  const turns = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!inWindow(o, sinceMs)) continue;
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
  // mtime is only the scan filter; the per-turn stamp is the window.
  for (const f of listRecentFiles(CLAUDE_PROJECTS, sinceMs)) sources.push({ file: f, kind: 'claude', mtimeMs: fs.statSync(f).mtimeMs, turns: readClaudeTranscript(f, { sinceMs }) });
  for (const f of listRecentFiles(CODEX_SESSIONS, sinceMs)) sources.push({ file: f, kind: 'codex', mtimeMs: fs.statSync(f).mtimeMs, turns: readCodexTranscript(f, { sinceMs }) });
  return sources.filter((s) => s.turns.length).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ── redaction + chunking ─────────────────────────────────────────────

function redactedChunks(sources, { redact }) {
  const stats = { turns: 0, withheld: 0, findings: {} };
  // Chunk per source so the cap can keep the NEWEST material: sources arrive
  // newest-first, turns inside a source oldest-first, so a long session
  // contributes its latest chunks first (Codex r1 P2).
  const perSource = sources.map((src) => {
    const chunks = [];
    let buf = '';
    const flush = () => { if (buf.trim()) chunks.push(buf); buf = ''; };
    for (const turn of src.turns) {
      const clean = redact(turn.text);
      for (const f of clean.findings) stats.findings[f.type] = (stats.findings[f.type] || 0) + (f.count || 1);
      stats.turns += 1;
      // pii-redactor returns the ORIGINAL text at confidence 'low' when it
      // cannot safely tokenise (all-lowercase names, suspicious unstructured
      // runs). That text never leaves the machine — the turn is withheld
      // whole (Codex r1 P1).
      if (clean.confidence === 'low' || containsSecret(clean.text)) { stats.withheld += 1; continue; }
      const piece = `[${turn.role}] ${clean.text.trim()}\n\n`;
      if (buf.length + piece.length > CHUNK_CHARS) flush();
      // A single oversized turn is truncated, not split — an idea rarely
      // needs more than the first 14k chars of a turn.
      buf += piece.slice(0, CHUNK_CHARS);
    }
    flush();
    return chunks;
  });
  const total = perSource.reduce((n, c) => n + c.length, 0);
  const ordered = [];
  for (const chunks of perSource) for (let i = chunks.length - 1; i >= 0; i--) ordered.push(chunks[i]);
  return { chunks: ordered.slice(0, MAX_CHUNKS), truncated: total > MAX_CHUNKS, stats };
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

const PINNED_SLUG_RE = /^\/(pest-control|lawn-care|tree-shrub|mosquito)\/[a-z0-9-]+\/$/;
const NEAR_ME_RE = /\bnear me\b|\bnearby\b/i;
const DOOR_TO_DOOR_RE = /door[\s-]to[\s-]door/i;
const SOURCE_HOSTS = ['edis.ifas.ufl.edu', 'gardeningsolutions.ifas.ufl.edu', 'entnemdept.ufl.edu', 'epa.gov', 'fdacs.gov', 'cdc.gov'];
const PULL_INSTRUCTION_RE = /^pull the current uf\/ifas edis publication\b/i;
// The canonical gates the engine applies pre-draft / at publish — reused here
// so the review lane never offers an idea the runner would reject later
// (Codex r1 P1 ×2): geography from topic-targeting-gate (full out-of-area
// list, strict statewide framing), compliance idiom + banned topics from
// content-guardrails.
const targetingGate = require(path.join(REPO_ROOT, 'server/services/content/topic-targeting-gate'));
const { reentrySafetyClaimFinding, bannedTopicFinding } = require(path.join(REPO_ROOT, 'server/services/content/content-guardrails'))._internals;

function ideaText(idea) {
  return [idea.working_title, idea.slug, idea.primary_kw, ...(idea.secondary_kws || []), idea.thesis, ...(idea.outline || [])].filter(Boolean).join(' \n ');
}

function sourceAllowed(src) {
  const s = String(src || '');
  if (PULL_INSTRUCTION_RE.test(s) || /^facts-bank:/i.test(s)) return true;
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
  // The runner honours an operator pin only as an exact lowercase two-segment
  // /category/leaf/ path (autonomous-runner applyOperatorSlugRepair); anything
  // else survives review and then parks at generation, so reject it here
  // (Codex r3 P2).
  if (!PINNED_SLUG_RE.test(slug)) return 'slug_shape';
  if (NEAR_ME_RE.test(text)) return 'near_me_phrasing';
  if (DOOR_TO_DOOR_RE.test(text) || bannedTopicFinding(text)) return 'banned_topic';
  // Framing parts only (title / slug / keyword) — an outline may MENTION
  // Tampa educationally; the post may not be built around it.
  // The city is a semantic field the writer is bound to ("City: Tampa"), so
  // it is framing even when title/slug/keyword are generic (Codex r4 P2).
  const geo = targetingGate.geoBlockReason(`${title} ${slug.replace(/[-/]/g, ' ')} ${idea.primary_kw || ''} ${idea.city || ''}`);
  if (geo === targetingGate.CODES.GEO_OUT_OF_AREA) return 'out_of_footprint_geo';
  if (geo) return 'statewide_only';
  if (reentrySafetyClaimFinding(text)) return 'reentry_safety_claim';
  const sources = Array.isArray(idea.sources) ? idea.sources : [];
  if (!sources.length) return 'no_allowed_source';
  // The seeder turns EVERY listed source into a binding citation, so one
  // unapproved URL next to an approved one is still a violation (Codex r4 P2).
  if (sources.some((src) => !sourceAllowed(src))) return 'disallowed_source';
  const citySuffix = slug.match(/-(bradenton|sarasota|venice|parrish|palmetto|north-port|lakewood-ranch|port-charlotte)-fl\/$/);
  if (citySuffix && String(idea.city || '').trim().toLowerCase() !== citySuffix[1].replace(/-/g, ' ')) return 'city_slug_mismatch';
  return null;
}

function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Inverse of briefFor, so seed mode can re-run targetingViolation on a brief
// the owner edited by hand.
function ideaFromBrief(b) {
  return {
    working_title: b.working_title, slug: b.slug, city: b.city || null, primary_kw: b.primary_kw || '',
    secondary_kws: Array.isArray(b.secondary_kws) ? b.secondary_kws : [], thesis: b.thesis,
    outline: Array.isArray(b.outline) ? b.outline : [], sources: Array.isArray(b.sources) ? b.sources : [],
  };
}

function briefFor(idea, { now }) {
  const sources = idea.sources;
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
    window: etDateString(now), // ET calendar day — availableAtFor reads it as ET midnight (Codex r1 P1)
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

// One malformed entry must not abort the whole extraction: coerce the
// list fields, drop entries missing the required strings (Codex r1 P2).
function shapeIdea(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const idea = {
    working_title: str(raw.working_title), slug: str(raw.slug), city: str(raw.city) || null,
    primary_kw: str(raw.primary_kw), secondary_kws: list(raw.secondary_kws), thesis: str(raw.thesis),
    outline: list(raw.outline), sources: list(raw.sources), why_now: str(raw.why_now), evidence: str(raw.evidence),
    confidence: Number(raw.confidence) || 0,
  };
  if (!idea.working_title || !idea.slug || !idea.thesis || !idea.outline.length) return null;
  return idea;
}

async function extractIdeas(chunks, { dispatch, policy }) {
  const ideas = [];
  const failures = [];
  for (const [i, chunk] of chunks.entries()) {
    const res = await dispatch(policy, { system: SYSTEM_PROMPT, text: chunk, jsonMode: true, maxTokens: 2500 });
    if (!res.ok || !res.json || !Array.isArray(res.json.ideas)) { failures.push({ chunk: i, reason: res.reason || 'bad_json' }); continue; }
    for (const idea of res.json.ideas) {
      const shaped = shapeIdea(idea);
      if (shaped) ideas.push(shaped); else failures.push({ chunk: i, reason: 'malformed_idea' });
    }
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

const TERMINAL_QUEUE_STATUSES = new Set(['skipped', 'expired']);

// Live-corpus verdict for one brief through the SAME topic-targeting gate
// the runner applies pre-draft (geo framing, semantic city, entity / slug
// ownership against the live Astro blog corpus). A title-only lookup let
// candidates through that the runner would reject after the owner had
// already released them (Codex r4 P1).
function liveCorpusVerdict(brief, index) {
  const r = targetingGate.evaluate({
    actionType: 'new_supporting_blog',
    query: brief.primary_kw || null,
    title: brief.working_title || null,
    slug: brief.slug || null,
    city: brief.city || null,
  }, { index, requireCorpus: true });
  return r.ok ? null : r.findings.map((f) => f.code).join(',');
}

async function seedFlags(db, briefs, { index }) {
  const keys = briefs.map((b) => `catseed:v1:${b.id}`);
  const queued = keys.length ? await db('opportunity_queue').whereIn('dedupe_key', keys).select('id', 'dedupe_key', 'status') : [];
  const byKey = new Map(queued.map((r) => [r.dedupe_key, r]));
  // A dismissed row whose latest run is still completed_pending_review must
  // not be revived by a reseed: the review read model would surface that
  // old draft with Approve & publish. Reopen it from the review queue
  // instead (Codex r4 P1).
  const terminalIds = queued.filter((r) => TERMINAL_QUEUE_STATUSES.has(r.status)).map((r) => r.id);
  const reviewableRuns = new Set(terminalIds.length
    ? (await db('autonomous_runs').whereIn('opportunity_id', terminalIds).where('outcome', 'completed_pending_review').select('opportunity_id')).map((r) => r.opportunity_id)
    : []);
  const titles = briefs.map((b) => normalizeTitle(b.working_title));
  const queuedTitles = new Set(
    (await db('opportunity_queue')
      .whereNotIn('status', [...TERMINAL_QUEUE_STATUSES])
      .whereRaw("signal_metadata->'category_brief'->>'working_title' IS NOT NULL")
      .select(db.raw("signal_metadata->'category_brief'->>'working_title' AS title")))
      .map((r) => normalizeTitle(r.title)),
  );
  return briefs.map((b, i) => {
    const row = byKey.get(keys[i]) || null;
    return {
      id: b.id,
      title: b.working_title,
      already_queued: row ? row.status : null,
      prior_run_reviewable: !!(row && reviewableRuns.has(row.id)),
      title_in_queue: !row && queuedTitles.has(titles[i]),
      live_corpus_block: liveCorpusVerdict(b, index),
    };
  });
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
  if (onlyIds) {
    const known = new Set(manifest.briefs.map((b) => b.id));
    const unknown = [...onlyIds].filter((id) => !known.has(id));
    // A mistyped id must not silently shrink an --execute run (Codex r1 P2).
    if (unknown.length) { console.error(`--only names ids not in the manifest: ${unknown.join(', ')}`); process.exit(2); }
  }
  const briefs = manifest.briefs.filter((b) => !onlyIds || onlyIds.has(b.id));
  if (!briefs.length) { console.error('no briefs selected'); process.exit(2); }

  // The owner edits manifests in place during the brainstorm; loadManifest
  // checks shape, not rulings. Re-run the extraction predicate on every
  // selected brief before any DB work (Codex r2 P2).
  const violations = briefs.map((b) => [b.id, targetingViolation(ideaFromBrief(b))]).filter(([, why]) => why);
  if (violations.length) {
    console.error(`refusing to seed — targeting rulings failed: ${violations.map(([id, why]) => `${id}=${why}`).join(', ')}`);
    await db.destroy();
    process.exit(2);
  }
  // The live Astro blog corpus is REQUIRED (fail closed): without it the
  // ownership check cannot run and the owner would approve rows the runner
  // rejects.
  let index;
  try {
    index = await targetingGate.loadLiveIndex();
  } catch (err) {
    console.error(`refusing to seed — live blog corpus unavailable for the topic-targeting gate (${err.message})`);
    await db.destroy();
    process.exit(2);
  }
  const flags = await seedFlags(db, briefs, { index });
  // A dismissed (skipped) or expired row is the seeder's own revival case
  // (category-seed-seeder ON CONFLICT revives it at the initial status with
  // a reset claim budget) — only a live queue status, or a prior run that
  // is still reviewable, blocks a reseed (Codex r3 P2 + r4 P1).
  const blocksReseed = (f) => f.already_queued && (!TERMINAL_QUEUE_STATUSES.has(f.already_queued) || f.prior_run_reviewable);
  const skip = new Set(flags.filter((f) => blocksReseed(f) || f.title_in_queue || f.live_corpus_block).map((f) => f.id));
  console.log(`\n${execute ? 'EXECUTE' : 'DRY RUN'} — ${briefs.length} selected, ${briefs.length - skip.size} to seed at pending_review\n`);
  for (const f of flags) {
    const why = f.already_queued && f.prior_run_reviewable ? `${f.already_queued} with a still-reviewable run — requeue it from the review queue, not a reseed`
      : blocksReseed(f) ? `already queued (${f.already_queued})`
        : f.live_corpus_block ? `topic-targeting gate: ${f.live_corpus_block}`
          : f.title_in_queue ? 'same title already in queue'
            : f.already_queued ? `revive (${f.already_queued})` : 'seed';
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

async function runExtract({ hours, out, execute }) {
  const { redact } = require(path.join(REPO_ROOT, 'server/services/content/pii-redactor'));
  const MODELS = require(path.join(REPO_ROOT, 'server/config/models'));
  const { dispatchWithFallback } = require(path.join(REPO_ROOT, 'server/services/llm/call'));
  const now = new Date();

  const sources = collectTurns({ hours, now: now.getTime() });
  const { chunks, truncated, stats } = redactedChunks(sources, { redact });
  console.log(`transcripts: ${sources.length} file(s), ${stats.turns} prose turn(s), ${chunks.length} chunk(s)${truncated ? ` (capped at --max-chunks=${MAX_CHUNKS})` : ''}`);
  console.log(`redacted: ${Object.entries(stats.findings).map(([k, v]) => `${k}×${v}`).join(', ') || 'nothing matched'}; ${stats.withheld} turn(s) withheld (low-confidence redaction)`);
  if (!chunks.length) { console.log('nothing to listen to'); return; }

  const { ideas, failures } = await extractIdeas(chunks, { dispatch: dispatchWithFallback, policy: MODELS.TEXT_POLICIES.fastStructured });
  const { manifest, dropped } = buildManifest(ideas, { now });
  // MUTATES contract: --out names the destination, --execute authorizes the
  // write (Codex r2+r3 P1). Without --execute the manifest is printed as JSON
  // and nothing touches the filesystem.
  const write = !!(out && execute);
  if (write) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  }

  console.log(`\nideas: ${ideas.length} raw → ${manifest.briefs.length} kept, ${dropped.length} dropped${failures.length ? `, ${failures.length} chunk(s) failed (${failures.map((f) => f.reason).join(', ')})` : ''}`);
  for (const b of manifest.briefs) {
    console.log(`\n  ${b.id}  [${b.listen.confidence.toFixed(2)}]  ${b.working_title}\n    ${b.slug}\n    ${b.thesis}\n    why now: ${b.verify_notes[1].slice(9)}`);
  }
  if (dropped.length) {
    console.log('\ndropped:');
    for (const d of dropped) console.log(`  - ${d.reason}: ${d.title}`);
  }
  if (write) {
    console.log(`\nmanifest → ${out}\nnext: railway run --service Postgres node ops/agents/listen-transcripts.js seed --file=${out} [--only=id,id] [--execute]`);
  } else if (manifest.briefs.length) {
    const dest = out || path.join(os.tmpdir(), `listen-${etDateString(now)}.json`);
    console.log(`\nDRY RUN — manifest NOT written. Re-run with --out=${dest} --execute to keep it:\n`);
    console.log(JSON.stringify(manifest, null, 2));
  }
}

if (require.main === module) {
  (async () => {
    if (mode === 'extract') {
      const outFlag = flag('out', null);
      if (outFlag === true) { console.error('--out needs a path (--out=/tmp/listen-<date>.json)'); process.exit(2); }
      const execute = flag('execute', false) === true;
      if (execute && !outFlag) { console.error('--execute needs --out=<path> to write to'); process.exit(2); }
      await runExtract({ hours: Number(flag('hours', 24)), out: outFlag ? path.resolve(outFlag) : null, execute });
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
    textBlocks, stripHarnessBlocks, inWindow, readClaudeTranscript, liveCorpusVerdict, readCodexTranscript, redactedChunks, extractIdeas,
    targetingViolation, buildManifest, briefFor, ideaFromBrief, normalizeTitle, sourceAllowed, shapeIdea, containsSecret, SYSTEM_PROMPT,
  },
};
