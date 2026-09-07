jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(), loadTemplateByKey: jest.fn(),
  queuedRowInFlight: jest.requireActual('../services/email-template-library').queuedRowInFlight,
}));
jest.mock('../services/twilio', () => ({ findOutboundMessageSince: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
  normalizeRecipient: jest.requireActual('../services/messaging/send-customer-message').normalizeRecipient,
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/sms-auto-send', () => ({ isRealProviderSend: jest.requireActual('../services/sms-auto-send').isRealProviderSend }));
// The sprinkler timer guide's watering block reads the CURRENT restriction
// policy; pinned here so the copy assertions do not depend on the calendar
// (the checked-in default expires 2026-10-01 and then fails closed).
let mockRestrictionPolicy = null;
// The seasonal-guide SMS consent basis (document-contract-delivery's own
// derivation): opted in only when notification_prefs.seasonal_tips === true.
let mockNotificationPrefsRow = null;
// The guide's audience: the Monday sweep's own recurring-lawn predicate.
let mockRecurringLawn = true;
jest.mock('../services/irrigation-weekly-email', () => ({
  hasRecurringLawnEvidence: jest.fn(async () => mockRecurringLawn),
}));
jest.mock('../services/document-contract-delivery', () => ({
  marketingSmsConsentBasisForContract: jest.fn(async () => (mockNotificationPrefsRow?.seasonal_tips === true
    ? { status: 'opted_in', source: 'notification_prefs.seasonal_tips', capturedAt: '2026-08-01T00:00:00Z' }
    : null)),
}));
jest.mock('../config/irrigation-restrictions', () => ({
  currentRestrictionPolicy: jest.fn(() => mockRestrictionPolicy),
  resolveRestrictionCounty: jest.fn(() => 'Manatee'),
}));
// The per-customer advisory lock: pass-through by default; a test flips it
// to "lease held elsewhere" (the real lock semantics live in cron-lock's own suite).
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  wasLockSkipped: jest.requireActual('../utils/cron-lock').wasLockSkipped,
}));
jest.mock('../services/project-email', () => ({
  // Mirrors the real resolver: a configured service contact wins the email
  // recipient (address + name); otherwise the primary customer.
  resolveProjectEmailRecipient: (customer) => ({
    email: customer.service_contact_email || customer.email || '',
    name: customer.service_contact_name || customer.first_name || '',
    role: customer.service_contact_email ? 'service_contact' : 'primary',
  }),
  // Real implementations (against the mocked db) so the tokened prep_url
  // and confirmed-delivery stamp paths are exercised end-to-end.
  ensureServicePrepToken: jest.requireActual('../services/project-email').ensureServicePrepToken,
}));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendPrepToCustomer } = require('../services/prep-guide-sender');

let customerRow;
let prefsRow = null; // property_preferences (sprinkler timer guide minutes)
let turfRow = null; // customer_turf_profiles (county)
let turfQueries = [];

function customersQuery() {
  const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), first: jest.fn(async () => customerRow) };
  return q;
}
// nextUpcomingVisit lookup — no upcoming visit by default. When a test sets
// upcomingVisitRow, the same table also serves ensureServicePrepToken's
// chains (.select()…first() token read + .update().returning() mint).
let upcomingVisitRow = null;
let ownershipLost = false; // the send-time re-read finds the page re-keyed
let upcomingVisitRows = null; // several candidates (soonest first); null = [upcomingVisitRow]
let viewRow = null; // prep_guide_views
let visitLookupError = null;
// A live upcoming visit as the appointment page's pageState reads it —
// status + a date ahead of the run (the pick requires state 'upcoming').
const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const liveVisit = (extra = {}) => ({ id: 'svc-9', status: 'confirmed', scheduled_date: FUTURE, ...extra });
let servicePrepRow = null;
let serviceUpdates = [];
let scheduledQueries = [];
// Automated-lane rows for the abandoned-reservation check: [] = none.
let runRows = [];
let enrollmentRows = [];
let enrollmentUpdates = [];
let enrollmentWheres = [];
let stepSendRow = null;
let lastRunsQuery = null;
// Manual-delivery traces for the abandoned-reservation check: null = none.
let manualEmailRow = null;
let manualEmailQueries = [];
let interactionQueries = [];
let manualSmsRow = null;
let interactionMarkerRow = null;
function traceQuery(row) {
  const q = { where: jest.fn(() => q), whereIn: jest.fn(() => q), whereNot: jest.fn(() => q), whereNotIn: jest.fn(() => q), whereRaw: jest.fn(() => q), orderBy: jest.fn(() => q), first: jest.fn(async () => row), select: jest.fn(async () => row ? (Array.isArray(row) ? row : [row]) : []) };
  return q;
}
// Honours a whereIn('status', …) filter so the live-lane read (first) and
// the full trace read (select) see the same rows.
function livenessQuery(rows) {
  let statuses = null;
  let enabledOnly = false; // the enrolment liveness read joins the template and requires t.enabled
  let stepZeroOnly = false; // the enrolment reads take current_step: 0 (still awaiting the prep step)
  const q = {
    join: jest.fn(() => q),
    where: jest.fn((col, val) => {
      enrollmentWheres.push(col);
      if (col === 't.enabled' && val === true) enabledOnly = true;
      if (col && typeof col === 'object' && col.current_step === 0) stepZeroOnly = true;
      return q;
    }),
    whereIn: jest.fn((col, vals) => { if (col === 'status' || col === 'e.status') statuses = vals; return q; }),
    select: jest.fn(async () => rows),
    update: jest.fn(async (patch) => { enrollmentUpdates.push(patch); return rows.filter((r) => !statuses || statuses.includes(r.status)).length; }),
    first: jest.fn(async () => rows.find((r) => (!statuses || statuses.includes(r.status))
      && (!enabledOnly || r.template_enabled !== false)
      && (!stepZeroOnly || Number(r.current_step || 0) === 0)) || undefined),
  };
  return q;
}
jest.mock('../services/email-template-automation-executor', () => ({ RUNNABLE_STATUSES: ['queued', 'scheduled', 'retry_scheduled'] }));
jest.mock('../services/automation-runner', () => ({ advanceEnrollment: jest.fn(async () => ({ sent: true, done: false })) }));
const { advanceEnrollment } = require('../services/automation-runner');
// Rows affected by an awaited .update() (the prep-page claim); 1 = claimed.
let serviceUpdateCount = 1;
function scheduledQuery() {
  let tokenMode = false;
  let listMode = false; // nextUpcomingVisit: .limit(n).select(cols) → rows
  const q = {
    limit: jest.fn(() => { listMode = true; return q; }),
    offset: jest.fn(() => q),
    // nextUpcomingVisits / nextUpcomingVisit: …limit().offset().select(cols) → rows.
    select: jest.fn(() => {
      if (listMode) {
        if (visitLookupError) return Promise.reject(visitLookupError);
        return Promise.resolve(upcomingVisitRows || (upcomingVisitRow ? [upcomingVisitRow] : []));
      }
      tokenMode = true; return q;
    }),
    where: jest.fn(() => q), whereIn: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNotIn: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    update: jest.fn((patch) => {
      serviceUpdates.push(patch);
      // Thenable so `await …update()` yields the row count, while
      // `.update().returning()` still chains.
      return { ...q, then: (resolve) => resolve(serviceUpdateCount) };
    }),
    returning: jest.fn(async () => [{}]),
    catch: jest.fn(async () => undefined),
    orderBy: jest.fn(() => q),
    first: jest.fn(async (...cols) => {
      // The post-claim key re-read asks for the key column alone.
      if (cols.length === 1 && cols[0] === 'prep_template_key') return servicePrepRow;
      // The send-time ownership re-check.
      if (cols.length === 1 && cols[0] === 'id') return ownershipLost ? undefined : { id: upcomingVisitRow?.id || 'svc-1' };
      return tokenMode ? servicePrepRow : upcomingVisitRow;
    }),
  };
  return q;
}
const interactionsInsert = jest.fn(async () => [{ id: 'claim-1' }]);
let interactionUpdates = [];
let interactionDeletes = 0;
let interactionClaimWheres = [];

beforeEach(() => {
  jest.clearAllMocks();
  customerRow = {
    id: 'cust-1', first_name: 'Megan', last_name: 'Example',
    email: 'megan@example.com', phone: '+19415550101',
    address_line1: '5022 Sunnyside Ln', city: 'Bradenton', state: 'FL', zip: '34211',
    active: true, deleted_at: null,
  };
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery();
    if (table === 'scheduled_services') { const q = scheduledQuery(); scheduledQueries.push(q); return q; }
    if (table === 'customer_interactions') {
      // One object: traceQuery's where() returns ITS OWN q, so the claim's
      // update / del must live on that same object, not on a spread copy.
      const q = traceQuery(interactionMarkerRow);
      q.insert = interactionsInsert;
      q.update = jest.fn(async (patch) => { interactionUpdates.push(patch); return 1; });
      q.del = jest.fn(async () => { interactionDeletes += 1; return 1; });
      const where = q.where;
      q.where = jest.fn((...args) => { if (args[0] && typeof args[0] === 'object' && 'id' in args[0]) interactionClaimWheres.push(args[0]); return where(...args); });
      interactionQueries.push(q); return q;
    }
    if (table === 'email_messages') { const q = traceQuery(manualEmailRow); manualEmailQueries.push(q); return q; }
    if (table === 'sms_log') return traceQuery(manualSmsRow);
    if (table === 'email_template_automation_runs') { lastRunsQuery = livenessQuery(runRows); return lastRunsQuery; }
    if (table === 'automation_enrollments' || table === 'automation_enrollments as e') return livenessQuery(enrollmentRows);
    if (table === 'automation_step_sends') return traceQuery(stepSendRow);
    if (table === 'prep_guide_views') return traceQuery(viewRow);
    if (table === 'property_preferences') return traceQuery(prefsRow);
    if (table === 'customer_turf_profiles') { const q = traceQuery(turfRow); turfQueries.push(q); return q; }
    if (table === 'notification_prefs') return traceQuery(mockNotificationPrefsRow);
    return customersQuery();
  });
  prefsRow = null;
  turfRow = null;
  turfQueries = [];
  mockNotificationPrefsRow = null;
  mockRecurringLawn = true;
  interactionUpdates = [];
  interactionDeletes = 0;
  interactionClaimWheres = [];
  mockRestrictionPolicy = null;
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  // The dispatch-boundary stamp recheck runs in a transaction under the
  // prefs advisory lock; the trx reads the same mocked tables.
  db.transaction = jest.fn(async (fn) => fn(Object.assign((table) => db(table), { raw: jest.fn(async () => undefined) })));
  runRows = [];
  enrollmentRows = [];
  enrollmentUpdates = [];
  enrollmentWheres = [];
  lastRunsQuery = null;
  stepSendRow = null;
  manualEmailRow = null;
  manualEmailQueries = [];
  interactionQueries = [];
  manualSmsRow = null;
  interactionMarkerRow = null;
  scheduledQueries = [];
  upcomingVisitRow = null;
  ownershipLost = false;
  upcomingVisitRows = null;
  viewRow = null;
  visitLookupError = null;
  serviceUpdateCount = 1;
  servicePrepRow = { prep_token: null, prep_template_key: null };
  serviceUpdates = [];
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
  EmailTemplateLibrary.loadTemplateByKey.mockResolvedValue({ activeVersion: { id: 'v1' } });
  TwilioService.findOutboundMessageSince.mockResolvedValue({ found: false });
  renderSmsTemplate.mockResolvedValue('Prep text...');
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM123' });
});

describe('sendPrepToCustomer', () => {
  // A live upcoming visit as the appointment page's pageState reads it.
  const VISIT = liveVisit({ customer_id: 'cust-1' });

  test('default channel (both), no upcoming visit → emails the guide AND texts the inline-steps standalone', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result).toMatchObject({ ok: true, channel: 'both', emailSent: true, smsSent: true });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0]).toMatchObject({
      templateKey: 'prep.flea',
      to: 'megan@example.com',
      recipientId: 'cust-1',
      // Provider errors can echo the recipient address — keep them out of logs.
      suppressProviderErrorLog: true,
    });
    // service_date is a required prep-template var — never empty, even with no
    // upcoming visit (falls back to a non-empty placeholder).
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.service_date)
      .toBe('To be confirmed');
    // No visit → no guide page to link; the inline-steps text goes instead.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ prep_variant: 'standalone' });
  });

  test('both with an upcoming visit → the text carries the tokened guide page link', async () => {
    upcomingVisitRow = VISIT;

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: true, emailSent: true, smsSent: true });
    const [key, vars] = renderSmsTemplate.mock.calls[0];
    expect(key).toBe('auto_prep_guide_link');
    expect(vars.first_name).toBe('Megan');
    expect(vars.prep_label).toBe('Flea Treatment');
    expect(vars.prep_url).toMatch(/\/prep\/[0-9a-f]{32}$/);
    // Same token in the email and the text.
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.prep_url).toBe(vars.prep_url);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ prep_variant: 'guide_link' });
  });

  test('email only → no text, even with a phone on file', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });

    expect(result).toMatchObject({ ok: true, channel: 'email', emailSent: true, smsSent: false });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(interactionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ interaction_type: 'email_outbound', subject: 'Flea Treatment prep sent (manual)' }),
    );
  });

  test('text only → no email, even with an email on file', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'sms' });

    expect(result).toMatchObject({ ok: true, channel: 'sms', emailSent: false, smsSent: true });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('Both with no link to text still emails — partial, the text named as the failed leg with the link reason', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'both' });
    expect(result).toMatchObject({ ok: true, reason: 'partial', failedChannel: 'sms', emailSent: true, smsSent: false, smsLinkReason: 'no_upcoming_visit' });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('text only for a guide with no inline-steps text needs an upcoming visit', async () => {
    const refused = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(refused).toMatchObject({ ok: false, reason: 'no_upcoming_visit' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    upcomingVisitRow = VISIT;
    const sent = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(sent).toMatchObject({ ok: true, smsSent: true, emailSent: false });
    const [key, vars] = renderSmsTemplate.mock.calls[0];
    expect(key).toBe('auto_prep_guide_link');
    expect(vars.prep_label).toBe('Termite Service');
    // The texted link IS the guide delivery: prep_sent_at is stamped for it —
    // conditional on the key still being ours (P1 on b909d8007).
    expect(scheduledQueries.some((q) => q.where.mock.calls.some(([arg]) => arg && arg.id === VISIT.id && arg.prep_template_key === 'prep.termite')
      && q.update.mock.calls.some(([p]) => p && p.prep_sent_at))).toBe(true);
    // The stamp carries only prep_sent_at; the key is the WHERE fence (prep.termite).
    expect(serviceUpdates).toContainEqual({ prep_sent_at: 'NOW()' });
  });

  test('every live prep guide is sendable by email', async () => {
    const { PREP_CONFIG } = require('../services/prep-guide-sender');
    const keys = Object.keys(PREP_CONFIG);
    // prep.wildlife stays archived — wildlife is a prohibited Waves service.
    expect(keys.sort()).toEqual([
      'bed_bug', 'cockroach', 'flea', 'interior_pest', 'lawn', 'mosquito', 'rodent', 'sprinkler_timer', 'termite',
    ]);
    for (const pestType of keys) {
      jest.clearAllMocks();
      EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
      const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType, channel: 'email' });
      expect(result.ok).toBe(true);
      expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].templateKey).toBe(PREP_CONFIG[pestType].emailTemplateKey);
    }
  });

  test('service-contact account: email greets the contact, SMS greets the phone owner', async () => {
    customerRow = {
      ...customerRow,
      first_name: 'Megan',
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'jamie@example.com',
    };

    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    // Email is addressed to the service contact (recipient), by their name.
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].to).toBe('jamie@example.com');
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.first_name).toBe('Jamie');
    // The SMS goes to the primary's phone, so it greets the primary — not Jamie.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('manual send is attributed to the operator', async () => {
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', actorId: 'tech-9' });

    // adminUserId (not actor_id) is the key the Twilio path reads for sms_log.
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
      adminUserId: 'tech-9',
      manual: true,
    });
    expect(interactionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ admin_user_id: 'tech-9' }),
    );
  });

  test('an SMS send writes the tagger-compatible prep marker (replay dedupe)', async () => {
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    // Must match appointment-tagger's hasSentPrepSms lookup exactly
    // (sms_outbound + "<pestType> prep info sent") so a later automated
    // replay doesn't re-text prep this manual click already delivered.
    expect(interactionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction_type: 'sms_outbound',
        subject: 'flea prep info sent',
      }),
    );
  });

  test('a chosen channel with nothing on file is refused, not silently skipped', async () => {
    customerRow = { ...customerRow, email: '' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' }))
      .toMatchObject({ ok: false, reason: 'no_email' });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' }))
      .toMatchObject({ ok: false, reason: 'no_email' });

    customerRow = { ...customerRow, email: 'megan@example.com', phone: '' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'no_phone' });

    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('unknown customer → customer_not_found', async () => {
    customerRow = undefined;

    const result = await sendPrepToCustomer({ customerId: 'missing', pestType: 'flea' });

    expect(result).toMatchObject({ ok: false, reason: 'customer_not_found' });
  });

  test('unsupported pest type or channel → rejected', async () => {
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'gator' }))
      .toMatchObject({ ok: false, reason: 'unsupported_pest_type' });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'fax' }))
      .toMatchObject({ ok: false, reason: 'unsupported_channel' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('both: a rejected email still lets the text go out', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: true, emailSent: false, smsSent: true });
  });

  test('upcoming visit → prep_url is the tokened public prep page and a sent email stamps prep_sent_at', async () => {
    upcomingVisitRow = VISIT;

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });

    expect(result.ok).toBe(true);
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toMatch(/\/prep\/[0-9a-f]{32}$/);
    expect(payload.customer_portal_url).toContain('?tab=visits');
    expect(payload.service_date).not.toBe('To be confirmed');
    // Confirmed send → the track page's "prep actually went out" marker,
    // aligned to the guide THIS email delivered.
    // The stamp carries only prep_sent_at; the key is the WHERE fence (prep.flea).
    expect(serviceUpdates).toContainEqual({ prep_sent_at: 'NOW()' });
  });

  test('a suppressed text (sent:true sentinel, no provider id) is not a delivery', async () => {
    upcomingVisitRow = VISIT;
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'gate-blocked' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });

    expect(result).toMatchObject({ ok: false, reason: 'send_failed', smsSent: false });
    expect(serviceUpdates.some((p) => p && p.prep_sent_at)).toBe(false);
    expect(interactionsInsert).not.toHaveBeenCalled();
  });

  test('nothing delivered never stamps prep_sent_at', async () => {
    upcomingVisitRow = VISIT;
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'suppressed' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: false, reason: 'send_failed' });
    expect(serviceUpdates.some((p) => p && p.prep_sent_at)).toBe(false);
    // The provisional page claim is handed back — a later guide is not
    // blocked by a send that delivered nothing.
    expect(serviceUpdates[serviceUpdates.length - 1]).toEqual({ prep_template_key: null });
  });

  test('a text that fails before the provider releases the claim; a wrapper throw is classified by its provider outcome', async () => {
    upcomingVisitRow = VISIT;
    renderSmsTemplate.mockRejectedValueOnce(new Error('renderer down'));
    const preProvider = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(preProvider).toMatchObject({ ok: false, reason: 'send_failed' });
    expect(serviceUpdates[serviceUpdates.length - 1]).toEqual({ prep_template_key: null });
    // The release is fenced on the view columns like the re-key (P0 on fb2d7d01f).
    expect(scheduledQueries.some((q) => q.whereNull.mock.calls.some(([c]) => c === 'prep_first_viewed_at')
      && q.whereRaw.mock.calls.some(([sql]) => sql === 'COALESCE(prep_view_count, 0) = 0')
      && q.update.mock.calls.some(([p]) => p && p.prep_template_key === null))).toBe(true);

    serviceUpdates = [];
    renderSmsTemplate.mockResolvedValue('Prep text...');
    // sendCustomerMessage swallows provider failures; a throw WITHOUT a
    // provider outcome happened before the handoff — definite, claim released.
    sendCustomerMessage.mockRejectedValueOnce(new Error('socket hang up'));
    const preHandoff = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(preHandoff).toMatchObject({ ok: false, reason: 'send_failed', smsSent: false });
    expect(preHandoff.smsUncertain).toBe(false);
    expect(serviceUpdates[serviceUpdates.length - 1]).toEqual({ prep_template_key: null });

    // A throw while persisting the audit carries the KNOWN outcome: an
    // accepted send is a send — page stamped, never handed back.
    serviceUpdates = [];
    const auditErr = new Error('audit insert failed');
    auditErr.providerOutcome = { sent: true, messageId: 'SM1' };
    sendCustomerMessage.mockRejectedValueOnce(auditErr);
    const accepted = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(accepted).toMatchObject({ ok: true, smsSent: true });
    expect(serviceUpdates.some((p) => p && p.prep_template_key === null)).toBe(false);
  });

  test('an email-library throw after dispatch is uncertain (claim kept); before dispatch it is not (claim released)', async () => {
    upcomingVisitRow = VISIT;
    // Post-dispatch: the library ran onQueued (about to call SendGrid) and then threw.
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async (opts) => {
      await opts.onQueued({ id: 'em-1' });
      throw new Error('post-dispatch bookkeeping failed');
    });
    const afterDispatch = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'email' });
    expect(afterDispatch).toMatchObject({ ok: false, reason: 'send_failed', emailSent: false, emailUncertain: true });
    // SendGrid may have accepted it — the delivered URL must keep rendering.
    expect(serviceUpdates.some((p) => p && p.prep_template_key === null)).toBe(false);
    expect(serviceUpdates.some((p) => p && p.prep_sent_at)).toBe(false);

    // A DEFINITE SendGrid 4xx after dispatch is not uncertain: the fresh
    // claim is released (r17 P2).
    serviceUpdates = [];
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async (opts) => {
      await opts.onQueued({ id: 'em-2' });
      const err = new Error('SendGrid 400: bad address');
      err.status = 400;
      throw err;
    });
    const rejected = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'email' });
    expect(rejected).toMatchObject({ ok: false, reason: 'send_failed', emailUncertain: false });
    expect(serviceUpdates[serviceUpdates.length - 1]).toEqual({ prep_template_key: null });

    // Pre-dispatch: no onQueued — nobody could have received the URL.
    serviceUpdates = [];
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(new Error('template not found'));
    const beforeDispatch = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'email' });
    expect(beforeDispatch).toMatchObject({ ok: false, reason: 'send_failed', emailUncertain: false });
    expect(serviceUpdates[serviceUpdates.length - 1]).toEqual({ prep_template_key: null });
  });

  test('a partial Both names the failed leg', async () => {
    sendCustomerMessage.mockRejectedValueOnce(new Error('socket hang up'));

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: true, reason: 'partial', failedChannel: 'sms', emailUncertain: false });
    expect(result.smsUncertain).toBe(false);
  });

  test('a claim that already matched (another same-guide attempt made it) is never released', async () => {
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.termite' };
    servicePrepRow = { prep_token: 'd'.repeat(32), prep_template_key: 'prep.termite' };
    serviceUpdateCount = 0; // whereNull fresh claim affects no row — the key is already ours
    renderSmsTemplate.mockRejectedValueOnce(new Error('renderer down'));

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });

    expect(result).toMatchObject({ ok: false, reason: 'send_failed' });
    // The other attempt's (or a prior delivery's) page stays intact.
    expect(serviceUpdates.some((p) => p && p.prep_template_key === null)).toBe(false);
  });

  test('claim → send → release runs under the per-customer advisory lock; a held lease is "busy"', async () => {
    const { runExclusive } = require('../utils/cron-lock');
    upcomingVisitRow = VISIT;

    const sent = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(sent.ok).toBe(true);
    expect(runExclusive).toHaveBeenCalledWith('prep-send:cust-1', expect.any(Function), { recordHealth: false, waitForSlot: false });

    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    const busy = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(busy).toMatchObject({ ok: false, reason: 'prep_send_busy' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a delivered guide keeps its page claim; a partial Both does not release it', async () => {
    upcomingVisitRow = VISIT;
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'suppressed' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: true, reason: 'partial', failedChannel: 'sms' });
    expect(serviceUpdates.some((p) => p && p.prep_template_key === null)).toBe(false);
  });

  test('a visit whose prep page already carries another guide is never re-keyed or linked', async () => {
    // A combined "Pest + Lawn" row whose page went out as interior pest.
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.interior_pest', prep_sent_at: new Date('2026-06-01T12:00:00Z') };
    servicePrepRow = { prep_token: 'a'.repeat(32), prep_template_key: 'prep.interior_pest' };

    // Text: refused with its own reason (not "no visit"), naming the guide
    // the page belongs to.
    const refused = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' });
    expect(refused).toMatchObject({ ok: false, reason: 'prep_page_taken', takenBy: 'Interior Pest Treatment' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    // Email: still goes out (dated by the visit) but links the portal, not
    // the other guide's page, and never moves the row's key onto lawn — the
    // interior-pest URLs already delivered keep rendering interior pest.
    const emailed = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'email' });
    expect(emailed).toMatchObject({ ok: true, emailSent: true });
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toContain('?tab=visits');
    expect(payload.service_date).not.toBe('To be confirmed');
    expect(serviceUpdates).toEqual([]);
  });

  test('an undelivered reservation for another guide is never re-keyed — no delivery-evidence read at all (GH Codex #3856 r23 P0)', async () => {
    // The tagger reserved prep.flea and its lane never stamped prep_sent_at:
    // whether it delivered is unknowable from our tables (a Twilio send
    // survives a failed sms_log insert; a composer draft holding the link
    // leaves no trace), so the page stays flea's and lawn is refused.
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea', prep_sent_at: null };
    servicePrepRow = { prep_token: 'e'.repeat(32), prep_template_key: 'prep.flea' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_page_taken', takenBy: 'Flea Treatment' });
    expect(serviceUpdates).toEqual([]);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // No liveness / trace tables are consulted for another guide's page.
    expect(lastRunsQuery).toBeNull();
    expect(manualEmailQueries).toEqual([]);
    // Both: the email still goes (portal link, not the page), the text is
    // the failed leg with the page's reason.
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'both' }))
      .toMatchObject({ ok: true, emailSent: true, smsSent: false, reason: 'partial', smsLinkReason: 'prep_page_taken' });
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.prep_url).not.toMatch(/\/prep\//);
    expect(serviceUpdates).toEqual([]);
  });

  test('a same-guide page still owned by a queued / running automation refuses the manual send (it would send the prep twice); a finished lane lets it through', async () => {
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea' };
    servicePrepRow = { prep_token: 'h'.repeat(32), prep_template_key: 'prep.flea' };
    runRows = [{ status: 'scheduled', idempotency_key: 'run-k2' }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: false, reason: 'prep_send_pending' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    runRows = [{ status: 'sent', idempotency_key: 'run-k2' }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: true });

    // An UNKEYED visit with a runnable run for this guide is pending too: a
    // pre-dispatch failure released the executor's fresh claim ahead of its
    // retry, and a manual claim now would be followed by the retry's send
    // (pre-push Codex P1 on 4f6261cc3).
    upcomingVisitRow = { ...VISIT, prep_template_key: null };
    servicePrepRow = { prep_token: null, prep_template_key: null };
    runRows = [{ status: 'retry_scheduled', idempotency_key: 'run-k2' }];
    serviceUpdates = [];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: false, reason: 'prep_send_pending' });
    expect(serviceUpdates).toEqual([]);
  });

  test('a live enrolment holds the same-guide page whether or not its template is enabled (a held one resumes on re-enable); a confirmed manual send settles the customer\'s live enrolment (GH Codex #3856 r23 P1)', async () => {
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea' };
    servicePrepRow = { prep_token: 'h'.repeat(32), prep_template_key: 'prep.flea' };
    runRows = [];
    enrollmentRows = [{ id: 'enr-1', status: 'active', template_enabled: true }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: false, reason: 'prep_send_pending' });
    enrollmentRows = [{ id: 'enr-1', status: 'active', template_enabled: false }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: false, reason: 'prep_send_pending' });
    expect(enrollmentUpdates).toEqual([]);

    // Finished lanes let it through; a finished enrolment has nothing to
    // settle.
    enrollmentRows = [{ id: 'enr-1', status: 'completed' }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: true });
    expect(advanceEnrollment).not.toHaveBeenCalled();

    // The delivery settles a live step-0 enrolment as DELIVERED through the
    // runner's own advance — its follow-up steps keep their schedule; a
    // cancel would drop them (pre-push Codex P1 on 47f085038). The lane
    // parks the manual send while such an enrolment is live, so this is
    // the held case: the template is disabled.
    enrollmentRows = [{ id: 'enr-1', status: 'active', template_enabled: false, current_step: 0, template_key: 'flea' }];
    runRows = [{ status: 'completed' }];
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea' };
    // (automationLaneLive still parks it — a live step-0 enrolment holds the page.)
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: false, reason: 'prep_send_pending' });
    expect(advanceEnrollment).not.toHaveBeenCalled();

    // An enrolment already past step 0 (the prep step — the runner's
    // stampPrepSentForSequence) has sent the prep: it neither parks the
    // manual re-send nor gets settled (its follow-up steps keep going;
    // GH Codex #3856 r25 P2). The settle write itself is step-0 scoped.
    enrollmentRows = [{ id: 'enr-1', status: 'active', template_enabled: true, current_step: 1 }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' })).toMatchObject({ ok: true });
    // The settle read is scoped to current_step 0 — it cannot see this
    // advanced enrolment, so nothing is advanced.
    expect(advanceEnrollment).not.toHaveBeenCalled();
    expect(enrollmentWheres.filter((w) => w && typeof w === 'object' && w.template_key === 'flea').every((w) => w.current_step === 0)).toBe(true);

    // The settle itself (the composer's prep-link text calls it directly —
    // no lane check there; GH Codex #3856 r30 P1): a live step-0 enrolment
    // is advanced through the runner, held or not.
    const { settleHeldEnrollment } = require('../services/prep-guide-sender');
    enrollmentRows = [{ id: 'enr-1', status: 'active', template_enabled: false, current_step: 0, template_key: 'flea' }];
    await settleHeldEnrollment('cust-1', 'prep.flea');
    expect(advanceEnrollment).toHaveBeenCalledTimes(1);
    expect(advanceEnrollment).toHaveBeenCalledWith(expect.objectContaining({ id: 'enr-1', current_step: 0 }));
    expect(enrollmentUpdates).toEqual([]); // no cancel write
    advanceEnrollment.mockClear();

    // A guide with no sequence (lawn) settles nothing.
    upcomingVisitRow = { ...VISIT };
    servicePrepRow = { prep_token: 'h'.repeat(32), prep_template_key: 'prep.lawn' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'both' })).toMatchObject({ ok: true });
    expect(advanceEnrollment).not.toHaveBeenCalled();
    expect(enrollmentUpdates).toEqual([]);
  });

  test('a later visit with a free page hosts the link when the soonest one is legitimately owned by another guide (r16 P2)', async () => {
    upcomingVisitRows = [
      { ...VISIT, id: 'svc-soon', prep_template_key: 'prep.interior_pest', prep_sent_at: new Date() },
      { ...VISIT, id: 'svc-later', prep_template_key: null },
    ];
    servicePrepRow = { prep_token: 'g'.repeat(32), prep_template_key: 'prep.lawn' };
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' });
    expect(result).toMatchObject({ ok: true, smsSent: true });
    // The fresh claim went to the later visit, not the owned one.
    expect(serviceUpdates[0]).toEqual({ prep_template_key: 'prep.lawn' });
    expect(scheduledQueries.some((q) => q.where.mock.calls.some(([arg]) => arg && arg.id === 'svc-later'))).toBe(true);
    expect(scheduledQueries.some((q) => q.where.mock.calls.some(([arg]) => arg && arg.id === 'svc-soon' && arg.prep_template_key))).toBe(false);

    // Every candidate owned → the soonest visit's refusal.
    serviceUpdates = [];
    upcomingVisitRows = [
      { ...VISIT, id: 'svc-soon', prep_template_key: 'prep.interior_pest', prep_sent_at: new Date() },
      { ...VISIT, id: 'svc-later', prep_template_key: 'prep.flea', prep_sent_at: new Date() },
    ];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_page_taken', takenBy: 'Interior Pest Treatment' });
    expect(serviceUpdates).toEqual([]);
  });

  test('a page re-keyed between the claim and dispatch is never linked: text skipped with the reason, email falls back to the portal (send-time fence)', async () => {
    upcomingVisitRow = VISIT;
    ownershipLost = true;
    const both = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'both' });
    expect(both).toMatchObject({ ok: true, reason: 'partial', failedChannel: 'sms', smsLinkReason: 'prep_page_taken', emailSent: true, smsSent: false });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toContain('?tab=visits');
    expect(serviceUpdates.some((p) => p && p.prep_sent_at)).toBe(false);

    const textOnly = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(textOnly).toMatchObject({ ok: false, reason: 'prep_page_taken' });
  });

  test('the interior-pest visit match excludes "Lawn Pest Control" (a lawn-line visit)', async () => {
    upcomingVisitRow = VISIT;
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'interior_pest', channel: 'email' });
    const excluded = scheduledQueries.some((q) => q.whereRaw.mock.calls.some(([sql, args]) => sql === 'LOWER(service_type) NOT LIKE ?' && args[0] === '%lawn pest%'));
    expect(excluded).toBe(true);
  });

  test('the interior-pest visit match excludes the generic "Waves Pest Control Appointment" placeholder — an unknown service type gets no interior treatment prep (GH Codex #3856 r31 P1)', async () => {
    upcomingVisitRow = { ...VISIT, service_type: 'Waves Pest Control Appointment' };
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'interior_pest', channel: 'email' });
    const excluded = scheduledQueries.some((q) => q.whereRaw.mock.calls.some(([sql, args]) => sql === 'LOWER(service_type) NOT LIKE ?' && args[0] === '%appointment%'));
    expect(excluded).toBe(true);
  });

  test('the interior-pest visit match excludes a rodent-led name unless it is a pest-primary "pest ... rodent" plan', async () => {
    upcomingVisitRow = VISIT;
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'interior_pest', channel: 'email' });
    const excluded = scheduledQueries.some((q) => q.whereRaw.mock.calls.some(([sql, args]) => (
      sql === '(LOWER(service_type) NOT LIKE ? OR LOWER(service_type) LIKE ?)' && args[0] === '%rodent%' && args[1] === '%pest%rodent%'
    )));
    expect(excluded).toBe(true);
  });

  // An inspection-word exclusion lifted by any treatment cue (r28 P1): the
  // SQL is "(NOT LIKE ?kw OR LIKE ?cue OR …)" with the keyword first.
  const inspectionOnlyExclusions = () => scheduledQueries.flatMap((q) => q.whereRaw.mock.calls
    .filter(([sql]) => sql.startsWith('(LOWER(service_type) NOT LIKE ? OR LOWER(service_type) LIKE ?'))
    .map(([, args]) => ({ keyword: args[0], unless: args.slice(1) })));

  test('the interior-pest visit match excludes a "Pest Inspection Service" — a diagnostic walkthrough gets no treatment prep (GH Codex #3856 r26 P1)', async () => {
    upcomingVisitRow = { ...VISIT, service_type: 'Pest Inspection Service' };
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'interior_pest', channel: 'email' });
    const ex = inspectionOnlyExclusions();
    expect(ex.map((e) => e.keyword)).toEqual(expect.arrayContaining(['%inspect%', '%assess%']));
    expect(ex.find((e) => e.keyword === '%inspect%').unless).toEqual(expect.arrayContaining(['%treatment%', '%liquid%', '%spot%']));
  });

  test('the termite visit match excludes inspection, monitoring and WDO visits (treatment prep only)', async () => {
    upcomingVisitRow = VISIT;
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'email' });
    // Inspection-ONLY: each exclusion is lifted by a treatment cue, so
    // "Termite Liquid Treatment & Inspection" / "Termite Inspection & Spot
    // Treatment" keep their prep (GH Codex #3856 r28 P1).
    const ex = inspectionOnlyExclusions();
    // A "Termite Warranty Renewal" / bond-only visit applies nothing either
    // (GH Codex #3856 r30 P1).
    expect(ex.map((e) => e.keyword)).toEqual(expect.arrayContaining(['%inspect%', '%monitor%', '%wdo%', '%wood destroying%', '%renew%', '%warranty%', '%bond%']));
    for (const e of ex) expect(e.unless).toEqual(expect.arrayContaining(['%treatment%', '%liquid%', '%foam%', '%trench%', '%spot%', '%drill%', '%applic%']));
  });

  test('the rodent visit match excludes a sanitation-only visit — a "Rodent Sanitation Service" is a cleanup lane, not trapping (GH Codex #3856 r30 P1)', async () => {
    upcomingVisitRow = VISIT;
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'rodent', channel: 'email' });
    const ex = scheduledQueries.flatMap((q) => q.whereRaw.mock.calls
      .filter(([sql]) => sql.startsWith('(LOWER(service_type) NOT LIKE ? OR LOWER(service_type) LIKE ?'))
      .map(([, args]) => ({ keyword: args[0], unless: args.slice(1) })));
    expect(ex).toHaveLength(1);
    expect(ex[0].keyword).toBe('%sanitation%');
    // A combined "Rodent Trapping & Sanitation" keeps its prep.
    expect(ex[0].unless).toEqual(expect.arrayContaining(['%trap%', '%exclusion%']));
    // No inspection exclusion: prep.rodent covers inspections itself.
    expect(ex.map((e) => e.keyword)).not.toContain('%inspect%');
  });

  test('the lawn visit match excludes inspection and assessment visits — a "Lawn Health Inspection" gets no mow / irrigation / keep-off prep (GH Codex #3856 r22 P1)', async () => {
    upcomingVisitRow = VISIT;
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'email' });
    const ex = inspectionOnlyExclusions();
    expect(ex.map((e) => e.keyword)).toEqual(expect.arrayContaining(['%inspect%', '%assess%']));
    expect(ex.every((e) => e.unless.includes('%treatment%'))).toBe(true);
  });

  test('the lawn visit match excludes mechanical work — "Lawn Dethatching", "Lawn Plugging" and "Lawn Top Dressing" apply no product and get no dry-time / irrigation prep (GH Codex #3856 r31 P1)', async () => {
    upcomingVisitRow = { ...VISIT, service_type: 'Lawn Dethatching' };
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'email' });
    const plain = scheduledQueries.flatMap((q) => q.whereRaw.mock.calls
      .filter(([sql]) => sql === 'LOWER(service_type) NOT LIKE ?')
      .map(([, args]) => args[0]));
    // Unconditional: no treatment cue lifts these (a top dressing is never
    // an application).
    expect(plain).toEqual(expect.arrayContaining(['%dethatch%', '%plugging%', '%top dress%']));
  });

  test('losing the prep-page claim (another guide keyed the row after the read) refuses the text', async () => {
    // The read sees an unkeyed row; the conditional claim then affects 0
    // rows because a concurrent send keyed it to interior pest.
    upcomingVisitRow = { ...VISIT, prep_template_key: null };
    servicePrepRow = { prep_token: 'c'.repeat(32), prep_template_key: 'prep.interior_pest' };
    serviceUpdateCount = 0;

    const refused = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' });

    expect(refused).toMatchObject({ ok: false, reason: 'prep_page_taken', takenBy: 'Interior Pest Treatment' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The claim is the only write attempted, and it is conditional.
    expect(serviceUpdates).toEqual([{ prep_template_key: 'prep.lawn' }]);
    expect(serviceUpdates.some((p) => p.prep_sent_at)).toBe(false);
  });

  test('a visit whose page is this guide (or unkeyed) reuses its token and stamps normally', async () => {
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.lawn' };
    servicePrepRow = { prep_token: 'b'.repeat(32), prep_template_key: 'prep.lawn' };

    const sent = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' });

    expect(sent).toMatchObject({ ok: true, smsSent: true });
    expect(renderSmsTemplate.mock.calls[0][1].prep_url).toMatch(new RegExp(`/prep/${'b'.repeat(32)}$`));
    expect(serviceUpdates).toContainEqual({ prep_sent_at: 'NOW()' }); // key is the WHERE fence (prep.lawn)
  });

  test('the page is texted only when it will render: no active template version or an expired token refuses the link before any claim (pre-push Codex P1 on 7f82e7564)', async () => {
    upcomingVisitRow = { ...VISIT };
    EmailTemplateLibrary.loadTemplateByKey.mockResolvedValue({ activeVersion: null });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_guide_inactive' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(serviceUpdates).toEqual([]);
    expect(EmailTemplateLibrary.loadTemplateByKey).toHaveBeenCalledWith('prep.lawn');

    EmailTemplateLibrary.loadTemplateByKey.mockResolvedValue({ activeVersion: { id: 'v1' } });
    upcomingVisitRow = { ...VISIT, prep_expires_at: new Date(Date.now() - 60_000) };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_page_expired' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(serviceUpdates).toEqual([]);
    // Both: the email still goes (portal link), the text names the reason.
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'both' }))
      .toMatchObject({ ok: true, emailSent: true, smsSent: false, reason: 'partial', smsLinkReason: 'prep_page_expired' });
    expect(serviceUpdates).toEqual([]);

    // A template lookup failure is a retryable link failure.
    EmailTemplateLibrary.loadTemplateByKey.mockRejectedValueOnce(new Error('db down'));
    upcomingVisitRow = { ...VISIT };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_link_failed' });
  });

  test('a failed visit lookup or token mint is reported as a link failure, not a missing visit', async () => {
    visitLookupError = new Error('connection reset');
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_link_failed' });

    visitLookupError = null;
    upcomingVisitRow = VISIT;
    servicePrepRow = { prep_token: null, prep_template_key: 'not-a-prep-key' };
    // Token read says no token; the mint's .returning() finds no row and the
    // post-race re-read has none either → ensureServicePrepToken throws.
    db.mockImplementation((table) => {
      if (table === 'customers') return customersQuery();
      if (table === 'scheduled_services') {
        const q = scheduledQuery();
        q.returning = jest.fn(async () => []);
        return q;
      }
      if (table === 'customer_interactions') return { insert: interactionsInsert };
      // The unkeyed candidate's liveness read (no runnable run).
      if (table === 'email_template_automation_runs') return livenessQuery([]);
      return customersQuery();
    });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_link_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The fresh claim made before the failed mint is handed back.
    expect(serviceUpdates[serviceUpdates.length - 1]).toEqual({ prep_template_key: null });

    // Email after a failed mint: goes out with the portal link, but the row
    // is never stamped as a delivered guide (no token = no page owned).
    serviceUpdates = [];
    const emailed = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'email' });
    expect(emailed).toMatchObject({ ok: true, emailSent: true });
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.prep_url).toContain('?tab=visits');
    expect(serviceUpdates.some((p) => p && p.prep_sent_at)).toBe(false);
  });

  test('both with one leg down reports a partial send naming the failed channel', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'gate-blocked' });
    const textDown = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });
    expect(textDown).toMatchObject({ ok: true, emailSent: true, smsSent: false, reason: 'partial', failedChannel: 'sms' });

    jest.clearAllMocks();
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM123' });
    renderSmsTemplate.mockResolvedValue('Prep text...');
    const emailDown = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });
    expect(emailDown).toMatchObject({ ok: true, emailSent: false, smsSent: true, reason: 'partial', failedChannel: 'email' });

    // A clean Both carries no reason at all.
    jest.clearAllMocks();
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
    renderSmsTemplate.mockResolvedValue('Prep text...');
    const clean = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });
    expect(clean.ok).toBe(true);
    expect(clean.reason).toBeUndefined();
  });

  test('nextUpcomingVisit hides a dispatch-owned pending booking — the customer schedule\'s own null-safe predicate (GH Codex #3844 r5 P1)', async () => {
    const { nextUpcomingVisit } = require('../services/prep-guide-sender');
    const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');
    let visitsQuery = null;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') { visitsQuery = scheduledQuery(); return visitsQuery; }
      return customersQuery();
    });
    upcomingVisitRow = liveVisit();
    expect(await nextUpcomingVisit('cust-1', 'flea')).toEqual(upcomingVisitRow);
    const predicate = visitsQuery.where.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function');
    expect(predicate).toBeInstanceOf(Function);
    const qb = { whereNull: jest.fn(() => qb), orWhereNotIn: jest.fn(() => qb), orWhereNot: jest.fn(() => qb), orWhere: jest.fn(() => qb) };
    predicate(qb);
    expect(qb.whereNull).toHaveBeenCalledWith('source_action');
    expect(qb.orWhereNotIn).toHaveBeenCalledWith('source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS);
    expect(qb.orWhereNot).toHaveBeenCalledWith('status', 'pending');
    expect(qb.orWhere).toHaveBeenCalledWith('customer_confirmed', true);
  });

  test('nextUpcomingVisit skips a visit already underway — too late to prep for, and it would hide the later treatment (GH Codex #3844 r13 P2)', async () => {
    const { nextUpcomingVisit } = require('../services/prep-guide-sender');
    upcomingVisitRow = liveVisit({ status: 'en_route' });
    expect(await nextUpcomingVisit('cust-1', 'flea')).toBeNull();
    upcomingVisitRow = liveVisit({ status: 'on_site' });
    expect(await nextUpcomingVisit('cust-1', 'flea')).toBeNull();
  });

  test('no upcoming visit → the email prep_url stays the portal visits tab', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });

    expect(result.ok).toBe(true);
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toContain('?tab=visits');
    expect(payload.service_date).toBe('To be confirmed');
  });
});

// The sprinkler timer guide: a one-time how-to, not visit prep (owner scope
// 2026-09-05, docs/irrigation-controller-guide-scope.md).
describe('sprinkler timer guide', () => {
  const ORDER = {
    maxDaysPerWeek: 1, label: 'SWFWMD Modified Phase III water shortage order',
    hoursNote: 'on your assigned day, during your area\'s allowed hours', expiresOn: '2026-10-01', county: 'Manatee',
  };

  test('hangs on no visit: no scheduled_services read, no page claim, no prep_url — even with a lawn visit upcoming', async () => {
    upcomingVisitRow = liveVisit({ service_type: 'Lawn Treatment', prep_template_key: 'prep.lawn' });
    mockRestrictionPolicy = ORDER;
    mockNotificationPrefsRow = { seasonal_tips: true };
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(result.smsSent).toBe(true);
    expect(scheduledQueries).toHaveLength(0);
    expect(serviceUpdates).toEqual([]);
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('prep.sprinkler_timer');
    expect(call.payload).not.toHaveProperty('prep_url');
    expect(call.payload).not.toHaveProperty('service_date');
    expect(call.payload.watering_block).toMatch(/one watering day a week/);
    // The text is the hub-link standalone, never the tokened guide page —
    // and it runs under the seasonal-tips policy, not appointment prep.
    expect(renderSmsTemplate.mock.calls[0][0]).toBe('auto_sprinkler_timer');
    expect(sendCustomerMessage.mock.calls[0][0].metadata.prep_variant).toBe('standalone');
    expect(sendCustomerMessage.mock.calls[0][0].purpose).toBe('marketing_seasonal');
    expect(sendCustomerMessage.mock.calls[0][0].consentBasis).toEqual({ status: 'opted_in', source: 'notification_prefs.seasonal_tips', capturedAt: '2026-08-01T00:00:00Z' });
  });

  test('the text needs the explicit Seasonal Tips opt-in: Text is refused without it, Both drops the text leg and names it', async () => {
    mockNotificationPrefsRow = { seasonal_tips: null }; // never asked — not consent
    const sms = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(sms).toMatchObject({ ok: false, reason: 'seasonal_tips_not_opted_in' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const both = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
    expect(both).toMatchObject({ ok: true, emailSent: true, smsSent: false, reason: 'partial', failedChannel: 'sms', smsLinkReason: 'seasonal_tips_not_opted_in' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Visit-prep texts are appointment messages: no opt-in needed, no basis attached.
    jest.clearAllMocks();
    const flea = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'sms' });
    expect(flea.ok).toBe(true);
    expect(sendCustomerMessage.mock.calls[0][0]).not.toHaveProperty('consentBasis');
  });

  test('visit prep texts keep the appointment purpose', async () => {
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'sms' });
    expect(sendCustomerMessage.mock.calls[0][0].purpose).toBe('appointment');
  });

  test('a customer who turned off Seasonal Lawn Tips is refused on every channel (the guide is a seasonal tip)', async () => {
    mockNotificationPrefsRow = { seasonal_tips: false };
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
    expect(result).toMatchObject({ ok: false, reason: 'seasonal_tips_off' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The visit-prep guides are unaffected by the preference.
    const flea = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });
    expect(flea.ok).toBe(true);
  });

  test('a customer who turned off email: Email is refused, Both texts the hub link and names the email as the leg that did not go, Text is unaffected', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true, email_enabled: false };
    const email = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(email).toMatchObject({ ok: false, reason: 'email_opted_out' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    const both = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
    expect(both).toMatchObject({ ok: true, emailSent: false, smsSent: true, reason: 'partial', failedChannel: 'email', emailSkipReason: 'email_opted_out' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    const sms = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(sms).toMatchObject({ ok: true, smsSent: true });
    expect(sms.reason).toBeUndefined();
    // Already sent beats the opt-out: Both must not text a second copy.
    jest.clearAllMocks();
    interactionMarkerRow = { id: 'i-1', subject: 'sprinkler_timer prep info sent', created_at: '2026-09-01T14:00:00Z' };
    const again = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
    expect(again).toMatchObject({ ok: false, reason: 'guide_already_sent' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('sent once: a customer who already received the guide is refused, with the date', async () => {
    interactionMarkerRow = { id: 'i-1', subject: 'sprinkler_timer prep info sent', created_at: '2026-09-01T14:00:00Z' };
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(result).toMatchObject({ ok: false, reason: 'guide_already_sent', sentAt: '2026-09-01T14:00:00Z' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    // The history read names exactly the two subjects logPrepInteraction writes.
    const q = interactionQueries.find((iq) => iq.whereIn.mock.calls.length);
    expect(q.whereIn.mock.calls[0]).toEqual(['subject', ['sprinkler_timer prep info sent', 'Sprinkler Timer Guide prep sent (manual)']]);
  });

  test('sent once, durably: the email ledger and the SMS log count as delivery too (belt and braces around the claim)', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    const first = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
    expect(first.ok).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].idempotencyKey).toBe('prep_guide_once:cust-1:prep.sprinkler_timer:claim-1');
    // A delivered email is enough, even without the interaction marker…
    jest.clearAllMocks();
    manualEmailRow = { id: 'em-1', status: 'sent', created_at: '2026-09-02T10:00:00Z' };
    const second = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
    expect(second).toMatchObject({ ok: false, reason: 'guide_already_sent', sentAt: '2026-09-02T10:00:00Z' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const emailQ = manualEmailQueries[manualEmailQueries.length - 1];
    expect(emailQ.where).toHaveBeenCalledWith({ recipient_id: 'cust-1', template_key: 'prep.sprinkler_timer' });
    expect(emailQ.whereNotIn).toHaveBeenCalledWith('status', ['blocked', 'failed']);
    // …and so is a text that carried the hub link.
    jest.clearAllMocks();
    manualEmailRow = null;
    manualSmsRow = { id: 'sms-1', created_at: '2026-09-03T10:00:00Z' };
    const third = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(third).toMatchObject({ ok: false, reason: 'guide_already_sent', sentAt: '2026-09-03T10:00:00Z' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the standalone email uses the weekly plan primary recipient, not a service contact', async () => {
    customerRow.service_contact_email = 'contact@example.com';
    customerRow.service_contact_name = 'Service Contact';
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(result).toMatchObject({ ok: true, emailAddress: customerRow.email });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      to: customerRow.email, payload: expect.objectContaining({ first_name: customerRow.first_name }),
    }));
    customerRow.email = null;
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' }))
      .toMatchObject({ ok: false, reason: 'no_email' });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('an accepted email whose process loses all post-provider writes stays fenced after the queue expires', async () => {
    const baseDb = db.getMockImplementation();
    let lostWrites = false;
    db.mockImplementation((table) => {
      const q = baseDb(table);
      if (table === 'customer_interactions' && lostWrites) {
        q.update = jest.fn(async () => { throw new Error('connection lost'); });
        q.del = jest.fn(async () => { throw new Error('connection lost'); });
      }
      return q;
    });
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ onQueued }) => {
      expect(await onQueued()).toBe(true);
      const beforeProvider = interactionUpdates.at(-1);
      expect(beforeProvider.body).toMatch(/dispatch started/);
      const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      interactionMarkerRow = { ...interactionsInsert.mock.calls.at(-1)[0], ...beforeProvider, id: 'crashed', created_at: old };
      manualEmailRow = { status: 'queued', queued_at: old, created_at: old };
      lostWrites = true;
      throw new Error('provider response lost');
    });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' }))
      .toMatchObject({ ok: false, emailUncertain: true });
    lostWrites = false;
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' }))
      .toMatchObject({ ok: false, reason: 'guide_already_sent' });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(interactionDeletes).toBe(0);
  });

  test.each([0, 'throws'])('email dispatch aborts when its durable fence cannot be written: %s', async (failure) => {
    const baseDb = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = baseDb(table);
      if (table === 'customer_interactions') q.update = jest.fn(async () => {
        if (failure === 'throws') throw new Error('write unavailable');
        return failure;
      });
      return q;
    });
    let providerCalled = false;
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ onQueued }) => {
      // Mirrors the library: thrown callbacks permit dispatch; explicit false aborts.
      let keep = true;
      try { keep = (await onQueued()) !== false; } catch { /* library fail-open hook */ }
      providerCalled = keep;
      return { sent: keep };
    });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' }))
      .toMatchObject({ ok: false, emailSent: false });
    expect(providerCalled).toBe(false);
  });

  test.each(['(941) 555-0101', '941-555-0101', '1 941 555 0101'])('SMS claims and legacy reconciliation normalize %s like dispatch', async (rawPhone) => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    customerRow.phone = rawPhone;
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'PROVIDER_FAILURE' });
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(interactionsInsert.mock.calls.at(-1)[0].metadata.guide_sms_to).toBe('+19415550101');
    // Already-persisted claims from the previous head stored free-form numbers.
    interactionMarkerRow = {
      ...interactionsInsert.mock.calls.at(-1)[0], id: 'legacy-phone',
      metadata: { guide_sms_to: rawPhone },
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    customerRow.phone = '+19415550102';
    TwilioService.findOutboundMessageSince.mockResolvedValueOnce({ found: true });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'guide_already_sent' });
    expect(TwilioService.findOutboundMessageSince).toHaveBeenCalledWith(expect.objectContaining({ to: '+19415550101' }));
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('an uncertain email (post-dispatch throw) writes a durable marker so the next click is refused, even though the ledger row reads failed', async () => {
    EmailTemplateLibrary.sendTemplate.mockImplementation(async ({ onQueued }) => { await onQueued?.(); throw new Error('response lost'); });
    const first = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(first).toMatchObject({ ok: false, emailSent: false, emailUncertain: true });
    // The pre-send claim is kept and marked uncertain — never released.
    expect(interactionDeletes).toBe(0);
    expect(interactionUpdates).toEqual([
      { body: expect.stringMatching(/dispatch started/) },
      { body: expect.stringMatching(/delivery uncertain/) },
    ]);
    // A definite pre-dispatch failure releases the claim (a retry is fine).
    jest.clearAllMocks(); interactionUpdates = []; interactionDeletes = 0;
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('template missing'));
    const second = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(second).toMatchObject({ ok: false, emailSent: false });
    expect(interactionDeletes).toBe(1);
    expect(interactionUpdates).toEqual([]);
  });

  test('the send is claimed BEFORE dispatch, settled into the tagger-compatible marker on delivery, and refused when the claim cannot be written', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    const order = [];
    interactionsInsert.mockImplementation(async () => { order.push('claim'); return [{ id: 'claim-9' }]; });
    sendCustomerMessage.mockImplementation(async () => { order.push('sms'); return { sent: true, providerMessageId: 'SM1' }; });
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(result.ok).toBe(true);
    expect(order).toEqual(['claim', 'sms']);
    expect(interactionsInsert.mock.calls[0][0]).toMatchObject({ customer_id: 'cust-1', subject: 'Sprinkler Timer Guide prep sent (manual)' });
    expect(interactionClaimWheres).toContainEqual({ id: 'claim-9', customer_id: 'cust-1' });
    expect(interactionUpdates).toEqual([expect.objectContaining({ interaction_type: 'sms_outbound', subject: 'sprinkler_timer prep info sent' })]);
    expect(interactionUpdates[0].body).toMatch(/text to \+19415550101/);
    expect(interactionDeletes).toBe(0);
    // A definite text miss releases the claim.
    jest.clearAllMocks(); interactionUpdates = []; interactionDeletes = 0;
    interactionsInsert.mockResolvedValue([{ id: 'claim-10' }]);
    sendCustomerMessage.mockResolvedValue({ sent: false, code: 'NO_MARKETING_CONSENT' });
    const miss = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(miss.ok).toBe(false);
    expect(interactionDeletes).toBe(1);
    // No claim = no send.
    jest.clearAllMocks();
    interactionsInsert.mockRejectedValueOnce(new Error('db unavailable'));
    const refused = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(refused).toMatchObject({ ok: false, reason: 'guide_check_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the email is withheld at the dispatch boundary when the move stamp changed since the block was built (onQueued → false, under the prefs advisory lock)', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    prefsRow = { irrigation_run_minutes: 35, irrigation_home_changed_at: null };
    let queuedVerdict;
    EmailTemplateLibrary.sendTemplate.mockImplementation(async ({ onQueued }) => {
      queuedVerdict = await onQueued();
      return queuedVerdict === false ? { sent: false, aborted: true } : { sent: true };
    });
    // Unchanged stamp → dispatch.
    const ok = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(queuedVerdict).toBe(true);
    expect(ok.ok).toBe(true);
    expect(db.transaction).toHaveBeenCalled();
    // A move committed between the block and the queue → withheld (the claim
    // is released: nothing reached the customer).
    jest.clearAllMocks(); interactionDeletes = 0;
    let prefReads = 0;
    db.mockImplementation((table) => {
      if (table === 'customers') return customersQuery();
      if (table === 'property_preferences') return { where: () => ({ first: async () => ({ irrigation_run_minutes: 35, irrigation_home_changed_at: (prefReads++ < 2) ? null : '2026-09-05T22:00:00Z' }) }) };
      if (table === 'customer_turf_profiles') return traceQuery(null);
      if (table === 'notification_prefs') return traceQuery(mockNotificationPrefsRow);
      if (table === 'customer_interactions') { const q = traceQuery(null); q.insert = interactionsInsert; q.update = jest.fn(async () => 1); q.del = jest.fn(async () => { interactionDeletes += 1; return 1; }); return q; }
      if (table === 'email_messages') return traceQuery(null);
      if (table === 'sms_log') return traceQuery(null);
      return customersQuery();
    });
    const withheld = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(queuedVerdict).toBe(false);
    expect(withheld.ok).toBe(false);
    expect(interactionDeletes).toBe(1);
    // An unreadable check aborts explicitly (the library keeps sending on a
    // THROWING hook), through the library's real callback handling.
    jest.clearAllMocks(); interactionDeletes = 0;
    db.mockImplementation((table) => {
      if (table === 'customers') return customersQuery();
      if (table === 'property_preferences') return traceQuery({ irrigation_run_minutes: 35, irrigation_home_changed_at: null });
      if (table === 'customer_turf_profiles') return traceQuery(null);
      if (table === 'notification_prefs') return traceQuery(mockNotificationPrefsRow);
      if (table === 'customer_interactions') { const q = traceQuery(null); q.insert = interactionsInsert; q.update = jest.fn(async () => 1); q.del = jest.fn(async () => { interactionDeletes += 1; return 1; }); return q; }
      if (table === 'email_messages') return traceQuery(null);
      if (table === 'sms_log') return traceQuery(null);
      return customersQuery();
    });
    db.transaction = jest.fn(async () => { throw new Error('lock timeout'); });
    let libraryKeep = true;
    EmailTemplateLibrary.sendTemplate.mockImplementation(async ({ onQueued }) => {
      try { libraryKeep = (await onQueued()) !== false; } catch { /* the library's own handling: a throw keeps sending */ }
      return libraryKeep ? { sent: true } : { sent: false, aborted: true };
    });
    const unreadable = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(libraryKeep).toBe(false);
    expect(unreadable.ok).toBe(false);
    expect(interactionDeletes).toBe(1);
  });

  test('a stale pre-dispatch claim (process died before the provider call) is reclaimed; a young one reads as in flight', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    const CLAIM = 'Prep send claimed via Communications — dispatching.';
    interactionMarkerRow = { id: 'stale-1', subject: 'Sprinkler Timer Guide prep sent (manual)', body: CLAIM, created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    const reclaimed = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(reclaimed.ok).toBe(true);
    expect(interactionClaimWheres).toContainEqual({ id: 'stale-1', customer_id: 'cust-1' });
    expect(interactionDeletes).toBeGreaterThanOrEqual(1);
    jest.clearAllMocks();
    interactionMarkerRow = { ...interactionMarkerRow, created_at: new Date().toISOString() };
    const busy = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(busy).toMatchObject({ ok: false, reason: 'prep_send_busy' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([false, true])('an abandoned queued email retries only with a pre-dispatch fence (fenced: %s)', async (withClaim) => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    manualEmailRow = { status: 'queued', queued_at: old, created_at: old };
    if (withClaim) interactionMarkerRow = {
      id: 'abandoned', body: 'Prep send claimed via Communications — dispatching.',
      created_at: old, metadata: { guide_sms_to: null, guide_email_fenced: true },
    };
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(result).toMatchObject(withClaim
      ? { ok: true, emailSent: true } : { ok: false, reason: 'guide_check_failed' });
    expect(TwilioService.findOutboundMessageSince).not.toHaveBeenCalled();
  });

  test('a young queued email is busy; a newer abandoned attempt cannot hide a delivered email', async () => {
    const now = new Date().toISOString();
    manualEmailRow = { status: 'queued', queued_at: now, created_at: now };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' }))
      .toMatchObject({ ok: false, reason: 'prep_send_busy' });
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    manualEmailRow = [{ status: 'queued', queued_at: old }, { status: 'delivered', created_at: old }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' }))
      .toMatchObject({ ok: false, reason: 'guide_already_sent' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([{ found: true }, { unavailable: true }, { found: false, unavailable: true }, {}])(
    'stale SMS claim stays blocked unless the provider proves absence: %j', async (outcome) => {
      mockNotificationPrefsRow = { seasonal_tips: true };
      const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      interactionMarkerRow = {
        id: 'sms-claim', body: 'Prep send claimed via Communications — dispatching.',
        created_at: old, metadata: { guide_sms_to: '+19415550102' },
      };
      TwilioService.findOutboundMessageSince.mockResolvedValue(outcome);
      const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' });
      expect(result).toMatchObject({ ok: false, reason: outcome.found ? 'guide_already_sent' : 'guide_check_failed' });
      expect(TwilioService.findOutboundMessageSince).toHaveBeenCalledWith({
        to: '+19415550102', sentAfter: old, bodyFragment: 'wavespestcontrol.com/sprinkler-timers/',
      });
      expect(interactionDeletes).toBe(0);
      expect(interactionUpdates).toEqual(outcome.found
        ? [{ body: 'Prep text confirmed by provider reconciliation — not resent.' }] : []);
      expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    },
  );

  test.each(['returned', 'audit throws'])('an uncertain SMS %s retains the claim for reconciliation', async (mode) => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    const outcome = { sent: false, code: 'PROVIDER_FAILURE', retryable: true };
    if (mode === 'returned') sendCustomerMessage.mockResolvedValueOnce(outcome);
    else sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit write failed'), { providerOutcome: outcome }));
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(result).toMatchObject({ ok: false, smsSent: false, smsUncertain: true });
    expect(interactionDeletes).toBe(0);
    expect(interactionUpdates).toEqual([{ body: 'Prep send claimed via Communications — dispatching.' }]);
    interactionMarkerRow = {
      ...interactionsInsert.mock.calls.at(-1)[0], id: 'uncertain-sms',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    TwilioService.findOutboundMessageSince.mockResolvedValueOnce({ found: true });
    const retry = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(retry).toMatchObject({ ok: false, reason: 'guide_already_sent' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(interactionDeletes).toBe(0);
  });

  test('a definite email rejection plus uncertain text restores the text reconciliation state', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ onQueued }) => {
      expect(await onQueued()).toBe(true);
      throw Object.assign(new Error('provider rejected'), { status: 400 });
    });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'PROVIDER_FAILURE' });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'both' }))
      .toMatchObject({ ok: false, emailUncertain: false, smsUncertain: true });
    expect(interactionUpdates[0].body).toMatch(/email dispatch started/);
    expect(interactionUpdates.at(-1).body).toBe('Prep send claimed via Communications — dispatching.');
    expect(interactionDeletes).toBe(0);
    interactionMarkerRow = {
      ...interactionsInsert.mock.calls.at(-1)[0], ...interactionUpdates.at(-1), id: 'retryable-text',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' }))
      .toMatchObject({ ok: true, smsSent: true });
    expect(TwilioService.findOutboundMessageSince).toHaveBeenCalled();
  });

  test('provider reconciliation failure preserves the stale claim; confirmed absence permits retry', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    interactionMarkerRow = {
      id: 'sms-claim', body: 'Prep send claimed via Communications — dispatching.',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      metadata: { guide_sms_to: customerRow.phone },
    };
    TwilioService.findOutboundMessageSince.mockRejectedValueOnce(new Error('provider unavailable'));
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'guide_check_failed' });
    expect(interactionDeletes).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(result).toMatchObject({ ok: true, smsSent: true });
    expect(interactionDeletes).toBe(1);
    expect(interactionsInsert).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: { guide_sms_to: customerRow.phone, guide_email_fenced: true },
    }), ['id']);
  });

  test('only an active recurring lawn customer (the Monday plan\'s audience) gets the guide; channel preferences are judged per leg, not by the audience', async () => {
    mockRecurringLawn = false;
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(result).toMatchObject({ ok: false, reason: 'not_recurring_lawn' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    mockRecurringLawn = true;
    customerRow = { ...customerRow, active: false };
    const inactive = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(inactive).toMatchObject({ ok: false, reason: 'not_recurring_lawn' });
    // An email opt-out never masquerades as "not in the audience": Text still goes.
    customerRow = { ...customerRow, active: true };
    mockNotificationPrefsRow = { seasonal_tips: true, email_enabled: false };
    const text = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(text).toMatchObject({ ok: true, smsSent: true });
    // Visit prep is unaffected by the lawn audience.
    const flea = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });
    expect(flea.ok).toBe(true);
  });

  test('watering block uses the re-read address and fails closed when the move stamp changes mid-build', async () => {
    const { buildWateringBlock } = require('../services/prep-guide-sender');
    mockRestrictionPolicy = ORDER;
    prefsRow = { irrigation_run_minutes: 35 };
    const { resolveRestrictionCounty } = require('../config/irrigation-restrictions');
    // The caller's row says Bradenton; the fresh read says the customer moved to Venice.
    db.mockImplementation((table) => {
      if (table === 'customers') return { where: () => ({ first: async () => ({ city: 'Venice', zip: '34285' }) }) };
      if (table === 'property_preferences') return traceQuery(prefsRow);
      if (table === 'customer_turf_profiles') return traceQuery(null);
      return customersQuery();
    });
    await buildWateringBlock(customerRow);
    expect(resolveRestrictionCounty).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Venice', zip: '34285' }));
    // A stamp that differs between the two preference reads = inputs straddle a move → fail closed.
    let reads = 0;
    db.mockImplementation((table) => {
      if (table === 'customers') return { where: () => ({ first: async () => ({ city: 'Venice', zip: '34285' }) }) };
      if (table === 'property_preferences') return { where: () => ({ first: async () => ({ irrigation_run_minutes: 35, irrigation_home_changed_at: (reads++ === 0) ? null : '2026-09-05T20:00:00Z' }) }) };
      if (table === 'customer_turf_profiles') return traceQuery(null);
      return customersQuery();
    });
    const block = await buildWateringBlock(customerRow);
    expect(block).toMatch(/check your county's watering rules/);
    expect(block).not.toMatch(/watering day a week/);
  });

  test('an unreadable preference or history fails closed (no send)', async () => {
    db.mockImplementation((table) => {
      if (table === 'customers') return customersQuery();
      if (table === 'notification_prefs') return { where: () => ({ first: async () => { throw new Error('boom'); } }) };
      return customersQuery();
    });
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'email' });
    expect(result).toMatchObject({ ok: false, reason: 'guide_check_failed' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('watering block reads the ACTIVE turf profile only (a retired profile\'s county is the former home\'s)', async () => {
    const { buildWateringBlock } = require('../services/prep-guide-sender');
    mockRestrictionPolicy = ORDER;
    await buildWateringBlock(customerRow);
    expect(turfQueries).toHaveLength(1);
    expect(turfQueries[0].where).toHaveBeenCalledWith({ customer_id: 'cust-1', active: true });
  });

  test('the seasonal consent helper the gate imports is a real top-level export (the suite mocks it; pre-push Codex P1 on d85f2981c)', () => {
    const actual = jest.requireActual('../services/document-contract-delivery');
    expect(typeof actual.marketingSmsConsentBasisForContract).toBe('function');
  });

  test('every visit-prep entry carries a service family; only a guide may omit it (the composer scan iterates PREP_CONFIG)', () => {
    const { PREP_CONFIG } = require('../services/prep-guide-sender');
    for (const config of Object.values(PREP_CONFIG)) {
      if (config.guide) expect(config.serviceKeywords).toBeUndefined();
      else expect(Array.isArray(config.serviceKeywords) && config.serviceKeywords.length > 0).toBe(true);
    }
    expect(PREP_CONFIG.sprinkler_timer.guide).toBe(true);
  });

  test('text only needs no visit (unlike the visit-prep guides with no inline text)', async () => {
    mockNotificationPrefsRow = { seasonal_tips: true };
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'sprinkler_timer', channel: 'sms' });
    expect(result.ok).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(renderSmsTemplate.mock.calls[0][0]).toBe('auto_sprinkler_timer');
  });

  test('watering block: day count from the policy, minutes from the customer\'s settings', async () => {
    const { buildWateringBlock } = require('../services/prep-guide-sender');
    mockRestrictionPolicy = ORDER;
    prefsRow = { irrigation_run_minutes: 35 };
    const block = await buildWateringBlock(customerRow);
    expect(block).toMatch(/one watering day a week \(SWFWMD Modified Phase III water shortage order\)/);
    expect(block).toMatch(/run each grass zone about 35 minutes\./);
    // No weekday, no hour window: the policy cannot name either.
    expect(block).not.toMatch(/Wednesday|AM|PM/);
  });

  test('watering block: no minutes on file → Monday\'s email carries the number', async () => {
    const { buildWateringBlock } = require('../services/prep-guide-sender');
    mockRestrictionPolicy = ORDER;
    const block = await buildWateringBlock(customerRow);
    expect(block).toMatch(/Monday's email tells you how many minutes/);
    expect(block).not.toMatch(/about \d+ minutes/);
  });

  test('watering block fails closed: no policy (coverage not established) → check your county, never a guessed day count', async () => {
    const { buildWateringBlock } = require('../services/prep-guide-sender');
    mockRestrictionPolicy = null;
    prefsRow = { irrigation_run_minutes: 40 };
    const block = await buildWateringBlock(customerRow);
    expect(block).toMatch(/check your county's watering rules/);
    expect(block).toMatch(/about 40 minutes/);
    expect(block).not.toMatch(/watering day a week/);
  });

  test('watering block: minutes saved before a move are the former home\'s — left out until re-confirmed (pre-push Codex P1 on d82831055)', async () => {
    const { buildWateringBlock } = require('../services/prep-guide-sender');
    mockRestrictionPolicy = ORDER;
    prefsRow = { irrigation_run_minutes: 35, irrigation_home_changed_at: '2026-08-20T12:00:00Z', irrigation_confirmed_fields: JSON.stringify(['watering_days']) };
    let block = await buildWateringBlock(customerRow);
    expect(block).not.toMatch(/about 35 minutes/);
    expect(block).toMatch(/Monday's email tells you how many minutes/);
    // Re-entered after the move → current again.
    prefsRow = { ...prefsRow, irrigation_confirmed_fields: JSON.stringify(['watering_days', 'irrigation_run_minutes']) };
    block = await buildWateringBlock(customerRow);
    expect(block).toMatch(/about 35 minutes/);
  });

  test('watering block survives a preferences read failure (fails closed)', async () => {
    const { buildWateringBlock } = require('../services/prep-guide-sender');
    mockRestrictionPolicy = ORDER;
    db.mockImplementation((table) => {
      if (table === 'property_preferences') return { where: () => ({ first: async () => { throw new Error('boom'); } }) };
      return customersQuery();
    });
    const block = await buildWateringBlock(customerRow);
    expect(block).toMatch(/check your county's watering rules/);
  });
});
