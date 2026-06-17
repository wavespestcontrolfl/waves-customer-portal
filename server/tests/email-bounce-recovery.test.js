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
const recovery = require('../services/email-bounce-recovery');

// Minimal chainable knex mock. Every builder method returns the chain; the
// terminal-ish methods resolve to configurable values.
function makeChain(overrides = {}) {
  const chain = {};
  const passthrough = ['where', 'whereRaw', 'whereNot', 'whereIn', 'andWhere',
    'orWhereRaw', 'onConflict', 'ignore', 'modify', 'insert'];
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
