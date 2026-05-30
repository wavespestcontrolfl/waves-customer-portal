const { TRIGGER_REGISTRY, __private } = require('../services/notification-triggers');

describe('notification trigger push tags', () => {
  test('SMS replies get unique tags so iOS does not silently replace prior alerts', () => {
    const payload = { threadId: 'customer-123', fromPhone: '+19415551234' };

    const first = __private.pushTagFor('sms_reply', payload);
    const second = __private.pushTagFor('sms_reply', payload);

    expect(first).toMatch(/^waves-sms_reply-customer-123-/);
    expect(second).toMatch(/^waves-sms_reply-customer-123-/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(payload.fromPhone);
    expect(second).not.toContain(payload.fromPhone);
  });

  test('non-SMS triggers keep collapsing by trigger key', () => {
    expect(__private.pushTagFor('payment_failed', {})).toBe('waves-payment_failed');
  });

  test('new lead trigger can carry tracking number context', () => {
    const built = TRIGGER_REGISTRY.new_lead.build({
      title: 'New lead from palmettoexterminator.com',
      name: 'Unknown prospect',
      source: 'palmettoexterminator.com',
      area: 'Palmetto',
      phone: '+18182079399',
      message: 'Cynthia Sparagna 1000 Riverside Drive',
      leadId: 'lead-123',
    });

    expect(built.title).toBe('New lead from palmettoexterminator.com');
    expect(built.body).toContain('Unknown prospect via palmettoexterminator.com (Palmetto)');
    expect(built.body).toContain('Phone: ***9399');
    expect(built.body).toContain('Message included on lead record');
    expect(built.body).not.toContain('+18182079399');
    expect(built.body).not.toContain('1000 Riverside Drive');
    expect(built.link).toBe('/admin/leads/lead-123');
  });

  test('SMS reply trigger masks fallback phone and redacts sensitive message text', () => {
    const built = TRIGGER_REGISTRY.sms_reply.build({
      fromPhone: '+19415551234',
      message: 'Call me at +19415551234 or test@example.com near 1000 Riverside Drive',
      threadId: 'customer-123',
    });

    expect(built.title).toBe('SMS from ***1234');
    expect(built.body).toContain('***1234');
    expect(built.body).toContain('t***@example.com');
    expect(built.body).toContain('[address]');
    expect(built.body).not.toContain('+19415551234');
    expect(built.body).not.toContain('test@example.com');
    expect(built.body).not.toContain('1000 Riverside Drive');
    expect(built.link).toBe('/admin/communications?thread=customer-123');
  });

  test('KB audit trigger summarizes flagged entries for the admin bell', () => {
    const built = TRIGGER_REGISTRY.kb_audit_flagged.build({
      count: 2,
      entries: [
        { title: 'Rodent Service Phases', summary: 'Correct the RUP claim.' },
        { title: 'SEO Strategy', summary: 'Address the doorway-page risk.' },
      ],
    });

    expect(built.title).toBe('KB audit flagged 2 entries');
    expect(built.body).toContain('Rodent Service Phases: Correct the RUP claim.');
    expect(built.body).toContain('SEO Strategy: Address the doorway-page risk.');
    expect(built.link).toBe('/admin/kb');
  });

  test('legacy internal admin SMS redirects have a generic notification trigger', () => {
    const built = TRIGGER_REGISTRY.internal_admin_alert.build({
      title: 'Tax Deadline Alert',
      body: 'Two filings need review.',
      link: '/admin/tax',
    });

    expect(built).toEqual({
      title: 'Tax Deadline Alert',
      body: 'Two filings need review.',
      link: '/admin/tax',
    });
  });

  test('bundle quote trigger distinguishes inquiry from self-applied bundle', () => {
    const inquiry = TRIGGER_REGISTRY.bundle_quote_requested.build({
      customerName: 'Existing Appointment Demo',
      suggestedService: 'Lawn Care',
      previousTier: 'Bronze',
      estimateId: 'estimate-123',
    });

    expect(inquiry).toEqual({
      title: 'Bundle inquiry: Existing Appointment Demo',
      body: 'Interested in adding Lawn Care to Bronze plan',
      link: '/admin/estimates?estimateId=estimate-123',
    });

    const selfApplied = TRIGGER_REGISTRY.bundle_quote_requested.build({
      customerName: 'Existing Appointment Demo',
      suggestedService: 'Lawn Care',
      bundled: true,
      newTier: 'Silver',
      newMonthly: 112.5,
      estimateId: 'estimate-123',
    });

    expect(selfApplied).toEqual({
      title: 'Bundle self-applied: Existing Appointment Demo',
      body: 'Added Lawn Care \u2192 Silver @ $112.50/mo',
      link: '/admin/estimates?estimateId=estimate-123',
    });
  });

  test('notification body sanitizer redacts customer contact details across triggers', () => {
    const built = __private.sanitizeBuiltNotification({
      title: 'Admin alert for test@example.com',
      body: 'Text +19415551234 about 1000 Riverside Drive',
      link: '/admin/dashboard',
    });

    expect(built.title).toBe('Admin alert for t***@example.com');
    expect(built.body).toBe('Text ***1234 about [address]');
    expect(built.link).toBe('/admin/dashboard');
  });

  test('notification metadata payload sanitizer does not persist raw contact fields', () => {
    const safe = __private.sanitizeNotificationPayload('new_lead', {
      phone: '+18182079399',
      email: 'lead@example.com',
      address: '1000 Riverside Drive',
      message: 'Reach me at +18182079399 from 1000 Riverside Drive',
      nested: {
        body: 'Email lead@example.com',
      },
    });

    expect(safe).toEqual({
      phone: '***9399',
      email: 'l***@example.com',
      address: '[address]',
      message: 'Reach me at ***9399 from [address]',
      nested: {
        body: 'Email l***@example.com',
      },
    });
  });
});
