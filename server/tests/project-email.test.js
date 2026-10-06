jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-123', status: 'sent', sent_at: '2026-05-20T12:00:00.000Z' },
  })),
}));
// sendPrepGuide mints a public /prep/:token via ensurePrepToken (projects
// select + prep_template_key update) — stub the db so the token resolves
// without a live connection.
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const ProjectEmail = require('../services/project-email');

function dbChain(firstResult) {
  const q = {};
  ['select', 'where', 'whereNull', 'update', 'insert'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.first = jest.fn(async () => firstResult);
  q.returning = jest.fn(async () => []);
  q.then = (resolve, reject) => Promise.resolve(undefined).then(resolve, reject);
  return q;
}

function customer(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Morgan',
    email: 'primary@example.com',
    phone: '+19415550101',
    address_line1: '123 Palm Ave',
    city: 'Bradenton',
    state: 'FL',
    zip: '34211',
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: 'project-1',
    customer_id: 'cust-1',
    project_type: 'rodent_exclusion',
    title: 'Rodent exclusion report',
    project_date: '2026-05-20',
    report_token: 'abcdef123456abcdef123456abcdef12',
    findings: { entry_points_found: 'Garage door seal' },
    ...overrides,
  };
}

describe('project email service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Project already carries a prep_token, so ensurePrepToken's select
    // returns it and no mint/update path runs.
    db.mockImplementation(() => dbChain({ prep_token: 'preptok123' }));
  });

  test('sends project report ready through the template library', async () => {
    const result = await ProjectEmail.sendProjectReportReady({
      project: project(),
      customer: customer({ service_contact_email: 'service@example.com', service_contact_name: 'Sam Service' }),
      reportUrl: 'https://portal.wavespestcontrol.com/report/project/taylor-morgan-abcdef123456',
    });

    expect(result).toMatchObject({ ok: true, messageId: 'sg-123' });
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'project.report_ready',
      to: 'service@example.com',
      suppressionGroupKey: 'service_operational',
      idempotencyKey: 'project.report_ready:project-1:initial:abcdef123456abcdef123456abcdef12',
      payload: expect.objectContaining({
        first_name: 'Sam',
        report_url: 'https://portal.wavespestcontrol.com/report/project/taylor-morgan-abcdef123456',
        report_type: 'Rodent Exclusion',
        project_type: 'Rodent Exclusion',
        project_title: 'Rodent exclusion report',
        property_address: '123 Palm Ave Bradenton, FL 34211',
      }),
    }));
  });

  test('sends mapped prep guide with supplied idempotency key', async () => {
    await ProjectEmail.sendPrepGuide({
      project: project(),
      customer: customer(),
      idempotencyKey: 'project.prep:test',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'prep.rodent',
      to: 'primary@example.com',
      suppressionGroupKey: 'service_operational',
      idempotencyKey: 'project.prep:test',
      payload: expect.objectContaining({
        service_date: 'May 20, 2026',
        // Public prep-guide page link (#1199) — tokenized, not the portal tab.
        prep_url: 'https://portal.wavespestcontrol.com/prep/preptok123',
      }),
    }));
  });

  test('uses a fresh default idempotency key for manual prep guide resends', async () => {
    await ProjectEmail.sendPrepGuide({ project: project(), customer: customer() });
    await ProjectEmail.sendPrepGuide({ project: project(), customer: customer() });

    const keys = EmailTemplates.sendTemplate.mock.calls.map(([args]) => args.idempotencyKey);
    expect(keys[0]).toMatch(/^project\.prep:project-1:prep\.rodent:/);
    expect(keys[1]).toMatch(/^project\.prep:project-1:prep\.rodent:/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('skips prep guide when no template is mapped for the project type', async () => {
    // bed_bug gained a prep template (prep.bed_bug); WDO inspections have no
    // prep guide, so they exercise the unsupported path now.
    const result = await ProjectEmail.sendPrepGuide({
      project: project({ project_type: 'wdo_inspection' }),
      customer: customer(),
    });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'unsupported_prep_template' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('sends portal invite as a required account notice', async () => {
    await ProjectEmail.sendPortalInvite({
      project: project(),
      customer: customer({ service_contact_email: 'service@example.com', service_contact_name: 'Sam Service' }),
      idempotencyKey: 'portal.invite:test',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'portal.invite',
      to: 'primary@example.com',
      suppressionGroupKey: 'transactional_required',
      idempotencyKey: 'portal.invite:test',
      payload: expect.objectContaining({
        first_name: 'Taylor',
        customer_email: 'primary@example.com',
        portal_invite_url: 'https://portal.wavespestcontrol.com/login?next=%2F%3Ftab%3Ddashboard',
        customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=dashboard',
      }),
    }));
  });

  test('does not send when the customer has no valid email', async () => {
    const result = await ProjectEmail.sendPortalInvite({
      project: project(),
      customer: customer({ email: '', service_contact_email: 'not-an-email' }),
    });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'missing_email' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('returns a failed result when template delivery throws', async () => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(new Error('template missing'));

    const result = await ProjectEmail.sendProjectReportReady({
      project: project(),
      customer: customer(),
      reportUrl: 'https://portal.wavespestcontrol.com/report/project/taylor',
    });

    expect(result).toMatchObject({ ok: false, error: 'template missing' });
  });
});

describe('resolveProjectEmailRecipient: the tenant report rule', () => {
  const base = {
    first_name: 'Dana', email: 'dana@example.com', phone: '+19415550100',
    service_contact_name: 'Riley Occupant', service_contact_email: 'riley@example.com',
  };

  test('the slot-1 contact gets the project email, as before, on an owner account', () => {
    expect(ProjectEmail.resolveProjectEmailRecipient(base, { applyReportRule: true }).email).toBe('riley@example.com');
  });

  test('a tenant, or an occupant on a manager account, never gets it: the account holder does', () => {
    const rule = { applyReportRule: true };
    expect(ProjectEmail.resolveProjectEmailRecipient({ ...base, service_contact_role: 'tenant' }, rule))
      .toMatchObject({ email: 'dana@example.com', role: 'primary' });
    expect(ProjectEmail.resolveProjectEmailRecipient({ ...base, contact_role: 'property_manager' }, rule).email).toBe('dana@example.com');
    // A manager listed as the slot-1 contact still gets it.
    expect(ProjectEmail.resolveProjectEmailRecipient({ ...base, contact_role: 'property_manager', service_contact_role: 'property_manager' }, rule).email)
      .toBe('riley@example.com');
  });

  test('prep mail with no findings (the default) still reaches the on-site tenant', () => {
    expect(ProjectEmail.resolveProjectEmailRecipient({ ...base, service_contact_role: 'tenant' }).email).toBe('riley@example.com');
  });

  test('the report senders apply the rule; an explicit copy recipient is kept', async () => {
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { id: 'm1' } });
    const project = { id: 'p1', project_type: 'termite_inspection', title: 'Inspection' };
    await ProjectEmail.sendProjectReportReady({ project, customer: { ...base, service_contact_role: 'tenant' }, reportUrl: 'https://portal.example/r' });
    expect(EmailTemplates.sendTemplate.mock.calls.at(-1)[0].to).toBe('dana@example.com');
    await ProjectEmail.sendProjectReportReady({ project, customer: { ...base, service_contact_role: 'tenant' }, reportUrl: 'https://portal.example/r',
      recipient: { email: 'copy@example.com', name: 'there', role: 'report_copy' } });
    expect(EmailTemplates.sendTemplate.mock.calls.at(-1)[0].to).toBe('copy@example.com');
  });
});
