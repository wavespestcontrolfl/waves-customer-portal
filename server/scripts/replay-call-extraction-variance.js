#!/usr/bin/env node
/**
 * Read-only replay of historical call transcripts through the current v2
 * extractor, with variance reporting against the stored legacy extraction and
 * any prior stored v2 shadow extraction.
 *
 * This does not write to call_log, customers, leads, scheduled_services,
 * route_decisions, triage_items, or customer_field_candidates.
 *
 * Usage:
 *   node server/scripts/replay-call-extraction-variance.js --limit=10 --days=30
 *   node server/scripts/replay-call-extraction-variance.js --limit=3 --retranscribe
 *   node server/scripts/replay-call-extraction-variance.js --ids=<call_id>,<call_id> --include-values
 *   node server/scripts/replay-call-extraction-variance.js --limit=25 --jsonl
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { normalizeStreetLine } = require('../utils/address-normalizer');

const DEFAULT_LIMIT = 10;
const DEFAULT_DAYS = 30;
const DEFAULT_MIN_TRANSCRIPT_CHARS = 200;

const FIELD_GROUPS = {
  high: [
    'appointment_confirmed',
    'preferred_date_time',
    'is_spam',
    'is_voicemail',
    'matched_service',
    'requested_service',
    'address_line1',
    'zip',
  ],
  medium: [
    'first_name',
    'last_name',
    'phone',
    'email',
    'city',
  ],
  low: [
    'lead_quality',
    'sentiment',
  ],
};

const FIELD_SEVERITY = Object.entries(FIELD_GROUPS).reduce((acc, [severity, fields]) => {
  for (const field of fields) acc[field] = severity;
  return acc;
}, {});

const COMPARED_FIELDS = Object.keys(FIELD_SEVERITY);

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    limit: DEFAULT_LIMIT,
    days: DEFAULT_DAYS,
    minTranscriptChars: DEFAULT_MIN_TRANSCRIPT_CHARS,
    statuses: ['processed'],
    ids: [],
    fixturePath: null,
    retranscribe: false,
    onlyAppointmentCandidates: false,
    includeValues: false,
    jsonl: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }
    const [rawKey, ...rawValueParts] = arg.slice(2).split('=');
    const value = rawValueParts.length ? rawValueParts.join('=') : 'true';
    switch (rawKey) {
      case 'limit':
        opts.limit = clampInt(value, 1, 100, DEFAULT_LIMIT);
        break;
      case 'days':
        opts.days = clampInt(value, 1, 3650, DEFAULT_DAYS);
        break;
      case 'min-transcript-chars':
        opts.minTranscriptChars = clampInt(value, 0, 100000, DEFAULT_MIN_TRANSCRIPT_CHARS);
        break;
      case 'status':
      case 'statuses':
        opts.statuses = splitCsv(value);
        break;
      case 'ids':
        opts.ids = splitCsv(value);
        break;
      case 'fixture':
        opts.fixturePath = value;
        break;
      case 'retranscribe':
        opts.retranscribe = parseBool(value);
        break;
      case 'only-appointment-candidates':
        opts.onlyAppointmentCandidates = parseBool(value);
        break;
      case 'include-values':
        opts.includeValues = parseBool(value);
        break;
      case 'jsonl':
        opts.jsonl = parseBool(value);
        break;
      default:
        throw new Error(`Unknown option: --${rawKey}`);
    }
  }

  return opts;
}

function usage() {
  return [
    'Read-only replay of stored call transcripts through the current v2 extractor.',
    '',
    'Options:',
    '  --limit=N                         Calls to replay. Default: 10, max: 100.',
    '  --days=N                          Lookback window when --ids is omitted. Default: 30.',
    '  --status=a,b                      call_log.processing_status filter. Default: processed. Use all to disable.',
    '  --ids=id1,id2                     Replay exact call_log ids; bypasses days/status filters.',
    '  --fixture=path                    Load reviewed call ids and expectations from a JSON fixture.',
    '  --min-transcript-chars=N          Minimum transcript length. Default: 200.',
    '  --retranscribe                    Download recording and re-run current transcription before extraction.',
    '  --only-appointment-candidates     Only replay calls whose stored legacy extraction looked appointment-like.',
    '  --include-values                  Include old/new extracted values. May print PII.',
    '  --jsonl                           Print one JSON object per call plus a final summary row.',
    '',
    'Examples:',
    '  node server/scripts/replay-call-extraction-variance.js --limit=10 --days=30',
    '  node server/scripts/replay-call-extraction-variance.js --limit=3 --days=30 --retranscribe',
    '  node server/scripts/replay-call-extraction-variance.js --fixture=server/fixtures/call-extraction-eval/reviewed-calls.json --jsonl',
    '  node server/scripts/replay-call-extraction-variance.js --limit=25 --status=processed,customer_creation_failed --jsonl',
    '  node server/scripts/replay-call-extraction-variance.js --ids=<call_id>,<call_id> --include-values',
  ].join('\n');
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(value) {
  if (value === true) return true;
  return !/^(false|0|no|off)$/i.test(String(value || 'true'));
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function loadReplayFixture(fixturePath) {
  if (!fixturePath) return null;
  const resolvedPath = path.isAbsolute(fixturePath)
    ? fixturePath
    : path.resolve(process.cwd(), fixturePath);
  const document = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  if (!Array.isArray(document.cases)) {
    throw new Error(`Replay fixture ${fixturePath} must contain a cases array`);
  }

  const cases = document.cases.map((item, index) => {
    const callId = item.call_log_id || item.callId;
    if (!callId) throw new Error(`Replay fixture ${fixturePath} case ${index + 1} is missing call_log_id`);
    return { ...item, call_log_id: callId };
  });
  return {
    path: resolvedPath,
    document,
    cases,
    byCallId: new Map(cases.map((item) => [item.call_log_id, item])),
  };
}

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  return s ? s.toLowerCase() : null;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizeBool(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === false) return value;
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(s)) return true;
  if (['false', 'no', '0'].includes(s)) return false;
  return null;
}

function normalizeDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 16);
  return normalizeString(value);
}

function normalizeTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  const match = s.match(/^(\d{1,2}):(\d{2})/);
  if (match) return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
  return normalizeString(s);
}

function normalizeField(field, value) {
  if (field === 'address_line1') return normalizeString(normalizeStreetLine(value));
  if (field === 'phone') return normalizePhone(value);
  if (field === 'email') return normalizeString(value);
  if (field === 'appointment_confirmed' || field === 'is_spam' || field === 'is_voicemail') return normalizeBool(value);
  if (field === 'preferred_date_time') return normalizeDateTime(value);
  return normalizeString(value);
}

function normalizeExpectedArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function evaluateFixtureExpectation(result, fixtureCase) {
  const expect = fixtureCase?.expect;
  if (!expect) return null;

  const failures = [];
  const checks = [];
  const check = (name, passed, actual, expected) => {
    checks.push(name);
    if (!passed) failures.push({ name, actual, expected });
  };

  if (Object.prototype.hasOwnProperty.call(expect, 'current_status')) {
    check('current_status', result.current.status === expect.current_status, result.current.status, expect.current_status);
  }
  if (Object.prototype.hasOwnProperty.call(expect, 'current_would_auto_route')) {
    check(
      'current_would_auto_route',
      result.current.wouldAutoRoute === expect.current_would_auto_route,
      result.current.wouldAutoRoute,
      expect.current_would_auto_route
    );
  }
  if (Object.prototype.hasOwnProperty.call(expect, 'legacy_scheduled_created')) {
    check(
      'legacy_scheduled_created',
      result.legacy.scheduledCreated === expect.legacy_scheduled_created,
      result.legacy.scheduledCreated,
      expect.legacy_scheduled_created
    );
  }
  if (Object.prototype.hasOwnProperty.call(expect, 'route_changed_vs_legacy_schedule')) {
    check(
      'route_changed_vs_legacy_schedule',
      result.variance.routeChangedVsLegacySchedule === expect.route_changed_vs_legacy_schedule,
      result.variance.routeChangedVsLegacySchedule,
      expect.route_changed_vs_legacy_schedule
    );
  }
  if (Object.prototype.hasOwnProperty.call(expect, 'appointment_candidate_changed_vs_legacy')) {
    check(
      'appointment_candidate_changed_vs_legacy',
      result.variance.appointmentCandidateChangedVsLegacy === expect.appointment_candidate_changed_vs_legacy,
      result.variance.appointmentCandidateChangedVsLegacy,
      expect.appointment_candidate_changed_vs_legacy
    );
  }
  if (Object.prototype.hasOwnProperty.call(expect, 'prior_v2_route_changed')) {
    check(
      'prior_v2_route_changed',
      result.variance.priorV2RouteChanged === expect.prior_v2_route_changed,
      result.variance.priorV2RouteChanged,
      expect.prior_v2_route_changed
    );
  }

  const flags = new Set(result.current.flags || []);
  for (const flag of normalizeExpectedArray(expect.current_flags_include)) {
    check(`current_flags_include:${flag}`, flags.has(flag), [...flags], flag);
  }
  for (const flag of normalizeExpectedArray(expect.current_flags_exclude)) {
    check(`current_flags_exclude:${flag}`, !flags.has(flag), [...flags], flag);
  }

  const legacyScheduleFields = new Set((result.variance.legacyScheduledServiceVariances || []).map((item) => item.field));
  for (const field of normalizeExpectedArray(expect.legacy_schedule_variance_fields)) {
    check(`legacy_schedule_variance_fields:${field}`, legacyScheduleFields.has(field), [...legacyScheduleFields], field);
  }

  return {
    status: failures.length ? 'fail' : 'pass',
    checked: checks.length,
    failures,
  };
}

function valuePresence(value) {
  if (value === null || value === undefined || value === '') return 'missing';
  if (Array.isArray(value) && value.length === 0) return 'missing';
  return 'present';
}

function valueForReport(value, includeValues) {
  return includeValues ? value : valuePresence(value);
}

function transcriptLabelCounts(transcript) {
  const text = String(transcript || '');
  return {
    agent: (text.match(/(^|\n)\s*Agent\s*:/gi) || []).length,
    caller: (text.match(/(^|\n)\s*Caller\s*:/gi) || []).length,
  };
}

function transcriptTokenSet(transcript) {
  return new Set(
    String(transcript || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2)
  );
}

function transcriptDeltaMetrics(storedTranscript, replayTranscript) {
  const stored = String(storedTranscript || '');
  const replay = String(replayTranscript || '');
  const storedTokens = transcriptTokenSet(stored);
  const replayTokens = transcriptTokenSet(replay);
  const intersection = [...storedTokens].filter((token) => replayTokens.has(token)).length;
  const union = new Set([...storedTokens, ...replayTokens]).size;
  const charDelta = replay.length - stored.length;
  return {
    storedChars: stored.length,
    replayChars: replay.length,
    charDelta,
    charDeltaPct: stored.length ? Number((charDelta / stored.length).toFixed(3)) : null,
    tokenJaccard: union ? Number((intersection / union).toFixed(3)) : null,
    storedLabels: transcriptLabelCounts(stored),
    replayLabels: transcriptLabelCounts(replay),
  };
}

function compareFlatFields(oldFlat, currentFlat, includeValues) {
  const variances = [];
  for (const field of COMPARED_FIELDS) {
    const oldValue = oldFlat?.[field] ?? null;
    const currentValue = currentFlat?.[field] ?? null;
    const oldNorm = normalizeField(field, oldValue);
    const currentNorm = normalizeField(field, currentValue);
    if (oldNorm === currentNorm) continue;
    variances.push({
      field,
      severity: FIELD_SEVERITY[field],
      old: valueForReport(oldValue, includeValues),
      current: valueForReport(currentValue, includeValues),
    });
  }
  return variances;
}

function appointmentCandidate(flat) {
  return !!(normalizeBool(flat?.appointment_confirmed) === true || flat?.preferred_date_time);
}

function etScheduleParts(value) {
  if (!value) return {};
  const d = new Date(value);
  if (isNaN(d.getTime())) return {};
  return {
    scheduled_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d),
    window_start: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d),
  };
}

function compareScheduledService(scheduled, currentFlat, includeValues) {
  if (!scheduled || !currentFlat) return [];
  const currentSchedule = etScheduleParts(currentFlat.preferred_date_time);
  const comparisons = [
    ['scheduled_date', scheduled.scheduled_date, currentSchedule.scheduled_date],
    ['window_start', scheduled.window_start, currentSchedule.window_start],
    ['service_type', scheduled.service_type, currentFlat.matched_service || currentFlat.requested_service],
  ];

  return comparisons
    .filter(([field, legacyValue, currentValue]) => {
      const legacyNorm = field === 'window_start' ? normalizeTime(legacyValue) : normalizeString(legacyValue);
      const currentNorm = field === 'window_start' ? normalizeTime(currentValue) : normalizeString(currentValue);
      return legacyNorm !== currentNorm;
    })
    .map(([field, legacyValue, currentValue]) => ({
      field,
      severity: 'high',
      legacyScheduled: valueForReport(legacyValue, includeValues),
      current: valueForReport(currentValue, includeValues),
    }));
}

function contactPhoneForCall(call) {
  return String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone;
}

function routeForV2(extraction, contactPhone, helpers) {
  if (!extraction) return { allowed: false, reason: 'no_extraction', flags: [] };
  const modelFlags = helpers.suppressAddressFlagsForAV(extraction.triage_flags || [], null);
  const deterministicFlags = helpers.computeDeterministicTriageFlags(extraction, { contactPhone });
  const flags = helpers.mergeTriageFlags(modelFlags, deterministicFlags);
  const route = helpers.canAutoRoute(extraction, { contactPhone });
  return {
    allowed: !!route.allowed,
    reason: route.allowed ? 'allowed' : (route.reason || 'blocked'),
    flags,
    appointmentBlockingFlags: route.appointmentBlockingFlags || flags,
  };
}

function countBy(items, fn) {
  const counts = {};
  for (const item of items) {
    const key = fn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeResults(results, options) {
  const allLegacyFieldVariances = results.flatMap((r) => r.variance.legacyFieldVariances || []);
  const allPriorV2FieldVariances = results.flatMap((r) => r.variance.priorV2FieldVariances || []);
  const triageFlags = results.flatMap((r) => r.current.flags || []);
  const fixtureExpectations = results
    .map((r) => r.fixture?.expectation)
    .filter(Boolean);
  return {
    checked: results.length,
    options: {
      limit: options.limit,
      days: options.ids.length ? null : options.days,
      statuses: options.ids.length ? null : options.statuses,
      ids: options.ids.length,
      fixturePath: options.fixturePath || null,
      retranscribe: options.retranscribe,
      onlyAppointmentCandidates: options.onlyAppointmentCandidates,
      includeValues: options.includeValues,
    },
    currentStatusCounts: countBy(results, (r) => r.current.status),
    currentValid: results.filter((r) => r.current.status === 'valid').length,
    currentInvalid: results.filter((r) => r.current.status !== 'valid').length,
    replayErrors: results.filter((r) => r.current.status === 'error').length,
    replayErrorCallIds: results.filter((r) => r.current.status === 'error').map((r) => r.callId),
    legacyScheduledCreated: results.filter((r) => r.legacy.scheduledCreated).length,
    currentWouldAutoRoute: results.filter((r) => r.current.wouldAutoRoute).length,
    routeChangedVsLegacySchedule: results.filter((r) => r.variance.routeChangedVsLegacySchedule).length,
    appointmentCandidateChangedVsLegacy: results.filter((r) => r.variance.appointmentCandidateChangedVsLegacy).length,
    priorV2RouteChanged: results.filter((r) => r.variance.priorV2RouteChanged).length,
    retranscription: {
      attempted: results.filter((r) => r.transcription.replay?.attempted).length,
      succeeded: results.filter((r) => r.transcription.replay?.status === 'completed').length,
      failed: results.filter((r) => r.transcription.replay?.attempted && r.transcription.replay?.status !== 'completed').length,
      providers: countBy(
        results.filter((r) => r.transcription.replay?.provider),
        (r) => r.transcription.replay.provider
      ),
    },
    legacyFieldVarianceCounts: {
      high: allLegacyFieldVariances.filter((v) => v.severity === 'high').length,
      medium: allLegacyFieldVariances.filter((v) => v.severity === 'medium').length,
      low: allLegacyFieldVariances.filter((v) => v.severity === 'low').length,
    },
    priorV2FieldVarianceCounts: {
      high: allPriorV2FieldVariances.filter((v) => v.severity === 'high').length,
      medium: allPriorV2FieldVariances.filter((v) => v.severity === 'medium').length,
      low: allPriorV2FieldVariances.filter((v) => v.severity === 'low').length,
    },
    topLegacyFieldsChanged: countBy(allLegacyFieldVariances, (v) => v.field),
    topPriorV2FieldsChanged: countBy(allPriorV2FieldVariances, (v) => v.field),
    currentTriageFlagCounts: countBy(triageFlags, (f) => f),
    fixtureExpectations: {
      checked: fixtureExpectations.length,
      passed: fixtureExpectations.filter((r) => r.status === 'pass').length,
      failed: fixtureExpectations.filter((r) => r.status === 'fail').length,
      failedCallIds: results
        .filter((r) => r.fixture?.expectation?.status === 'fail')
        .map((r) => r.callId),
    },
  };
}

function printHumanHeader(options, rowsFound) {
  console.log('Read-only call extraction variance replay');
  console.log(`Found ${rowsFound} candidate call(s). Replaying ${Math.min(rowsFound, options.limit)} with the current v2 extractor.`);
  console.log(`Transcript source: ${options.retranscribe ? 'fresh recording transcription' : 'stored call_log.transcription'}`);
  console.log(`Values: ${options.includeValues ? 'included (PII may print)' : 'redacted (presence only)'}`);
  console.log('');
}

function printHumanResult(result, index) {
  const currentRoute = result.current.wouldAutoRoute ? 'auto_route' : `triage:${result.current.routeReason}`;
  const pieces = [
    `[${index + 1}] ${result.callId}`,
    `created=${result.createdAt}`,
    `status=${result.processingStatus}`,
    `current=${result.current.status}`,
    `route=${currentRoute}`,
    `legacy_scheduled=${result.legacy.scheduledCreated}`,
    `legacy_field_deltas=${result.variance.legacyFieldVariances.length}`,
  ];
  if (result.variance.routeChangedVsLegacySchedule) pieces.push('ROUTE_CHANGED');
  if (result.variance.appointmentCandidateChangedVsLegacy) pieces.push('APPOINTMENT_CHANGED');
  if (result.variance.priorV2RouteChanged) pieces.push('PRIOR_V2_ROUTE_CHANGED');
  console.log(pieces.join(' | '));

  if (result.current.flags.length) {
    console.log(`     current_flags=[${result.current.flags.join(', ')}]`);
  }
  if (result.transcription.replay?.attempted) {
    const replay = result.transcription.replay;
    const metrics = replay.delta || {};
    console.log(`     retranscription=${replay.status} provider=${replay.provider || 'none'} model=${replay.model || 'none'} chars_delta=${metrics.charDelta ?? 'n/a'} token_jaccard=${metrics.tokenJaccard ?? 'n/a'}`);
  }
  if (result.variance.legacyFieldVariances.length) {
    const fields = result.variance.legacyFieldVariances
      .map((v) => `${v.field}:${v.severity}`)
      .join(', ');
    console.log(`     legacy_field_variances=${fields}`);
  }
  if (result.variance.legacyScheduledServiceVariances.length) {
    const fields = result.variance.legacyScheduledServiceVariances
      .map((v) => `${v.field}:${v.severity}`)
      .join(', ');
    console.log(`     legacy_schedule_variances=${fields}`);
  }
  if (result.variance.priorV2FieldVariances.length) {
    const fields = result.variance.priorV2FieldVariances
      .map((v) => `${v.field}:${v.severity}`)
      .join(', ');
    console.log(`     prior_v2_field_variances=${fields}`);
  }
  if (result.includeValues) {
    console.log(`     values=${JSON.stringify({
      legacy: result.variance.legacyFieldVariances,
      legacySchedule: result.variance.legacyScheduledServiceVariances,
      priorV2: result.variance.priorV2FieldVariances,
    })}`);
  }
  if (result.fixture?.expectation) {
    console.log(`     fixture=${result.fixture.caseId}:${result.fixture.expectation.status}`);
    for (const failure of result.fixture.expectation.failures || []) {
      console.log(`       fixture_failure=${failure.name} actual=${JSON.stringify(failure.actual)} expected=${JSON.stringify(failure.expected)}`);
    }
  }
  if (result.error) {
    console.log(`     error=${result.error.name}: ${result.error.message}`);
  }
  console.log('');
}

function printHumanSummary(summary) {
  console.log('Summary');
  console.log(JSON.stringify(summary, null, 2));
}

async function tableExists(db, table) {
  return db.schema.hasTable(table).catch(() => false);
}

async function columnInfo(db, table) {
  return db(table).columnInfo().catch(() => ({}));
}

async function loadCandidateCalls(db, options) {
  const callColumns = await columnInfo(db, 'call_log');
  for (const required of ['id', 'transcription', 'ai_extraction']) {
    if (!callColumns[required]) throw new Error(`call_log.${required} is required but was not found`);
  }

  const optionalColumns = [
    'id',
    'twilio_call_sid',
    'created_at',
    'from_phone',
    'to_phone',
    'direction',
    'processing_status',
    'transcription',
    'ai_extraction',
    'ai_extraction_enriched',
    'v2_extraction_status',
    'ai_extraction_model',
    'ai_extraction_prompt_version',
    'transcription_provider',
    'transcription_model',
    'recording_url',
  ];
  const selected = optionalColumns
    .filter((col) => callColumns[col])
    .map((col) => `cl.${col}`);

  const query = db('call_log as cl')
    .select(selected)
    .whereNotNull('cl.transcription')
    .whereRaw('length(cl.transcription) >= ?', [options.minTranscriptChars])
    .whereNotNull('cl.ai_extraction')
    .orderBy('cl.created_at', 'desc');

  if (options.retranscribe && callColumns.recording_url) {
    query.whereNotNull('cl.recording_url').where('cl.recording_url', '!=', '');
  }

  if (options.ids.length) {
    query.whereIn('cl.id', options.ids);
  } else {
    if (!options.statuses.includes('all')) {
      query.whereIn('cl.processing_status', options.statuses);
    }
    query.where('cl.created_at', '>=', db.raw("NOW() - (? * INTERVAL '1 day')", [options.days]));
  }

  const dbLimit = options.onlyAppointmentCandidates ? Math.min(options.limit * 5, 500) : options.limit;
  const rows = await query.limit(dbLimit);

  if (!options.onlyAppointmentCandidates) return rows.slice(0, options.limit);

  return rows
    .filter((row) => appointmentCandidate(parseJson(row.ai_extraction, {})))
    .slice(0, options.limit);
}

async function findLegacyScheduledService(db, call, scheduledColumns) {
  if (!scheduledColumns || !call?.twilio_call_sid) return null;

  if (scheduledColumns.source_call_log_id) {
    const linked = await db('scheduled_services')
      .where({ source_call_log_id: call.id })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);
    if (linked) return linked;
  }

  if (!scheduledColumns.notes) return null;
  return db('scheduled_services')
    .where('notes', 'like', `%Call SID: ${call.twilio_call_sid}%`)
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
}

async function replayCall(call, context) {
  const { helpers, CRP, db, scheduledColumns, includeValues, retranscribe, fixtureCaseByCallId } = context;
  const contactPhone = contactPhoneForCall(call);
  const legacyFlat = parseJson(call.ai_extraction, {}) || {};
  const priorV2 = parseJson(call.ai_extraction_enriched, null);
  const priorV2Valid = priorV2 && helpers.isV2Extraction(priorV2);
  const priorV2Flat = priorV2Valid ? helpers.flatView(priorV2) : null;
  const priorV2Route = priorV2Valid ? routeForV2(priorV2, contactPhone, helpers) : null;
  const scheduled = await findLegacyScheduledService(db, call, scheduledColumns);

  let transcriptForExtraction = call.transcription;
  let replayTranscription = {
    attempted: false,
    status: 'not_requested',
    provider: null,
    model: null,
    delta: null,
  };
  if (retranscribe) {
    replayTranscription = {
      attempted: true,
      status: 'no_recording_url',
      provider: null,
      model: null,
      delta: null,
    };
    if (call.recording_url && typeof CRP._test.transcribeRecording === 'function') {
      const transcriptResult = await CRP._test.transcribeRecording(call.recording_url, { call, contactPhone });
      if (transcriptResult?.transcription) {
        transcriptForExtraction = transcriptResult.transcription;
        replayTranscription = {
          attempted: true,
          status: 'completed',
          provider: transcriptResult.provider || null,
          model: transcriptResult.model || null,
          metadata: {
            responseFormat: transcriptResult.metadata?.response_format || null,
            labelProvider: transcriptResult.metadata?.label_provider || null,
            labelModel: transcriptResult.metadata?.label_model || null,
            fallbackAttempted: transcriptResult.metadata?.fallback_attempted ?? null,
            fallbackProvider: transcriptResult.metadata?.fallback_provider || null,
            fallbackModel: transcriptResult.metadata?.fallback_model || null,
          },
          delta: transcriptDeltaMetrics(call.transcription, transcriptResult.transcription),
        };
      } else {
        replayTranscription.status = 'failed';
        replayTranscription.provider = transcriptResult?.provider || null;
        replayTranscription.model = transcriptResult?.model || null;
      }
    }
  }

  const startedAt = Date.now();
  const current = transcriptForExtraction
    ? await CRP._test.extractCallDataV2(transcriptForExtraction, contactPhone, {
        callId: call.id,
        callStartedAt: call.created_at && !isNaN(new Date(call.created_at)) ? new Date(call.created_at) : new Date(),
      })
    : { status: replayTranscription.status || 'no_transcription', extraction: null, errors: null };
  const durationMs = Date.now() - startedAt;

  const currentExtraction = current.status === 'valid' ? current.extraction : null;
  const currentFlat = currentExtraction ? helpers.flatView(currentExtraction) : null;
  const currentRoute = currentExtraction
    ? routeForV2(currentExtraction, contactPhone, helpers)
    : { allowed: false, reason: current.status, flags: [] };

  const legacyFieldVariances = currentFlat ? compareFlatFields(legacyFlat, currentFlat, includeValues) : [];
  const priorV2FieldVariances = currentFlat && priorV2Flat
    ? compareFlatFields(priorV2Flat, currentFlat, includeValues)
    : [];
  const legacyScheduledServiceVariances = currentFlat
    ? compareScheduledService(scheduled, currentFlat, includeValues)
    : [];

  const legacyAppointmentCandidate = appointmentCandidate(legacyFlat);
  const currentAppointmentCandidate = appointmentCandidate(currentFlat || {});

  const result = {
    callId: call.id,
    createdAt: call.created_at || null,
    processingStatus: call.processing_status || null,
    transcription: {
      provider: call.transcription_provider || null,
      model: call.transcription_model || null,
      chars: String(call.transcription || '').length,
      source: retranscribe ? 'fresh_recording' : 'stored_transcript',
      replay: replayTranscription,
    },
    legacy: {
      hasExtraction: !!Object.keys(legacyFlat).length,
      appointmentCandidate: legacyAppointmentCandidate,
      scheduledCreated: !!scheduled,
      scheduledServiceId: scheduled?.id || null,
    },
    priorV2: {
      status: call.v2_extraction_status || null,
      hasStoredExtraction: !!priorV2,
      schemaValidShape: !!priorV2Valid,
      wouldAutoRoute: priorV2Route?.allowed ?? null,
      routeReason: priorV2Route?.reason || null,
    },
    current: {
      status: current.status,
      durationMs,
      schemaErrors: current.status === 'valid' ? [] : (current.errors || []).slice(0, 3),
      wouldAutoRoute: currentRoute.allowed,
      routeReason: currentRoute.reason,
      flags: currentRoute.flags || [],
      appointmentBlockingFlags: currentRoute.appointmentBlockingFlags || [],
      confidence: currentExtraction?.confidence?.overall ?? null,
      schedulingStatus: currentExtraction?.scheduling?.status || null,
      serviceCategory: currentExtraction?.service_request?.primary_service_category || null,
    },
    variance: {
      routeChangedVsLegacySchedule: !!scheduled !== !!currentRoute.allowed,
      appointmentCandidateChangedVsLegacy: legacyAppointmentCandidate !== currentAppointmentCandidate,
      priorV2RouteChanged: priorV2Route ? priorV2Route.allowed !== currentRoute.allowed : false,
      legacyFieldVariances,
      legacyScheduledServiceVariances,
      priorV2FieldVariances,
    },
    includeValues,
  };
  const fixtureCase = fixtureCaseByCallId?.get(call.id) || null;
  if (fixtureCase) {
    result.fixture = {
      caseId: fixtureCase.id,
      reviewedOutcome: fixtureCase.reviewed_outcome || null,
      expectation: evaluateFixtureExpectation(result, fixtureCase),
    };
  }
  return result;
}

function buildReplayErrorResult(call, err, context = {}) {
  const { includeValues = false, retranscribe = false, fixtureCaseByCallId = null } = context;
  const legacyFlat = parseJson(call?.ai_extraction, {}) || {};
  const result = {
    callId: call?.id || null,
    createdAt: call?.created_at || null,
    processingStatus: call?.processing_status || null,
    transcription: {
      provider: call?.transcription_provider || null,
      model: call?.transcription_model || null,
      chars: String(call?.transcription || '').length,
      source: retranscribe ? 'fresh_recording' : 'stored_transcript',
      replay: {
        attempted: !!retranscribe,
        status: 'error',
        provider: null,
        model: null,
        delta: null,
      },
    },
    legacy: {
      hasExtraction: !!Object.keys(legacyFlat).length,
      appointmentCandidate: appointmentCandidate(legacyFlat),
      scheduledCreated: false,
      scheduledServiceId: null,
    },
    priorV2: {
      status: call?.v2_extraction_status || null,
      hasStoredExtraction: !!parseJson(call?.ai_extraction_enriched, null),
      schemaValidShape: false,
      wouldAutoRoute: null,
      routeReason: null,
    },
    current: {
      status: 'error',
      durationMs: null,
      schemaErrors: [],
      wouldAutoRoute: false,
      routeReason: 'replay_error',
      flags: [],
      appointmentBlockingFlags: [],
      confidence: null,
      schedulingStatus: null,
      serviceCategory: null,
    },
    variance: {
      routeChangedVsLegacySchedule: false,
      appointmentCandidateChangedVsLegacy: false,
      priorV2RouteChanged: false,
      legacyFieldVariances: [],
      legacyScheduledServiceVariances: [],
      priorV2FieldVariances: [],
    },
    includeValues,
    error: {
      name: err?.name || 'Error',
      message: err?.message || String(err || 'unknown error'),
    },
  };
  const fixtureCase = call?.id ? fixtureCaseByCallId?.get(call.id) : null;
  if (fixtureCase) {
    result.fixture = {
      caseId: fixtureCase.id,
      reviewedOutcome: fixtureCase.reviewed_outcome || null,
      expectation: evaluateFixtureExpectation(result, fixtureCase),
    };
  }
  return result;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not present; the current v2 extractor cannot be replayed here');
  }

  const db = require('../models/db');
  const CRP = require('../services/call-recording-processor');
  const triageFlags = require('../services/call-triage-flags');
  const extractionCompat = require('../utils/extraction-compat');
  const helpers = { ...triageFlags, ...extractionCompat };
  const fixture = loadReplayFixture(options.fixturePath);
  if (fixture && !options.ids.length) {
    options.ids = fixture.cases.map((item) => item.call_log_id);
    options.limit = Math.max(options.limit, options.ids.length);
  }
  const fixtureCaseByCallId = fixture?.byCallId || new Map();

  try {
    const scheduledColumns = (await tableExists(db, 'scheduled_services'))
      ? await columnInfo(db, 'scheduled_services')
      : null;
    const rows = await loadCandidateCalls(db, options);
    if (!options.jsonl) printHumanHeader(options, rows.length);

    const results = [];
    for (const call of rows) {
      let result;
      try {
        result = await replayCall(call, {
          helpers,
          CRP,
          db,
          scheduledColumns,
          includeValues: options.includeValues,
          retranscribe: options.retranscribe,
          fixtureCaseByCallId,
        });
      } catch (err) {
        result = buildReplayErrorResult(call, err, {
          includeValues: options.includeValues,
          retranscribe: options.retranscribe,
          fixtureCaseByCallId,
        });
      }
      results.push(result);
      if (options.jsonl) {
        console.log(JSON.stringify({ type: 'call', ...result }));
      } else {
        printHumanResult(result, results.length - 1);
      }
    }

    const summary = summarizeResults(results, options);
    if (options.jsonl) {
      console.log(JSON.stringify({ type: 'summary', ...summary }));
    } else {
      printHumanSummary(summary);
    }
  } finally {
    await db.destroy().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Replay failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  normalizeField,
  summarizeResults,
  evaluateFixtureExpectation,
  buildReplayErrorResult,
  loadReplayFixture,
};
