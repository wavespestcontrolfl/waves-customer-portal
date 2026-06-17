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
    resolveCsrName,
    resolveInboundDialCompletion,
    wasForwardAccepted,
  } = voiceRouter._test;

  const CSR_ENV_KEYS = [
    'WAVES_CSR_NUMBER_MAP',
    'VIRGINIA_PHONE',
    'ADAM_PHONE',
    'OFFICE_MANAGER_PHONE',
    'WAVES_OFFICE_MANAGER_PHONE',
    'OWNER_PHONE',
  ];
  let savedCsrEnv;

  beforeEach(() => {
    db.mockReset();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    savedCsrEnv = {};
    for (const key of CSR_ENV_KEYS) {
      savedCsrEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CSR_ENV_KEYS) {
      if (savedCsrEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedCsrEnv[key];
    }
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

  test('resolveCsrName maps the explicit WAVES_CSR_NUMBER_MAP override', () => {
    process.env.WAVES_CSR_NUMBER_MAP = '+19415551234:Virginia, +19415995678:Adam';
    expect(resolveCsrName('+19415551234')).toBe('Virginia');
    expect(resolveCsrName('9415995678')).toBe('Adam');
  });

  test('resolveCsrName falls back to named per-person env vars', () => {
    process.env.VIRGINIA_PHONE = '+19415551234';
    process.env.ADAM_PHONE = '+19415995678';
    expect(resolveCsrName('+19415551234')).toBe('Virginia');
    expect(resolveCsrName('+19415995678')).toBe('Adam');
  });

  test('resolveCsrName returns null for unmapped or missing numbers', () => {
    process.env.VIRGINIA_PHONE = '+19415551234';
    expect(resolveCsrName('+19990000000')).toBeNull();
    expect(resolveCsrName('')).toBeNull();
    expect(resolveCsrName(undefined)).toBeNull();
  });

  test('persists the answering number and resolved CSR name', async () => {
    process.env.VIRGINIA_PHONE = '+19415551234';
    const update = jest.fn().mockResolvedValue(1);
    const where = jest.fn(() => ({ update }));
    db.mockReturnValue({ where });

    await rememberForwardAccept({
      parentCallSid: 'CA_parent',
      dialCallSid: 'CA_child',
      answeredByNumber: '+19415551234',
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        bindings: [expect.stringContaining('"csr_name":"Virginia"')],
      }),
    }));
    expect(update.mock.calls[0][0].metadata.bindings[0]).toContain('"answered_by_number":"+19415551234"');
  });

  test('persists null CSR name when the answering number is unmapped', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const where = jest.fn(() => ({ update }));
    db.mockReturnValue({ where });

    await rememberForwardAccept({
      parentCallSid: 'CA_parent',
      dialCallSid: 'CA_child',
      answeredByNumber: '+19990000000',
    });

    expect(update.mock.calls[0][0].metadata.bindings[0]).toContain('"csr_name":null');
  });
});
