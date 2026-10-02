#!/usr/bin/env node
/**
 * Sandy PR 0a — where each second of a turn goes, per call and in aggregate.
 *
 * For each Sandy call, reads Twilio Voice Insights' ConversationRelay event
 * timeline (end of customer speech → prompt → first token → agent speech)
 * and joins it with our own stored per-turn stats (model vs tool time, tool
 * names) from call_log.transcription_metadata.turn_stats (or the recovery
 * segments' turn_stats). Prints the release-criteria gap (caller stops →
 * caller hears Sandy) split into hearing / us / voice, plain vs tool turns.
 *
 * Usage:
 *   node server/scripts/voice-relay-turn-timing.js --call=CA...
 *   node server/scripts/voice-relay-turn-timing.js --sandbox --since=7d [--limit=20]
 *   ... --json=out.json   (also write every joined turn)
 *
 * Read-only: one READ ONLY transaction against call_log, GETs against
 * insights.twilio.com. Needs DATABASE_URL (or DATABASE_PUBLIC_URL via
 * `railway run`) and TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN. Events reach
 * the API about 90 s after a call ends.
 */

const fs = require('fs');
const {
  fetchConversationRelayEvents, buildTurnTimeline, joinTurnStats, summarizeTimeline,
} = require('../services/voice-agent/relay-insights');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

function sinceDate(spec) {
  const m = /^(\d+)([hd])$/.exec(String(spec || '7d'));
  if (!m) throw new Error(`--since must look like 12h or 7d, got ${spec}`);
  const ms = Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3);
  return new Date(Date.now() - ms);
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

/** Our turn stats: the final transcript's, else every recovery segment's in order. */
function storedStatsFor(row) {
  const tm = parseJson(row.transcription_metadata) || {};
  if (Array.isArray(tm.turn_stats)) return tm.turn_stats;
  const meta = parseJson(row.metadata) || {};
  const segments = Array.isArray(meta.relay_segments) ? meta.relay_segments : [];
  const fromSegments = segments.flatMap((s) => (Array.isArray(s && s.turn_stats) ? s.turn_stats : []));
  return fromSegments.length ? fromSegments : [];
}

async function loadRows() {
  const db = require('../models/db');
  const trx = await db.transaction();
  try {
    await trx.raw('SET TRANSACTION READ ONLY');
    const q = trx('call_log').select('twilio_call_sid', 'source', 'created_at', 'transcription_metadata', 'metadata');
    if (ARGS.call) q.where('twilio_call_sid', String(ARGS.call));
    else {
      if (ARGS.sandbox) q.where('source', 'voice_relay_sandbox');
      else q.whereRaw("transcription_metadata->>'source' = 'voice_relay_session'");
      q.where('created_at', '>=', sinceDate(ARGS.since)).orderBy('created_at', 'desc').limit(Number(ARGS.limit) || 20);
    }
    return await q;
  } finally {
    await trx.rollback().catch(() => {});
    await db.destroy().catch(() => {});
  }
}

const fmt = (v) => (v == null ? '   n/a' : `${(v / 1000).toFixed(2).padStart(5)}s`);

function printGroup(label, g) {
  if (!g.turns) { console.log(`  ${label.padEnd(13)} no turns`); return; }
  const row = (name, s) => `${name} p50 ${fmt(s.p50)} p95 ${fmt(s.p95)} (n=${s.n})`;
  console.log(`  ${label.padEnd(13)} ${g.turns} turns`);
  console.log(`    heard gap   ${row('', g.heard_gap)}   ← release criterion: p50 ≤ 0.80s, p95 ≤ 1.50s (plain)`);
  console.log(`    hearing/STT ${row('', g.stt)}`);
  console.log(`    us (app)    ${row('', g.app)}`);
  console.log(`      model     ${row('', g.model)}`);
  console.log(`      tools     ${row('', g.tools)}`);
  console.log(`    voice/TTS   ${row('', g.voice)}`);
}

function printSummary(title, s) {
  console.log(`\n${title}`);
  console.log(`  prompts ${s.prompts}  outcomes ${JSON.stringify(s.outcomes)}  agent-over-caller ${s.agent_over_caller}  caller barge-ins ${s.caller_barge_ins}  unpaired ${s.unclassified}`);
  printGroup('all spoken', s.all);
  printGroup('plain turns', s.plain);
  printGroup('tool turns', s.tool);
}

async function main() {
  const rows = await loadRows();
  if (!rows.length) { console.log('No matching calls.'); return; }
  const allJoined = [];
  const perCall = [];
  for (const row of rows) {
    const sid = row.twilio_call_sid;
    let fetched;
    try {
      fetched = await fetchConversationRelayEvents(sid);
    } catch (e) {
      console.log(`${sid}: Voice Insights read failed (${e.message})`);
      continue;
    }
    const timeline = buildTurnTimeline(fetched.events);
    if (!timeline.length) { console.log(`${sid}: no ConversationRelay turns in Voice Insights${fetched.available ? '' : ' (not available yet)'}`); continue; }
    const joined = joinTurnStats(timeline, storedStatsFor(row));
    allJoined.push(...joined.map((t) => ({ callSid: sid, ...t })));
    perCall.push({ callSid: sid, createdAt: row.created_at, summary: summarizeTimeline(joined), turns: joined });
    printSummary(`${sid}  ${new Date(row.created_at).toISOString()}  ${row.source || ''}`, summarizeTimeline(joined));
  }
  if (perCall.length > 1) printSummary(`ALL ${perCall.length} CALLS`, summarizeTimeline(allJoined));
  if (ARGS.json) {
    fs.writeFileSync(String(ARGS.json), JSON.stringify({ generatedAt: new Date().toISOString(), calls: perCall, aggregate: summarizeTimeline(allJoined) }, null, 2));
    console.log(`\nWrote ${ARGS.json}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { storedStatsFor };
