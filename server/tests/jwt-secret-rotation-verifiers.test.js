// JWT_SECRET_PREVIOUS across the verifiers: customer + staff auth middleware
// and the link / signature verifiers that fall back to JWT_SECRET.
// For each: a token signed with the retired secret verifies when it is listed,
// fails when it is not, and with the variable unset nothing changes.
process.env.JWT_SECRET = 'rotation-current-secret-0123456789';

jest.mock('../models/db', () => jest.fn());

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../models/db');
const { authenticate, generateToken } = require('../middleware/auth');
const { adminAuthenticate } = require('../middleware/admin-auth');

const CURRENT = 'rotation-current-secret-0123456789';
const OLD = 'rotation-retired-secret-abcdefghij';
const OTHER = 'rotation-unrelated-secret-zzzzzzzz';

const DEDICATED_VARS = [
  'JWT_SECRET_PREVIOUS', 'ESTIMATE_HANDOFF_SECRET', 'LEAD_PREFILL_SECRET', 'CONTRACT_LINK_SECRET',
  'REPORT_PIN_SECRET', 'ESTIMATE_DOC_PIN_SECRET', 'BOOKING_CAPTURE_SECRET',
];
const saved = {};
beforeEach(() => {
  for (const name of DEDICATED_VARS) { saved[name] = process.env[name]; delete process.env[name]; }
  process.env.JWT_SECRET = CURRENT;
  db.mockReset();
});
afterAll(() => {
  for (const name of DEDICATED_VARS) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});

// Run `fn` as if JWT_SECRET were the retired secret (for modules that read the
// env at call time), then restore.
function asRetired(fn, key = 'JWT_SECRET') {
  const before = process.env[key];
  process.env[key] = OLD;
  try { return fn(); } finally {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
}

function res() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('customer auth middleware', () => {
  const customerQuery = () => ({
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ id: 'prop-1', active: true, account_id: 'acct-1' }),
  });
  const oldToken = () => jwt.sign({ customerId: 'prop-1', accountId: 'acct-1' }, OLD, { expiresIn: '15m' });

  it('rejects a token signed with the retired secret when JWT_SECRET_PREVIOUS is unset', async () => {
    const req = { headers: { authorization: `Bearer ${oldToken()}` } };
    const out = res(); const next = jest.fn();
    await authenticate(req, out, next);
    expect(out.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts it when the retired secret is listed, and still accepts current tokens', async () => {
    process.env.JWT_SECRET_PREVIOUS = `junk-entry, ${OLD}`;
    db.mockReturnValue(customerQuery());
    const req = { headers: { authorization: `Bearer ${oldToken()}` } };
    const next = jest.fn();
    await authenticate(req, res(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const current = { headers: { authorization: `Bearer ${generateToken('prop-1', 'acct-1')}` } };
    const next2 = jest.fn();
    await authenticate(current, res(), next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('still rejects a token signed with an unlisted secret and an expired retired token', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD;
    const stranger = jwt.sign({ customerId: 'prop-1', accountId: 'acct-1' }, OTHER, { expiresIn: '15m' });
    const out = res(); const next = jest.fn();
    await authenticate({ headers: { authorization: `Bearer ${stranger}` } }, out, next);
    expect(out.status).toHaveBeenCalledWith(401);

    const expired = jwt.sign({ customerId: 'prop-1', accountId: 'acct-1' }, OLD, { expiresIn: -60 });
    const out2 = res();
    await authenticate({ headers: { authorization: `Bearer ${expired}` } }, out2, next);
    expect(out2.status).toHaveBeenCalledWith(401);
    expect(out2.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('staff auth middleware', () => {
  const tech = { id: 7, active: true, employment_status: 'active', role: 'admin', auth_token_version: 1 };
  const staffToken = (secret, extra = {}) => jwt.sign({ technicianId: 7, type: 'access', tokenVersion: 1, ...extra }, secret, { expiresIn: '1h' });
  const mockTech = () => db.mockImplementation(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => tech) })) }));

  it('rejects a retired-secret token when JWT_SECRET_PREVIOUS is unset', async () => {
    mockTech();
    const out = res(); const next = jest.fn();
    await adminAuthenticate({ headers: { authorization: `Bearer ${staffToken(OLD)}` }, method: 'GET', path: '/x' }, out, next);
    expect(out.status).toHaveBeenCalledWith(401);
    expect(out.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a retired-secret token when listed and keeps the token_version check', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD;
    mockTech();
    const req = { headers: { authorization: `Bearer ${staffToken(OLD)}` }, method: 'GET', path: '/x' };
    const next = jest.fn();
    await adminAuthenticate(req, res(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.technicianId).toBe(7);

    const stale = { headers: { authorization: `Bearer ${staffToken(OLD, { tokenVersion: 2 })}` }, method: 'GET', path: '/x' };
    const out = res(); const next2 = jest.fn();
    await adminAuthenticate(stale, out, next2);
    expect(out.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_REVOKED' }));
    expect(next2).not.toHaveBeenCalled();
  });

  it('keeps its type and scope checks for a retired-secret token', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD;
    mockTech();
    const refresh = jwt.sign({ technicianId: 7, type: 'refresh' }, OLD);
    const out = res(); const next = jest.fn();
    await adminAuthenticate({ headers: { authorization: `Bearer ${refresh}` }, method: 'GET', path: '/x' }, out, next);
    expect(out.json).toHaveBeenCalledWith({ error: 'Invalid token type' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('estimate handoff token (14 days, 1 year for accept links)', () => {
  const T = require('../utils/estimate-handoff-token');
  it('verifies a retired-secret token only while the secret is listed', () => {
    const token = asRetired(() => T.mintEstimateHandoffToken('est-1'));
    const accept = asRetired(() => T.mintEstimateAcceptToken('est-1'));
    expect(T.verifyEstimateHandoffToken('est-1', token)).toBe(false);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(T.verifyEstimateHandoffToken('est-1', token)).toBe(true);
    expect(T.verifyEstimateHandoffToken('est-2', token)).toBe(false);
    expect(T.verifyEstimateHandoffToken('estimate-accept:est-1', accept)).toBe(true);
    process.env.JWT_SECRET_PREVIOUS = OTHER;
    expect(T.verifyEstimateHandoffToken('est-1', token)).toBe(false);
  });

  it('unset: current tokens verify, and signing uses the current secret', () => {
    const token = T.mintEstimateHandoffToken('est-1');
    expect(T.verifyEstimateHandoffToken('est-1', token)).toBe(true);
    const [exp, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', CURRENT).update(`estimate-handoff:est-1:${exp}`).digest('base64url');
    expect(sig).toBe(expected);
  });

  it('a dedicated secret ignores JWT_SECRET_PREVIOUS', () => {
    process.env.ESTIMATE_HANDOFF_SECRET = 'dedicated-handoff-secret';
    process.env.JWT_SECRET_PREVIOUS = OLD;
    const viaOld = asRetired(() => T.mintEstimateHandoffToken('est-1'));
    // asRetired changes JWT_SECRET, but the dedicated secret still signs.
    expect(T.verifyEstimateHandoffToken('est-1', viaOld)).toBe(true);
    const forged = (() => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      return `${exp}.${crypto.createHmac('sha256', OLD).update(`estimate-handoff:est-1:${exp}`).digest('base64url')}`;
    })();
    expect(T.verifyEstimateHandoffToken('est-1', forged)).toBe(false);
  });
});

describe('lead prefill / consultation / waitlist tokens', () => {
  const P = require('../utils/lead-prefill-token');
  const C = require('../utils/lead-consultation-token');

  it('prefill token', () => {
    const token = asRetired(() => P.mintLeadPrefillToken('lead-1'));
    expect(P.verifyLeadPrefillToken('lead-1', token)).toBe(false);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(P.verifyLeadPrefillToken('lead-1', token)).toBe(true);
    expect(P.verifyLeadPrefillToken('lead-2', token)).toBe(false);
  });

  it('consultation token, its phone-bound SMS claim and the waitlist ticket', () => {
    const channel = asRetired(() => C.smsChannelFor('+19415550123'));
    const token = asRetired(() => C.mintLeadConsultationToken('lead-1', undefined, channel));
    const ticket = asRetired(() => C.mintWaitlistTicket('lead-1', 'Sarasota'));
    expect(C.verifyLeadConsultationToken(token)).toBeNull();
    expect(C.verifyWaitlistTicket(ticket, 'lead-1')).toBeNull();
    expect(C.smsChannelMatches(channel, '+19415550123')).toBe(false);

    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(C.verifyLeadConsultationToken(token)).toEqual({ leadId: 'lead-1', channel });
    expect(C.verifyWaitlistTicket(ticket, 'lead-1')).toEqual({ county: 'Sarasota' });
    expect(C.smsChannelMatches(channel, '+19415550123')).toBe(true);
    expect(C.smsChannelMatches(channel, '+19415550999')).toBe(false);
    expect(C.verifyWaitlistTicket(ticket, 'lead-2')).toBeNull();
  });

  it('unset: current-secret tokens verify and channel equals smsChannelFor', () => {
    const ch = C.smsChannelFor('+19415550123');
    expect(C.smsChannelMatches(ch, '+19415550123')).toBe(true);
    expect(C.verifyLeadConsultationToken(C.mintLeadConsultationToken('lead-1'))).toEqual({ leadId: 'lead-1' });
  });
});

describe('composer contract token', () => {
  const K = require('../utils/composer-contract-token');
  it('verifies a retired-secret token only while the secret is listed', () => {
    const token = asRetired(() => K.mintComposerContractToken('contract-1'));
    expect(K.verifyComposerContractToken('contract-1', token)).toBe(false);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(K.verifyComposerContractToken('contract-1', token)).toBe(true);
    expect(K.verifyComposerContractToken('contract-2', token)).toBe(false);
  });
});

describe('signed map image token', () => {
  const M = require('../services/signed-map-image');
  const params = { lat: 27.3364, lng: -82.5307, zoom: 19, width: 600, height: 400 };
  it('verifies a retired-secret token only while the secret is listed', () => {
    const token = asRetired(() => M.signMapImageToken(params));
    expect(token).toBeTruthy();
    expect(M.verifyMapImageToken(token)).toBeNull();
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(M.verifyMapImageToken(token)).toMatchObject({ zoom: 19, width: 600 });
    process.env.JWT_SECRET_PREVIOUS = OTHER;
    expect(M.verifyMapImageToken(token)).toBeNull();
  });

  it('REPORT_PIN_SECRET wins: JWT_SECRET_PREVIOUS does not apply', () => {
    process.env.REPORT_PIN_SECRET = 'dedicated-pin-secret';
    process.env.JWT_SECRET_PREVIOUS = OLD;
    const forged = asRetired(() => {
      delete process.env.REPORT_PIN_SECRET;
      const t = M.signMapImageToken(params);
      process.env.REPORT_PIN_SECRET = 'dedicated-pin-secret';
      return t;
    });
    expect(M.verifyMapImageToken(forged)).toBeNull();
    expect(M.verifyMapImageToken(M.signMapImageToken(params))).not.toBeNull();
  });
});

describe('report assessment pin', () => {
  const A = require('../services/service-report/assessment-pin');
  it('verifies a retired-secret pin only while the secret is listed', () => {
    const pin = asRetired(() => A.signAssessmentPin('report-token', 'assess-1'));
    const check = () => A.verifyAssessmentPin('report-token', 'assess-1', pin.signature, pin.expiresAt);
    expect(check()).toBe(false);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(check()).toBe(true);
    expect(A.verifyAssessmentPin('report-token', 'assess-2', pin.signature, pin.expiresAt)).toBe(false);
  });
});

describe('slot offer token (secret read at load)', () => {
  const load = (jwtSecret) => {
    let mod;
    const before = process.env.JWT_SECRET;
    process.env.JWT_SECRET = jwtSecret;
    jest.isolateModules(() => { mod = require('../utils/slot-offer-token'); });
    process.env.JWT_SECRET = before;
    return mod;
  };
  const payload = {
    surface: 'booking', scopeId: 's1', serviceKey: 'pest', locationKey: 'loc', date: '2026-11-02',
    startMinutes: 540, technicianId: 4, durationMinutes: 60,
  };

  it('verifies an offer signed under the retired secret only while it is listed', () => {
    const retired = load(OLD);
    const current = load(CURRENT);
    const { exp, sig } = retired.signSlotOffer(payload);
    expect(current.verifySlotOffer({ ...payload, exp }, sig)).toBe(false);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(current.verifySlotOffer({ ...payload, exp }, sig)).toBe(true);
    expect(current.verifySlotOffer({ ...payload, startMinutes: 600, exp }, sig)).toBe(false);
    const fresh = current.signSlotOffer(payload);
    expect(current.verifySlotOffer({ ...payload, exp: fresh.exp }, fresh.sig)).toBe(true);
  });
});

describe('booking capture token (secret read at load, IP key is secret-keyed)', () => {
  const load = (jwtSecret) => {
    let mod;
    const before = process.env.JWT_SECRET;
    process.env.JWT_SECRET = jwtSecret;
    jest.isolateModules(() => { mod = require('../routes/booking')._internals; });
    process.env.JWT_SECRET = before;
    return mod;
  };
  const req = { ip: '203.0.113.9', headers: {} };

  it('verifies a token minted under the retired secret only while it is listed', () => {
    const retired = load(OLD);
    const current = load(CURRENT);
    const token = retired.mintCaptureToken(retired.captureIpKey(req));
    const now = Date.now();
    expect(current.verifyCaptureToken(token, current.captureIpKey(req), now, req)).toBe(false);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(current.verifyCaptureToken(token, current.captureIpKey(req), now, req)).toBe(true);
    // Still bound to the minting IP.
    const other = { ip: '198.51.100.1', headers: {} };
    expect(current.verifyCaptureToken(token, current.captureIpKey(other), now, other)).toBe(false);
  });

  it('unset: a current token verifies', () => {
    const current = load(CURRENT);
    const token = current.mintCaptureToken(current.captureIpKey(req));
    expect(current.verifyCaptureToken(token, current.captureIpKey(req), Date.now(), req)).toBe(true);
  });
});

describe('estimate document render pin (JWT with a dedicated-secret option)', () => {
  const D = require('../services/pdf/estimate-doc-pdf');
  const pin = (secret) => jwt.sign({ kind: 'estimate_doc_render', tokenHash: crypto.createHash('sha256').update('tok').digest('hex') }, secret, { expiresIn: 600 });

  it('accepts a retired-secret pin only while listed', () => {
    expect(D.verifyEstimateDocPin(pin(OLD), 'tok')).toBeNull();
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(D.verifyEstimateDocPin(pin(OLD), 'tok')).toEqual({ validThrough: null });
    expect(D.verifyEstimateDocPin(pin(OLD), 'other-tok')).toBeNull();
  });

  it('ESTIMATE_DOC_PIN_SECRET wins: JWT_SECRET_PREVIOUS does not apply', () => {
    process.env.ESTIMATE_DOC_PIN_SECRET = 'dedicated-doc-pin';
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(D.verifyEstimateDocPin(pin(OLD), 'tok')).toBeNull();
    expect(D.verifyEstimateDocPin(pin('dedicated-doc-pin'), 'tok')).toEqual({ validThrough: null });
    delete process.env.ESTIMATE_DOC_PIN_SECRET;
  });
});

describe('outlink click context signature', () => {
  const O = require('../services/outlink-tracking');
  const code = 'abc123def456';
  const uuid = '11111111-1111-4111-8111-111111111111';
  it('verifies a context signed under the retired secret only while listed', () => {
    const sign = (secret) => {
      const key = crypto.createHmac('sha256', secret).update('outlink-context-v1').digest();
      return crypto.createHmac('sha256', key).update([code, '', uuid, '', '', 'sms'].join('|')).digest('hex').slice(0, 24);
    };
    const query = { c: uuid, s: 'sms', g: sign(OLD) };
    expect(O.verifyContext({ ...query, g: sign(CURRENT) }, code)).toMatchObject({ customerId: uuid });
    expect(O.verifyContext(query, code)).toBeNull();
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(O.verifyContext(query, code)).toMatchObject({ customerId: uuid });
    expect(O.verifyContext(query, 'zzz999zzz999')).toBeNull();
  });
});

describe('pricing snapshot keyring', () => {
  const U = require('../services/pricing-engine/unit-band-pricing');
  it('fallback to JWT_SECRET also rotates; a dedicated secret ignores JWT_SECRET_PREVIOUS', () => {
    expect(typeof U.signUnitBandSnapshot).toBe('function');
    const band = {
      serviceCode: 'pest', frequency: 'quarterly', band: '1', initialPrice: 100, recurringPrice: 50,
      includedScope: 'x', oversizeSqftThreshold: 5000, effectiveDate: '2026-01-01',
    };
    const signed = asRetired(() => U.signUnitBandSnapshot(band, '1 Main St'));
    const row = { ...band, ...signed };
    expect(U.verifyUnitBandSnapshot(row, '1 Main St')).toBe(false);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(U.verifyUnitBandSnapshot(row, '1 Main St')).toBe(true);
    process.env.PRICING_SNAPSHOT_SECRET = 'dedicated-pricing';
    try {
      expect(U.verifyUnitBandSnapshot(row, '1 Main St')).toBe(false);
    } finally { delete process.env.PRICING_SNAPSHOT_SECRET; }
  });
});

describe('SMS attachment tokens', () => {
  const S = require('../services/sms-media');
  it('verifies a token minted under the retired secret only while listed', () => {
    const attachment = { key: 'sms-attachments/a.png', size: 12, mimeType: 'image/png' };
    const attachmentToken = S.createAttachmentToken(attachment, OLD);
    const full = { ...attachment, attachmentToken };
    const keyOf = (a) => S.mediaFromOutboundAttachments([a])[0].key;
    expect(keyOf(full)).toBeNull();
    process.env.JWT_SECRET_PREVIOUS = OLD;
    expect(keyOf(full)).toBe('sms-attachments/a.png');
    expect(keyOf({ ...full, size: 13 })).toBeNull();
  });
});

describe('service-contact phone fingerprint', () => {
  const E = require('../services/service-contact-events');
  it('lists the current fingerprint first, then one per retired secret', () => {
    const current = E.phoneFingerprint('9415550123');
    expect(E.phoneFingerprintCandidates('9415550123')).toEqual([current]);
    process.env.JWT_SECRET_PREVIOUS = OLD;
    const old = E.phoneFingerprint('9415550123', OLD);
    expect(E.phoneFingerprintCandidates('9415550123')).toEqual([current, old]);
    expect(old).not.toBe(current);
  });
});
