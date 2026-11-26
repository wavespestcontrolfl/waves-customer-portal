const mockValidateSelection = jest.fn(async () => ({ valid: true, errors: [], flagship: true }));

jest.mock('../models/db', () => jest.fn());
// isFlagshipSend: the flagship type, or a NULL-type send the flagship calendar links (every
// NULL-type fixture here is a linked one).
const mockIsFlagshipSend = jest.fn(async (send) => send?.newsletter_type === 'local-weekly-fresh-events' || send?.newsletter_type === null);
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: mockValidateSelection,
  isFlagshipSend: mockIsFlagshipSend,
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn() }));

const db = require('../models/db');
const { sendCampaign } = require('../services/newsletter-sender');
const { addressKey } = require('../services/newsletter-warm-audience');

const FLAGSHIP = {
  id: 'send-legacy',
  status: 'draft',
  newsletter_type: 'local-weekly-fresh-events',
  audience_phase: 'all', // the first-readers step has widened (newsletter-weekly-audience.js)
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
    jest.useFakeTimers().setSystemTime(new Date('2026-07-23T10:00:00Z')); // Thu 6 AM EDT
    fetchOnly();
    mockValidateSelection.mockResolvedValueOnce({ valid: false, errors: ['Locked event is no longer eligible: Weekly Yoga.'], flagship: true });

    await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({
      code: 'EVENT_SELECTION_INVALID',
    });
    expect(db).toHaveBeenCalledTimes(1); // fetch only; no draft/scheduled → sending claim
  });

  test('calendar-classified legacy NULL type cannot bypass the same gate', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-23T10:00:00Z'));
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

  test('otherwise-valid flagship refuses production delivery outside Thursday 6 AM ET', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-23T11:00:00Z')); // Thu 7 AM EDT
    fetchOnly();
    mockValidateSelection.mockResolvedValueOnce({ valid: true, errors: [], flagship: true });

    await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({
      code: 'FLAGSHIP_CADENCE_WINDOW',
    });
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('an overdue scheduled row cannot ride a later Thursday delivery window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-23T10:05:00Z')); // current Thu window
    fetchOnly({ ...FLAGSHIP, status: 'scheduled', scheduled_for: '2026-07-16T10:00:00Z' });
    mockValidateSelection.mockResolvedValueOnce({ valid: true, errors: [], flagship: true });

    await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({
      code: 'FLAGSHIP_SCHEDULE_TARGET',
    });
    expect(db).toHaveBeenCalledTimes(1);
  });
  describe('first-readers step: the audience phase is required (owner 2026-11-26)', () => {
    const KEYS = { 1: addressKey('a@example.com'), 2: addressKey('b@example.com') };
    const WARM_PLAN = { subscriber_ids: [1, 2], holdout: 'weekly-warm', address_keys: KEYS };

    test.each([
      ['a weekly draft with no phase (older than the step) would mail the whole list', { audience_phase: null }, 'UNPLANNED_AUDIENCE'],
      ['a first-readers issue with no reader list', { audience_phase: 'warm', segment_filter: null }, 'UNPLANNED_AUDIENCE'],
      ['a first-readers issue carrying another issue type\'s plan', { audience_phase: 'warm', segment_filter: { ...WARM_PLAN, holdout: 'pest-insider' } }, 'UNPLANNED_AUDIENCE'],
      ['an everyone issue that still carries a reader list', { audience_phase: 'all', segment_filter: WARM_PLAN }, 'UNPLANNED_AUDIENCE'],
      ['a first-readers issue whose list has no address keys', { audience_phase: 'warm', segment_filter: { subscriber_ids: [1, 2], holdout: 'weekly-warm' } }, 'INCOMPLETE_PLAN'],
      ['a first-readers issue with an empty list', { audience_phase: 'warm', segment_filter: { ...WARM_PLAN, subscriber_ids: [] } }, 'INCOMPLETE_PLAN'],
    ])('%s is refused before any claim', async (_label, fields, code) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-23T10:00:00Z'));
      fetchOnly({ ...FLAGSHIP, ...fields });
      await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({ code, audienceRefusal: true });
      expect(db).toHaveBeenCalledTimes(1);
    });

    test('a calendar-linked send with no type needs its audience phase too (it cannot reach the whole list)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-23T10:00:00Z'));
      fetchOnly({ ...FLAGSHIP, newsletter_type: null, audience_phase: null });
      await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({ code: 'UNPLANNED_AUDIENCE', audienceRefusal: true });
      // a linked NULL-type send with a warm phase but no list is refused as well
      fetchOnly({ ...FLAGSHIP, newsletter_type: null, audience_phase: 'warm', segment_filter: null });
      await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({ code: 'UNPLANNED_AUDIENCE' });
    });

    test.each([
      ['a first-readers issue with its list', { audience_phase: 'warm', segment_filter: WARM_PLAN }],
      ['an everyone issue', { audience_phase: 'all', segment_filter: null }],
    ])('%s passes the audience check and reaches the lineup gate', async (_label, fields) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-23T10:00:00Z'));
      fetchOnly({ ...FLAGSHIP, ...fields });
      mockValidateSelection.mockResolvedValueOnce({ valid: false, errors: ['lineup'], flagship: true });
      await expect(sendCampaign('send-legacy', { force: true })).rejects.toMatchObject({ code: 'EVENT_SELECTION_INVALID' });
    });
  });
});
