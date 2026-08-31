jest.mock('../services/job-status', () => ({
  nextClaimTs: jest.fn(() => 'claim-token-1'),
  transitionJobStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));

const AppointmentReminders = require('../services/appointment-reminders');
const { registerSpawnedVisitReminder } = require('../routes/admin-schedule')._test;

describe('registerSpawnedVisitReminder registers from the committed row', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a spawn whose in-memory copy has no window still opts into the committed read, with a placeholder fallback', async () => {
    await registerSpawnedVisitReminder({
      scheduledServiceId: 901, customerId: 5, scheduledDate: '2026-09-15', windowStart: undefined,
      serviceType: 'Quarterly Pest Control', source: 'recurring_auto_extend',
    });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      901, 5, '2026-09-15T08:00', 'Quarterly Pest Control', 'recurring_auto_extend',
      { sendConfirmation: false, closeReminderWindows: true, fromCommittedRow: true },
    );
  });

  test('a spawn with a window passes it as the fallback and stays armed if the row agrees', async () => {
    await registerSpawnedVisitReminder({
      scheduledServiceId: 902, customerId: 5, scheduledDate: '2026-09-15', windowStart: '13:00',
      serviceType: 'Quarterly Pest Control', source: 'admin_manual',
    });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      902, 5, '2026-09-15T13:00', 'Quarterly Pest Control', 'admin_manual',
      { sendConfirmation: false, closeReminderWindows: false, fromCommittedRow: true },
    );
  });

  test('a registration failure alerts and never throws to the caller', async () => {
    AppointmentReminders.registerAppointment.mockRejectedValueOnce(new Error('boom'));
    await expect(registerSpawnedVisitReminder({
      scheduledServiceId: 903, customerId: 5, scheduledDate: '2026-09-15', windowStart: '13:00',
      serviceType: 'Quarterly Pest Control', source: 'admin_manual',
    })).resolves.toBeUndefined();
    expect(AppointmentReminders.alertRegistrationFailure).toHaveBeenCalled();
  });
});
