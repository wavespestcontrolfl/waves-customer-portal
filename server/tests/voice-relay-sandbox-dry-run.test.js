/**
 * A voice-agent sandbox call (call_log.source='voice_relay_sandbox', proven
 * at ws upgrade) is a DRY RUN: the transcript and latency record land on its
 * own call_log row, but no lead, re-service ticket or booking request is ever
 * written — a profile bake-off or a stranger dialling the test number cannot
 * create dispatch work (codex r1 P1 on #3852). Every KPI that counts inbound
 * calls drops the sandbox rows through one shared modifier.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const db = require('../models/db');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const { executeTool, SANDBOX_DRY_RUN_TOOLS, TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS } = require('../services/voice-agent/relay-tools');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const { whereNotSandboxCall, VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

describe('executeTool on a sandbox session', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([...SANDBOX_DRY_RUN_TOOLS])('%s is answered dry — nothing runs, nothing is written', async (name) => {
    const out = await executeTool(name, { anything: 'x' }, { sandbox: true, callSid: 'CA-sb-1', from: '+19415551234' });
    expect(out).toMatch(/Sandbox test call/);
    expect(out).toMatch(new RegExp(name + ' was NOT run'));
    expect(out).toMatch(/nothing was written/);
    expect(db).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('a dry-run capture keeps the in-memory completion effects so the call still ends after the goodbye (codex r3 P1)', async () => {
    const markCaptured = jest.fn();
    const noteCallSummary = jest.fn();
    const noteLeadId = jest.fn();
    const markReserviceFiled = jest.fn();
    const ctx = { sandbox: true, callSid: 'CA-sb-3', from: '+19415551234', markCaptured, noteCallSummary, noteLeadId, markReserviceFiled };
    await executeTool('capture_lead', { call_summary: 'Caller asked about ants.' }, ctx);
    expect(markCaptured).toHaveBeenCalledWith({ leadCreated: false });
    expect(noteCallSummary).toHaveBeenCalledWith('Caller asked about ants.');
    await executeTool('request_reservice', { problem: 'ants are back' }, ctx);
    expect(markCaptured).toHaveBeenCalledTimes(2);
    await executeTool('request_booking', {}, ctx);
    expect(markCaptured).toHaveBeenCalledTimes(2); // production request_booking does not mark a capture either
    expect(noteLeadId).not.toHaveBeenCalled();
    expect(markReserviceFiled).not.toHaveBeenCalled(); // nothing was filed
    expect(db).not.toHaveBeenCalled();
  });

  test('the gate covers every tool that writes outside the call_log row', () => {
    expect([...SANDBOX_DRY_RUN_TOOLS].sort()).toEqual(['capture_lead', 'request_booking', 'request_reservice']);
    const registered = [...TOOLS, ...CONTEXT_TOOLS, ...BOOKING_TOOLS].map((t) => t.name);
    for (const name of SANDBOX_DRY_RUN_TOOLS) expect(registered).toContain(name);
  });

  test('a production session (no flag, or a non-boolean one) is untouched by the gate', async () => {
    // capture_lead with no callback number returns its own no-number answer — proof the gate did not fire.
    for (const ctx of [{ callSid: 'CA-1' }, { callSid: 'CA-1', sandbox: 'true' }]) {
      const out = await executeTool('capture_lead', {}, ctx);
      expect(out).not.toMatch(/Sandbox test call/);
    }
  });
});

describe('RelayConversation.sandbox', () => {
  test('defaults false and only a boolean true sets it; the tool ctx carries it', () => {
    const plain = new RelayConversation({ callSid: 'CA-1', from: '+19415551234', send: jest.fn() });
    expect(plain.sandbox).toBe(false);
    expect(plain._buildToolCtx().sandbox).toBe(false);
    const forged = new RelayConversation({ callSid: 'CA-1', from: '+19415551234', send: jest.fn(), sandbox: 'true' });
    expect(forged.sandbox).toBe(false);
    const sb = new RelayConversation({ callSid: 'CA-sb-1', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(sb.sandbox).toBe(true);
    expect(sb._buildToolCtx().sandbox).toBe(true);
  });

  test('the hangup capture floor stays down on a sandbox call', async () => {
    const sb = new RelayConversation({ callSid: 'CA-sb-2', from: '+19415551234', send: jest.fn(), sandbox: true });
    await sb._runCaptureFloor('hangup');
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
});

describe('every call_log query site is either sandbox-excluding or audited as safe', () => {
  // A source scanner, not a hand-picked list: every file under server/services
  // and server/routes that queries call_log must either apply
  // whereNotSandboxCall / read VOICE_RELAY_SANDBOX_SOURCE row-level, or be
  // listed here with the reason a sandbox row (inbound, no recording, no
  // extraction, no customer_id, no disposition; relay-written transcript)
  // cannot reach it. A new call_log reader fails this test until classified.
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const QUERY_RE = /(db|trx|knex|dbc|conn)\('call_log( as [a-z]+)?'\)|from\('call_log'\)|\.table\('call_log'\)|\bFROM call_log\b|\bJOIN call_log\b/i;
  const SAFE = {
    // Writers and per-row processors keyed by id / CallSid / a marker only
    // the recording processor stamps — none of them lists inbound calls.
    'services/call-recording-processor.js': 'requires a recording; the sandbox has none',
    'routes/twilio-voice-webhook.js': 'writer keyed by CallSid (and the sandbox insert itself)',
    'routes/collections-voice-webhook.js': 'collections outbound rows, keyed by callLogId',
    'services/collections/outbound-voice/collections-conversation.js': 'collections outbound rows, keyed by CallSid',
    'services/collections/outbound-voice/origination.js': 'collections outbound rows',
    'services/collections/outbound-voice/outcomes.js': 'collections outbound rows, keyed by id',
    'services/collections/outbound-voice/retention.js': 'collections outbound rows',
    'services/collections/contact-policy.js': 'collections outbound rows, keyed by id',
    'services/collections/consent-provenance.js': 'collections outbound rows, keyed by id',
    'services/collections/shadow-sweep.js': 'collections outbound rows, keyed by id',
    'services/voice-agent/relay-alert.js': 'keyed by the session CallSid',
    'services/voice-agent/relay-context.js': 'keyed by the session CallSid',
    'services/voice-agent/relay-tools.js': 'keyed by the session CallSid (write tools run dry on a sandbox session)',
    'services/voice-agent/relay-conversation.js': 'keyed by the session CallSid (its own row is the artifact)',
    'routes/admin-import-sheets.js': 'writer',
    'routes/lead-webhook.js': 'keyed by CallSid',
    'services/lead-from-extraction.js': 'keyed by CallSid',
    'services/estimate-clarify-asks.js': 'keyed by id',
    'services/slot-reservation.js': 'keyed by id',
    'services/property-role-proposals.js': 'keyed by id / ownership token',
    'services/notification-service.js': 'keyed by CallSid',
    'services/customer-dedupe.js': 'keyed by customer_id (never stamped on a sandbox row)',
    'services/completion-comms-context.js': 'keyed by customer_id',
    'services/outbound-review-confirm.js': 'keyed by id',
    'services/customer-email-fanout.js': 'writer keyed by id',
    'services/admin-estimate-persistence.js': 'keyed by id',
    'services/reply-training-capture.js': 'keyed by customer_id',
    'services/email-bounce-reverify.js': 'requires a recording',
    'services/triage-auto-resolve.js': 'writer keyed by id',
    'services/missed-call-bell.js': 'requires customer_id and a terminal missed status',
    'services/contact-correction.js': 'keyed by id',
    'services/call-sentiment.js': 'keyed by id',
    'services/call-intelligence.js': 'keyed by id',
    'services/lead-attribution.js': 'keyed by CallSid',
    'services/customer-properties.js': 'keyed by id / ownership token',
    'services/ads/call-attribution.js': 'keyed by id / a marker the processor stamps',
    'services/call-field-candidates.js': 'keyed by id',
    'services/estimator-engine/index.js': 'keyed by id / markers the estimator stamps',
    'services/estimator-engine/draft-builder.js': 'keyed by id',
    'services/estimator-engine/booking-predraft.js': 'keyed by id',
    'services/knowledge-index/resolution-sync.js': 'requires ai_extraction_enriched, which the relay never writes',
    'services/ai-assistant/assistant.js': 'writer keyed by CallSid',
    'routes/admin-triage.js': 'keyed by id',
    'routes/admin-leads.js': 'keyed by the lead CallSid / stamp',
    'routes/admin-communications.js': 'keyed by id',
    'routes/admin-call-recordings.js': 'requires a recording',
    'services/call-ingest-watchdog.js': 'a known-SID set — a sandbox call IS an ingested call',
    'services/ops-queue.js': 'requires a recording or a PAN quarantine',
    'services/call-booking-miss-watchdog.js': 'requires v2_extraction_status = valid',
    'services/call-processing-stall-watchdog.js': 'requires a recording (recording-less rows are filtered before the page)',
    'services/promised-estimate-watcher.js': 'requires an enriched quote_promised extraction',
    'services/unworked-comms-watcher.js': 'requires disposition = callback_task_created, which only extraction sets',
  };
  const seen = new Set();
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (!QUERY_RE.test(src)) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      seen.add(rel);
      const excludes = /whereNotSandboxCall\(/.test(src) || /VOICE_RELAY_SANDBOX_SOURCE/.test(src);
      if (!excludes && !SAFE[rel]) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, 'services'));
  walk(path.join(ROOT, 'routes'));

  test('no call_log reader is unclassified', () => {
    expect(offenders).toEqual([]);
  });

  test('every audited-safe entry still queries call_log (no stale reasons)', () => {
    expect(Object.keys(SAFE).filter((rel) => !seen.has(rel))).toEqual([]);
  });

  test.each([
    'routes/admin-dashboard.js', 'routes/ai-assistant.js', 'routes/admin-agent-decisions.js',
    'services/seo/conversion-feedback-miner.js', 'services/seo/site-rollup.js',
    'services/call-research-miner.js', 'services/sms-voice-corpus-miner.js',
    'services/content/customer-insights-miner.js', 'services/context-aggregator.js',
    'services/call-self-audit.js', 'services/voice-agent/relay-history.js',
    'services/intelligence-bar/comms-tools.js', 'services/dashboard-alerts.js',
    'services/ads/google-call-bridge.js', 'services/email-bounce-rescue.js',
    'services/agent-estimate-context.js', 'services/estimator-engine/context-builder.js',
  ])('%s applies whereNotSandboxCall', (rel) => {
    expect(fs.readFileSync(path.join(ROOT, rel), 'utf8')).toMatch(/whereNotSandboxCall\(/);
  });
});

describe('whereNotSandboxCall', () => {
  test('binds the column as an identifier and the source as a value', () => {
    const qb = { whereRaw: jest.fn().mockReturnThis() };
    expect(whereNotSandboxCall(qb)).toBe(qb);
    expect(qb.whereRaw).toHaveBeenCalledWith("COALESCE(??, '') <> ?", ['source', VOICE_RELAY_SANDBOX_SOURCE]);
    whereNotSandboxCall(qb, 'c.source');
    expect(qb.whereRaw).toHaveBeenLastCalledWith("COALESCE(??, '') <> ?", ['c.source', VOICE_RELAY_SANDBOX_SOURCE]);
  });
});
