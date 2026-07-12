jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromAITrio: jest.fn(),
}));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => null),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: jest.fn(async () => ({
    automation_count: 1,
    results: [{ automation_key: 'prep', run: { id: 'run-1', status: 'queued' }, deduped: false }],
  })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/automation-runner', () => ({
  enrollCustomer: jest.fn(async () => ({ enrolled: true, enrollmentId: 'enr-1' })),
  hasLocalContent: jest.fn(async () => true),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const executor = require('../services/email-template-automation-executor');
const AppointmentTagger = require('../services/appointment-tagger');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { formatDisplayDate } = require('../utils/date-only');

const FUTURE_DATE = etDateString(addETDays(new Date(), 7));
const PAST_DATE = etDateString(addETDays(new Date(), -1));

function service(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Example',
    email: 'taylor@example.com',
    phone: '+19415550101',
    service_type: 'Cockroach Treatment - Interior',
    scheduled_date: FUTURE_DATE,
    status: 'scheduled',
    address_line1: '123 Palm Ave',
    city: 'Bradenton',
    zip: '34211',
    ...overrides,
  };
}

let customerRow;
let priorBookingRow;
let automationActiveRow;
let priorPrepInteraction;
let trxRaw;

// isPrepAutomationActive lookup (email_template_automations) — a row = active.
function automationsQuery() {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => automationActiveRow),
  };
  return q;
}

// customer_interactions — hasSentPrepSms dedupe lookup (.where().first()) plus
// the post-send marker insert.
function interactionsQuery() {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => priorPrepInteraction),
    insert: jest.fn(async () => [1]),
  };
  return q;
}

function customersQuery() {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => customerRow),
  };
  return q;
}

// First-time gate lookup (hasPriorSameTypeBooking) — resolves the prior
// same-family scheduled_services row, null = first-time treatment.
function priorBookingQuery() {
  const q = {
    where: jest.fn(() => q),
    whereIn: jest.fn(() => q),
    whereNot: jest.fn(() => q),
    whereNotIn: jest.fn(() => q),
    first: jest.fn(async () => priorBookingRow),
  };
  return q;
}

describe('appointment tagger prep email automation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // This describe covers the TRANSACTIONAL prep lane — the behavior for all
    // unwired pests, and for wired ones whenever the sequence gate is off.
    isEnabled.mockImplementation((key) => key !== 'treatmentAutomationEnroll');
    customerRow = {
      id: 'cust-1',
      first_name: 'Taylor',
      last_name: 'Example',
      email: 'taylor@example.com',
    };
    priorBookingRow = null;
    automationActiveRow = { id: 'auto-1' };
    priorPrepInteraction = null;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return priorBookingQuery();
      if (table === 'customer_interactions') return interactionsQuery();
      if (table === 'email_template_automations') return automationsQuery();
      return customersQuery();
    });
    // Standalone sends run inside db.transaction with a pg advisory lock; the
    // trx handle dispatches to the same per-table query mocks.
    const trx = (table) => db(table);
    trxRaw = jest.fn(async () => ({}));
    trx.raw = trxRaw;
    db.transaction = jest.fn(async (fn) => fn(trx));
  });

  test('cockroach booking emits appointment.booked scoped to prep.cockroach', async () => {
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.triggerEventKey).toBe('appointment.booked');
    expect(call.automationKey).toBe('prep.cockroach');
    expect(call.triggerEventId).toBe('appointment_booked:svc-1');
    expect(call.entityType).toBe('scheduled_service');
    expect(call.entityId).toBe('svc-1');
    expect(call.executeImmediately).toBe(false);
    expect(call.recipient).toEqual({ email: 'taylor@example.com', type: 'customer', id: 'cust-1' });
    expect(call.payload).toMatchObject({
      scheduled_service_id: 'svc-1',
      customer_id: 'cust-1',
      customer_email: 'taylor@example.com',
      first_name: 'Taylor',
      service_type: 'Cockroach Treatment - Interior',
      service_date: formatDisplayDate(FUTURE_DATE),
      property_address: '123 Palm Ave, Bradenton, 34211',
    });
    expect(call.payload.prep_url).toContain('?tab=visits');
    expect(call.payload.customer_portal_url).toContain('?tab=visits');
  });

  test('flea booking maps to prep.flea and renders the auto_flea SMS companion', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');

    await AppointmentTagger.triggerPestPrep(
      service({ service_type: 'Flea Treatment - Interior & Exterior' }),
      'flea',
    );

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.automationKey).toBe('prep.flea');
    expect(call.payload.project_type).toBe('Flea Treatment');
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea',
      { first_name: 'Taylor' },
      { workflow: 'appointment_tagger_prep', entity_type: 'scheduled_service', entity_id: 'svc-1' },
    );
  });

  test('no prep SMS when the guide email run was deduped or skipped (re-run safety)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    executor.processTrigger.mockResolvedValueOnce({
      automation_count: 1,
      results: [{ automation_key: 'prep.cockroach', run: { id: 'run-1', status: 'queued' }, deduped: true }],
    });

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('no prep SMS when the automation is inactive (zero results)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    executor.processTrigger.mockResolvedValueOnce({ automation_count: 0, results: [] });

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('skips prep entirely when the customer already had a same-family booking', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    priorBookingRow = { id: 'svc-0' };

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('classifier tags flea service types', () => {
    expect(AppointmentTagger.classifyAppointmentType('Flea Treatment')).toEqual({
      tag: 'flea',
      label: 'Flea Treatment',
    });
    expect(AppointmentTagger.classifyAppointmentType('flea & tick service').tag).toBe('flea');
  });

  test('bed bug booking maps to prep.bed_bug', async () => {
    await AppointmentTagger.triggerPestPrep(
      service({ service_type: 'Bed Bug Treatment' }),
      'bed_bug',
    );

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.automationKey).toBe('prep.bed_bug');
    expect(call.payload.project_type).toBe('Bed Bug Treatment');
  });

  test('DATE column returned as a UTC-midnight Date keeps the ET calendar day', async () => {
    await AppointmentTagger.triggerPestPrep(
      service({ scheduled_date: new Date(`${FUTURE_DATE}T00:00:00Z`) }),
      'cockroach',
    );

    expect(executor.processTrigger.mock.calls[0][0].payload.service_date).toBe(formatDisplayDate(FUTURE_DATE));
  });

  test('skips past-dated appointments (regenerate-brief re-runs)', async () => {
    await AppointmentTagger.triggerPestPrep(service({ scheduled_date: PAST_DATE }), 'cockroach');

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('skips terminal-status appointments', async () => {
    for (const status of ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']) {
      await AppointmentTagger.triggerPestPrep(service({ status }), 'cockroach');
    }

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('payload carries the calendar date for the send-time appointment.past exit', async () => {
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger.mock.calls[0][0].payload.service_date_ymd).toBe(FUTURE_DATE);
  });

  test('skips when the emailTemplateAutomations gate is off', async () => {
    isEnabled.mockReturnValue(false);

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('routes to the service contact when one is set', async () => {
    customerRow = {
      ...customerRow,
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'onsite@example.com',
    };

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.recipient.email).toBe('onsite@example.com');
    expect(call.payload.customer_email).toBe('onsite@example.com');
    expect(call.payload.first_name).toBe('Jamie');
  });

  test('still sends via the service contact when the primary email is blank', async () => {
    customerRow = {
      ...customerRow,
      email: '',
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'onsite@example.com',
    };

    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'bed_bug');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    expect(executor.processTrigger.mock.calls[0][0].recipient.email).toBe('onsite@example.com');
  });

  test('no email on file falls back to the self-contained prep SMS', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    customerRow = { ...customerRow, email: '' };
    renderSmsTemplate.mockResolvedValueOnce('Bed bug prep steps...');
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });

    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'bed_bug');

    // No email means no guide email — but the phone-only customer still gets
    // the self-contained prep text (auto_bed_bug_no_email), not the companion.
    expect(executor.processTrigger).not.toHaveBeenCalled();
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_bed_bug_no_email',
      { first_name: 'Taylor' },
      { workflow: 'appointment_tagger_prep', entity_type: 'scheduled_service', entity_id: 'svc-1' },
    );
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({
      body: 'Bed bug prep steps...',
      metadata: expect.objectContaining({ prep_variant: 'standalone', pest_type: 'bed_bug' }),
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('prep.bed_bug'));
  });

  test('no email AND the prep automation is inactive → no standalone SMS (kill switch honored)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    customerRow = { ...customerRow, email: '' };
    automationActiveRow = null; // automation paused/disabled

    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'bed_bug');

    // A paused automation suppresses email-capable customers (zero executor
    // results); the phone-only fallback must respect the same pause.
    expect(executor.processTrigger).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('standalone prep SMS is not resent when one was already logged (replay safety)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    customerRow = { ...customerRow, email: '' };
    priorPrepInteraction = { id: 'int-1' }; // a prep SMS was already logged

    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'bed_bug');

    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('standalone dedupe check + marker run inside an advisory-lock transaction', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    customerRow = { ...customerRow, email: '' };
    renderSmsTemplate.mockResolvedValueOnce('Bed bug prep steps...');
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });

    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'bed_bug');

    // Concurrent replays (booking hook vs regenerate-brief) serialize on the
    // customer+pest advisory lock so both can't pass the marker check.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(trxRaw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?))',
      ['prep_sms:cust-1:bed_bug'],
    );
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('companion SMS is suppressed when standalone prep was already texted (email added later)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    // Customer got the self-contained prep text while phone-only; staff later
    // added an email and onServiceScheduled replayed. The guide email queues
    // (first run for this appointment) — that alone is the right follow-up;
    // a second prep text would be a duplicate.
    priorPrepInteraction = { id: 'int-1' };

    await AppointmentTagger.triggerPestPrep(service(), 'bed_bug');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1); // email still queues
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('flea with no email on file renders the auto_flea_no_email variant', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    customerRow = { ...customerRow, email: '' };

    await AppointmentTagger.triggerPestPrep(
      service({ email: null, service_type: 'Flea Treatment - Interior & Exterior' }),
      'flea',
    );

    expect(executor.processTrigger).not.toHaveBeenCalled();
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email',
      { first_name: 'Taylor' },
      { workflow: 'appointment_tagger_prep', entity_type: 'scheduled_service', entity_id: 'svc-1' },
    );
  });

  test('no standalone fallback when the email skip reason is not "no email"', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');

    // gate off, terminal, past, and dedupe all skip the email for reasons
    // other than a missing address — none should trigger the standalone SMS.
    isEnabled.mockReturnValueOnce(false);
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    await AppointmentTagger.triggerPestPrep(service({ status: 'cancelled' }), 'cockroach');
    await AppointmentTagger.triggerPestPrep(service({ scheduled_date: PAST_DATE }), 'cockroach');

    executor.processTrigger.mockResolvedValueOnce({
      automation_count: 1,
      results: [{ automation_key: 'prep.cockroach', run: { id: 'run-1', status: 'queued' }, deduped: true }],
    });
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('executor failure is logged and does not throw', async () => {
    executor.processTrigger.mockRejectedValueOnce(new Error('boom'));

    await expect(AppointmentTagger.triggerPestPrep(service(), 'cockroach')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  test('unknown pest type does not emit', async () => {
    await AppointmentTagger.triggerPrepEmailGuide(service(), 'termite');

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });
});

describe('treatment automation sequence (one guide email, Automations-tab source)', () => {
  const { enrollCustomer } = require('../services/automation-runner');
  let priorEnrollmentRow;
  let templateRow;
  let firstStepRow;

  // automation_enrollments — the once-per-customer booking-hook dedupe lookup
  // (.where().where(fn).first(); the fn models whereNot-failed OR delivered).
  function enrollmentsQuery() {
    const q = {
      where: jest.fn(() => q),
      whereNot: jest.fn(() => q),
      orWhereNotNull: jest.fn(() => q),
      first: jest.fn(async () => priorEnrollmentRow),
    };
    return q;
  }
  // automation_templates — isTreatmentSequenceSendable lookup.
  function templatesQuery() {
    const q = {
      where: jest.fn(() => q),
      first: jest.fn(async () => templateRow),
    };
    return q;
  }
  // automation_steps — first-enabled-step content check.
  function stepsQuery() {
    const q = {
      where: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      first: jest.fn(async () => firstStepRow),
    };
    return q;
  }

  beforeEach(() => {
    // Same harness as the prep describe: first-time booking, gates on.
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
    enrollCustomer.mockResolvedValue({ enrolled: true, enrollmentId: 'enr-1' });
    priorBookingRow = null;
    priorPrepInteraction = null;
    priorEnrollmentRow = null;
    templateRow = { key: 'bed_bug', enabled: true };
    firstStepRow = { step_order: 0, enabled: true, html_body: '<p>guide</p>', text_body: '' };
    customerRow = {
      id: 'cust-1',
      first_name: 'Taylor',
      last_name: 'Example',
      email: 'taylor@example.com',
    };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return priorBookingQuery();
      if (table === 'customer_interactions') return interactionsQuery();
      if (table === 'email_template_automations') return automationsQuery();
      if (table === 'automation_enrollments') return enrollmentsQuery();
      if (table === 'automation_templates') return templatesQuery();
      if (table === 'automation_steps') return stepsQuery();
      return customersQuery();
    });
    const trx = (table) => db(table);
    trxRaw = jest.fn(async () => ({}));
    trx.raw = trxRaw;
    db.transaction = jest.fn(async (fn) => fn(trx));
  });

  test('gate on: the sequence replaces the transactional guide email and the companion SMS keys off the enrollment', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockResolvedValueOnce('Bed bug prep steps...');
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });

    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');

    // ONE email: the sequence enrolls; the transactional prep automation is
    // never triggered.
    expect(executor.processTrigger).not.toHaveBeenCalled();
    expect(enrollCustomer).toHaveBeenCalledTimes(1);
    expect(enrollCustomer).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'bed_bug',
      customer: expect.objectContaining({ id: 'cust-1', email: 'taylor@example.com', first_name: 'Taylor' }),
      dbh: expect.anything(), // runs on the advisory-lock transaction
    }));
    // Companion text still goes out — the guide email is coming via the runner.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_bed_bug', { first_name: 'Taylor' }, expect.any(Object),
    );
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('gate off: the transactional prep lane runs unchanged and nothing enrolls', async () => {
    isEnabled.mockImplementation((key) => key !== 'treatmentAutomationEnroll');

    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test('unwired pests keep the transactional lane even with the gate on', async () => {
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test('phone-only customer gets the standalone prep SMS when the sequence is sendable', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    customerRow = { ...customerRow, email: '' };
    renderSmsTemplate.mockResolvedValueOnce('Bed bug prep steps...');
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });

    await AppointmentTagger.triggerPestPrep(service({ email: null, service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(enrollCustomer).not.toHaveBeenCalled();
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_bed_bug_no_email', { first_name: 'Taylor' }, expect.any(Object),
    );
  });

  test('phone-only customer stays silent when the sequence is paused or empty (kill-switch parity)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    customerRow = { ...customerRow, email: '' };
    templateRow = { key: 'bed_bug', enabled: false };

    await AppointmentTagger.triggerPestPrep(service({ email: null, service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(renderSmsTemplate).not.toHaveBeenCalled();

    templateRow = { key: 'bed_bug', enabled: true };
    firstStepRow = { step_order: 0, enabled: true, html_body: '', text_body: '' }; // first step empty
    await AppointmentTagger.triggerPestPrep(service({ email: null, service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('a prior delivered/deliverable enrollment blocks re-enrollment AND the SMS (post-completion replay)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    priorEnrollmentRow = { id: 'enr-0' }; // active/completed/cancelled — non-failed

    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(enrollCustomer).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('a prior FAILED enrollment does not suppress prep — the new booking retries it', async () => {
    // The dedupe lookup excludes failed rows (whereNot status failed), so the
    // mock returning null models "only a failed row exists".
    priorEnrollmentRow = null;

    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(enrollCustomer).toHaveBeenCalledTimes(1);
  });

  test('empty FIRST step never enrolls, even if a later step has content (companion would lie)', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    // The runner starts at step 0; a contentful later step doesn't make the
    // guide send. isTreatmentSequenceSendable checks the FIRST enabled step.
    firstStepRow = { step_order: 0, enabled: true, html_body: '   ', text_body: '' };

    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(enrollCustomer).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('enrollment is serialized under a customer+template advisory lock', async () => {
    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(trxRaw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?))',
      ['treatment_enroll:cust-1:bed_bug'],
    );
  });

  test('terminal or past visits never enroll (regenerate-brief replay safety)', async () => {
    await AppointmentTagger.triggerPestPrep(service({ status: 'cancelled', service_type: 'Bed Bug Treatment' }), 'bed_bug');
    await AppointmentTagger.triggerPestPrep(service({ status: 'completed', service_type: 'Bed Bug Treatment' }), 'bed_bug');
    await AppointmentTagger.triggerPestPrep(service({ scheduled_date: PAST_DATE, service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(enrollCustomer).not.toHaveBeenCalled();
    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('service-contact account routes the enrollment to the on-site contact', async () => {
    customerRow = {
      ...customerRow,
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'jamie@example.com',
    };

    const result = await AppointmentTagger.enrollTreatmentSequence(service(), 'bed_bug');

    expect(result).toEqual({ queued: true, reason: 'queued' });
    expect(enrollCustomer).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'bed_bug',
      customer: expect.objectContaining({ email: 'jamie@example.com', first_name: 'Jamie' }),
    }));
  });

  test('enrollment failure fails closed: logged, no SMS, booking unaffected', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    enrollCustomer.mockRejectedValueOnce(new Error('boom'));

    await expect(
      AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug'),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bed_bug sequence enroll failed'));
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });
});
