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
// The re-service dedupe reads through the scheduler (its own db handle); the
// sandbox boundary sits behind them, so they answer "nothing open" here.
jest.mock('../services/reservice-scheduler', () => ({
  openReserviceCallbacks: jest.fn(async () => ({})),
  reserviceLanesForCustomer: jest.fn(async () => []),
  openCallbackExistsForLane: jest.fn(async () => false),
  RESERVICE_LANES: {},
}));

const db = require('../models/db');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const { executeTool, SANDBOX_DRY_RUN_TOOLS, TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS } = require('../services/voice-agent/relay-tools');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const { whereNotSandboxCall, VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

describe('executeTool on a sandbox session', () => {
  const OLD_CTX_GATE = process.env.VOICE_RELAY_CONTEXT_ENABLED;
  beforeEach(() => { jest.clearAllMocks(); process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });
  afterEach(() => {
    if (OLD_CTX_GATE === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    else process.env.VOICE_RELAY_CONTEXT_ENABLED = OLD_CTX_GATE;
  });

  // ⭐ VALIDATION FIRST (codex r7 P2): a malformed call is refused exactly as
  // in production — the dry run answers only at the write boundary, so a
  // bake-off measures the same post-tool conversation production would have.
  test('a malformed sandbox call gets the production refusal, never a fake success', async () => {
    const base = { sandbox: true, callSid: 'CA-sb-1', markCaptured: jest.fn() };
    const noNumber = await executeTool('capture_lead', { call_summary: 'x' }, { ...base, from: 'anonymous' });
    expect(noNumber).toMatch(/valid phone number/);
    const noCustomer = await executeTool('request_reservice', { lane: 'pest', issue: 'ants' }, { ...base, from: '+19415551234' });
    expect(noCustomer).not.toMatch(/Sandbox test call/);
    const noSlot = await executeTool('request_booking', { service: 'pest' }, { ...base, from: '+19415551234', customerId: 'c-1', customerTier: 'full' });
    expect(noSlot).toMatch(/slot_ref|not available/);
    for (const out of [noNumber, noCustomer, noSlot]) expect(out).not.toMatch(/Sandbox test call/);
    expect(base.markCaptured).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('a VALID capture is answered dry at the write boundary and keeps the in-memory completion effects (codex r3 P1)', async () => {
    const markCaptured = jest.fn();
    const noteCallSummary = jest.fn();
    const noteLeadId = jest.fn();
    const ctx = { sandbox: true, callSid: 'CA-sb-3', from: '+19415551234', markCaptured, noteCallSummary, noteLeadId };
    const out = await executeTool('capture_lead', { first_name: 'Pat', call_summary: 'Caller asked about ants.', lead_quality: 'warm' }, ctx);
    expect(out).toMatch(/Sandbox test call: capture_lead was NOT run/);
    expect(out).toMatch(/nothing was written/);
    expect(markCaptured).toHaveBeenCalledWith({ leadCreated: false, holdOpen: false });
    expect(noteCallSummary).toHaveBeenCalledWith('Caller asked about ants.');
    expect(noteLeadId).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('an incomplete estimate capture still holds the call open and names what is missing on a sandbox call (codex r8 P2)', async () => {
    const markCaptured = jest.fn();
    const ctx = { sandbox: true, callSid: 'CA-sb-6', from: '+19415551234', markCaptured, noteCallSummary: jest.fn() };
    const out = await executeTool('capture_lead', { first_name: 'Pat', call_summary: 'Wants a quote.', estimate_requested: true }, ctx);
    expect(out).toMatch(/Sandbox test call: capture_lead was NOT run/);
    expect(out).toMatch(/NOT queued yet — still missing/);
    expect(markCaptured).toHaveBeenCalledWith({ leadCreated: false, holdOpen: true });
    expect(db).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('a VALID re-service request runs every production check, then skips only the ticket write', async () => {
    // Reads answer "nothing open"; the write transaction must never start.
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'select']) chain[m] = jest.fn(() => chain);
    chain.first = jest.fn(async () => undefined);
    db.mockImplementation(() => chain);
    db.transaction = jest.fn(async () => { throw new Error('write transaction must not start'); });
    const markCaptured = jest.fn();
    const markReserviceFiled = jest.fn();
    const ctx = { sandbox: true, callSid: 'CA-sb-4', from: '+19415551234', customerId: 'c-1', customerTier: 'full', markCaptured, markReserviceFiled };
    const out = await executeTool('request_reservice', { lane: 'pest', issue: 'ants are back in the kitchen' }, ctx);
    expect(out).toMatch(/Sandbox test call: request_reservice was NOT run/);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(markCaptured).toHaveBeenCalledWith({ leadCreated: false, holdOpen: false });
    expect(markReserviceFiled).not.toHaveBeenCalled(); // nothing was filed
    db.mockImplementation(() => { throw new Error('db must not be touched'); });
    delete db.transaction;
  });

  test('an already-open voice request never re-pages the owner from a sandbox session (hook P0)', async () => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'select']) chain[m] = jest.fn(() => chain);
    chain.update = jest.fn(async () => 1);
    chain.first = jest.fn(async () => ({ id: 'sr-1', source: 'voice_agent', owner_alerted_at: null, created_at: new Date(), category: 'pest_control', customer_id: 'c-1' }));
    db.mockImplementation(() => chain);
    const ctx = { sandbox: true, callSid: 'CA-sb-5', from: '+19415551234', customerId: 'c-1', customerTier: 'full', markCaptured: jest.fn() };
    const out = await executeTool('request_reservice', { lane: 'pest', issue: 'ants are back' }, ctx);
    expect(out).not.toMatch(/Sandbox test call/); // the production "already open" answer
    expect(chain.update).not.toHaveBeenCalled(); // no claim stamp, no page
    db.mockImplementation(() => { throw new Error('db must not be touched'); });
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
  // A source scanner, not a hand-picked list: every file under server/services,
  // server/routes, server/scripts and the repo-root scripts/ that queries call_log must either apply
  // whereNotSandboxCall / read VOICE_RELAY_SANDBOX_SOURCE row-level, or be
  // listed here with the reason a sandbox row (inbound, no recording, no
  // extraction, no customer_id, no disposition; relay-written transcript)
  // cannot reach it. A new call_log reader fails this test until classified.
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  // ANY handle name — the repo injects knex as db/trx/conn/dbi/dbh/database/
  // runner/sp/q… (codex r5 + r12); a query is a call with the table literal,
  // whatever the local variable is called.
  const QUERY_RE = /\b[A-Za-z_$][\w$]*\(['"]call_log( as [a-z]+)?['"]\)|\bFROM call_log\b(?![.\w])|\bJOIN call_log\b(?![.\w])/gi;
  const SAFE = {
    // Writers and per-row processors keyed by id / CallSid / a marker only
    // the recording processor stamps — none of them lists inbound calls.
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
    'routes/admin-communications.js': 'keyed by id',
    'routes/admin-call-recordings.js': 'requires a recording',
    'services/call-ingest-watchdog.js': 'a known-SID set — a sandbox call IS an ingested call',
    'services/ops-queue.js': 'requires a recording or a PAN quarantine',
    'services/call-booking-miss-watchdog.js': 'requires v2_extraction_status = valid',
    'services/call-processing-stall-watchdog.js': 'requires a recording (recording-less rows are filtered before the page)',
    'services/promised-estimate-watcher.js': 'requires an enriched quote_promised extraction',
    'services/unworked-comms-watcher.js': 'requires disposition = callback_task_created, which only extraction sets',
    'scripts/backfill-resolution-artifacts.js': 'requires ai_extraction_enriched, which the relay never writes',
    'scripts/backfill-call-route-decisions.js': 'requires a processing_status only the recording processor sets',
    'scripts/speaker-label-eval.js': 'requires transcript_structured, which only the recording processor writes',
    'scripts/v2-promotion-readiness.js': 'requires v2_extraction_status, which only extraction sets',
    'scripts/verify-v2-shadow-path.js': 'requires processing_status = processed, which only the recording processor sets',
  };
  // A query keyed by a row id, CallSid, call_log_id, customer_id (a sandbox
  // row never gains one) or the processor's token: knex form or raw SQL.
  // Keyed = where/first on id / CallSid / call_log_id / customer_id /
  // processing_token (object, shorthand `{ id }`, or positional), a bound
  // raw equality, or a correlated join `cl.id = <table>.call_log_id`.
  const KEYED_RE = /(where|whereIn|andWhere|first)\(\s*(\{\s*)?['"]?(call_log\.|cl\.|c\.)?(id|twilio_call_sid|call_log_id|customer_id|processing_token)['"]?\s*[:,)}]|whereNotNull\(\s*['"](call_log\.|cl\.|c\.)?customer_id['"]\s*\)|\b(call_log\.|cl\.)?(id|twilio_call_sid|call_log_id)\s*(=|IN)\s*(\?|\$\d|\(|ANY)|\bcl\.id\s*=\s*[a-z_]+\.call_log_id\b/;
  // The statement holding a query: from the start of its line to the ';'
  // that closes it at paren/brace depth zero (callbacks carry their own ';';
  // line comments are skipped).
  const statementAt = (src, at) => {
    const start = src.lastIndexOf('\n', at) + 1;
    let depth = 0;
    for (let i = at; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
      if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
      else if (ch === ';' && depth <= 0) return src.slice(start, i);
    }
    return src.slice(start);
  };
  const seen = new Set();
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      const matches = [...src.matchAll(QUERY_RE)];
      if (!matches.length) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      seen.add(rel);
      if (SAFE[rel]) continue;
      // EACH query must exclude, not the file as a whole: the exclusion has
      // to ride the statement that contains the query, or the statement is
      // keyed by an id / CallSid / customer_id (never a sandbox row's).
      for (const m of matches) {
        const statement = statementAt(src, m.index);
        const excludes = /whereNotSandboxCall\(/.test(statement) || /VOICE_RELAY_SANDBOX_SOURCE/.test(statement);
        if (!excludes && !KEYED_RE.test(statement)) offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  };
  walk(path.join(ROOT, 'services'));
  walk(path.join(ROOT, 'routes'));
  walk(path.join(ROOT, 'scripts'));
  walk(path.join(ROOT, '..', 'scripts')); // repo-root operator scripts (codex r11 P2: the inbound routing audit)

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
    '../scripts/twilio/audit-inbound-routing.js', 'services/call-retranscription-backfill.js', 'routes/admin-leads.js',
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
