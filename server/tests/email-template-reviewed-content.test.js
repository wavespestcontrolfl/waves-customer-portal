/** Reviewed email content remains pinned even after its version is archived. */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ sql }));
  return db;
});
jest.mock('../services/sendgrid-mail', () => ({ sendOne: jest.fn() }));
jest.mock('../services/audit-log', () => ({ auditNotificationTemplateIssue: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { sendOne } = require('../services/sendgrid-mail');
const { auditNotificationTemplateIssue } = require('../services/audit-log');
const { templateContentHash, sendTemplate } = require('../services/email-template-library');

const template = {
  id: 'synthetic-email-template', template_key: 'estimate.delivery',
  name: 'Synthetic estimate delivery', status: 'active', mode: 'service',
  send_stream: 'service_operational', from_name: 'Waves Pest Control',
  from_email: 'sender@example.invalid', reply_to: 'reply@example.invalid',
  allowed_variables: ['first_name', 'estimate_url'], required_variables: ['estimate_url'],
};
const reviewedVersion = {
  id: 'synthetic-reviewed-version', template_id: template.id, status: 'active',
  subject: 'Your estimate is ready', preview_text: 'Review the saved estimate.',
  text_body: 'Your estimate: {{estimate_url}}',
  blocks: [{ type: 'paragraph', content: 'Hi {{first_name}}, review your saved estimate.' }],
};

beforeEach(() => { jest.clearAllMocks(); });

test.each([
  ['subject', 'Changed subject'],
  ['preview_text', 'Changed preview'],
  ['text_body', 'Changed body: {{estimate_url}}'],
  ['blocks', [{ type: 'paragraph', content: 'Changed message.' }]],
])('an edited archived pinned version rejects changed %s before email persistence or dispatch', async (field, value) => {
  const expectedContentHash = templateContentHash(template, reviewedVersion);
  const pinnedVersion = {
    ...reviewedVersion, template, status: 'archived', [field]: value,
    archived_at: '2026-01-02T12:00:00.000Z', updated_at: '2026-01-03T12:00:00.000Z',
  };
  const query = {};
  for (const method of ['join', 'where', 'select']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => structuredClone(pinnedVersion));
  db.mockImplementation((table) => {
    if (table !== 'email_template_versions as v') throw new Error(`Unexpected persistence access: ${table}`);
    return query;
  });

  await expect(sendTemplate({
    templateKey: template.template_key, versionId: reviewedVersion.id, expectedContentHash,
    to: 'recipient@example.invalid', payload: { first_name: 'Synthetic', estimate_url: 'https://example.invalid/estimate' },
    idempotencyKey: 'synthetic-reviewed-attempt',
  })).rejects.toThrow('The reviewed email content changed');

  expect(query.where).toHaveBeenCalledWith('v.id', reviewedVersion.id);
  expect(db.mock.calls.map(([table]) => table)).toEqual(['email_template_versions as v']);
  expect(sendOne).not.toHaveBeenCalled();
  expect(auditNotificationTemplateIssue).not.toHaveBeenCalled();
});

test('archival, status and update timestamps do not change an unchanged content hash', () => {
  const reviewedHash = templateContentHash(template, reviewedVersion);
  expect(templateContentHash({
    ...template, status: 'archived', archived_at: '2026-01-02T12:00:00.000Z',
    updated_at: '2026-01-03T12:00:00.000Z', active_version_id: 'synthetic-new-version',
  }, {
    ...reviewedVersion, status: 'archived', archived_at: '2026-01-02T12:00:00.000Z',
    updated_at: '2026-01-03T12:00:00.000Z', published_at: '2026-01-01T12:00:00.000Z',
  })).toBe(reviewedHash);
});
