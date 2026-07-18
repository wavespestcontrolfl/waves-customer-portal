const mockValidateSelection = jest.fn(async () => ({ valid: true, errors: [], flagship: true }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: mockValidateSelection,
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn() }));

const db = require('../models/db');
const { sendCampaign } = require('../services/newsletter-sender');

const FLAGSHIP = {
  id: 'send-legacy',
  status: 'draft',
  newsletter_type: 'local-weekly-fresh-events',
  event_ids: ['11111111-1111-4111-8111-111111111111'],
  html_body: '<p>Weekend events</p>',
  text_body: 'Weekend events',
};

function fetchOnly(send = FLAGSHIP) {
  const chain = {
    where: jest.fn(() => chain),
    first: jest.fn(async () => send),
  };
  db.mockImplementation(() => chain);
}

describe('sendCampaign flagship final gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateSelection.mockResolvedValue({ valid: true, errors: [], flagship: true });
  });
  afterEach(() => jest.useRealTimers());

  test('legacy recurring lineup is rejected before any send-state claim', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T10:00:00Z')); // Tue 6 AM EDT
    fetchOnly();
    mockValidateSelection.mockResolvedValueOnce({ valid: false, errors: ['Locked event is no longer eligible: Weekly Yoga.'], flagship: true });

    await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({
      code: 'EVENT_SELECTION_INVALID',
    });
    expect(db).toHaveBeenCalledTimes(1); // fetch only; no draft/scheduled → sending claim
  });

  test('calendar-classified legacy NULL type cannot bypass the same gate', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T10:00:00Z'));
    fetchOnly({ ...FLAGSHIP, newsletter_type: null });
    mockValidateSelection.mockResolvedValueOnce({
      valid: false,
      errors: ['Locked event is no longer eligible: Sunset Yoga.'],
      flagship: true,
    });

    await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({
      code: 'EVENT_SELECTION_INVALID',
    });
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('otherwise-valid flagship refuses production delivery outside Tuesday 6 AM ET', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T11:00:00Z')); // Tue 7 AM EDT
    fetchOnly();
    mockValidateSelection.mockResolvedValueOnce({ valid: true, errors: [], flagship: true });

    await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({
      code: 'FLAGSHIP_CADENCE_WINDOW',
    });
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('an overdue scheduled row cannot ride a later Tuesday delivery window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T10:05:00Z')); // current Tue window
    fetchOnly({ ...FLAGSHIP, status: 'scheduled', scheduled_for: '2026-07-14T10:00:00Z' });
    mockValidateSelection.mockResolvedValueOnce({ valid: true, errors: [], flagship: true });

    await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({
      code: 'FLAGSHIP_SCHEDULE_TARGET',
    });
    expect(db).toHaveBeenCalledTimes(1);
  });
});
