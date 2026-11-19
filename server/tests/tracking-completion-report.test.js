jest.mock('../services/portal-service-history', () => ({
  listPortalServiceHistory: jest.fn(),
}));
jest.mock('../services/contact-session-projection', () => {
  const actual = jest.requireActual('../services/contact-session-projection');
  return { ...actual, contactSessionReportsWithheld: jest.fn(async () => false) };
});

const { listPortalServiceHistory } = require('../services/portal-service-history');
const { contactSessionReportsWithheld } = require('../services/contact-session-projection');
const trackingRouter = require('../routes/tracking');

const attach = trackingRouter._test.attachCompletionSummary;
const sentence = trackingRouter._test.completionSummarySentence;
const service = { id: 'visit-1' };
const completed = { state: 'complete', currentStep: 7, serviceSummary: null };

beforeEach(() => jest.clearAllMocks());

test('the Home excerpt is one bounded sentence from the reviewed report text', () => {
  expect(sentence('Treated the exterior entry points. Full findings follow in the report.')).toBe('Treated the exterior entry points.');
  expect(sentence('First approved line\nSecond approved line')).toBe('First approved line');
  expect(sentence(null)).toBeNull();
});

test('attaches the reviewed summary and report belonging to the exact completed stop', async () => {
  listPortalServiceHistory.mockResolvedValue({
    services: [{
      id: 'record-1', notes: 'Reviewed customer closeout.', reportUrl: '/report/report-1',
      reportPdfUrl: '/api/reports/report-1', reportAvailable: true, isProjectCompletion: false,
    }],
    total: 1,
  });

  const scope = { enabled: true, scoped: true, property: { id: 'primary', is_primary: true } };
  const tracker = await attach({ customerId: 'customer-1' }, { ...completed }, service, scope);

  expect(listPortalServiceHistory).toHaveBeenCalledWith('customer-1', {
    limit: 1,
    completedOnly: true,
    scheduledServiceId: 'visit-1',
    scope,
  });
  expect(tracker.serviceSummary).toEqual({
    customerSummary: 'Reviewed customer closeout.',
    reportUrl: '/report/report-1',
    reportPdfUrl: '/api/reports/report-1',
    reportPending: false,
    reportWithheld: false,
  });
  expect(JSON.stringify(tracker)).not.toMatch(/technician_notes/i);
});

test('uses the authenticated exact-record report when a public report token is not ready', async () => {
  listPortalServiceHistory.mockResolvedValue({
    services: [{ id: 'record-2', notes: null, reportUrl: null, reportPdfUrl: null, reportAvailable: true, isProjectCompletion: false }],
    total: 1,
  });

  const tracker = await attach({ customerId: 'customer-1' }, { ...completed }, service);
  expect(tracker.serviceSummary).toEqual({
    customerSummary: null,
    reportUrl: null,
    reportPdfUrl: '/api/documents/service-report/record-2',
    reportPending: false,
    reportWithheld: false,
  });
});

test('keeps the completed tracker refreshable until its exact service record exists', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: [], total: 0 });
  const tracker = await attach({ customerId: 'customer-1' }, { ...completed }, service);
  expect(tracker.serviceSummary).toEqual({ reportPending: true, reportWithheld: false });
});

test('withholds immediately when the contact-session rule denies, even before the record exists', async () => {
  contactSessionReportsWithheld.mockResolvedValueOnce(true);
  const tracker = await attach({ customerId: 'customer-1', contactSession: { phoneKey: 'x' } }, { ...completed }, service);
  expect(tracker.serviceSummary).toEqual({
    customerSummary: null,
    reportUrl: null,
    reportPdfUrl: null,
    reportPending: false,
    reportWithheld: true,
  });
  expect(listPortalServiceHistory).not.toHaveBeenCalled();
});

test('fails closed without loading the report when contact permission lookup fails', async () => {
  contactSessionReportsWithheld.mockRejectedValueOnce(new Error('account lookup unavailable'));
  const tracker = await attach({ customerId: 'customer-1', contactSession: { phoneKey: 'x' } }, { ...completed }, service);
  expect(tracker.serviceSummary).toEqual({
    customerSummary: null,
    reportUrl: null,
    reportPdfUrl: null,
    reportPending: false,
    reportWithheld: true,
  });
  expect(listPortalServiceHistory).not.toHaveBeenCalled();
});

test('an allowed contact stays pending when its exact completion record lookup fails', async () => {
  contactSessionReportsWithheld.mockResolvedValueOnce(false);
  listPortalServiceHistory.mockRejectedValueOnce(new Error('history unavailable'));
  const tracker = await attach({ customerId: 'customer-1', contactSession: { phoneKey: 'x' } }, { ...completed }, service);
  expect(tracker.serviceSummary).toEqual({ reportPending: true, reportWithheld: false });
  expect(contactSessionReportsWithheld.mock.invocationCallOrder[0])
    .toBeLessThan(listPortalServiceHistory.mock.invocationCallOrder[0]);
});

test('does not look up reports for cancelled, missed or active visits', async () => {
  for (const tracker of [
    { state: 'cancelled', currentStep: 7 },
    { state: 'no_show', currentStep: 7 },
    { state: 'on_property', currentStep: 4 },
  ]) await attach({ customerId: 'customer-1' }, tracker, service);
  expect(listPortalServiceHistory).not.toHaveBeenCalled();
});

test('withholds an excerpt when the qualifier falls outside the displayed sentence', () => {
  const reviewed = 'Treatment is safe once dry. Your technician confirmed timing.';
  expect(require('../services/service-report/technician-report-copy').customerCopyViolations(reviewed)).toEqual([]);
  expect(sentence(reviewed)).toBeNull();
});

test('screens the full source even when a project’s opening sentence can be shown alone', () => {
  expect(sentence('Your project is complete. The treatment is completely safe.')).toBeNull();
});
