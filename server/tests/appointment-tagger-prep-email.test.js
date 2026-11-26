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
  isNewRecurringSignupCandidate: jest.fn(async () => false),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => null),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
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
const AppointmentTagger = require('../services/appointment-tagger');
const { etDateString, addETDays } = require('../utils/datetime-et');

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
let priorPrepInteraction;
let servicePrepRow;
let servicePrepUpdateResult;
let serviceUpdates;
let trxRaw;

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

// scheduled_services serves two chains: the first-time gate lookup
// (hasPriorSameTypeBooking — .where()…first(), null = first-time) and the
// ensureServicePrepToken mint (.select('prep_token',…)…first() +
// .update().returning()). The .select() call marks token mode.
function priorBookingQuery() {
  let tokenMode = false;
  const q = {
    select: jest.fn(() => { tokenMode = true; return q; }),
    where: jest.fn(() => q),
    whereIn: jest.fn(() => q),
    whereNot: jest.fn(() => q),
    whereNotIn: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    update: jest.fn((patch) => { serviceUpdates.push(patch); return q; }),
    returning: jest.fn(async () => servicePrepUpdateResult),
    catch: jest.fn(async () => undefined),
    first: jest.fn(async () => (tokenMode ? servicePrepRow : priorBookingRow)),
  };
  return q;
}

describe('appointment tagger prep email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // No treatment sequence is wired in this describe: the prep email only
    // goes out through the Automations-tab sequence (see the next describe).
    isEnabled.mockImplementation((key) => key !== 'treatmentAutomationEnroll');
    customerRow = {
      id: 'cust-1',
      first_name: 'Taylor',
      last_name: 'Example',
      email: 'taylor@example.com',
    };
    priorBookingRow = null;
    priorPrepInteraction = null;
    servicePrepRow = { prep_token: null, prep_template_key: null };
    servicePrepUpdateResult = [{}];
    serviceUpdates = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return priorBookingQuery();
      if (table === 'customer_interactions') return interactionsQuery();
      return customersQuery();
    });
    const trx = (table) => db(table);
    trxRaw = jest.fn(async () => ({}));
    trx.raw = trxRaw;
    db.transaction = jest.fn(async (fn) => fn(trx));
    db.fn = { now: jest.fn(() => 'NOW()') };
  });

  // codex #6162 r1 P1: Admin Schedule can book the car roach row, which runs
  // onServiceScheduled. The name carries "german" and "roach", so it used to
  // classify as household roach work and queue prep.cockroach (a kitchen
  // cabinets email). A car job now gets its own tag and no prep automation.
  describe('vehicle roach rows get no household roach prep', () => {
    function bookingRow(serviceType) {
      return service({ service_type: serviceType, is_recurring: false });
    }
    function mockBooking(row) {
      // First scheduled_services read is the booking row; later reads
      // (prior-booking gate, prep token) fall through to the shared defaults.
      let served = false;
      db.mockImplementation((table) => {
        if (table === 'scheduled_services') {
          const q = priorBookingQuery();
          const defaultFirst = q.first;
          q.leftJoin = jest.fn(() => q);
          q.select = jest.fn(() => q);
          q.first = jest.fn(async (...args) => {
            if (!served) { served = true; return row; }
            return defaultFirst(...args);
          });
          return q;
        }
        if (table === 'customer_interactions') return interactionsQuery();
        return customersQuery();
      });
    }

    test.each([
      'Vehicle German Roach Treatment (2 Visits)',
      'Vehicle Roach Add-On',
    ])('classifier: %s is not a household roach type', (name) => {
      expect(AppointmentTagger.classifyAppointmentType(name)).toEqual({ tag: 'vehicle_roach', label: 'Vehicle Roach Treatment' });
    });

    test('household roach names still classify as roach work', () => {
      expect(AppointmentTagger.classifyAppointmentType('German Roach Initial Service (3-Visit)').tag).toBe('german_roach');
      expect(AppointmentTagger.classifyAppointmentType('Cockroach Treatment - Interior').tag).toBe('german_roach');
      expect(AppointmentTagger.classifyAppointmentType('Roach Control').tag).toBe('cockroach');
    });

    test('onServiceScheduled for the car job sends no prep email, prep text or sequence enrollment', async () => {
      const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
      const { renderSmsTemplate } = require('../services/sms-template-renderer');
      const automationRunner = require('../services/automation-runner');
      mockBooking(bookingRow('Vehicle German Roach Treatment (2 Visits)'));

      await AppointmentTagger.onServiceScheduled('svc-1');

      expect(automationRunner.enrollCustomer).not.toHaveBeenCalled();
      expect(renderSmsTemplate).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('a prior car job does not count as a prior household roach booking', async () => {
      // hasPriorSameTypeBooking looks only at the household roach tags.
      priorBookingRow = null;
      await AppointmentTagger.hasPriorSameTypeBooking(service(), 'cockroach');
      const q = db.mock.results.at(-1).value;
      expect(q.whereIn).toHaveBeenCalledWith('appointment_type', ['german_roach', 'cockroach']);
    });
  });

  test('with the sequence gate off no guide email goes out: nothing enrolls and no prep SMS sends', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    const { enrollCustomer } = require('../services/automation-runner');

    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');
    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'flea');

    expect(enrollCustomer).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('classifier tags flea service types', () => {
    expect(AppointmentTagger.classifyAppointmentType('Flea Treatment')).toEqual({
      tag: 'flea',
      label: 'Flea Treatment',
    });
    expect(AppointmentTagger.classifyAppointmentType('flea & tick service').tag).toBe('flea');
  });

  describe('bed bug heat and hybrid jobs', () => {
    test('a heat job takes no sequence enrollment even with the sequence gate on (step 0 is the chemical guide)', async () => {
      isEnabled.mockImplementation(() => true);
      const { enrollCustomer } = require('../services/automation-runner');
      const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
      await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Hybrid Heat + Residual Program' }), 'bed_bug_heat');

      expect(enrollCustomer).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('a prior chemical bed bug booking counts as the same family for heat (first-time only)', async () => {
      await AppointmentTagger.hasPriorSameTypeBooking(service({ service_type: 'Bed Bug Heat Treatment' }), 'bed_bug_heat');
      const q = db.mock.results.at(-1).value;
      expect(q.whereIn).toHaveBeenCalledWith('appointment_type', ['bed_bug']);
    });

    test.each([
      ['Bed Bug Heat Treatment', 'bed_bug_heat'],
      ['Bed Bug Hybrid Heat + Residual Program', 'bed_bug_heat'],
      ['Heat Bed Bug Treatment', 'bed_bug_heat'],
      ['Bed Bug Treatment Service', 'bed_bug'],
      ['Bed Bug Chemical/IPM Program', 'bed_bug'],
    ])('onServiceScheduled routes %s to the %s guide', async (serviceType, pestType) => {
      let served = false;
      db.mockImplementation((table) => {
        if (table !== 'scheduled_services') return customersQuery();
        const q = priorBookingQuery();
        const defaultFirst = q.first;
        q.leftJoin = jest.fn(() => q);
        q.select = jest.fn(() => q);
        q.first = jest.fn(async (...args) => {
          if (!served) { served = true; return service({ service_type: serviceType }); }
          return defaultFirst(...args);
        });
        return q;
      });
      const spy = jest.spyOn(AppointmentTagger, 'triggerPestPrep').mockResolvedValue(undefined);
      try {
        await AppointmentTagger.onServiceScheduled('svc-1');
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ service_type: serviceType }), pestType);
      } finally {
        spy.mockRestore();
      }
    });
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
    servicePrepRow = { prep_token: null, prep_template_key: null };
    servicePrepUpdateResult = [{}];
    serviceUpdates = [];
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

    // ONE email: the sequence enrolls.
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
    // Sequence-lane parity: the visit's public prep token is minted at
    // enroll time (the runner stamps prep_sent_at when step-0 delivers).
    expect(serviceUpdates.some((p) => p && p.prep_token && p.prep_template_key === 'prep.bed_bug')).toBe(true);
    // But never the delivery stamp — that belongs to the runner.
    expect(serviceUpdates.some((p) => p && p.prep_sent_at !== undefined)).toBe(false);
  });

  test('gate off: nothing enrolls and no prep SMS sends', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    isEnabled.mockImplementation((key) => key !== 'treatmentAutomationEnroll');

    await AppointmentTagger.triggerPestPrep(service({ service_type: 'Bed Bug Treatment' }), 'bed_bug');

    expect(enrollCustomer).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('a same-family earlier booking skips prep entirely', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    priorBookingRow = { id: 'svc-0' };

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(enrollCustomer).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test('cockroach and flea bookings route to their sequences too (all three pests wired)', async () => {
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');
    await AppointmentTagger.triggerPestPrep(
      service({ service_type: 'Flea Treatment - Interior & Exterior' }),
      'flea',
    );

    // ONE email each: the sequences enroll.
    expect(enrollCustomer).toHaveBeenCalledTimes(2);
    expect(enrollCustomer).toHaveBeenCalledWith(expect.objectContaining({ templateKey: 'cockroach' }));
    expect(enrollCustomer).toHaveBeenCalledWith(expect.objectContaining({ templateKey: 'flea' }));
  });

  test('an unmapped pest type reports no_automation and never enrolls', async () => {
    const result = await AppointmentTagger.enrollTreatmentSequence(service(), 'mosquito');

    expect(result).toEqual({ queued: false, reason: 'no_automation' });
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
