jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/sms-auto-send', () => ({ isRealProviderSend: jest.requireActual('../services/sms-auto-send').isRealProviderSend }));
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
  markServicePrepSent: jest.requireActual('../services/project-email').markServicePrepSent,
}));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendPrepToCustomer } = require('../services/prep-guide-sender');

let customerRow;

function customersQuery() {
  const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), first: jest.fn(async () => customerRow) };
  return q;
}
// nextUpcomingVisit lookup — no upcoming visit by default. When a test sets
// upcomingVisitRow, the same table also serves ensureServicePrepToken's
// chains (.select()…first() token read + .update().returning() mint).
let upcomingVisitRow = null;
let upcomingVisitRows = null; // several candidates (soonest first); null = [upcomingVisitRow]
let viewRow = null; // prep_guide_views
let visitLookupError = null;
let servicePrepRow = null;
let serviceUpdates = [];
let scheduledQueries = [];
// Automated-lane rows for the abandoned-reservation check: [] = none.
let runRows = [];
let enrollmentRows = [];
let stepSendRow = null;
let lastRunsQuery = null;
// Manual-delivery traces for the abandoned-reservation check: null = none.
let manualEmailRow = null;
let manualEmailQueries = [];
let interactionQueries = [];
let manualSmsRow = null;
let interactionMarkerRow = null;
function traceQuery(row) {
  const q = { where: jest.fn(() => q), whereIn: jest.fn(() => q), whereNot: jest.fn(() => q), whereNotIn: jest.fn(() => q), whereRaw: jest.fn(() => q), first: jest.fn(async () => row) };
  return q;
}
function livenessQuery(rows) {
  const q = { where: jest.fn(() => q), whereIn: jest.fn(() => q), select: jest.fn(async () => rows) };
  return q;
}
jest.mock('../services/email-template-automation-executor', () => ({ RUNNABLE_STATUSES: ['queued', 'scheduled', 'retry_scheduled'] }));
// Rows affected by an awaited .update() (the prep-page claim); 1 = claimed.
let serviceUpdateCount = 1;
function scheduledQuery() {
  let tokenMode = false;
  const q = {
    select: jest.fn(() => { tokenMode = true; return q; }),
    where: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNotIn: jest.fn(() => q),
    whereNull: jest.fn(() => q), limit: jest.fn(() => q),
    // nextUpcomingVisits awaits the chain itself (…limit().select(cols)).
    then: (resolve, reject) => {
      if (visitLookupError) return reject(visitLookupError);
      return resolve(upcomingVisitRows || (upcomingVisitRow ? [upcomingVisitRow] : []));
    },
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
      return tokenMode ? servicePrepRow : upcomingVisitRow;
    }),
  };
  return q;
}
const interactionsInsert = jest.fn(async () => [1]);

beforeEach(() => {
  jest.clearAllMocks();
  customerRow = {
    id: 'cust-1', first_name: 'Megan', last_name: 'Example',
    email: 'megan@example.com', phone: '+19415550101',
    address_line1: '5022 Sunnyside Ln', city: 'Bradenton', state: 'FL', zip: '34211',
    deleted_at: null,
  };
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery();
    if (table === 'scheduled_services') { const q = scheduledQuery(); scheduledQueries.push(q); return q; }
    if (table === 'customer_interactions') { const q = { insert: interactionsInsert, ...traceQuery(interactionMarkerRow) }; interactionQueries.push(q); return q; }
    if (table === 'email_messages') { const q = traceQuery(manualEmailRow); manualEmailQueries.push(q); return q; }
    if (table === 'sms_log') return traceQuery(manualSmsRow);
    if (table === 'email_template_automation_runs') { lastRunsQuery = livenessQuery(runRows); return lastRunsQuery; }
    if (table === 'automation_enrollments') return livenessQuery(enrollmentRows);
    if (table === 'automation_step_sends') return traceQuery(stepSendRow);
    if (table === 'prep_guide_views') return traceQuery(viewRow);
    return customersQuery();
  });
  db.fn = { now: jest.fn(() => 'NOW()') };
  runRows = [];
  enrollmentRows = [];
  stepSendRow = null;
  manualEmailRow = null;
  manualEmailQueries = [];
  interactionQueries = [];
  manualSmsRow = null;
  interactionMarkerRow = null;
  scheduledQueries = [];
  upcomingVisitRow = null;
  upcomingVisitRows = null;
  viewRow = null;
  visitLookupError = null;
  serviceUpdateCount = 1;
  servicePrepRow = { prep_token: null, prep_template_key: null };
  serviceUpdates = [];
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
  renderSmsTemplate.mockResolvedValue('Prep text...');
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM123' });
});

describe('sendPrepToCustomer', () => {
  const VISIT = { id: 'svc-9', scheduled_date: '2026-08-01' };

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
    // The texted link IS the guide delivery: prep_sent_at is stamped for it.
    expect(serviceUpdates).toContainEqual(expect.objectContaining({
      prep_sent_at: 'NOW()',
      prep_template_key: 'prep.termite',
    }));
  });

  test('every live prep guide is sendable by email', async () => {
    const { PREP_CONFIG } = require('../services/prep-guide-sender');
    const keys = Object.keys(PREP_CONFIG);
    // prep.wildlife stays archived — wildlife is a prohibited Waves service.
    expect(keys.sort()).toEqual([
      'bed_bug', 'cockroach', 'flea', 'interior_pest', 'lawn', 'mosquito', 'rodent', 'termite',
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
    expect(serviceUpdates).toContainEqual(expect.objectContaining({
      prep_sent_at: 'NOW()',
      prep_template_key: 'prep.flea',
    }));
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

    serviceUpdates = [];
    renderSmsTemplate.mockResolvedValue('Prep text...');
    // sendCustomerMessage swallows provider failures; a throw WITHOUT a
    // provider outcome happened before the handoff — definite, claim released.
    sendCustomerMessage.mockRejectedValueOnce(new Error('socket hang up'));
    const preHandoff = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(preHandoff).toMatchObject({ ok: false, reason: 'send_failed', smsSent: false });
    expect(preHandoff.smsUncertain).toBeUndefined();
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
    expect(result.smsUncertain).toBeUndefined();
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

  test('an abandoned automated reservation (undelivered, no live run or enrolment) is re-keyed to the requested guide; a live lane or a delivered page keeps it', async () => {
    // The tagger reserved prep.flea before its lane delivered; the lane died.
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea', prep_sent_at: null };
    servicePrepRow = { prep_token: 'e'.repeat(32), prep_template_key: 'prep.lawn' };
    const rekeyed = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' });
    expect(rekeyed).toMatchObject({ ok: true, smsSent: true });
    expect(serviceUpdates[0]).toEqual({ prep_template_key: 'prep.lawn' });
    // The re-key is fenced on the view columns (atomic against a concurrent
    // public page load, which stamps the view in its read; r17 P0).
    expect(scheduledQueries.some((q) => q.whereNull.mock.calls.some(([c]) => c === 'prep_first_viewed_at')
      && q.whereRaw.mock.calls.some(([sql]) => sql === 'COALESCE(prep_view_count, 0) = 0'))).toBe(true);
    expect(lastRunsQuery.where).toHaveBeenCalledWith({ entity_type: 'scheduled_service', entity_id: VISIT.id, template_key: 'prep.flea' });

    // A skipped run with no email past dispatch is abandoned too.
    serviceUpdates = [];
    runRows = [{ status: 'skipped', idempotency_key: 'run-k1' }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: true, smsSent: true });

    // A live sequence enrolment (its first step would stamp prep.flea) owns the page.
    serviceUpdates = [];
    runRows = [];
    enrollmentRows = [{ id: 'enr-1', status: 'active', last_sent_at: null }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_page_taken', takenBy: 'Flea Treatment' });
    expect(serviceUpdates).toEqual([]);

    // A failed enrolment that ever sent a step, or has a step-send row past
    // its blocked gate (a post-dispatch throw is 'failed' too), may have
    // delivered the guide (pre-push Codex P0 on 8a5799a6d).
    enrollmentRows = [{ id: 'enr-1', status: 'failed', last_sent_at: new Date() }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    enrollmentRows = [{ id: 'enr-1', status: 'failed', last_sent_at: null }];
    stepSendRow = { id: 'ss-1' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    stepSendRow = null;
    enrollmentRows = [];

    // A live transactional run (a future run_after is stored 'scheduled'),
    // a run that SENT (stamp lost), or a failed run whose email got past the
    // dispatch boundary each own the page.
    runRows = [{ status: 'scheduled', idempotency_key: 'run-k1' }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_page_taken' });
    runRows = [{ status: 'sent', idempotency_key: 'run-k1' }];
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    runRows = [{ status: 'failed', idempotency_key: 'run-k1' }];
    manualEmailRow = { id: 'em-run' }; // the email_messages trace query serves both lanes
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    manualEmailRow = null;
    runRows = [];

    // A MANUAL send that kept the key without a stamp (uncertain email /
    // lost stamp) may have put the page in the customer's hands: an
    // email_messages row (VISIT-scoped trigger id) past the dispatch
    // boundary, an outbound text carrying the /prep/:token link, or the
    // confirmed-text marker written since this visit was created each keep
    // the page (r13 P0; visit scoping = pre-push P1 on b5d05dd14).
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea', prep_sent_at: null, prep_token: 'f'.repeat(32), created_at: new Date('2026-06-01T00:00:00Z') };
    manualEmailRow = { id: 'em-1' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    expect(manualEmailQueries.some((q) => q.where.mock.calls.some(([arg]) => arg && arg.trigger_event_id === `manual_prep:cust-1:prep.flea:${VISIT.id}`))).toBe(true);
    manualEmailRow = null;
    manualSmsRow = { id: 'sms-1' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    // With no visit-scoped row the legacy customer-wide id from the parent
    // sender is consulted too, bounded to rows since this visit was created (r14 P0).
    expect(manualEmailQueries.some((q) => q.where.mock.calls.some(([arg]) => arg && arg.trigger_event_id === 'manual_prep:cust-1:prep.flea')
      && q.where.mock.calls.some(([col, op, v]) => col === 'created_at' && op === '>=' && v instanceof Date))).toBe(true);
    manualSmsRow = null;
    interactionMarkerRow = { id: 'ci-1' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    expect(interactionQueries.some((q) => q.where.mock.calls.some(([col, op, v]) => col === 'created_at' && op === '>=' && v instanceof Date))).toBe(true);
    interactionMarkerRow = null;
    expect(serviceUpdates).toEqual([]);

    // An OPENED page (prep_first_viewed_at / prep_view_count / a
    // prep_guide_views row) is never re-keyed, traces or not (r16 P0).
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea', prep_sent_at: null, prep_first_viewed_at: new Date() };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea', prep_sent_at: null, prep_view_count: 2 };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea', prep_sent_at: null };
    viewRow = { id: 'v-1' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' })).toMatchObject({ ok: false, reason: 'prep_page_taken' });
    viewRow = null;
    expect(serviceUpdates).toEqual([]);

    // Delivered (prep_sent_at) is never re-keyed — no liveness read at all.
    upcomingVisitRow = { ...VISIT, prep_template_key: 'prep.flea', prep_sent_at: new Date() };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'lawn', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'prep_page_taken' });
    expect(serviceUpdates).toEqual([]);
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

  test('the interior-pest visit match excludes "Lawn Pest Control" (a lawn-line visit)', async () => {
    upcomingVisitRow = VISIT;
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'interior_pest', channel: 'email' });
    const excluded = scheduledQueries.some((q) => q.whereRaw.mock.calls.some(([sql, args]) => sql === 'LOWER(service_type) NOT LIKE ?' && args[0] === '%lawn pest%'));
    expect(excluded).toBe(true);
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
    expect(serviceUpdates).toContainEqual(expect.objectContaining({ prep_sent_at: 'NOW()', prep_template_key: 'prep.lawn' }));
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

  test('no upcoming visit → the email prep_url stays the portal visits tab', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });

    expect(result.ok).toBe(true);
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toContain('?tab=visits');
    expect(payload.service_date).toBe('To be confirmed');
  });
});
