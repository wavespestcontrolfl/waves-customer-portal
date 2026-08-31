jest.mock('../services/job-status', () => ({
  nextClaimTs: jest.fn(() => 'claim-token-1'),
  transitionJobStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/appointment-reminders', () => ({
  resolveCommittedVisitTime: jest.fn(),
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));

const AppointmentReminders = require('../services/appointment-reminders');
const { registerSpawnedVisitReminder } = require('../routes/admin-schedule')._test;

describe('registerSpawnedVisitReminder registers from the committed row', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a windowed committed row registers ARMED at its own window, ignoring the stale caller copy', async () => {
    AppointmentReminders.resolveCommittedVisitTime.mockResolvedValue({ appointmentTime: '2026-09-15T11:00', windowless: false });
    await registerSpawnedVisitReminder({
      scheduledServiceId: 901, customerId: 5, scheduledDate: '2026-09-15', windowStart: undefined,
      serviceType: 'Quarterly Pest Control', source: 'recurring_auto_extend',
    });
    expect(AppointmentReminders.resolveCommittedVisitTime).toHaveBeenCalledWith(901, { date: '2026-09-15', windowStart: null });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      901, 5, '2026-09-15T11:00', 'Quarterly Pest Control', 'recurring_auto_extend',
      { sendConfirmation: false, closeReminderWindows: false },
    );
  });

  test('a windowless committed row registers as a NON-DELIVERING placeholder (closeReminderWindows)', async () => {
    AppointmentReminders.resolveCommittedVisitTime.mockResolvedValue({ appointmentTime: '2026-09-15T08:00', windowless: true });
    await registerSpawnedVisitReminder({
      scheduledServiceId: 902, customerId: 5, scheduledDate: '2026-09-15', windowStart: '13:00',
      serviceType: 'Quarterly Pest Control', source: 'admin_manual',
    });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      902, 5, '2026-09-15T08:00', 'Quarterly Pest Control', 'admin_manual',
      { sendConfirmation: false, closeReminderWindows: true },
    );
  });

  test('nothing resolvable → nothing registered, no alert', async () => {
    AppointmentReminders.resolveCommittedVisitTime.mockResolvedValue(null);
    await registerSpawnedVisitReminder({ scheduledServiceId: 903, customerId: 5, source: 'admin_manual' });
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
    expect(AppointmentReminders.alertRegistrationFailure).not.toHaveBeenCalled();
  });
});
