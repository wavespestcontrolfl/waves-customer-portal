jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({
  sendTechEnRoute: jest.fn(),
}));
jest.mock('../services/tech-status', () => ({
  setTechJobStatus: jest.fn().mockResolvedValue({}),
  clearTechCurrentJob: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/job-status', () => ({
  transitionJobStatus: jest.fn().mockResolvedValue({}),
}));

const db = require('../models/db');
const { setTechJobStatus } = require('../services/tech-status');
const { transitionJobStatus } = require('../services/job-status');
const trackTransitions = require('../services/track-transitions');

function query(result) {
  return {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(result),
    first: jest.fn().mockResolvedValue(result),
  };
}

describe('track-transitions lifecycle side effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('markEnRoute sets tech_status current job without relying on Bouncie', async () => {
    const svc = {
      id: 'job-1',
      customer_id: 'cust-1',
      technician_id: 'tech-1',
      status: 'confirmed',
      track_state: 'scheduled',
      track_sms_sent_at: new Date(),
      track_view_token: 'a'.repeat(64),
    };
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markEnRoute('job-1');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    expect(setTechJobStatus).toHaveBeenCalledWith({
      tech_id: 'tech-1',
      status: 'en_route',
      current_job_id: 'job-1',
    });
  });

  test('markOnProperty accepts scheduled tracker state and syncs operational status', async () => {
    const svc = {
      id: 'job-2',
      technician_id: 'tech-2',
      status: 'pending',
      track_state: 'scheduled',
      cancelled_at: null,
    };
    const load = query(svc);
    const update = query(1);
    db
      .mockReturnValueOnce(load)
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markOnProperty('job-2');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(transitionJobStatus).toHaveBeenCalledWith({
      jobId: 'job-2',
      fromStatus: 'pending',
      toStatus: 'on_site',
      transitionedBy: null,
    });
    expect(update.whereIn).toHaveBeenCalledWith('track_state', ['scheduled', 'en_route']);
    expect(setTechJobStatus).toHaveBeenCalledWith({
      tech_id: 'tech-2',
      status: 'on_site',
      current_job_id: 'job-2',
    });
  });
});
