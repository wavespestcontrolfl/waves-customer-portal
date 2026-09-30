// The admin notification composer (docs/admin-notifications.md sections 2, 3, 6, 7).
// Customer names below are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const { composeAdminAlert, raiseAdminAlert, MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('../services/admin-alert-compose');

const spec = (over = {}) => ({
  area: 'Comms',
  action: 'call Mona Refay back',
  why: 'Promised on a 3:22 PM call; an hour has passed with no contact.',
  severity: 'needs-you',
  link: '/admin/communications#tab=calls&call=abc',
  subject: { type: 'call', id: 'call-1' },
  doneWhen: 'promise_fulfilled',
  who: 'person',
  ...over,
});
const violationsOf = (s) => { try { composeAdminAlert(s); } catch (e) { return e.violations; } return null; };

describe('composeAdminAlert', () => {
  test('a valid spec composes the documented shape', () => {
    expect(composeAdminAlert(spec())).toEqual({
      headline: 'Comms — call Mona Refay back',
      why: 'Promised on a 3:22 PM call; an hour has passed with no contact.',
      link: '/admin/communications#tab=calls&call=abc',
      metadata: { area: 'Comms', severity: 'needs-you', subject: { type: 'call', id: 'call-1' }, doneWhen: 'promise_fulfilled', who: 'person' },
    });
  });

  test.each([
    ['Billing — charge 5 invoices with a card on file', '$1,254 never charged; the oldest is 41 days old.', { area: 'Billing', action: 'charge 5 invoices with a card on file' }],
    ['Schedule — book Diane Dizon\'s wasp removal', 'She confirmed Sat Oct 4 at 11:00 on a call; nothing is on the calendar.', { area: 'Schedule', action: 'book Diane Dizon\'s wasp removal' }],
    ['Comms — call Mona Refay back', 'Promised on a 3:22 PM call; an hour has passed with no contact.', { area: 'Comms', action: 'call Mona Refay back' }],
    ['System — Venice review sync silent 3 days', 'No new reviews fetched since Sat; Google shows 2.', { area: 'System', action: 'Venice review sync silent 3 days' }],
  ])('the doc example "%s" passes', (headline, why, over) => {
    expect(composeAdminAlert(spec({ ...over, why }))).toMatchObject({ headline, why });
  });

  test.each([
    ['area', { area: 'Sales' }, 'area_invalid'],
    ['severity', { severity: 'urgent' }, 'severity_invalid'],
    ['who', { who: 'anyone' }, 'who_invalid'],
    ['subject type', { subject: { type: 'request', id: '1' } }, 'subject_type_invalid'],
    ['subject id', { subject: { type: 'call', id: '' } }, 'subject_id_invalid'],
    ['done-when not snake_case', { doneWhen: 'Promise Fulfilled' }, 'done_when_invalid'],
    ['missing action', { action: '' }, 'action_missing'],
    ['headline over 60', { action: 'x'.repeat(MAX_HEADLINE_CHARS) }, 'headline_too_long'],
    ['why over 110', { why: 'word '.repeat(MAX_WHY_CHARS / 4) }, 'why_too_long'],
    ['why missing on needs-you', { why: '' }, 'why_missing'],
    ['why missing on broken', { severity: 'broken', why: '' }, 'why_missing'],
    ['needs-you without a link', { link: undefined }, 'link_required'],
    ['link outside /admin/', { link: 'https://example.com/x' }, 'link_not_admin'],
    ['needs-you linked to the Activity feed', { link: '/admin/agents?tab=activity&row=1' }, 'link_is_activity_feed'],
  ])('rejects a bad %s', (_name, over, slug) => {
    expect(violationsOf(spec(over))).toContain(slug);
  });

  test.each([
    ['iso_date', 'Due 2026-10-04 at noon.'],
    ['hash', 'Row 3f9a8c1d-0b2e-4c7a-9d11-5e6f7a8b9c0d is stuck.'],
    ['hash', 'Hash deadbeef0123456 was rejected.'],
    ['env_name', 'GATE_STAMPED_ZERO_FREE is off.'],
    ['env_name', 'SOME_ENV_NAME is unset.'],
    ['snake_case', 'Visit stuck on_site since noon.'],
    ['snake_case', 'Rows in scheduled_services look wrong.'],
    ['file_path', 'See server/services/foo.js for the cause.'],
    ['file_path', 'Saved to ~/notes today.'],
    ['bracket_tag', 'Check [venice:silent_empty] fired.'],
    ['zero_new', 'Sync ran with 0 new reviews.'],
    ['action_prefix', 'ACT: call her back.'],
    ['exclamation', 'She called twice!'],
    ['emoji', 'She called back \u{1F6A8} twice.'],
  ])('%s is forbidden in a why: %s', (slug, why) => {
    expect(violationsOf(spec({ why }))).toContain(`why_forbidden_token:${slug}`);
  });

  test.each([
    ['iso_date', 'call back 2026-10-04'],
    ['snake_case', 'fix on_site visit'],
    ['action_prefix', 'FIX: the sync'],
    ['exclamation', 'call now!'],
  ])('%s is forbidden in a headline', (slug, action) => {
    expect(violationsOf(spec({ action }))).toContain(`headline_forbidden_token:${slug}`);
  });

  test('ordinary prose with numbers, money and spoken dates passes', () => {
    expect(violationsOf(spec({ why: 'Paid $1,254 on Sat Oct 4 at 11:00; 12 of 40 visits left, 3.5 hours each.' }))).toBeNull();
  });

  test('an error names the rules and never echoes the offending text', () => {
    const s = spec({ action: 'call Zelda Quill', why: 'Zelda Quill asked 2026-10-04 about on_site work!' });
    let err;
    try { composeAdminAlert(s); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'ADMIN_ALERT_RULE' });
    expect(err.violations).toEqual(expect.arrayContaining(['why_forbidden_token:iso_date', 'why_forbidden_token:snake_case', 'why_forbidden_token:exclamation']));
    expect(err.message).not.toMatch(/Zelda|2026|on_site/);
  });
});

describe('raiseAdminAlert', () => {
  beforeEach(() => {
    NotificationService.notifyAdmin.mockReset().mockResolvedValue({ id: 'n-1' });
    logger.warn.mockClear();
  });

  test('needs-you rings under the emitter category with the composed text and merged metadata', async () => {
    const out = await raiseAdminAlert('alert', spec(), { bell: true, dedupeKey: 'k1', metadata: { call_log_id: 'call-1' } });
    expect(out).toEqual({ id: 'n-1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'alert', 'Comms — call Mona Refay back', 'Promised on a 3:22 PM call; an hour has passed with no contact.',
      expect.objectContaining({ bell: true, dedupeKey: 'k1', link: '/admin/communications#tab=calls&call=abc', metadata: { call_log_id: 'call-1', area: 'Comms', severity: 'needs-you', subject: { type: 'call', id: 'call-1' }, doneWhen: 'promise_fulfilled', who: 'person' } }),
    );
  });

  test('fyi writes nothing', async () => {
    expect(await raiseAdminAlert('alert', spec({ severity: 'fyi' }))).toEqual({ id: null, suppressed: true, reason: 'fyi' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('broken is refused and points at deliverOpsDigest', async () => {
    await expect(raiseAdminAlert('system', spec({ severity: 'broken' }))).rejects.toMatchObject({ code: 'ADMIN_ALERT_RULE', violations: ['broken_uses_ops_digest'], message: expect.stringContaining('deliverOpsDigest') });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a violation throws under test so offenders are caught', async () => {
    await expect(raiseAdminAlert('alert', spec({ why: 'Hurry!' }))).rejects.toMatchObject({ code: 'ADMIN_ALERT_RULE' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('outside tests a violation still rings, headline cut to 60, violations stamped, no text logged', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await raiseAdminAlert('alert', spec({ action: 'call Zelda Quill about the very long standing arrangement for spring', why: 'Hurry, Zelda Quill!' }), { bell: true });
    } finally { process.env.NODE_ENV = env; }
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(title.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
    expect(title).toMatch(/^Comms — call Zelda Quill.*…$/);
    expect(body).toBe('Hurry, Zelda Quill!');
    expect(opts).toMatchObject({ bell: true, link: '/admin/communications#tab=calls&call=abc' });
    expect(opts.metadata.ruleViolations).toEqual(expect.arrayContaining(['headline_too_long', 'why_forbidden_token:exclamation']));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/Zelda/);
  });

  test('the fallback drops a link the rule refuses and still rings', async () => {
    const env = process.env.NODE_ENV;
    for (const link of ['https://example.com/x', '/admin/agents?tab=activity']) {
      NotificationService.notifyAdmin.mockClear();
      process.env.NODE_ENV = 'production';
      try { await raiseAdminAlert('alert', spec({ link })); } finally { process.env.NODE_ENV = env; }
      const opts = NotificationService.notifyAdmin.mock.calls[0][3];
      expect(opts).not.toHaveProperty('link');
      expect(opts.metadata.ruleViolations).toEqual(expect.arrayContaining([link.startsWith('/admin/') ? 'link_is_activity_feed' : 'link_not_admin']));
    }
  });

  test('the fallback keeps the structured fields that are valid and drops the ones that are not', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await raiseAdminAlert('service', spec({ why: 'Please come on 2026-10-04.', who: 'nobody' }), { metadata: { requestId: 'r1' } });
    } finally { process.env.NODE_ENV = env; }
    const { metadata } = NotificationService.notifyAdmin.mock.calls[0][3];
    const valid = spec();
    expect(metadata).toMatchObject({
      requestId: 'r1', area: valid.area, severity: 'needs-you', subject: valid.subject, doneWhen: valid.doneWhen,
    });
    expect(metadata).not.toHaveProperty('who');
    expect(metadata.ruleViolations).toEqual(expect.arrayContaining(['who_invalid', 'why_forbidden_token:iso_date']));
  });
});

describe('why is one sentence', () => {
  test.each([
    'The charge failed. Retry it now.',
    'Is the card still valid? Ask on the next call.',
    'Done! Nothing else to do.',
  ])('two sentences are refused: %s', (why) => {
    expect(() => composeAdminAlert(spec({ why }))).toThrow(expect.objectContaining({
      violations: expect.arrayContaining(['why_multiple_sentences']),
    }));
  });

  test.each([
    '$1,254 never charged; the oldest is 41 days old.',
    'Parked awaiting your approval: a.org, b.org, c.org +2 more.',
    'Dr. Lee confirmed Sat Oct 4 at 11:00 a.m. on a call.',
    'J. Rivera asked about the St. Pete property.',
    'Version 2.5 of the label is on file',
  ])('one sentence passes: %s', (why) => {
    expect(composeAdminAlert(spec({ why })).why).toBe(why);
  });
});
