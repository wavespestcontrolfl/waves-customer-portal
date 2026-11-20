/**
 * GATE_CALL_PHONE_YES_ACCEPT, the parts that need no database (owner 2026-11-18, step 1: the office taps): the gate
 * reader, the wiring (the scheduler, the booking text, the admin-only card, the one caller's-word module) and the card's
 * two states. The caller's word is tested in call-phone-yes-word(.db).test.js; the sweep runs against PostgreSQL in
 * call-phone-yes-accept.db.test.js. Synthetic names and numbers only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const gates = require('../config/feature-gates');
const { runCallPhoneYesSweep, cardSummary, REASONS } = require('../services/call-phone-yes-accept');

const GATE = 'GATE_CALL_PHONE_YES_ACCEPT';
const saved = process.env[GATE];
afterEach(() => {
  if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved;
});
const read = (path) => fs.readFileSync(require.resolve(path), 'utf8');

describe('the gate', () => {
  test('strict true only, read at call time; the boot log lists it', () => {
    delete process.env[GATE];
    expect(gates.callPhoneYesAcceptLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', 'on', '']) { process.env[GATE] = v; expect(gates.callPhoneYesAcceptLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(gates.callPhoneYesAcceptLive()).toBe(true);
    delete process.env[GATE];
    expect(gates.callPhoneYesAcceptLive()).toBe(false);
    expect(Object.keys(gates.gates)).toContain('callPhoneYesAccept');
  });

  test('off: the sweep returns before any query', async () => {
    delete process.env[GATE];
    await expect(runCallPhoneYesSweep()).resolves.toEqual({ skipped: true, scanned: 0, filed: 0, closed: 0 });
  });
});

describe('wiring', () => {
  test('the sweep is scheduled behind the gate, inside runExclusive', () => {
    const scheduler = read('../services/scheduler.js');
    expect(scheduler).toMatch(/if \(!require\('\.\.\/config\/feature-gates'\)\.callPhoneYesAcceptLive\(\)\) return;\s+try \{\s+await runExclusive\('call-phone-yes'/);
    expect(scheduler).toContain("require('./call-phone-yes-accept').runCallPhoneYesSweep()");
  });

  test('the booking text is untouched: it keeps the accept link', () => {
    expect(read('../services/call-recording-processor.js')).not.toContain('call-phone-yes-accept');
  });

  test("filing accepts nothing and sends nothing; the tap runs only the office's own accept and sends nothing itself", () => {
    const service = read('../services/call-phone-yes-accept.js');
    const at = service.indexOf('// ── The tap: "Accept as pay per application" ──');
    expect(at).toBeGreaterThan(0);
    const filing = service.slice(0, at);
    const tap = service.slice(at);
    for (const word of ['markEstimateManuallyAccepted', 'convertEstimate', 'sendSms', 'sendEmail', 'twilio', 'sendgrid', 'sendInvoice',
      'notifyAdmin', 'sendCustomerMessage', 'sendMembershipStarted', '.update({ source_estimate_id', 'estimated_price:']) {
      expect(filing).not.toContain(word);
    }
    // The tap: the office's own accept (it sends the membership email itself, as Mark accepted does), no send of its own.
    expect(tap).toContain('Manual.markEstimateManuallyAccepted({');
    for (const word of ['convertEstimate', 'sendSms', 'sendEmail', 'twilio', 'sendgrid', 'sendInvoice', 'notifyAdmin', 'sendCustomerMessage', 'sendMembershipStarted']) {
      expect(tap).not.toContain(word);
    }
  });

  test('the tap\'s link step takes its locks in order: property-preferences, the customers row, the triage lock, the booking call, the estimates (then the send check), the catalog, then the visit', () => {
    const service = read('../services/call-phone-yes-accept.js');
    const inOrder = (text, needles) => {
      const order = needles.map((needle) => text.indexOf(needle));
      expect(order.every((at) => at > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    };
    inOrder(service.slice(service.indexOf('function linkVisitStep('), service.indexOf('function priceSeriesStep(')), [
      "['property-preferences', String(customerId)]",
      "trx('customers').where({ id: customerId }).forUpdate()",
      "lockNoWaitOrStop(trx, [TRIAGE_LOCK_NAMESPACE, bookingCallId], 'call_busy')",
      "trx('call_log').where({ id: bookingCallId, customer_id: customerId }).forUpdate().noWait()",
      'await lockCustomerEstimates(trx, customerId);',
      "require('./scheduling/catalog-lock').lockCatalogIdentity(trx)",
      "trx('scheduled_services').where({ id: visit.id }).forUpdate()",
    ]);
    // The send check reads after the estimates' lock, so a claim cannot land between the read and the commit.
    inOrder(service.slice(service.indexOf('async function lockCustomerEstimates('), service.indexOf('function linkVisitStep(')), [
      '.forShare().noWait()',
      'estimateBeingSent(trx, customerId, new Date())',
    ]);
  });

  test("the caller's word comes from one module: the cards keep no copy of its rules", () => {
    const service = read('../services/call-phone-yes-accept.js');
    expect(service).toContain("require('./call-phone-yes-word')");
    for (const copy of ['function owedReadSql', 'function callerWordsOf', 'function wordOfCall', 'function latestBillingChoice',
      'function unreadCallSince', 'function laterWordProblem', 'function callerWord', "->> 'billing_choice'", 'billingChoiceOf(']) {
      expect(service).not.toContain(copy);
    }
  });

  test('the sweep rewrites the card in place, so its Resolve and Dismiss carry the version; a new recording keeps it', () => {
    expect(read('../routes/admin-triage.js')).toMatch(/const VERSION_BOUND_REASONS = \[[^\]]*'call_phone_yes'/);
    const { SUPERSEDE_KEPT_REASON_CODES, SUPERSEDE_KEPT_CARD_SQL } = require('../services/call-routing-gates');
    expect(SUPERSEDE_KEPT_REASON_CODES).toContain('call_phone_yes');
    // The implausible-transcript rejection reads only the SQL.
    expect(SUPERSEDE_KEPT_CARD_SQL).toContain("OR reason_code = 'call_phone_yes' OR");
  });

  test('the card is admin only and never closed by a call verdict', () => {
    const triage = read('../routes/admin-triage.js');
    expect(triage).toMatch(/const ADMIN_ONLY_REASONS = \[[^\]]*'call_phone_yes'/);
    expect(triage).toMatch(/call_phone_yes: 'This card asks the office to accept/);
    expect(triage).toMatch(/\.whereNotIn\('reason_code', \[[\s\S]*?'call_phone_yes',[\s\S]*?\]\)/);
    const client = read('../../client/src/pages/admin/TriageInboxTabV2.jsx');
    expect(client).toMatch(/const NO_VERDICT_REASONS = new Set\(\[[^\]]*"call_phone_yes"/);
    expect(client).toMatch(/const EVIDENCE_BY_REASON = \{[^}]*call_phone_yes: PhoneYesEvidence/);
  });
});

describe('the card text', () => {
  test('while the call with the yes is read again, the headline says so and claims no yes', () => {
    expect(cardSummary({ yes: null, rechecking: true })).toBe(
      'A call booked a pest visit while an estimate is open. The call with the yes is being read again. The estimate is not accepted yet.',
    );
  });

  test('two states: a yes the call reader recorded, or no yes heard', () => {
    expect(cardSummary({ yes: { callLogId: 'call-1', at: new Date(), quote: null } }))
      .toBe('Caller said yes to pay per application on the call. The estimate is not accepted yet.');
    expect(cardSummary({ yes: null }))
      .toBe('A call booked a pest visit while an estimate is open. No yes heard on the call. The estimate is not accepted yet.');
    expect(cardSummary({ yes: null })).not.toMatch(/said yes/);
  });

  test('every reason is one plain sentence or two, with no code words', () => {
    for (const [code, text] of Object.entries(REASONS)) {
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text).not.toContain(code);
    }
  });
});
