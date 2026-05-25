jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
  sendOne: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({
  auditNotificationTemplateIssue: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const { auditNotificationTemplateIssue } = require('../services/audit-log');
const EmailTemplates = require('../services/email-template-library');

function chain({ result = [], first } = {}) {
  const q = {};
  ['where', 'orderBy', 'select', 'limit'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.first = jest.fn(async () => first);
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
}

describe('email template issue auditing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('audits missing payload variables before send', async () => {
    setDbQueues({
      email_templates: [chain({
        first: {
          id: 'tmpl-1',
          template_key: 'estimate.expiring_notice',
          name: 'Estimate Expiring Notice',
          mode: 'service',
          status: 'active',
          send_stream: 'service_operational',
          allowed_variables: ['first_name', 'estimate_url', 'expires_at'],
          required_variables: ['first_name', 'estimate_url', 'expires_at'],
          active_version_id: 'ver-1',
        },
      })],
      email_template_versions: [chain({
        first: {
          id: 'ver-1',
          subject: 'Estimate expires {{expires_at}}',
          preview_text: '',
          text_body: '',
          blocks: [{ type: 'paragraph', content: 'Hi {{first_name}}' }],
        },
      })],
      email_messages: [chain({ first: null })],
    });

    await expect(EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'customer@example.com',
      payload: {
        first_name: 'Ada',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/abc',
      },
      recipientType: 'estimate',
      recipientId: '11111111-1111-1111-1111-111111111111',
      idempotencyKey: 'estimate.expiring_notice:111',
    })).rejects.toThrow('Missing required variables: expires_at');

    expect(auditNotificationTemplateIssue).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email',
      template_key: 'estimate.expiring_notice',
      event_type: 'missing_payload',
      entity_type: 'estimate',
      entity_id: '11111111-1111-1111-1111-111111111111',
      unresolved_placeholders: ['expires_at'],
    }));
  });
});
