jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  sendOne: jest.fn(),
  newsletterGroupId: jest.fn(() => 111),
  serviceGroupId: jest.fn(() => 222),
}));
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: jest.fn(),
  activeSuppressionFor: jest.fn(),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const emailLib = require('../services/email-template-library');
const NotificationService = require('../services/notification-service');
const recovery = require('../services/email-bounce-recovery');

// Minimal chainable knex mock. Every builder method returns the chain; the
// terminal-ish methods resolve to configurable values.
function makeChain(overrides = {}) {
  const chain = {};
  const passthrough = ['where', 'whereRaw', 'whereNot', 'whereIn', 'andWhere',
    'orWhereRaw', 'onConflict', 'ignore', 'modify', 'insert', 'select'];
  for (const m of passthrough) chain[m] = jest.fn(() => chain);
  chain.first = jest.fn(() => Promise.resolve('first' in overrides ? overrides.first : null));
  chain.update = jest.fn(() => Promise.resolve('update' in overrides ? overrides.update : 0));
  chain.returning = jest.fn(() => Promise.resolve('returning' in overrides ? overrides.returning : []));
  return chain;
}

describe('isHardBounceEvent', () => {
  test('true only for true hard bounces', () => {
    expect(recovery.isHardBounceEvent({ event: 'bounce', type: 'bounce' })).toBe(true);
    expect(recovery.isHardBounceEvent({ event: 'bounce', type: 'hard' })).toBe(true);
    expect(recovery.isHardBounceEvent({ event: 'bounce' })).toBe(true);
    expect(recovery.isHardBounceEvent({ event: 'dropped', reason: 'Bounced Address' })).toBe(true);
    expect(recovery.isHardBounceEvent({ event: 'dropped', reason: 'Invalid' })).toBe(true);
  });
  test('false for soft / non-address signals', () => {
    expect(recovery.isHardBounceEvent({ event: 'bounce', type: 'blocked' })).toBe(false);
    expect(recovery.isHardBounceEvent({ event: 'blocked' })).toBe(false);
    expect(recovery.isHardBounceEvent({ event: 'dropped', reason: 'Unsubscribed Address' })).toBe(false);
    expect(recovery.isHardBounceEvent({ event: 'dropped', reason: 'Spam Reporting Address' })).toBe(false);
    expect(recovery.isHardBounceEvent({ event: 'delivered' })).toBe(false);
    expect(recovery.isHardBounceEvent({})).toBe(false);
  });
});

describe('isRecoveryMessage', () => {
  test('detects the bounce_recovery category in array or JSON-string form', () => {
    expect(recovery.isRecoveryMessage({ categories: ['email_template', 'bounce_recovery'] })).toBe(true);
    expect(recovery.isRecoveryMessage({ categories: JSON.stringify(['x', 'bounce_recovery']) })).toBe(true);
    expect(recovery.isRecoveryMessage({ categories: ['email_template'] })).toBe(false);
    expect(recovery.isRecoveryMessage({ categories: null })).toBe(false);
    expect(recovery.isRecoveryMessage({})).toBe(false);
  });
});

describe('decideRecoveryAction', () => {
  test('sends only a confidence-passing, non-suppressed candidate', () => {
    expect(recovery.decideRecoveryAction({ candidate: { confidence: 'high' }, suppressed: false, min: 'high' }))
      .toEqual({ action: 'send', status: 'resent' });
  });
  test('skips when no candidate', () => {
    expect(recovery.decideRecoveryAction({ candidate: null, suppressed: false, min: 'high' }))
      .toEqual({ action: 'skip', status: 'no_candidate' });
  });
  test('skips below threshold', () => {
    expect(recovery.decideRecoveryAction({ candidate: { confidence: 'medium' }, suppressed: false, min: 'high' }))
      .toEqual({ action: 'skip', status: 'skipped_low_confidence' });
  });
  test('skips when corrected address is suppressed', () => {
    expect(recovery.decideRecoveryAction({ candidate: { confidence: 'high' }, suppressed: true, min: 'high' }))
      .toEqual({ action: 'skip', status: 'corrected_suppressed' });
  });
  test('skips (privacy) when corrected address belongs to another customer', () => {
    expect(recovery.decideRecoveryAction({ candidate: { confidence: 'high' }, suppressed: false, ownedByOther: true, min: 'high' }))
      .toEqual({ action: 'skip', status: 'corrected_owned_by_other' });
  });
  test('skips when the original carried an attachment (cannot replay PDF)', () => {
    expect(recovery.decideRecoveryAction({ candidate: { confidence: 'high' }, suppressed: false, ownedByOther: false, hasAttachments: true, min: 'high' }))
      .toEqual({ action: 'skip', status: 'has_attachments' });
  });
  test('skips when the bounced address is no longer on file', () => {
    expect(recovery.decideRecoveryAction({ candidate: { confidence: 'high' }, suppressed: false, ownedByOther: false, addressOnFile: false, min: 'high' }))
      .toEqual({ action: 'skip', status: 'address_no_longer_on_file' });
  });
  test('medium threshold accepts medium candidates', () => {
    expect(recovery.decideRecoveryAction({ candidate: { confidence: 'medium' }, suppressed: false, min: 'medium' }))
      .toEqual({ action: 'send', status: 'resent' });
  });
});

describe('asmGroupIdForStream', () => {
  test('maps streams to ASM groups', () => {
    expect(recovery.asmGroupIdForStream('transactional_required')).toBe(0);
    expect(recovery.asmGroupIdForStream('marketing_newsletter')).toBe(111);
    expect(recovery.asmGroupIdForStream('service_operational')).toBe(222);
    expect(recovery.asmGroupIdForStream(null)).toBe(222);
  });
});

describe('env gating', () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  test('recoveryEnabled defaults on, off via env', () => {
    delete process.env.EMAIL_BOUNCE_RECOVERY;
    expect(recovery.recoveryEnabled()).toBe(true);
    process.env.EMAIL_BOUNCE_RECOVERY = 'off';
    expect(recovery.recoveryEnabled()).toBe(false);
  });
  test('minConfidence defaults high, honors valid override', () => {
    delete process.env.EMAIL_RECOVERY_MIN_CONFIDENCE;
    expect(recovery.minConfidence()).toBe('high');
    process.env.EMAIL_RECOVERY_MIN_CONFIDENCE = 'medium';
    expect(recovery.minConfidence()).toBe('medium');
    process.env.EMAIL_RECOVERY_MIN_CONFIDENCE = 'garbage';
    expect(recovery.minConfidence()).toBe('high');
  });
});

describe('attemptRecovery guards', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    db.mockReset();
    db.mockReturnValue(makeChain());
  });
  afterEach(() => { process.env = { ...orig }; });

  test('disabled killswitch short-circuits before any DB access', async () => {
    process.env.EMAIL_BOUNCE_RECOVERY = 'off';
    const res = await recovery.attemptRecovery({ id: 'm1', recipient_email_snapshot: 'a@gmial.com' }, {});
    expect(res).toEqual({ skipped: 'disabled' });
    expect(db).not.toHaveBeenCalled();
  });

  test('loop guard: a recovery message that re-bounces does not recurse', async () => {
    delete process.env.EMAIL_BOUNCE_RECOVERY;
    db.mockReturnValue(makeChain({ first: null }));
    const res = await recovery.attemptRecovery(
      { id: 'm2', recipient_email_snapshot: 'a@gmail.com', categories: ['bounce_recovery'] },
      { event: 'bounce', type: 'bounce' },
    );
    expect(res).toEqual({ skipped: 'recovery_message_rebounced' });
  });

  test('idempotent: a duplicate bounce (insert conflict) is skipped', async () => {
    delete process.env.EMAIL_BOUNCE_RECOVERY;
    db.mockReturnValue(makeChain({ returning: [] })); // onConflict ignore -> no row
    const res = await recovery.attemptRecovery(
      { id: 'm3', recipient_email_snapshot: 'a@gmial.com', categories: ['email_template'] },
      { event: 'bounce', type: 'bounce' },
    );
    expect(res).toEqual({ skipped: 'already_attempted' });
  });
});

// Per-table mock that records every .update() in call order, so we can assert
// the ledger is linked before the provider id is published.
function orderedDb(resolvers = {}) {
  const calls = [];
  const fn = jest.fn((table) => {
    const chain = {};
    for (const m of ['where', 'whereRaw', 'whereNot', 'whereIn', 'andWhere', 'orWhereRaw', 'onConflict', 'ignore', 'modify', 'insert', 'select']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.first = jest.fn(() => Promise.resolve(resolvers.first ? resolvers.first(table) : null));
    chain.returning = jest.fn(() => Promise.resolve(resolvers.returning ? resolvers.returning(table) : []));
    chain.update = jest.fn((data) => { calls.push({ table, data }); return Promise.resolve(resolvers.update ? resolvers.update(table, data) : 1); });
    // Thenable so `await db(...).where(...).catch(...)` (suppression fallback) resolves to rows.
    const rowsFor = () => (resolvers.rows ? resolvers.rows(table) : []);
    chain.then = (res, rej) => Promise.resolve(rowsFor()).then(res, rej);
    chain.catch = (rej) => Promise.resolve(rowsFor()).catch(rej);
    return chain;
  });
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  fn._calls = calls;
  return fn;
}

describe('attemptRecovery codex-fix behaviors', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    db.mockReset();
    sendgrid.sendOne.mockReset();
    emailLib.loadTemplateByKey.mockReset();
    NotificationService.notifyAdmin.mockReset();
    db.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
    delete process.env.EMAIL_BOUNCE_RECOVERY;
    delete process.env.EMAIL_RECOVERY_MIN_CONFIDENCE;
  });
  afterEach(() => { process.env = { ...orig }; });

  test('links the ledger BEFORE publishing the provider id (delivery-race fix)', async () => {
    emailLib.loadTemplateByKey.mockResolvedValue(undefined);
    sendgrid.sendOne.mockResolvedValue({ messageId: 'pm_1' });
    const mockDb = orderedDb({
      // estimates/leads return a row so the "bounced address still on file" gate passes.
      first: (table) => ((table === 'estimates' || table === 'leads') ? { id: 'src' } : null),
      returning: (table) => {
        if (table === 'email_bounce_recoveries') return [{ id: 'rec1' }];
        if (table === 'email_messages') return [{ id: 'msg1', status: 'queued', from_email_snapshot: 'contact@wavespestcontrol.com', from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com', subject_snapshot: 'S' }];
        return [];
      },
    });
    db.mockImplementation(mockDb);

    const res = await recovery.attemptRecovery(
      { id: 'orig1', recipient_email_snapshot: 'jane@gmial.com', template_key: 'estimate.delivery', suppression_group_key_snapshot: 'service_operational', categories: ['email_template'] },
      { event: 'bounce', type: 'bounce' },
    );

    expect(res).toMatchObject({ resent: true });
    const linkIdx = mockDb._calls.findIndex((c) => c.table === 'email_bounce_recoveries' && c.data.recovery_message_id === 'msg1');
    const pubIdx = mockDb._calls.findIndex((c) => c.table === 'email_messages' && c.data.provider_message_id === 'pm_1');
    expect(linkIdx).toBeGreaterThanOrEqual(0);
    expect(pubIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeLessThan(pubIdx);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // P2: the send carries a custom arg so a fast webhook can resolve the row
    // before provider_message_id is committed.
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ customArgs: { email_message_id: 'msg1' } }));
    // round 10: the provider-id write must NOT also set status (so a fast
    // delivery/bounce webhook that already terminalized the row isn't regressed);
    // status is advanced separately, guarded on still-'queued'.
    const pubCall = mockDb._calls.find((c) => c.table === 'email_messages' && c.data.provider_message_id === 'pm_1');
    expect(pubCall.data.status).toBeUndefined();
    expect(mockDb._calls.some((c) => c.table === 'email_messages' && c.data.status === 'sent')).toBe(true);
  });

  test('does NOT send when the corrected address belongs to another customer (privacy)', async () => {
    emailLib.loadTemplateByKey.mockResolvedValue(undefined);
    db.mockImplementation(orderedDb({
      first: () => null, // no resolvable owner for the bounced message (lead)
      returning: (table) => (table === 'email_bounce_recoveries' ? [{ id: 'rec3' }] : []),
      rows: (table) => (table === 'customers' ? [{ id: 'other-customer' }] : []),
    }));

    const res = await recovery.attemptRecovery(
      { id: 'orig3', recipient_email_snapshot: 'jane@gmial.com', template_key: 'invoice.sent', suppression_group_key_snapshot: 'service_operational', categories: ['email_template'] },
      { event: 'bounce', type: 'bounce' },
    );

    expect(res).toEqual({ skipped: 'corrected_owned_by_other' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('already belongs to another customer');
  });

  test('alerts with a suggestion when a medium-confidence typo is below the auto-send threshold', async () => {
    emailLib.loadTemplateByKey.mockResolvedValue(undefined);
    db.mockImplementation(orderedDb({
      first: () => null,
      returning: (table) => (table === 'email_bounce_recoveries' ? [{ id: 'rec2' }] : []),
    }));

    const res = await recovery.attemptRecovery(
      { id: 'orig2', recipient_email_snapshot: 'jane@gnaul.com', template_key: 'estimate.delivery', suppression_group_key_snapshot: 'service_operational', categories: ['email_template'] },
      { event: 'bounce', type: 'bounce' },
    );

    expect(res).toEqual({ skipped: 'skipped_low_confidence' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('Suggested correction: jane@gmail.com');
  });

  test('does NOT auto-replay an attachment-bearing send (routes to manual)', async () => {
    emailLib.loadTemplateByKey.mockResolvedValue(undefined);
    db.mockImplementation(orderedDb({
      first: () => null,
      returning: (table) => (table === 'email_bounce_recoveries' ? [{ id: 'rec4' }] : []),
    }));

    const res = await recovery.attemptRecovery(
      { id: 'orig4', recipient_email_snapshot: 'jane@gmial.com', template_key: 'invoice.sent', suppression_group_key_snapshot: 'transactional_required', categories: ['email_template'], has_attachments: true },
      { event: 'bounce', type: 'bounce' },
    );

    expect(res).toEqual({ skipped: 'has_attachments' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('attachment');
  });

  test('fails closed on a known attachment template even when has_attachments is unset (legacy row)', async () => {
    emailLib.loadTemplateByKey.mockResolvedValue(undefined);
    db.mockImplementation(orderedDb({
      first: () => null,
      returning: (table) => (table === 'email_bounce_recoveries' ? [{ id: 'rec5' }] : []),
    }));

    const res = await recovery.attemptRecovery(
      // Legacy direct-inserter row: attachment-bearing template, flag not stamped.
      { id: 'orig5', recipient_email_snapshot: 'jane@gmial.com', template_key: 'service.report_ready.legacy', suppression_group_key_snapshot: 'service_operational', categories: ['service_report_v1'], has_attachments: false },
      { event: 'bounce', type: 'bounce' },
    );

    expect(res).toEqual({ skipped: 'has_attachments' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

// Thenable + chainable mock so `await db(...).where(...).catch(...)` resolves to rows.
function suppressionDb(rows) {
  return jest.fn(() => {
    const chain = {};
    const result = Promise.resolve(rows);
    for (const m of ['whereRaw', 'where', 'whereIn', 'whereNot', 'andWhere', 'orWhereRaw', 'modify']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.then = (res, rej) => result.then(res, rej);
    chain.catch = (rej) => result.catch(rej);
    chain.first = jest.fn(() => Promise.resolve(rows[0] || null));
    return chain;
  });
}

describe('correctedAddressSuppressed fallback honors group suppressions (codex P1)', () => {
  beforeEach(() => {
    db.mockReset();
    emailLib.loadTemplateByKey.mockReset();
    emailLib.loadTemplateByKey.mockResolvedValue(undefined); // force the fallback path
  });

  const msg = (stream) => ({ template_key: 'service.report_ready.legacy', suppression_group_key_snapshot: stream });

  test('blocks when an active group suppression matches the message stream', async () => {
    db.mockImplementation(suppressionDb([{ group_key: 'service_operational', suppression_type: 'unsubscribe' }]));
    await expect(recovery.correctedAddressSuppressed(msg('service_operational'), 'jane@gmail.com')).resolves.toBe(true);
  });

  test('does NOT block when the suppression is for a different group', async () => {
    db.mockImplementation(suppressionDb([{ group_key: 'marketing_newsletter', suppression_type: 'unsubscribe' }]));
    await expect(recovery.correctedAddressSuppressed(msg('service_operational'), 'jane@gmail.com')).resolves.toBe(false);
  });

  test('global suppressions always block', async () => {
    db.mockImplementation(suppressionDb([{ group_key: null, suppression_type: 'bounce' }]));
    await expect(recovery.correctedAddressSuppressed(msg('service_operational'), 'jane@gmail.com')).resolves.toBe(true);
  });

  test('transactional_required bypasses group opt-outs but not global ones', async () => {
    db.mockImplementation(suppressionDb([{ group_key: 'service_operational', suppression_type: 'unsubscribe' }]));
    await expect(recovery.correctedAddressSuppressed(msg('transactional_required'), 'jane@gmail.com')).resolves.toBe(false);
    db.mockImplementation(suppressionDb([{ group_key: null, suppression_type: 'do_not_email' }]));
    await expect(recovery.correctedAddressSuppressed(msg('transactional_required'), 'jane@gmail.com')).resolves.toBe(true);
  });

  test('no active suppression → not blocked', async () => {
    db.mockImplementation(suppressionDb([]));
    await expect(recovery.correctedAddressSuppressed(msg('service_operational'), 'jane@gmail.com')).resolves.toBe(false);
  });
});

// Table-aware thenable mock for the ownership queries (customers/leads/estimates).
function ownerDb(byTable = {}) {
  return jest.fn((table) => {
    const rows = byTable[table] || [];
    const chain = {};
    const result = Promise.resolve(rows);
    for (const m of ['where', 'whereRaw', 'orWhereRaw', 'select', 'modify']) chain[m] = jest.fn(() => chain);
    chain.then = (res, rej) => result.then(res, rej);
    chain.catch = (rej) => result.catch(rej);
    chain.first = jest.fn(() => Promise.resolve(rows[0] || null));
    return chain;
  });
}

describe('correctedAddressOwnedByOther (codex P1 privacy guard)', () => {
  beforeEach(() => db.mockReset());

  test('true when the corrected address is on file for a different customer', async () => {
    db.mockImplementation(ownerDb({ customers: [{ id: 'c2' }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', 'c1')).resolves.toBe(true);
  });
  test('false when it only matches the same customer', async () => {
    db.mockImplementation(ownerDb({ customers: [{ id: 'c1' }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', 'c1')).resolves.toBe(false);
  });
  test('false when no customer has it', async () => {
    db.mockImplementation(ownerDb({}));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', 'c1')).resolves.toBe(false);
  });
  test('lead (no own customer): a matching customer blocks', async () => {
    db.mockImplementation(ownerDb({ customers: [{ id: 'c9' }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', null)).resolves.toBe(true);
  });
  test('lead (no own customer): a matching OTHER lead blocks', async () => {
    db.mockImplementation(ownerDb({ leads: [{ id: 'l1' }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', null)).resolves.toBe(true);
  });
  test('lead (no own customer): a matching estimate blocks', async () => {
    db.mockImplementation(ownerDb({ estimates: [{ id: 'e1' }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', null)).resolves.toBe(true);
  });
  test('lead (no own customer): unowned address is fine', async () => {
    db.mockImplementation(ownerDb({}));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', null)).resolves.toBe(false);
  });
  test('customer recovery: blocks when address is on another party\'s estimate/lead', async () => {
    // A prospect estimate (no customer_id) holds the corrected address → other party.
    db.mockImplementation(ownerDb({ estimates: [{ customer_id: null }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', 'c1')).resolves.toBe(true);
    // An estimate owned by a DIFFERENT customer → other party.
    db.mockImplementation(ownerDb({ estimates: [{ customer_id: 'c2' }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', 'c1')).resolves.toBe(true);
  });
  test('customer recovery: allows when the matching estimate/lead is the SAME customer', async () => {
    // The customer's own prior estimate + lead (post-conversion) must not over-block.
    db.mockImplementation(ownerDb({ estimates: [{ customer_id: 'c1' }], leads: [{ customer_id: 'c1' }] }));
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', 'c1')).resolves.toBe(false);
  });
});

// Safety checks must fail CLOSED on DB error (codex round 6): a lookup failure
// must never let recovery auto-resend.
function rejectingDb() {
  return jest.fn(() => {
    const chain = {};
    for (const m of ['where', 'whereRaw', 'whereNot', 'whereIn', 'orWhereRaw', 'select', 'modify']) chain[m] = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.reject(new Error('db down')).then(res, rej);
    chain.catch = (rej) => Promise.reject(new Error('db down')).catch(rej);
    chain.first = jest.fn(() => Promise.reject(new Error('db down')));
    return chain;
  });
}

describe('safety checks fail closed on DB error (codex round 6)', () => {
  beforeEach(() => {
    db.mockReset();
    emailLib.loadTemplateByKey.mockReset();
    emailLib.loadTemplateByKey.mockResolvedValue(undefined); // force the fallback query path
    db.mockImplementation(rejectingDb());
  });

  test('correctedAddressSuppressed → suppressed (true) when the lookup errors', async () => {
    await expect(
      recovery.correctedAddressSuppressed({ template_key: 'x', suppression_group_key_snapshot: 'service_operational' }, 'jane@gmail.com'),
    ).resolves.toBe(true);
  });

  test('correctedAddressOwnedByOther → owned (true) when the lookup errors', async () => {
    await expect(recovery.correctedAddressOwnedByOther('jane@gmail.com', 'c1')).resolves.toBe(true);
  });

  test('bouncedAddressStillOnFile → not on file (false) when the lookup errors', async () => {
    // No customer-field match + estimate/lead lookup errors → fail closed to manual.
    await expect(recovery.bouncedAddressStillOnFile('jane@gmial.com', { customerId: 'c1', field: null })).resolves.toBe(false);
  });
});

// Lead/estimate recoveries must fix the SOURCE address on delivery, not just resend (codex round 7).
// estRows/leadRows feed the no-customer `select('id')` uniqueness path (round 11).
function commitDb({ rec, estUpdate = 1, leadUpdate = 1, estRows = [], leadRows = [] }) {
  const fn = jest.fn((table) => {
    const chain = {};
    const rowsFor = table === 'estimates' ? estRows : table === 'leads' ? leadRows : [];
    for (const m of ['where', 'whereRaw', 'whereNot', 'whereIn', 'andWhere', 'orWhereRaw', 'onConflict', 'ignore', 'modify', 'insert', 'select']) chain[m] = jest.fn(() => chain);
    // Thenable so `await db(t).whereRaw(...).select('id')` resolves to rows.
    chain.then = (res, rej) => Promise.resolve(rowsFor).then(res, rej);
    chain.catch = (rej) => Promise.resolve(rowsFor).catch(rej);
    chain.first = jest.fn(() => Promise.resolve(table === 'email_bounce_recoveries' ? rec : null));
    chain.update = jest.fn(() => Promise.resolve(table === 'estimates' ? estUpdate : table === 'leads' ? leadUpdate : 1));
    chain.returning = jest.fn(() => Promise.resolve([]));
    return chain;
  });
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return fn;
}

describe('commitRecoveryOnDelivery persists lead/estimate source address (codex round 7)', () => {
  beforeEach(() => {
    db.mockReset();
    NotificationService.notifyAdmin.mockReset();
  });

  test('updates estimates.customer_email for a no-customer recovery on delivery', async () => {
    const rec = {
      id: 'rec9', customer_id: null, customer_email_field: null,
      corrected_email: 'jane@gmail.com', bounced_email: 'jane@gmial.com',
      correction_rule: 'domain_typo', status: 'resent', record_updated: false, metadata: {},
    };
    db.mockImplementation(commitDb({ rec, estUpdate: 1, leadUpdate: 0, estRows: [{ id: 'e1' }], leadRows: [] }));
    await recovery.commitRecoveryOnDelivery({ id: 'msg9', recipient_email_snapshot: 'jane@gmail.com' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('estimates.customer_email');
  });

  test('no-customer recovery does NOT rewrite an AMBIGUOUS source (codex round 11)', async () => {
    const rec = {
      id: 'rec11', customer_id: null, customer_email_field: null,
      corrected_email: 'jane@gmail.com', bounced_email: 'jane@gmial.com',
      correction_rule: 'domain_typo', status: 'resent', record_updated: false, metadata: {},
    };
    // Two estimates share the same typo → ambiguous, must not corrupt either.
    db.mockImplementation(commitDb({ rec, estRows: [{ id: 'e1' }, { id: 'e2' }], leadRows: [] }));
    await recovery.commitRecoveryOnDelivery({ id: 'msg11', recipient_email_snapshot: 'jane@gmail.com' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    // Committed (resend delivered) but no source field was rewritten.
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).not.toContain('estimates.customer_email');
  });

  test('no-customer recovery does NOT rewrite when the typo is split across estimate + lead (codex round 12)', async () => {
    const rec = {
      id: 'rec12', customer_id: null, customer_email_field: null,
      corrected_email: 'jane@gmail.com', bounced_email: 'jane@gmial.com',
      correction_rule: 'domain_typo', status: 'resent', record_updated: false, metadata: {},
    };
    // 1 estimate + 1 lead = 2 matches across tables → can't prove same prospect.
    db.mockImplementation(commitDb({ rec, estRows: [{ id: 'e1' }], leadRows: [{ id: 'l1' }] }));
    await recovery.commitRecoveryOnDelivery({ id: 'msg12', recipient_email_snapshot: 'jane@gmail.com' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const body = NotificationService.notifyAdmin.mock.calls[0][2];
    expect(body).not.toContain('estimates.customer_email');
    expect(body).not.toContain('leads.email');
  });

  test('also fixes the estimate source for a CUSTOMER-owned recovery (codex round 9)', async () => {
    const rec = {
      id: 'rec10', customer_id: 'c1', customer_email_field: 'email',
      corrected_email: 'jane@gmail.com', bounced_email: 'jane@gmial.com',
      correction_rule: 'domain_typo', status: 'resent', record_updated: false, metadata: {},
    };
    db.mockImplementation(commitDb({ rec, estUpdate: 1, leadUpdate: 0 }));
    await recovery.commitRecoveryOnDelivery({ id: 'msg10', recipient_email_snapshot: 'jane@gmail.com' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const body = NotificationService.notifyAdmin.mock.calls[0][2];
    expect(body).toContain('estimates.customer_email'); // source fixed, not just the customer row
    expect(body).toContain('email');                    // customer column fixed too
  });
});
