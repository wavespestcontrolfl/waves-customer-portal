const table = {
  template_key: 'sample_template',
  body: 'Hello {first_name}! Track: {track_url}',
  is_active: true,
};

jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    where: jest.fn(() => ({
      first: jest.fn(async () => table),
    })),
  }));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/audit-log', () => ({
  auditNotificationTemplateIssue: jest.fn(async () => null),
}));
jest.mock('../services/sms-template-variants', () => ({
  selectVariant: jest.fn(async () => null),
}));

const smsTemplates = require('../routes/admin-sms-templates');
const { auditNotificationTemplateIssue } = require('../services/audit-log');
const SmsTemplateVariants = require('../services/sms-template-variants');

describe('admin SMS template renderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders supplied variables', async () => {
    const body = await smsTemplates.getTemplate('sample_template', {
      first_name: 'Sam',
      track_url: 'https://portal.wavespestcontrol.com/l/abc23',
    });

    // House-voice rule (2026-08-01): SMS portal links are sent BARE — no
    // https:// — for tappable one-segment sends (g.page links keep it).
    expect(body).toBe('Hello Sam! Track: portal.wavespestcontrol.com/l/abc23');
  });

  test('returns null instead of leaking unresolved placeholders', async () => {
    const body = await smsTemplates.getTemplate('sample_template', {
      first_name: 'Sam',
    });

    expect(body).toBeNull();
    expect(auditNotificationTemplateIssue).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      template_key: 'sample_template',
      event_type: 'unresolved_placeholders',
      unresolved_placeholders: ['track_url'],
    }));
  });

  test('opts.noVariants pins the base row even when a weighted variant is active', async () => {
    // Callers whose flow contracts on ONE exact body (rain-out custom rung:
    // pre-move segment cap + client counter preview) can't use a random
    // variant — codex #3363 r3 P1.
    SmsTemplateVariants.selectVariant.mockResolvedValue({ body: 'Variant hello {first_name}!{track_url}' });
    const vars = { first_name: 'Sam', track_url: '' };

    const withVariant = await smsTemplates.getTemplate('sample_template', vars);
    expect(withVariant).toBe('Variant hello Sam!');

    const pinned = await smsTemplates.getTemplate('sample_template', vars, {}, { noVariants: true });
    expect(pinned).toBe('Hello Sam! Track:');
    SmsTemplateVariants.selectVariant.mockResolvedValue(null);
  });

  test('opts.requiredVars rejects a body that lost a load-bearing placeholder', async () => {
    // The unresolved-check only rejects UNKNOWN placeholders — an admin
    // edit that DELETES one renders truthy with the promised content
    // silently gone (codex #3363 r3 P2). requiredVars closes it, checked
    // pre-substitution so a variable value matching static template text
    // can't mask the loss.
    const vars = { first_name: 'Sam', track_url: 'https://portal.wavespestcontrol.com/l/abc23' };

    const ok = await smsTemplates.getTemplate('sample_template', vars, {}, { requiredVars: ['first_name', 'track_url'] });
    expect(ok).toBe('Hello Sam! Track: portal.wavespestcontrol.com/l/abc23');

    const gutted = await smsTemplates.getTemplate('sample_template', vars, {}, { requiredVars: ['custom_message'] });
    expect(gutted).toBeNull();
    expect(auditNotificationTemplateIssue).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      template_key: 'sample_template',
      event_type: 'missing_required_placeholder',
      // The audit plumbing maps context into fixed columns — the offending
      // placeholder rides the reason text.
      reason: 'template body lost required placeholder {custom_message}',
    }));
  });

  test('requiredVars is enforced on the SELECTED variant body, not the base row', async () => {
    // A variant that drops the required placeholder must fail the render
    // even though the base row still carries it.
    SmsTemplateVariants.selectVariant.mockResolvedValue({ body: 'Variant without the greeting.{track_url}' });
    const gutted = await smsTemplates.getTemplate('sample_template', { first_name: 'Sam', track_url: '' }, {}, { requiredVars: ['first_name'] });
    expect(gutted).toBeNull();
    SmsTemplateVariants.selectVariant.mockResolvedValue(null);
  });
});
