// sendTemplate `cc`: one message copied to extra addresses (the invoice Send's CC).
jest.mock('../models/db', () => jest.fn());
jest.mock('../models/marker-db', () => () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
  sendOne: jest.fn(),
  applyAnnualOfferGuard: jest.fn(async ({ html, text, estimateIds }) => ({ sendHtml: html, sendText: text, sendEstimateIds: estimateIds })),
  isDefiniteRejection: jest.fn(() => false),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const EmailTemplates = require('../services/email-template-library');
const { CARBON_COPY_CATEGORY, staleStoredCopyReason } = require('../constants/email-replay-exclusions');
const { isTransactionalRetryEligible } = require('../services/transactional-email-provider-retry');
const { decideRecoveryAction } = require('../services/email-bounce-recovery');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereNull', 'whereIn', 'join', 'select', 'orderBy', 'limit', 'forUpdate'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  db.transaction = jest.fn(async (callback) => callback(db));
  db.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
}

const template = {
  id: 'tmpl-1',
  template_key: 'estimate.expiring_notice',
  name: 'Estimate Expiring Notice',
  mode: 'service',
  send_stream: 'service_operational',
  allowed_variables: ['first_name', 'estimate_url', 'expires_at'],
  required_variables: ['first_name', 'estimate_url', 'expires_at'],
  active_version_id: 'ver-1',
};
const version = {
  id: 'ver-1',
  subject: 'Your estimate expires {{expires_at}}',
  preview_text: 'Available until {{expires_at}}.',
  text_body: '',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your estimate is available until {{expires_at}}.' },
    { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
  ],
};
const payload = { first_name: 'Sam', estimate_url: 'https://example.com/e', expires_at: 'June 12' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendTemplate cc', () => {
  test('copies the one message to the CC, records it on the row and stamps the no-replay category', async () => {
    const queued = { id: 'msg-1', status: 'queued', send_attempt_token: 'tok' };
    const queueInsert = chain({ returning: [queued] });
    setDbQueues({
      email_templates: [chain({ first: template })],
      email_template_versions: [chain({ first: version })],
      email_suppressions: [chain({ result: [] }), chain({ result: [] })],
      email_messages: [queueInsert, chain({ returning: [{ ...queued, status: 'sent' }] })],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      cc: [' Manager@Example.com ', 'manager@example.com', 'SAM@example.com'],
      payload,
    });

    const row = queueInsert.insert.mock.calls[0][0];
    expect(JSON.parse(row.cc_email_snapshot)).toEqual(['manager@example.com']);
    expect(JSON.parse(row.categories)).toContain(CARBON_COPY_CATEGORY);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'sam@example.com',
      cc: ['manager@example.com'],
    }));
  });

  test('a send without a CC is unchanged: no snapshot, no category, an empty cc list', async () => {
    const queued = { id: 'msg-2', status: 'queued', send_attempt_token: 'tok' };
    const queueInsert = chain({ returning: [queued] });
    setDbQueues({
      email_templates: [chain({ first: template })],
      email_template_versions: [chain({ first: version })],
      email_suppressions: [chain({ result: [] })],
      email_messages: [queueInsert, chain({ returning: [{ ...queued, status: 'sent' }] })],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-2' });

    await EmailTemplates.sendTemplate({ templateKey: 'estimate.expiring_notice', to: 'sam@example.com', payload });

    const row = queueInsert.insert.mock.calls[0][0];
    expect(row).not.toHaveProperty('cc_email_snapshot');
    expect(JSON.parse(row.categories)).not.toContain(CARBON_COPY_CATEGORY);
    expect(sendgrid.sendOne.mock.calls[0][0]).not.toHaveProperty('cc');
  });

  test('a suppressed CC blocks the whole send and names the CC', async () => {
    const blockedInsert = chain({ returning: [{ id: 'msg-3', status: 'blocked' }] });
    setDbQueues({
      email_templates: [chain({ first: template })],
      email_template_versions: [chain({ first: version })],
      email_suppressions: [chain({ result: [] }), chain({ result: [{ suppression_type: 'bounce', group_key: null }] })],
      email_messages: [blockedInsert],
      notifications: [chain({ first: { id: 'existing-alert' } })],
    });

    const result = await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      cc: 'manager@example.com',
      payload,
    });

    expect(result).toMatchObject({ sent: false, blocked: true, reason: 'Suppressed CC address: bounce' });
    expect(blockedInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'blocked',
      error_message: 'Suppressed CC address: bounce',
      cc_email_snapshot: JSON.stringify(['manager@example.com']),
    }));
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('an address that is not one throws before any row is written', async () => {
    setDbQueues({
      email_templates: [chain({ first: template })],
      email_template_versions: [chain({ first: version })],
    });
    await expect(EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice', to: 'sam@example.com', cc: ['not-an-email'], payload,
    })).rejects.toThrow('Invalid CC email address');
    expect(db).not.toHaveBeenCalledWith('email_messages');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('a CC row is never re-sent from its stored copy', () => {
  test('provider retry rail', () => {
    expect(staleStoredCopyReason([CARBON_COPY_CATEGORY])).toMatch(/second address/);
    expect(isTransactionalRetryEligible({
      recipient_email_snapshot: 'sam@example.com', subject_snapshot: 'Hi', categories: [CARBON_COPY_CATEGORY],
    })).toBe(false);
  });

  test('bounce recovery', () => {
    expect(decideRecoveryAction({
      candidate: { corrected: 'sam@example.com', confidence: 'high' },
      suppressed: false, ownedByOther: false, hasAttachments: false, carbonCopy: true,
    })).toEqual({ action: 'skip', status: 'cc_not_replayed' });
  });
});
