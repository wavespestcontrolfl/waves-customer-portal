jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(),
  syncVoiceMessageForCall: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const voiceRouter = require('../routes/twilio-voice-webhook');

describe('twilio voice inbound forward acceptance', () => {
  const {
    metadataHasForwardAcceptance,
    rememberForwardAccept,
    resolveInboundDialCompletion,
    wasForwardAccepted,
  } = voiceRouter._test;

  beforeEach(() => {
    db.mockReset();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  test('treats completed staff leg without press-1 acceptance as Waves voicemail', () => {
    expect(resolveInboundDialCompletion({
      status: 'completed',
      duration: 13,
      forwardAccepted: false,
    })).toEqual({
      shouldRecordVoicemail: true,
      answeredBy: 'voicemail',
    });
  });

  test('treats completed staff leg with press-1 acceptance as human', () => {
    expect(resolveInboundDialCompletion({
      status: 'completed',
      duration: 45,
      forwardAccepted: true,
    })).toEqual({
      shouldRecordVoicemail: false,
      answeredBy: 'human',
    });
  });

  test('still sends no-answer, busy, and failed dials to Waves voicemail', () => {
    for (const status of ['no-answer', 'busy', 'failed']) {
      expect(resolveInboundDialCompletion({
        status,
        duration: 0,
        forwardAccepted: false,
      })).toEqual({
        shouldRecordVoicemail: true,
        answeredBy: 'voicemail',
      });
    }
  });

  test('recognizes persisted forward acceptance metadata', () => {
    const metadata = {
      forward_acceptance: {
        accepted: true,
        parent_call_sid: 'CA_parent',
        dial_call_sid: 'CA_child',
        accepted_at: '2026-05-25T07:00:00.000Z',
      },
    };

    expect(metadataHasForwardAcceptance(metadata, {
      parentCallSid: 'CA_parent',
      dialCallSid: 'CA_child',
    })).toBe(true);
    expect(metadataHasForwardAcceptance(JSON.stringify(metadata), {
      parentCallSid: 'CA_parent',
      dialCallSid: 'CA_child',
    })).toBe(true);
    expect(metadataHasForwardAcceptance(metadata, {
      parentCallSid: 'CA_other',
      dialCallSid: 'CA_other_child',
    })).toBe(false);
  });

  test('persists forward acceptance on the parent call_log row', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const where = jest.fn(() => ({ update }));
    db.mockReturnValue({ where });

    await expect(rememberForwardAccept({
      parentCallSid: 'CA_parent',
      dialCallSid: 'CA_child',
    })).resolves.toBe(1);

    expect(db).toHaveBeenCalledWith('call_log');
    expect(where).toHaveBeenCalledWith('twilio_call_sid', 'CA_parent');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        sql: expect.stringContaining('jsonb_set'),
        bindings: [expect.stringContaining('"dial_call_sid":"CA_child"')],
      }),
      updated_at: expect.any(Date),
    }));
  });

  test('loads forward acceptance from shared call_log metadata', async () => {
    const first = jest.fn().mockResolvedValue({
      metadata: {
        forward_acceptance: {
          accepted: true,
          parent_call_sid: 'CA_parent',
          dial_call_sid: 'CA_child',
        },
      },
    });
    const select = jest.fn(() => ({ first }));
    const where = jest.fn(() => ({ select }));
    db.mockReturnValue({ where });

    await expect(wasForwardAccepted({
      parentCallSid: 'CA_parent',
      dialCallSid: 'CA_child',
    })).resolves.toBe(true);

    expect(where).toHaveBeenCalledWith('twilio_call_sid', 'CA_parent');
  });
});
