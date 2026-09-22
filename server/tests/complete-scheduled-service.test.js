process.env.JWT_SECRET = 'completion-service-test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => sql);
  db.schema = { hasColumn: jest.fn(async () => false), hasTable: jest.fn(async () => false) };
  db.transaction = jest.fn(async (callback) => callback(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/completion-attempts', () => ({
  COMPLETION_SMS_DEFINITE_REJECTION_PREFIX: jest.requireActual('../services/completion-attempts').COMPLETION_SMS_DEFINITE_REJECTION_PREFIX,
  claimCompletionAttempt: jest.fn(),
  hashCompletionRequest: jest.fn(() => 'synthetic-request-hash'),
  markCompletionAttemptFailed: jest.fn(async () => {}),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({})),
}));
jest.mock('../services/visit-groups', () => ({ lockStopForRow: jest.fn(async () => {}), stopBaseKey: jest.fn(() => 'fixture-stop') }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: jest.fn(async () => null) }));

const db = require('../models/db');
const attempts = require('../services/completion-attempts');
const {
  completeScheduledService,
  deliveryUnverifiedProviderOutcome,
  throwIfDeliveryUnverified,
  completionSmsDefiniteRejectionError,
  definiteRejectionMarkerFromAttemptError,
} = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');

const SERVICE_ID = '00000000-0000-4000-8000-000000000101';
const TECH_ID = '00000000-0000-4000-8000-000000000102';
const actor = { techRole: 'technician', technicianId: TECH_ID };
let service;
let builder;

beforeEach(() => {
  jest.clearAllMocks();
  service = {
    id: SERVICE_ID,
    customer_id: '00000000-0000-4000-8000-000000000103',
    technician_id: TECH_ID,
    service_type: 'Quarterly Pest Control',
    scheduled_date: etDateString(),
    status: 'on_site',
  };
  builder = {};
  for (const method of ['where', 'leftJoin', 'select', 'orderBy', 'whereNot', 'whereIn', 'whereRaw', 'forUpdate', 'whereNotNull', 'whereNull', 'limit']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.first = jest.fn(async () => service);
  builder.columnInfo = jest.fn(async () => ({}));
  db.mockReturnValue(builder);
});

const complete = (body = {}, overrides = {}) => completeScheduledService({
  serviceId: SERVICE_ID, body, actor, ...overrides,
});

test.each([
  [{ offerInspectionCredit: 'true' }, 'offerInspectionCredit must be a boolean'],
  [{ clientPestRating: 6 }, 'client_pest_rating_invalid'],
  [{ completionPhotos: {} }, 'completion_photos_invalid'],
])('invalid submission returns a result before any database read: %j', async (body, error) => {
  const result = await complete(body);
  expect(result.status).toBe(400);
  expect(result.body.code || result.body.error).toBe(error);
  expect(db).not.toHaveBeenCalled();
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

const INVALID_AREAS = [false, '', 0, -1, 2500.5, 10000001, {}, []];
const withLawnGates = async (run) => {
  process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  try {
    await run();
  } finally {
    delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  }
};

test.each([
  'front', [{ productId: '00000000-0000-4000-8000-000000000201' }], [{ productName: 'Iron' }],
  [{ productId: '00000000-0000-4000-8000-000000000201', productName: 'Iron', extra: true }], [{ productId: true, productName: 'Iron' }],
  [{ productId: 'p1', productName: 'Iron' }], [{ productId: 42, productName: 'Iron' }],
  [{ productId: '00000000-0000-4000-8000-000000000201', productName: 'Iron' }, { productId: '00000000-0000-4000-8000-000000000201', productName: 'Iron', reason: 'again' }],
  // A case-variant pair is the same PostgreSQL uuid: canonicalized before uniqueness (codex #4113 P2).
  [{ productId: '0000ABCD-0000-4000-8000-000000000201', productName: 'Iron' }, { productId: '0000abcd-0000-4000-8000-000000000201', productName: 'Iron' }],
])('malformed skipped plan defaults %j are rejected before a completion claim or database read, whatever the UI gates', async skippedProducts => {
  delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  const result = await complete({ lawnProtocolCompletion: { treatedSqft: 2500, skippedProducts } });
  expect(result).toMatchObject({ status: 400, body: { code: 'lawn_skipped_products_invalid' } });
  expect(db).not.toHaveBeenCalled();
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('skipped-default names are measured after trimming: padding around 180 characters is accepted, a 181-character name is rejected', async () => {
  delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
  const productId = '00000000-0000-4000-8000-000000000201';
  const payload = { success: true, serviceRecordId: 'fixture-record' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  try {
    const padded = `${' '.repeat(40)}${'x'.repeat(180)}${' '.repeat(40)}`;
    await expect(complete({ lawnProtocolCompletion: { treatedSqft: 2500, skippedProducts: [{ productId, productName: padded }] } }))
      .resolves.toEqual({ status: 200, body: payload });
    const result = await complete({ lawnProtocolCompletion: { treatedSqft: 2500, skippedProducts: [{ productId, productName: 'x'.repeat(181) }] } });
    expect(result).toMatchObject({ status: 400, body: { code: 'lawn_skipped_products_invalid' } });
  } finally {
    delete process.env.GATE_LAWN_ACTUALS_LEDGER;
  }
});

const withLedgerGateAlone = async (run) => {
  delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
  try {
    await run();
  } finally {
    delete process.env.GATE_LAWN_ACTUALS_LEDGER;
  }
};

test.each([-1, 2500.5, 10000001, 'front'])('invalid lawn visit area %j fails a fresh completion attempt after the claim under the ledger gate alone (defaults gates off)', async treatedSqft => {
  const completionAttempt = { id: 'fixture-attempt' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: completionAttempt });
  await withLedgerGateAlone(async () => {
    const result = await complete({ lawnProtocolCompletion: { treatedSqft } });
    expect(result).toMatchObject({ status: 400, body: { code: 'lawn_completion_area_invalid' } });
  });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalled();
  expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'lawn_completion_area_invalid' }), expect.anything());
});

test.each([2500.5, 'front'])('lawn visit area %j never blocks a committed completion from replaying under the ledger gate alone', async treatedSqft => {
  const payload = { success: true, serviceRecordId: 'fixture-record' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  await withLedgerGateAlone(async () => {
    await expect(complete({ lawnProtocolCompletion: { treatedSqft } })).resolves.toEqual({ status: 200, body: payload });
  });
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test.each([undefined, null, 2500, '2500', ...INVALID_AREAS])('lawn visit area %j never blocks a committed completion from replaying', async treatedSqft => {
  const payload = { success: true, serviceRecordId: 'fixture-record' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  await withLawnGates(async () => {
    await expect(complete({ lawnProtocolCompletion: { treatedSqft } })).resolves.toEqual({ status: 200, body: payload });
  });
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test.each(INVALID_AREAS)('invalid lawn visit area %j fails a fresh completion attempt after the claim', async treatedSqft => {
  const completionAttempt = { id: 'fixture-attempt' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: completionAttempt });
  await withLawnGates(async () => {
    const result = await complete({ lawnProtocolCompletion: { treatedSqft } });
    expect(result).toMatchObject({ status: 400, body: { code: 'lawn_completion_area_invalid' } });
  });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalled();
  expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'lawn_completion_area_invalid' }), expect.anything());
});

test('a missing service returns the existing 404 payload', async () => {
  service = null;
  await expect(complete()).resolves.toEqual({ status: 404, body: { error: 'Service not found' } });
  expect(builder.where).toHaveBeenCalledWith('scheduled_services.id', SERVICE_ID);
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('submitted actor fields cannot override the authenticated technician', async () => {
  service.technician_id = '00000000-0000-4000-8000-000000000104';
  const result = await complete({ techRole: 'admin', actor: { techRole: 'admin' } });
  expect(result.status).toBe(403);
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('unexpected read failure rejects and preserves completion failure handling', async () => {
  const error = new Error('synthetic database failure');
  builder.first.mockRejectedValueOnce(error);
  await expect(complete()).rejects.toBe(error);
  expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(null, error, db);
});

test('a stored completion replays without rewriting or starting a new completion', async () => {
  const payload = { success: true, serviceRecordId: 'record-test', invoice: { id: 'invoice-test' } };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  await expect(complete({ idempotencyKey: 'body-key' }, { idempotencyKey: 'header-key' }))
    .resolves.toEqual({ status: 200, body: payload });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalledWith({
    serviceId: SERVICE_ID, idempotencyKey: 'header-key', requestHash: 'synthetic-request-hash',
  }, db);
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test('a claim conflict returns its original status and payload', async () => {
  const payload = { code: 'completion_in_progress', retryAfterMs: 5000 };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'conflict', status: 409, payload });
  await expect(complete({ idempotencyKey: 'body-key' }))
    .resolves.toEqual({ status: 409, body: payload });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'body-key' }), db);
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test('a saved packet blocks the individual replay/resume claim', async () => {
  service.visit_id = '00000000-0000-4000-8000-000000000105';
  const result = await complete();
  expect(result).toMatchObject({ status: 409, body: { code: 'visit_grouped', visitId: service.visit_id } });
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('packet fields in the submitted form cannot grant packet ownership', async () => {
  service.visit_id = '00000000-0000-4000-8000-000000000105';
  const result = await complete({ packetRecord: { itemId: SERVICE_ID }, visitPacketId: SERVICE_ID });
  expect(result.status).toBe(409);
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

describe('completion SMS delivery-unverified classifiers', () => {
  test('deliveryUnverifiedProviderOutcome recognizes a bare uncertain outcome and one nested under providerOutcome', () => {
    const bare = { deliveryOutcome: 'uncertain', code: 'PROVIDER_TIMEOUT' };
    expect(deliveryUnverifiedProviderOutcome(bare)).toBe(bare);
    const err = Object.assign(new Error('boom'), { providerOutcome: bare });
    expect(deliveryUnverifiedProviderOutcome(err)).toBe(bare);
  });

  test('deliveryUnverifiedProviderOutcome returns null for a definite outcome or a missing one', () => {
    expect(deliveryUnverifiedProviderOutcome({ deliveryOutcome: 'not_sent' })).toBeNull();
    expect(deliveryUnverifiedProviderOutcome({ sent: true })).toBeNull();
    expect(deliveryUnverifiedProviderOutcome(null)).toBeNull();
    expect(deliveryUnverifiedProviderOutcome(undefined)).toBeNull();
  });

  test('deliveryUnverifiedProviderOutcome returns null for a THROWN definite rejection — the exact shape sendCustomerMessageCore raises for a pre-dispatch failure or a definite not_sent, which carries providerOutcome on every exception (Codex pre-push P1, round 2)', () => {
    // A bare `if (err.providerOutcome)` truthiness check — the round-1
    // shape this test guards against regressing to — would wrongly treat
    // this as uncertain: the messaging layer attaches providerOutcome to
    // EVERY exception it raises, definite rejections included.
    const definiteRejection = Object.assign(new Error('carrier rejected'), {
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent', code: 'CARRIER_REJECTED' },
    });
    expect(deliveryUnverifiedProviderOutcome(definiteRejection)).toBeNull();
    const preDispatchFailure = Object.assign(new Error('no route to customer'), {
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent', code: 'NO_ROUTE' },
    });
    expect(deliveryUnverifiedProviderOutcome(preDispatchFailure)).toBeNull();
  });

  test('deliveryUnverifiedProviderOutcome ALSO returns null for a THROWN ACCEPTED delivery (sent: true) — a post-acceptance bookkeeping failure, not an uncertain outcome, and a caller must check .sent separately before treating "not uncertain" as "safe to restore" (Codex pre-push P1, round 3)', () => {
    // e.g. the provider accepted the text but the audit-row insert then
    // threw. deliveryUnverifiedProviderOutcome correctly says "not
    // uncertain" here too — it is NOT the uncertain classifier's job to
    // catch this class; a caller deciding whether to restore a send claim
    // must check providerOutcome.sent === true on its own, exactly like the
    // payment-failed decline notice's outer catch now does.
    const acceptedThenBookkeepingFailed = Object.assign(new Error('audit insert failed'), {
      providerOutcome: { sent: true, deliveryOutcome: 'provider_accepted' },
    });
    expect(deliveryUnverifiedProviderOutcome(acceptedThenBookkeepingFailed)).toBeNull();
    expect(acceptedThenBookkeepingFailed.providerOutcome.sent).toBe(true);
  });

  test('throwIfDeliveryUnverified passes a definite result through untouched', () => {
    const result = { sent: true, deliveryOutcome: 'provider_accepted' };
    expect(throwIfDeliveryUnverified(result)).toBe(result);
  });

  test('throwIfDeliveryUnverified converts an uncertain RETURN into a throw carrying the same providerOutcome', () => {
    const result = { sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_TIMEOUT', reason: 'socket closed' };
    expect(() => throwIfDeliveryUnverified(result)).toThrow('socket closed');
    try {
      throwIfDeliveryUnverified(result);
    } catch (err) {
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(err.providerOutcome).toBe(result);
    }
  });

  test('completionSmsDefiniteRejectionError embeds the marker so definiteRejectionMarkerFromAttemptError can extract it back out', () => {
    const err = completionSmsDefiniteRejectionError('Twilio refused the message', '2026-09-17T12:00:00.000Z');
    expect(err.message).toBe('[completion_sms_definite_rejection marker=2026-09-17T12:00:00.000Z] Twilio refused the message');
    expect(definiteRejectionMarkerFromAttemptError(err.message)).toBe('2026-09-17T12:00:00.000Z');
  });

  test('completionSmsDefiniteRejectionError falls back to "missing" when no marker is available', () => {
    const err = completionSmsDefiniteRejectionError('Twilio refused the message', null);
    expect(err.message).toContain('marker=missing');
  });

  test('definiteRejectionMarkerFromAttemptError returns null for any error not carrying this marker', () => {
    expect(definiteRejectionMarkerFromAttemptError('plain failure')).toBeNull();
    expect(definiteRejectionMarkerFromAttemptError(undefined)).toBeNull();
    expect(definiteRejectionMarkerFromAttemptError('[completion_sms_definite_rejection marker=abc without a closing bracket')).toBeNull();
  });
});

describe('quiet-hours completion SMS deferral clears the pre-send uncertainty marker (commit 1c882ef6df)', () => {
  // The pre-send completionSmsDeliveryUnverifiedAt marker is stamped just
  // before the provider handoff (see the classifiers above) so a thrown
  // uncertain outcome is never mistaken for a definite one. A QUIET_HOURS_HOLD
  // response is a DEFINITE non-delivery whose obligation moves to the queued
  // replay — but terminalDeferredCompletionSend's own write (services/
  // dispatch-completion-deferred.js) only ever sets completionSmsStatus,
  // completionSmsError and completionSmsFailedAt; it merges into
  // structured_notes and never touches completionSmsDeliveryUnverifiedAt.
  // A pre-send marker left in place by the deferral write would therefore
  // survive a terminal replay failure untouched and, per the
  // completionSmsAlreadyHandled guard beside completionSmsMarkerWasDefinitely-
  // Rejected, block every later completion retry despite the definite
  // non-delivery the terminal failure just recorded. This function is ~13k
  // lines deep with no functional harness reaching this exact branch
  // (confirmed: no test in this repo drives completeScheduledService's own
  // completion-SMS QUIET_HOURS_HOLD deferral to a real sendCustomerMessage
  // call), so the fix is pinned structurally, matching this repo's own
  // "source contracts" convention (tests/invoice-issued-closeout-completion-
  // postgres.test.js) for exactly this situation.
  test('the deferredDelta written with the queue insertion clears completionSmsDeliveryUnverifiedAt', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    // The SAME object also carries the marker clear inside the atomic
    // db.transaction that inserts the dispatch_completion_deferred queue
    // row and merges these exact keys into structured_notes — so this one
    // object literal IS the fix: reverting the added key desyncs the
    // written notes from the queue row that now owns delivery.
    expect(source).toMatch(
      /const deferredDelta = \{\s*\n\s*completionSmsStatus: 'deferred',\s*\n\s*completionSmsDeferredTo: smsResult\.nextAllowedAt,\s*\n(?:\s*\/\/[^\n]*\n)*\s*completionSmsDeliveryUnverifiedAt: null,\s*\n\s*\};/,
    );
    // Confirms the SAME object (not a stray copy) is what actually reaches
    // structured_notes, atomically with the queue insert.
    const deferredDeltaAt = source.indexOf("const deferredDelta = {");
    const txAt = source.indexOf('await db.transaction(async (trx) => {', deferredDeltaAt);
    const mergeAt = source.indexOf('JSON.stringify(deferredDelta)', txAt);
    expect(deferredDeltaAt).toBeGreaterThan(-1);
    expect(txAt).toBeGreaterThan(deferredDeltaAt);
    expect(mergeAt).toBeGreaterThan(txAt);
  });
});

describe('payment-failed decline notice claim acquisition (#4131 slice 5, deferred by #4632 r2 P2)', () => {
  // Same "source contract" convention as the quiet-hours deferral test above
  // (invoice-issued-closeout-completion-postgres.test.js's own precedent,
  // cited there): no existing harness in this repo drives
  // completeScheduledService's own autopay-decline branch to a real
  // sendCustomerMessage call (it needs a declined saved-card charge inside a
  // full packet/visit completion — the nearest fixture,
  // visit-completion-packets-postgres.test.js's enableFixtureAutopay, tests
  // the retention/collection lane, not this notice). Pinned structurally: the
  // notice must acquire the shared invoice send claim before it can send,
  // must wrap the provider call with throwIfDeliveryUnverified (an uncertain
  // outcome must escape to the outer catch WITHOUT restoring the claim), and
  // must give the claim back on every outcome that resolves without it
  // (deferred / not-sent / delivered) before the delivered branch finalizes
  // through markDeliverySent.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const noticeStart = source.indexOf("&& !isBackfillCompletion) {");
  const noticeEnd = source.indexOf("// Report EMAIL enqueue", noticeStart);
  const noticeBlock = noticeStart > -1 && noticeEnd > noticeStart ? source.slice(noticeStart, noticeEnd) : '';

  test('the notice block exists exactly once and is where the claim/send/restore sequence is checked', () => {
    expect(noticeStart).toBeGreaterThan(-1);
    expect(noticeEnd).toBeGreaterThan(noticeStart);
  });

  test('claims the shared invoice send claim before rendering or sending the notice', () => {
    const claimAt = noticeBlock.indexOf('.claimInvoiceForSend(invoice.id)');
    const sendAt = noticeBlock.indexOf('await sendCustomerMessage({');
    expect(claimAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(claimAt);
  });

  test('a claim refusal is caught and logged rather than thrown out of the completion', () => {
    expect(noticeBlock).toMatch(/let declineSendClaim = null;\s*\n\s*try \{\s*\n\s*declineSendClaim = await \w+\.claimInvoiceForSend\(invoice\.id\);\s*\n\s*\} catch \(claimErr\) \{/);
  });

  test('the send itself is wrapped with throwIfDeliveryUnverified', () => {
    expect(noticeBlock).toMatch(/const failResult = throwIfDeliveryUnverified\(await sendCustomerMessage\(\{/);
  });

  test('every resolved outcome that does NOT finalize (deferred, not-sent, no renderable body) gives the claim back with a plain restoreSendClaim call', () => {
    const restorePattern = /\.restoreSendClaim\(\s*\n\s*invoice\.id, declineSendClaim\.previousStatus, declineSendClaim\.claimed,\s*\n\s*\[\], db, declineSendClaim\.invoice\.send_claim_token,\s*\n\s*\);/g;
    const restoreCount = (noticeBlock.match(restorePattern) || []).length;
    // Deferred, not-sent, and no-renderable-body (an empty/disabled template)
    // each restore the claim outright — none of them go on to deliver
    // anything. The outer-catch fallback restore is deliberately excluded
    // from this count: it chains `.catch(() => {})` onto the same call, a
    // different shape, checked in its own test below.
    expect(restoreCount).toBe(3);
  });

  test('the delivered branch does NOT restore-then-finalize as two steps — it passes its own claim token into markDeliverySent so the finalize and the claim release are ONE atomic UPDATE (Codex pre-push P1)', () => {
    const deliveredAt = noticeBlock.indexOf('// The notice DELIVERED the pay link');
    expect(deliveredAt).toBeGreaterThan(-1);
    const restoreBetween = noticeBlock.indexOf('.restoreSendClaim(', deliveredAt);
    const markDeliveredAt = noticeBlock.indexOf('.markDeliverySent(invoice.id', deliveredAt);
    expect(markDeliveredAt).toBeGreaterThan(deliveredAt);
    // No plain restoreSendClaim call between the DELIVERED comment and its
    // own markDeliverySent call — a separate restore-then-finalize would
    // expose an unclaimed row in the gap for a concurrent sender to grab.
    expect(restoreBetween === -1 || restoreBetween > markDeliveredAt).toBe(true);
    expect(noticeBlock.slice(deliveredAt, markDeliveredAt + 400)).toMatch(
      /claimToken: declineSendClaim\.invoice\.send_claim_token/,
    );
  });

  test('markDeliverySent itself requires and releases a passed claimToken atomically, and never finalizes a row it does not own', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
    const fnAt = source.indexOf('async markDeliverySent(');
    expect(fnAt).toBeGreaterThan(-1);
    const fnBody = source.slice(fnAt, fnAt + 4000);
    expect(fnBody).toMatch(/if \(claimToken && invoice\.send_claim_token !== claimToken\) return invoice;/);
    expect(fnBody).toMatch(/if \(claimToken\) updates\.send_claim_token = null;/);
    expect(fnBody).toMatch(/if \(claimToken\) finalizeQuery\.where\(\{ send_claim_token: claimToken \}\);/);
  });

  test('a throw reaching the outer catch restores the claim ONLY when it is neither uncertain NOR provider-accepted — never a bare providerOutcome presence check, and never "not uncertain" alone (Codex pre-push P1, rounds 2 and 3)', () => {
    // Round 2: the messaging layer attaches providerOutcome to EVERY
    // exception it raises, including a DEFINITE rejection (deliveryOutcome:
    // 'not_sent') — checking mere presence (the round-1 shape) wrongly
    // retained those claims too. deliveryUnverifiedProviderOutcome (used by
    // every other completion-SMS sender in this file) distinguishes
    // "genuinely uncertain" from "definite".
    // Round 3: "not uncertain" alone is still not "safe to restore" — an
    // ACCEPTED delivery whose throw came from post-acceptance bookkeeping
    // (e.g. the audit-row insert) is ALSO not 'uncertain', so it must be
    // excluded on its own via providerOutcome.sent === true, or a customer
    // who already has the pay link gets it re-texted by the next retry.
    const catchAt = noticeBlock.lastIndexOf('} catch (failErr) {');
    expect(catchAt).toBeGreaterThan(-1);
    const catchBody = noticeBlock.slice(catchAt, catchAt + 2200);
    expect(catchBody).toMatch(/const providerAccepted = failErr\?\.providerOutcome\?\.sent === true;/);
    expect(catchBody).toMatch(/if \(declineSendClaim && !providerAccepted && !deliveryUnverifiedProviderOutcome\(failErr\)\) \{/);
    expect(catchBody).not.toMatch(/if \(declineSendClaim && !failErr\?\.providerOutcome\)/);
    expect(catchBody).not.toMatch(/if \(declineSendClaim && !deliveryUnverifiedProviderOutcome\(failErr\)\) \{/);
    expect(catchBody).toMatch(/\.restoreSendClaim\(/);
  });
});
