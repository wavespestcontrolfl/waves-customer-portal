#!/usr/bin/env node
/**
 * Speaker-label eval: measures how accurately the Agent/Caller transcript
 * relabel pass (OPENAI_TRANSCRIPT_LABEL_MODEL, call-recording-processor.js)
 * attributes each turn, against owner-labeled ground truth.
 *
 * Two modes:
 *
 *   Score (default) — for every case in
 *   server/fixtures/call-extraction-eval/speaker-labels.json: rebuild the
 *   canonical raw diarized transcript from call_log.transcript_structured,
 *   verify its sha256 against the fixture (drift -> unscored), run the EXACT
 *   production relabel pass, and score word- and line-level speaker accuracy.
 *
 *     node server/scripts/speaker-label-eval.js [--json] [--floor=0.95]
 *
 *   Sheet (--sheet) — write a labeling sheet for candidate calls (numbered
 *   raw lines + a suggested label read off the stored production transcript
 *   + a paste-ready fixture stub) to a PRIVATE 0600 file (--out, default in
 *   the OS tmpdir). stdout never carries transcript text, so a run inside
 *   the Railway service cannot leak PII into logs. Read the file privately,
 *   verify every suggested label, paste ONLY the corrected stubs into the
 *   fixture, then delete the file.
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
const path = require('path');

const DEFAULT_FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'call-extraction-eval', 'speaker-labels.json');
const SPEAKERS = new Set(['agent', 'caller']);

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    sheet: false,
    json: false,
    days: 60,
    limit: 10,
    ids: [],
    floor: null,
    fixturePath: DEFAULT_FIXTURE_PATH,
    out: path.join(require('os').tmpdir(), 'speaker-label-sheet.txt'),
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

// ── Canonical raw transcript ────────────────────────────────────────────────
// Deterministic rebuild of the pre-label diarized transcript from the stored
// transcript_structured segments: one line per segment, "Speaker N: text"
// with N assigned in first-appearance order and whitespace collapsed, so the
// same stored row always yields byte-identical text (sha-pinnable). This is
// the eval's replay input; production labeled the live provider payload, but
// the stored segments carry the same words and raw speaker split.
function canonicalRawTranscript(structured) {
  const segments = structured?.segments;
  if (!Array.isArray(segments) || !segments.length) return null;
  const speakerNames = new Map();
  const lines = [];
  for (const seg of segments) {
    const text = String(seg?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const rawSpeaker = seg.speaker || seg.speaker_id || seg.speaker_label || null;
    if (!rawSpeaker) {
      lines.push(text);
      continue;
    }
    if (!speakerNames.has(rawSpeaker)) speakerNames.set(rawSpeaker, `Speaker ${speakerNames.size + 1}`);
    lines.push(`${speakerNames.get(rawSpeaker)}: ${text}`);
  }
  return lines.length ? { text: lines.join('\n'), lines, distinctSpeakers: speakerNames.size } : null;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Same shape as the production word-preservation guard's tokenizer: strip a
// leading "<label>:" prefix, lowercase, keep [a-z0-9'] runs.
function lineTokens(line) {
  const content = String(line).replace(/^\s*[^:\n]{1,30}:\s*/, '');
  return content.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
}

// Gold word stream: every token of raw line i carries line_speakers[i].
function goldWordStream(rawLines, lineSpeakers) {
  if (rawLines.length !== lineSpeakers.length) {
    throw new Error(`line_speakers has ${lineSpeakers.length} entries but the canonical transcript has ${rawLines.length} lines`);
  }
  const words = [];
  rawLines.forEach((line, i) => {
    for (const tok of lineTokens(line)) words.push({ tok, speaker: lineSpeakers[i], line: i });
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

// Word-level speaker accuracy plus per-raw-line majority accuracy. The word
// streams must be the same token sequence (the production guard enforces the
// multiset; order deviations are rare and make positional credit meaningless,
// so a sequence mismatch is unscored, never guessed at).
function scoreLabeling(goldWords, modelWords, lineCount) {
  if (goldWords.length !== modelWords.length
    || goldWords.some((w, i) => w.tok !== modelWords[i].tok)) {
    return { status: 'word_sequence_mismatch' };
  }
  let correct = 0;
  const perLine = Array.from({ length: lineCount }, () => ({ total: 0, correct: 0 }));
  goldWords.forEach((gold, i) => {
    const hit = modelWords[i].speaker === gold.speaker;
    if (hit) correct += 1;
    perLine[gold.line].total += 1;
    if (hit) perLine[gold.line].correct += 1;
  });
  const misLines = [];
  perLine.forEach((line, i) => {
    // Majority credit: a 50/50 split is a MISS — crediting ties would inflate
    // line accuracy and could mis-rank label models.
    if (line.total && line.correct / line.total <= 0.5) misLines.push(i);
  });
  const ratio = (num, den) => (den ? Number((num / den).toFixed(4)) : null);
  return {
    status: 'scored',
    words: goldWords.length,
    correctWords: correct,
    wordAccuracy: ratio(correct, goldWords.length),
    lines: lineCount,
    correctLines: lineCount - misLines.length,
    lineAccuracy: ratio(lineCount - misLines.length, lineCount),
    misLines,
  };
}

function loadFixture(fixturePath) {
  const doc = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (doc.schemaVersion !== 'call-speaker-labels.v1') {
    throw new Error(`Unexpected speaker-label fixture schemaVersion: ${doc.schemaVersion}`);
  }
  if (!Array.isArray(doc.cases)) throw new Error('speaker-label fixture must contain a cases array');
  for (const item of doc.cases) {
    if (!item.call_log_id) throw new Error(`case ${item.id || '?'} is missing call_log_id`);
    if (!/^[0-9a-f]{64}$/i.test(item.transcript_sha256 || '')) throw new Error(`case ${item.id} has an invalid transcript_sha256`);
    if (!Array.isArray(item.line_speakers) || !item.line_speakers.length
      || !item.line_speakers.every((s) => SPEAKERS.has(s))) {
      throw new Error(`case ${item.id} line_speakers must be a non-empty array of "agent"/"caller"`);
    }
  }
  return doc;
}

async function loadCalls(db, ids) {
  return db('call_log')
    .select(['id', 'created_at', 'direction', 'from_phone', 'to_phone', 'transcription', 'transcript_structured'])
    .whereIn('id', ids);
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
    const canonical = canonicalRawTranscript(parseStructured(row));
    if (!canonical) {
      results.push({ ...base, status: 'no_structured_transcript' });
      continue;
    }
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
    const gold = goldWordStream(canonical.lines, item.line_speakers);
    results.push({ ...base, ...scoreLabeling(gold, modelWordStream(labeled), canonical.lines.length) });
  }

  const scored = results.filter((r) => r.status === 'scored');
  const totalWords = scored.reduce((n, r) => n + r.words, 0);
  const correctWords = scored.reduce((n, r) => n + r.correctWords, 0);
  const totalLines = scored.reduce((n, r) => n + r.lines, 0);
  const correctLines = scored.reduce((n, r) => n + r.correctLines, 0);
  const ratio = (num, den) => (den ? Number((num / den).toFixed(4)) : null);
  return {
    status: 'scored',
    model: process.env.OPENAI_TRANSCRIPT_LABEL_MODEL || 'gpt-5-mini (default)',
    cases: fixture.cases.length,
    scored: scored.length,
    unscored: results.filter((r) => r.status !== 'scored').map((r) => ({ caseId: r.caseId, status: r.status })),
    wordAccuracy: ratio(correctWords, totalWords),
    lineAccuracy: ratio(correctLines, totalLines),
    results,
  };
}

// ── Sheet mode ──────────────────────────────────────────────────────────────
// Suggested labels come from the STORED production transcription: align its
// word stream to the raw stream and take each raw line's majority vote. A
// suggestion is a starting point for the human pass, never ground truth.
function suggestedLineSpeakers(rawLines, storedTranscription) {
  const gold = [];
  rawLines.forEach((line, i) => {
    for (const tok of lineTokens(line)) gold.push({ tok, line: i });
  });
  const model = modelWordStream(storedTranscription);
  if (!gold.length || gold.length !== model.length || gold.some((w, i) => w.tok !== model[i].tok)) {
    return rawLines.map(() => null);
  }
  const votes = rawLines.map(() => ({ agent: 0, caller: 0 }));
  gold.forEach((word, i) => {
    const speaker = model[i].speaker;
    if (speaker === 'agent' || speaker === 'caller') votes[word.line][speaker] += 1;
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
  out.push('When a line is half agent / half caller, label the majority speaker or drop the call from the set.\n');
  for (const { row, canonical } of picked) {
    out.push(`── call ${row.id} · ${String(row.created_at).slice(0, 10)} · direction=${row.direction || '?'} · ${canonical.lines.length} lines`);
    const suggestions = suggestedLineSpeakers(canonical.lines, row.transcription);
    canonical.lines.forEach((line, i) => {
      out.push(`  [${String(i).padStart(3)}] (${suggestions[i] || 'UNKNOWN'}) ${line}`);
    });
    const stub = {
      id: `label-${String(row.id).slice(0, 8)}`,
      call_log_id: row.id,
      labeled_at: new Date().toISOString().slice(0, 10),
      labeled_by: 'owner',
      transcript_sha256: sha256(canonical.text),
      line_speakers: suggestions.map((s) => s || 'VERIFY'),
    };
    out.push(`  fixture stub (fix every VERIFY, confirm the rest):\n${JSON.stringify(stub, null, 2).replace(/^/gm, '  ')}\n`);
  }
  if (!picked.length) out.push('No candidate calls found (need transcript_structured with >=2 diarized speakers).');
  return out.join('\n');
}

async function runSheet(opts, deps) {
  let rows;
  if (opts.ids.length) {
    rows = await loadCalls(deps.db, opts.ids);
  } else {
    rows = await deps.db('call_log')
      .select(['id', 'created_at', 'direction', 'from_phone', 'to_phone', 'transcription', 'transcript_structured'])
      .whereNotNull('transcript_structured')
      .whereNotNull('transcription')
      .whereRaw('length(transcription) >= ?', [400])
      .where('created_at', '>=', deps.db.raw("NOW() - (? * INTERVAL '1 day')", [opts.days]))
      .orderBy('created_at', 'desc')
      .limit(opts.limit * 4);
  }

  const picked = [];
  for (const row of rows) {
    const canonical = canonicalRawTranscript(parseStructured(row));
    if (!canonical || canonical.distinctSpeakers < 2) continue;
    picked.push({ row, canonical });
    if (picked.length >= opts.limit) break;
  }

  // stdout stays PII-free (it may be captured in Railway logs); the sheet
  // itself goes to a 0600 file for the private labeling pass.
  fs.writeFileSync(opts.out, buildSheet(picked), { mode: 0o600 });
  console.log(`Speaker labeling sheet: ${picked.length} candidate call(s) written to ${opts.out}`);
  console.log('The file contains transcript text (PII). Read it privately, paste ONLY the corrected fixture stubs into speaker-labels.json, then delete it.');
  return { status: 'sheet', candidates: picked.length, out: opts.out };
}

async function main() {
  const opts = parseArgs();
  const db = require('../models/db');
  const { labelTranscriptWithOpenAI } = require('../services/call-recording-processor');
  const deps = { db, labelTranscript: labelTranscriptWithOpenAI };
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
      console.log('\n-- Speaker label eval --\n');
      console.log(`Label model: ${summary.model}`);
      console.log(`Cases: ${summary.scored}/${summary.cases} scored`);
      for (const miss of summary.unscored) console.log(`  unscored: ${miss.caseId} (${miss.status})`);
      console.log(`Word-level speaker accuracy: ${summary.wordAccuracy === null ? 'n/a' : `${(summary.wordAccuracy * 100).toFixed(1)}%`}`);
      console.log(`Line-level speaker accuracy: ${summary.lineAccuracy === null ? 'n/a' : `${(summary.lineAccuracy * 100).toFixed(1)}%`}`);
      for (const r of summary.results.filter((x) => x.status === 'scored')) {
        console.log(`  ${r.caseId.padEnd(20)} words ${r.correctWords}/${r.words} lines ${r.correctLines}/${r.lines}${r.misLines.length ? ` mislabeled_lines=[${r.misLines.join(', ')}]` : ''}`);
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
  suggestedLineSpeakers,
};
