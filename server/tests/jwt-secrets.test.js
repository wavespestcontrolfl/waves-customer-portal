// JWT_SECRET_PREVIOUS: the shared verify-side rotation helper.
const jwt = require('jsonwebtoken');
const {
  jwtVerifySecrets, jwtVerifySecretsOr, verifySecretsFor, staffVerifySecrets, verifyStaffJwt, verifyCustomerJwt, verifyJwtWithKeys,
} = require('../utils/jwt-secrets');

const CURRENT = 'current-secret-aaaaaaaaaaaaaaaa';
const OLD1 = 'retired-secret-one-bbbbbbbbbb';
const OLD2 = 'retired-secret-two-cccccccccc';

const saved = {
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_SECRET_PREVIOUS: process.env.JWT_SECRET_PREVIOUS,
  JWT_SECRET_ROTATED_AT: process.env.JWT_SECRET_ROTATED_AT,
  REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY,
};
const NOW_S = () => Math.floor(Date.now() / 1000);
// The rotation happened one minute ago; "old" tokens were minted 90 seconds ago.
const CUTOFF_MS = () => Date.now() - 60 * 1000;
beforeEach(() => {
  process.env.JWT_SECRET = CURRENT;
  delete process.env.JWT_SECRET_PREVIOUS;
  delete process.env.REFRESH_TOKEN_EXPIRY;
  process.env.JWT_SECRET_ROTATED_AT = new Date(CUTOFF_MS()).toISOString();
});
// A token minted before the rotation, with a normal 10 minute lifetime.
const oldToken = (payload, secret, expiresIn = '10m', iat = NOW_S() - 90) => jwt.sign({ ...payload, iat }, secret, { expiresIn });
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('jwtVerifySecrets', () => {
  it('is only the current secret when JWT_SECRET_PREVIOUS is unset or empty', () => {
    expect(jwtVerifySecrets()).toEqual([CURRENT]);
    process.env.JWT_SECRET_PREVIOUS = '';
    expect(jwtVerifySecrets()).toEqual([CURRENT]);
    process.env.JWT_SECRET_PREVIOUS = ' , ,';
    expect(jwtVerifySecrets()).toEqual([CURRENT]);
  });

  it('lists current first, then each previous secret in order', () => {
    process.env.JWT_SECRET_PREVIOUS = `${OLD1}, ${OLD2}`;
    expect(jwtVerifySecrets()).toEqual([CURRENT, OLD1, OLD2]);
  });

  it('drops empty entries, duplicates and an entry equal to the current secret', () => {
    process.env.JWT_SECRET_PREVIOUS = `,${OLD1},,${CURRENT},${OLD1}, `;
    expect(jwtVerifySecrets()).toEqual([CURRENT, OLD1]);
  });

  it('takes an explicit current secret and fails closed without one', () => {
    process.env.JWT_SECRET_PREVIOUS = OLD1;
    expect(jwtVerifySecrets('explicit')).toEqual(['explicit', OLD1]);
    expect(jwtVerifySecrets('')).toEqual([]);
    delete process.env.JWT_SECRET;
    expect(jwtVerifySecrets()).toEqual([]);
  });
});

describe('dedicated-secret fallbacks', () => {
  beforeEach(() => { process.env.JWT_SECRET_PREVIOUS = OLD1; });

  it('verifySecretsFor keeps a dedicated secret alone and rotates only the JWT fallback', () => {
    expect(verifySecretsFor('dedicated')).toEqual(['dedicated']);
    expect(verifySecretsFor('')).toEqual([CURRENT, OLD1]);
    expect(verifySecretsFor(undefined)).toEqual([CURRENT, OLD1]);
  });

  it('jwtVerifySecretsOr uses the dev fallback only while JWT_SECRET is unset', () => {
    expect(jwtVerifySecretsOr('dev')).toEqual([CURRENT, OLD1]);
    delete process.env.JWT_SECRET;
    expect(jwtVerifySecretsOr('dev')).toEqual(['dev']);
  });
});

describe('staff sessions never rotate through the previous list', () => {
  beforeEach(() => { process.env.JWT_SECRET_PREVIOUS = OLD1; });

  it('staffVerifySecrets is only the current secret, even when previous is listed', () => {
    expect(staffVerifySecrets(CURRENT)).toEqual([CURRENT]);
    expect(staffVerifySecrets('')).toEqual([]);
    expect(staffVerifySecrets(undefined)).toEqual([]);
  });

  it('verifyStaffJwt rejects a retired-secret token even when it is listed, and matches jwt.verify', () => {
    const forged = oldToken({ technicianId: 7, type: 'access', tokenVersion: 1, mfa: true }, OLD1);
    expect(() => verifyStaffJwt(forged, CURRENT)).toThrow('invalid signature');
    const good = jwt.sign({ technicianId: 7 }, CURRENT, { expiresIn: '1h' });
    expect(verifyStaffJwt(good, CURRENT)).toEqual(jwt.verify(good, CURRENT));
    expect(() => verifyStaffJwt(good, CURRENT, { algorithms: ['HS512'] })).toThrow('invalid algorithm');
  });

  it('verifyCustomerJwt refuses a retired-secret token carrying a staff claim', () => {
    for (const claims of [{ technicianId: 7 }, { customerId: 'c1', technicianId: 7 }, { customerId: 'c1', mfa: true }, { customerId: 'c1', scope: 'terminal' }, { kind: 'admin_marker' }, { customerId: 'c1', tokenVersion: 1 }]) {
      const forged = oldToken(claims, OLD1);
      expect(() => verifyCustomerJwt(forged, CURRENT)).toThrow('invalid signature');
    }
    const customer = oldToken({ customerId: 'c1' }, OLD1);
    expect(verifyCustomerJwt(customer, CURRENT).customerId).toBe('c1');
    const currentStaff = jwt.sign({ technicianId: 7 }, CURRENT, { expiresIn: '1h' });
    expect(verifyCustomerJwt(currentStaff, CURRENT).technicianId).toBe(7);
  });
});

describe('verifyCustomerJwt', () => {
  it('unset previous: identical to jwt.verify (same result, same errors)', () => {
    const good = jwt.sign({ a: 1 }, CURRENT, { expiresIn: '1h' });
    expect(verifyCustomerJwt(good, CURRENT)).toEqual(jwt.verify(good, CURRENT));
    const bad = jwt.sign({ a: 1 }, OLD1);
    let expected; let actual;
    try { jwt.verify(bad, CURRENT); } catch (e) { expected = e; }
    try { verifyCustomerJwt(bad, CURRENT); } catch (e) { actual = e; }
    expect(actual.name).toBe(expected.name);
    expect(actual.message).toBe(expected.message);
  });

  it('unset previous: passes options through and ignores the old secret', () => {
    const t = jwt.sign({ a: 1 }, CURRENT, { algorithm: 'HS256' });
    expect(() => verifyCustomerJwt(t, CURRENT, { algorithms: ['HS512'] })).toThrow('invalid algorithm');
    expect(verifyCustomerJwt(t, CURRENT, { algorithms: ['HS256'] }).a).toBe(1);
  });

  it('accepts a token signed with a listed previous secret, only when listed', () => {
    const old = oldToken({ a: 2 }, OLD2);
    expect(() => verifyCustomerJwt(old, CURRENT)).toThrow('invalid signature');
    process.env.JWT_SECRET_PREVIOUS = `${OLD1},${OLD2}`;
    expect(verifyCustomerJwt(old, CURRENT).a).toBe(2);
    process.env.JWT_SECRET_PREVIOUS = OLD1;
    expect(() => verifyCustomerJwt(old, CURRENT)).toThrow('invalid signature');
  });

  it('keeps the verifier own checks: an expired previous-signed token reports expiry', () => {
    process.env.JWT_SECRET_PREVIOUS = OLD1;
    const expired = jwt.sign({ a: 1 }, OLD1, { expiresIn: -10 });
    expect(() => verifyCustomerJwt(expired, CURRENT)).toThrow('jwt expired');
    const wrongAlg = jwt.sign({ a: 1 }, OLD1, { algorithm: 'HS384' });
    expect(() => verifyCustomerJwt(wrongAlg, CURRENT, { algorithms: ['HS256'] })).toThrow('invalid algorithm');
  });

  it('a token no listed secret signed fails with the current-secret error', () => {
    process.env.JWT_SECRET_PREVIOUS = OLD1;
    const stranger = jwt.sign({ a: 1 }, 'stranger-secret');
    expect(() => verifyCustomerJwt(stranger, CURRENT)).toThrow('invalid signature');
    expect(() => verifyCustomerJwt('not-a-jwt', CURRENT)).toThrow('jwt malformed');
  });

  it('previous secrets never authenticate when there is no current secret', () => {
    process.env.JWT_SECRET_PREVIOUS = OLD1;
    const old = jwt.sign({ a: 1 }, OLD1);
    expect(() => verifyCustomerJwt(old, undefined)).toThrow('secret or public key must be provided');
    expect(() => verifyCustomerJwt(old, '')).toThrow();
  });

  it('verifyJwtWithKeys tries a caller-built list in order', () => {
    const old = oldToken({ a: 3 }, OLD1);
    expect(verifyJwtWithKeys(old, ['dedicated', OLD1], undefined, 600).a).toBe(3);
    expect(() => verifyJwtWithKeys(old, ['dedicated'])).toThrow('invalid signature');
  });
});

describe('JWT_SECRET_ROTATED_AT cutoff', () => {
  beforeEach(() => { process.env.JWT_SECRET_PREVIOUS = OLD1; });

  it('previous secrets are ignored unless JWT_SECRET_ROTATED_AT is set, valid and not in the future', () => {
    for (const bad of [undefined, '', 'not-a-date', new Date(Date.now() + 3600 * 1000).toISOString()]) {
      if (bad === undefined) delete process.env.JWT_SECRET_ROTATED_AT; else process.env.JWT_SECRET_ROTATED_AT = bad;
      expect(jwtVerifySecrets()).toEqual([CURRENT]);
      expect(verifySecretsFor('')).toEqual([CURRENT]);
      expect(jwtVerifySecretsOr('dev')).toEqual([CURRENT]);
      expect(() => verifyCustomerJwt(oldToken({ customerId: 'c1' }, OLD1), CURRENT)).toThrow('invalid signature');
    }
    process.env.JWT_SECRET_ROTATED_AT = new Date(CUTOFF_MS()).toISOString();
    expect(jwtVerifySecrets()).toEqual([CURRENT, OLD1]);
  });

  it('accepts a legitimate pre-cutoff customer access and refresh token', () => {
    expect(verifyCustomerJwt(oldToken({ customerId: 'c1' }, OLD1, '15m'), CURRENT).customerId).toBe('c1');
    const refresh = oldToken({ customerId: 'c1', type: 'refresh', jti: 'j', familyId: 'f' }, OLD1, '30d');
    expect(verifyCustomerJwt(refresh, CURRENT).type).toBe('refresh');
  });

  it('refuses a retired-secret token minted after the cutoff', () => {
    const fresh = jwt.sign({ customerId: 'c1' }, OLD1, { expiresIn: '10m' });
    expect(() => verifyCustomerJwt(fresh, CURRENT)).toThrow('invalid signature');
    const afterCutoff = oldToken({ customerId: 'c1' }, OLD1, '10m', Math.floor((CUTOFF_MS() + 5000) / 1000));
    expect(() => verifyCustomerJwt(afterCutoff, CURRENT)).toThrow('invalid signature');
    expect(() => verifyJwtWithKeys(fresh, [CURRENT, OLD1], undefined, 600)).toThrow('invalid signature');
  });

  it('refuses a retired-secret token that outlives its family (exp - iat too long, or missing)', () => {
    expect(() => verifyCustomerJwt(oldToken({ customerId: 'c1' }, OLD1, '2h'), CURRENT)).toThrow('invalid signature');
    expect(() => verifyCustomerJwt(oldToken({ customerId: 'c1', type: 'refresh' }, OLD1, '90d'), CURRENT)).toThrow('invalid signature');
    const noExp = jwt.sign({ customerId: 'c1', iat: NOW_S() - 90 }, OLD1);
    expect(() => verifyCustomerJwt(noExp, CURRENT)).toThrow('invalid signature');
    expect(() => verifyJwtWithKeys(oldToken({ a: 1 }, OLD1, '3h'), [CURRENT, OLD1], undefined, 7200)).toThrow('invalid signature');
    process.env.REFRESH_TOKEN_EXPIRY = '7d';
    expect(() => verifyCustomerJwt(oldToken({ customerId: 'c1', type: 'refresh' }, OLD1, '30d'), CURRENT)).toThrow('invalid signature');
    expect(verifyCustomerJwt(oldToken({ customerId: 'c1', type: 'refresh' }, OLD1, '7d'), CURRENT).type).toBe('refresh');
  });

  it('retiredExpOk bounds an HMAC link expiry by cutoff + family TTL', () => {
    const { retiredExpOk, retiredMintedBefore } = require('../utils/jwt-secrets');
    const cutoffS = Math.floor(CUTOFF_MS() / 1000);
    expect(retiredExpOk(cutoffS + 3600, 3600)).toBe(true);
    expect(retiredExpOk(cutoffS + 3600 + 3600, 3600)).toBe(false);
    expect(retiredMintedBefore(CUTOFF_MS() - 1000)).toBe(true);
    expect(retiredMintedBefore(CUTOFF_MS() + 1000)).toBe(false);
  });

  it('verifiedByRetiredKey tells a current-key token from a retired-key one', () => {
    const { verifiedByRetiredKey } = require('../utils/jwt-secrets');
    expect(verifiedByRetiredKey(jwt.sign({ a: 1 }, CURRENT), CURRENT)).toBe(false);
    expect(verifiedByRetiredKey(oldToken({ a: 1 }, OLD1), CURRENT)).toBe(true);
    delete process.env.JWT_SECRET_PREVIOUS;
    expect(verifiedByRetiredKey(oldToken({ a: 1 }, OLD1), CURRENT)).toBe(false);
  });
});
