#!/usr/bin/env node
/**
 * Speaker-label eval: measures how accurately the Agent/Caller transcript
 * relabel pass (OPENAI_TRANSCRIPT_LABEL_MODEL, call-recording-processor.js)
 * attributes each turn, against owner-labeled ground truth.
 *
 * Two modes:
 *
 *   Score (default) — for every case in
 *   server/fixtures/call-extraction-eval/speaker-labels.json: rebuild the raw
 *   diarized transcript from call_log.transcript_structured exactly as the
 *   production normalizer renders it (checked against that normalizer at run
 *   time), verify its sha256 against the fixture (drift -> unscored), run the
 *   EXACT production relabel pass, and score word- and segment-level speaker
 *   accuracy.
 *
 *     node server/scripts/speaker-label-eval.js [--json] [--floor=0.95]
 *
 *   Sheet (--sheet) — write a labeling sheet for candidate calls (numbered
 *   raw segments + a suggested label read off the stored production
 *   transcript + a paste-ready fixture stub) to a PRIVATE file created
 *   exclusively with mode 0600 at an unpredictable tmp path (or --out, which
 *   must not already exist). stdout never carries transcript text, so a run
 *   inside the Railway service cannot leak PII into logs. Read the file
 *   privately, verify every suggested label, paste ONLY the corrected stubs
 *   into the fixture, then delete the file.
 *
 *     node server/scripts/speaker-label-eval.js --sheet [--days=60] [--limit=10] [--ids=a,b] [--out=path]
 *
 * Needs DATABASE_URL; score mode also needs OPENAI_API_KEY.
 * Exit codes: 0 = ok; 1 = a case errored or accuracy fell below --floor;
 * 2 = runner crashed. To compare a challenger model, set
 * OPENAI_TRANSCRIPT_LABEL_MODEL and re-run score mode.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'call-extraction-eval', 'speaker-labels.json');
const SCHEMA_VERSION = 'call-speaker-labels.v1';
const SPEAKERS = new Set(['agent', 'caller']);
// Exact key allowlist for a fixture case. Anything else (a note, a name, a
// snippet) is rejected so PII cannot ride into the repo on an extra field.
const CASE_KEYS = new Set(['id', 'call_log_id', 'labeled_at', 'labeled_by', 'transcript_sha256', 'segment_speakers']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    sheet: false,
    json: false,
    days: 60,
    limit: 10,
    ids: [],
    floor: null,
    fixturePath: DEFAULT_FIXTURE_PATH,
    out: null,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'sheet') opts.sheet = true;
    else if (key === 'json') opts.json = true;
    else if (key === 'days') opts.days = Math.max(1, Number(value) || 60);
    else if (key === 'limit') opts.limit = Math.min(25, Math.max(1, Number(value) || 10));
    else if (key === 'ids') opts.ids = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'floor') opts.floor = Number(value);
    else if (key === 'fixture') opts.fixturePath = path.resolve(process.cwd(), value);
    else if (key === 'out') opts.out = path.resolve(process.cwd(), value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

// ── Raw transcript rebuild ──────────────────────────────────────────────────
// Renders the stored transcript_structured segments the way the production
// normalizer (normalizeOpenAITranscript) renders the live provider payload:
// one "Speaker N: <trimmed text>" entry per non-empty segment, N assigned in
// first-appearance order, entries joined with "\n". Text is trimmed only —
// embedded line breaks inside a segment are preserved, because that is what
// the relabeler saw in production. Returns the per-segment renders (the unit
// the answer key labels) plus the joined text; callers verify the joined text
// against the production normalizer so the replay input is provably exact.
function canonicalRawTranscript(structured) {
  const segments = structured?.segments;
  if (!Array.isArray(segments) || !segments.length) return null;
  const speakerNames = new Map();
  const renders = [];
  for (const seg of segments) {
    const speaker = seg?.speaker || seg?.speaker_id || seg?.speaker_label;
    const body = String(seg?.text || '').trim();
    if (!body) continue;
    if (!speaker) {
      renders.push(body);
      continue;
    }
    if (!speakerNames.has(speaker)) speakerNames.set(speaker, `Speaker ${speakerNames.size + 1}`);
    renders.push(`${speakerNames.get(speaker)}: ${body}`);
  }
  const text = renders.join('\n').trim();
  return text ? { text, renders, distinctSpeakers: speakerNames.size } : null;
}

// Guard: the eval's rebuild must equal what production's normalizer produces
// from the same segments. If the normalizer ever changes shape, fail loudly
// rather than benchmark against an input the relabeler never saw.
function assertMatchesProductionNormalizer(structured, canonical, normalize) {
  const expected = normalize({ segments: structured.segments });
  if (expected !== canonical.text) {
    throw new Error('speaker-label-eval rebuild diverged from normalizeOpenAITranscript — update canonicalRawTranscript to match production');
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Same tokenizer shape as the production word-preservation guard, applied per
// physical line on BOTH sides: strip a leading "<label>:" prefix, lowercase,
// keep [a-z0-9'] runs.
function lineTokens(line) {
  const content = String(line).replace(/^\s*[^:\n]{1,30}:\s*/, '');
  return content.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
}

// Gold word stream: every token of segment i (across all its physical lines)
// carries segment_speakers[i].
function goldWordStream(renders, segmentSpeakers) {
  if (renders.length !== segmentSpeakers.length) {
    throw new Error(`segment_speakers has ${segmentSpeakers.length} entries but the raw transcript has ${renders.length} segments`);
  }
  const words = [];
  renders.forEach((render, i) => {
    for (const line of render.split('\n')) {
      for (const tok of lineTokens(line)) words.push({ tok, speaker: segmentSpeakers[i], segment: i });
    }
  });
  return words;
}

// Parse the relabeled transcript into turns, mirroring the production
// speakerTurns contract: a "<label>:" line starts a turn, unlabeled lines are
// continuations inheriting the current speaker. Labels outside Agent/Caller
// (or content before the first label) score as 'other' — a miss.
function modelWordStream(labeled) {
  const words = [];
  let speaker = 'other';
  for (const line of String(labeled || '').split('\n')) {
    const label = line.match(/^\s*([A-Za-z][A-Za-z0-9 ]{0,20}?)\s*:/);
    if (label) {
      const name = label[1].trim().toLowerCase();
      speaker = name === 'agent' ? 'agent' : (name === 'caller' || name === 'customer') ? 'caller' : 'other';
    }
    for (const tok of lineTokens(line)) words.push({ tok, speaker });
  }
  return words;
}

// Word-level speaker accuracy plus per-segment majority accuracy. The word
// streams must be the same token sequence (the production guard enforces the
// multiset; order deviations are rare and make positional credit meaningless,
// so a sequence mismatch is unscored, never guessed at).
function scoreLabeling(goldWords, modelWords, segmentCount) {
  if (goldWords.length !== modelWords.length
    || goldWords.some((w, i) => w.tok !== modelWords[i].tok)) {
    return { status: 'word_sequence_mismatch' };
  }
  let correct = 0;
  const perSegment = Array.from({ length: segmentCount }, () => ({ total: 0, correct: 0 }));
  goldWords.forEach((gold, i) => {
    const hit = modelWords[i].speaker === gold.speaker;
    if (hit) correct += 1;
    perSegment[gold.segment].total += 1;
    if (hit) perSegment[gold.segment].correct += 1;
  });
  const misSegments = [];
  perSegment.forEach((seg, i) => {
    // Majority credit: a 50/50 split is a MISS — crediting ties would inflate
    // segment accuracy and could mis-rank label models.
    if (seg.total && seg.correct / seg.total <= 0.5) misSegments.push(i);
  });
  const ratio = (num, den) => (den ? Number((num / den).toFixed(4)) : null);
  return {
    status: 'scored',
    words: goldWords.length,
    correctWords: correct,
    wordAccuracy: ratio(correct, goldWords.length),
    segments: segmentCount,
    correctSegments: segmentCount - misSegments.length,
    segmentAccuracy: ratio(segmentCount - misSegments.length, segmentCount),
    misSegments,
  };
}

function loadFixture(fixturePath) {
  const doc = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unexpected speaker-label fixture schemaVersion: ${doc.schemaVersion}`);
  }
  if (!Array.isArray(doc.cases)) throw new Error('speaker-label fixture must contain a cases array');
  const seen = new Set();
  for (const item of doc.cases) {
    const label = item?.id || '?';
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('speaker-label fixture case must be an object');
    for (const key of Object.keys(item)) {
      if (!CASE_KEYS.has(key)) throw new Error(`case ${label} has unsupported key "${key}" (allowed: ${[...CASE_KEYS].join(', ')})`);
    }
    if (!/^[a-z0-9-]+$/.test(String(item.id || ''))) throw new Error(`case ${label} id must be kebab-case`);
    if (seen.has(item.id)) throw new Error(`duplicate case id ${item.id}`);
    seen.add(item.id);
    if (!UUID_RE.test(String(item.call_log_id || ''))) throw new Error(`case ${label} call_log_id must be a uuid`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.labeled_at || ''))) throw new Error(`case ${label} labeled_at must be YYYY-MM-DD`);
    if (item.labeled_by !== 'owner') throw new Error(`case ${label} labeled_by must be "owner"`);
    if (!/^[0-9a-f]{64}$/i.test(String(item.transcript_sha256 || ''))) throw new Error(`case ${label} has an invalid transcript_sha256`);
    if (!Array.isArray(item.segment_speakers) || !item.segment_speakers.length
      || !item.segment_speakers.every((s) => SPEAKERS.has(s))) {
      throw new Error(`case ${label} segment_speakers must be a non-empty array of "agent"/"caller"`);
    }
  }
  return doc;
}

const CALL_COLUMNS = ['id', 'created_at', 'direction', 'from_phone', 'to_phone', 'transcription', 'transcript_structured'];

async function loadCalls(db, ids) {
  return db('call_log').select(CALL_COLUMNS).whereIn('id', ids);
}

function parseStructured(row) {
  const raw = row?.transcript_structured;
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// ── Score mode ──────────────────────────────────────────────────────────────
async function runScore(opts, deps) {
  const fixture = loadFixture(opts.fixturePath);
  if (!fixture.cases.length) {
    return {
      status: 'no_cases',
      message: 'speaker-labels.json has no labeled cases yet — run --sheet, label, then re-run.',
      results: [],
    };
  }

  const rows = await loadCalls(deps.db, fixture.cases.map((c) => c.call_log_id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const results = [];

  for (const item of fixture.cases) {
    const row = byId.get(item.call_log_id);
    const base = { caseId: item.id, callId: item.call_log_id };
    if (!row) {
      results.push({ ...base, status: 'call_not_found' });
      continue;
    }
    const structured = parseStructured(row);
    const canonical = canonicalRawTranscript(structured);
    if (!canonical) {
      results.push({ ...base, status: 'no_structured_transcript' });
      continue;
    }
    assertMatchesProductionNormalizer(structured, canonical, deps.normalizeTranscript);
    if (sha256(canonical.text) !== item.transcript_sha256.toLowerCase()) {
      results.push({ ...base, status: 'transcript_drift' });
      continue;
    }
    let labeled = null;
    try {
      labeled = await deps.labelTranscript(canonical.text, { call: row });
    } catch (err) {
      results.push({ ...base, status: 'labeling_error', error: err?.message || String(err) });
      continue;
    }
    if (!labeled) {
      // The production pass returned null: no labels, or the word-preservation
      // guard tripped. In production this falls back to the raw transcript —
      // for the eval it is a failure of the pass, reported as such.
      results.push({ ...base, status: 'labeling_failed' });
      continue;
    }
    const gold = goldWordStream(canonical.renders, item.segment_speakers);
    results.push({ ...base, ...scoreLabeling(gold, modelWordStream(labeled), canonical.renders.length) });
  }

  const scored = results.filter((r) => r.status === 'scored');
  const sum = (key) => scored.reduce((n, r) => n + r[key], 0);
  const ratio = (num, den) => (den ? Number((num / den).toFixed(4)) : null);
  return {
    status: 'scored',
    model: process.env.OPENAI_TRANSCRIPT_LABEL_MODEL || 'gpt-5-mini (default)',
    cases: fixture.cases.length,
    scored: scored.length,
    unscored: results.filter((r) => r.status !== 'scored').map((r) => ({ caseId: r.caseId, status: r.status })),
    wordAccuracy: ratio(sum('correctWords'), sum('words')),
    segmentAccuracy: ratio(sum('correctSegments'), sum('segments')),
    results,
  };
}

// ── Sheet mode ──────────────────────────────────────────────────────────────
// Suggested labels come from the STORED production transcription: align its
// word stream to the raw stream and take each segment's majority vote. A
// suggestion is a starting point for the human pass, never ground truth.
function suggestedSegmentSpeakers(renders, storedTranscription) {
  const gold = [];
  renders.forEach((render, i) => {
    for (const line of render.split('\n')) {
      for (const tok of lineTokens(line)) gold.push({ tok, segment: i });
    }
  });
  const model = modelWordStream(storedTranscription);
  if (!gold.length || gold.length !== model.length || gold.some((w, i) => w.tok !== model[i].tok)) {
    return renders.map(() => null);
  }
  const votes = renders.map(() => ({ agent: 0, caller: 0 }));
  gold.forEach((word, i) => {
    const speaker = model[i].speaker;
    if (speaker === 'agent' || speaker === 'caller') votes[word.segment][speaker] += 1;
  });
  return votes.map((v) => (v.agent === v.caller ? null : (v.agent > v.caller ? 'agent' : 'caller')));
}

// Pure renderer for the labeling sheet. The returned text contains transcript
// content (PII) — it is written to a private file, never to stdout, so a run
// inside the Railway service cannot persist customer text into plain-text logs.
function buildSheet(picked) {
  const out = [];
  out.push('SPEAKER LABELING SHEET — CONTAINS TRANSCRIPT TEXT (PII). Do not commit, paste into a PR, or store beyond the labeling pass; delete this file when done.');
  out.push('Verify EVERY suggested label against the text; suggestions come from the current model and are exactly what this eval is meant to test.');
  out.push('When a segment is half agent / half caller, label the majority speaker or drop the call from the set.\n');
  for (const { row, canonical } of picked) {
    out.push(`── call ${row.id} · ${String(row.created_at).slice(0, 10)} · direction=${row.direction || '?'} · ${canonical.renders.length} segments`);
    const suggestions = suggestedSegmentSpeakers(canonical.renders, row.transcription);
    canonical.renders.forEach((render, i) => {
      const [first, ...rest] = render.split('\n');
      out.push(`  [${String(i).padStart(3)}] (${suggestions[i] || 'UNKNOWN'}) ${first}`);
      for (const cont of rest) out.push(`        ${cont}`);
    });
    const stub = {
      id: `label-${String(row.id).slice(0, 8)}`,
      call_log_id: row.id,
      labeled_at: new Date().toISOString().slice(0, 10),
      labeled_by: 'owner',
      transcript_sha256: sha256(canonical.text),
      segment_speakers: suggestions.map((s) => s || 'VERIFY'),
    };
    out.push(`  fixture stub (fix every VERIFY, confirm the rest):\n${JSON.stringify(stub, null, 2).replace(/^/gm, '  ')}\n`);
  }
  if (!picked.length) out.push('No candidate calls found (need transcript_structured with >=2 diarized speakers).');
  return out.join('\n');
}

// Exclusive create (O_CREAT|O_EXCL) with mode 0600: refuses an existing file
// or symlink at the path, so a pre-planted target can never receive the PII
// sheet with broader permissions. Default path is a fresh private mkdtemp.
function writePrivateSheet(outPath, text) {
  const target = outPath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-label-sheet-')), 'sheet.txt');
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  return target;
}

async function runSheet(opts, deps) {
  let rows;
  if (opts.ids.length) {
    rows = await loadCalls(deps.db, opts.ids);
  } else {
    rows = await deps.db('call_log')
      .select(CALL_COLUMNS)
      .whereNotNull('transcript_structured')
      .whereNotNull('transcription')
      .whereRaw('length(transcription) >= ?', [400])
      .where('created_at', '>=', deps.db.raw("NOW() - (? * INTERVAL '1 day')", [opts.days]))
      .orderBy('created_at', 'desc')
      .limit(opts.limit * 4);
  }

  const picked = [];
  for (const row of rows) {
    const structured = parseStructured(row);
    const canonical = canonicalRawTranscript(structured);
    if (!canonical || canonical.distinctSpeakers < 2) continue;
    assertMatchesProductionNormalizer(structured, canonical, deps.normalizeTranscript);
    picked.push({ row, canonical });
    if (picked.length >= opts.limit) break;
  }

  // stdout stays PII-free (it may be captured in Railway logs).
  const written = writePrivateSheet(opts.out, buildSheet(picked));
  console.log(`Speaker labeling sheet: ${picked.length} candidate call(s) written to ${written}`);
  console.log('The file contains transcript text (PII). Read it privately, paste ONLY the corrected fixture stubs into speaker-labels.json, then delete it.');
  return { status: 'sheet', candidates: picked.length, out: written };
}

async function main() {
  const opts = parseArgs();
  const db = require('../models/db');
  const { labelTranscriptWithOpenAI, normalizeOpenAITranscript } = require('../services/call-recording-processor');
  const deps = { db, labelTranscript: labelTranscriptWithOpenAI, normalizeTranscript: normalizeOpenAITranscript };
  try {
    if (opts.sheet) {
      await runSheet(opts, deps);
      return;
    }
    const summary = await runScore(opts, deps);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (summary.status === 'no_cases') {
      console.log(summary.message);
    } else {
      const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
      console.log('\n-- Speaker label eval --\n');
      console.log(`Label model: ${summary.model}`);
      console.log(`Cases: ${summary.scored}/${summary.cases} scored`);
      for (const miss of summary.unscored) console.log(`  unscored: ${miss.caseId} (${miss.status})`);
      console.log(`Word-level speaker accuracy: ${pct(summary.wordAccuracy)}`);
      console.log(`Segment-level speaker accuracy: ${pct(summary.segmentAccuracy)}`);
      for (const r of summary.results.filter((x) => x.status === 'scored')) {
        console.log(`  ${r.caseId.padEnd(20)} words ${r.correctWords}/${r.words} segments ${r.correctSegments}/${r.segments}${r.misSegments.length ? ` mislabeled_segments=[${r.misSegments.join(', ')}]` : ''}`);
      }
      console.log('');
    }
    const failed = summary.status === 'scored'
      && (summary.unscored.length > 0
        || (Number.isFinite(opts.floor) && summary.wordAccuracy !== null && summary.wordAccuracy < opts.floor));
    if (failed) process.exitCode = 1;
  } finally {
    try { await db.destroy(); } catch { /* pool not open */ }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`speaker-label-eval failed: ${err.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  CASE_KEYS,
  assertMatchesProductionNormalizer,
  buildSheet,
  canonicalRawTranscript,
  goldWordStream,
  lineTokens,
  loadFixture,
  modelWordStream,
  parseArgs,
  runScore,
  runSheet,
  scoreLabeling,
  sha256,
  suggestedSegmentSpeakers,
  writePrivateSheet,
};
