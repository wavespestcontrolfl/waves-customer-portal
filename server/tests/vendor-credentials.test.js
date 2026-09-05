const { passwordWriteAction, vendorCredentialKey, vendorCredentialKeys } = require('../services/vendor-credentials');

describe('passwordWriteAction', () => {
  test('absent field -> skip (leave stored value untouched)', () => {
    expect(passwordWriteAction(undefined, true)).toBe('skip');
    expect(passwordWriteAction(undefined, false)).toBe('skip');
  });
  test('BLANK -> skip, NOT clear (the form submits "" for an untouched password)', () => {
    // Regression: a blank field must not wipe a saved credential when the operator edits
    // other vendor fields without retyping the password.
    expect(passwordWriteAction('', true)).toBe('skip');
    expect(passwordWriteAction('', false)).toBe('skip');
  });
  test('explicit clearRequested -> clear (set NULL), regardless of the field', () => {
    expect(passwordWriteAction('', true, true)).toBe('clear');
    expect(passwordWriteAction(undefined, false, true)).toBe('clear');
    expect(passwordWriteAction('whatever', true, true)).toBe('clear'); // clear flag wins
  });
  test('explicit null loginPassword -> clear (a deliberate API value the form never sends)', () => {
    expect(passwordWriteAction(null, true)).toBe('clear');
    expect(passwordWriteAction(null, false)).toBe('clear');
  });
  test('non-empty + key -> encrypt', () => {
    expect(passwordWriteAction('hunter2', true)).toBe('encrypt');
  });
  test('non-empty + NO key -> reject (fail closed, never store plaintext)', () => {
    expect(passwordWriteAction('hunter2', false)).toBe('reject');
  });
});

describe('vendorCredentialKey', () => {
  const orig = { v: process.env.VENDOR_CREDENTIAL_KEY, d: process.env.DATA_HYGIENE_VAULT_KEY };
  afterEach(() => {
    process.env.VENDOR_CREDENTIAL_KEY = orig.v;
    process.env.DATA_HYGIENE_VAULT_KEY = orig.d;
    if (orig.v === undefined) delete process.env.VENDOR_CREDENTIAL_KEY;
    if (orig.d === undefined) delete process.env.DATA_HYGIENE_VAULT_KEY;
  });
  test('prefers VENDOR_CREDENTIAL_KEY, falls back to DATA_HYGIENE_VAULT_KEY, else null', () => {
    process.env.VENDOR_CREDENTIAL_KEY = 'dedicated';
    process.env.DATA_HYGIENE_VAULT_KEY = 'vault';
    expect(vendorCredentialKey()).toBe('dedicated');
    delete process.env.VENDOR_CREDENTIAL_KEY;
    expect(vendorCredentialKey()).toBe('vault');
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    expect(vendorCredentialKey()).toBeNull();
  });
  test('vendorCredentialKeys lists candidates primary-first, deduped, for read-tries-all', () => {
    process.env.VENDOR_CREDENTIAL_KEY = 'dedicated';
    process.env.DATA_HYGIENE_VAULT_KEY = 'vault';
    expect(vendorCredentialKeys()).toEqual(['dedicated', 'vault']); // promotion: new key tried first, old still available
    process.env.DATA_HYGIENE_VAULT_KEY = 'dedicated'; // same value -> deduped
    expect(vendorCredentialKeys()).toEqual(['dedicated']);
    delete process.env.VENDOR_CREDENTIAL_KEY;
    process.env.DATA_HYGIENE_VAULT_KEY = 'vault';
    expect(vendorCredentialKeys()).toEqual(['vault']); // out-of-box: fallback only
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    expect(vendorCredentialKeys()).toEqual([]);
  });
});

describe('getVendorLoginCredentials — decrypt failures (Codex #3853 r6 P1)', () => {
  const { getVendorLoginCredentials, isInfrastructureError } = require('../services/vendor-credentials');
  const row = { login_username: 'u', login_email: 'e@x.y', account_number: '1', login_url: null, login_password_encrypted: '-----BEGIN PGP MESSAGE-----' };
  const fakeConn = (rawImpl) => { const c = () => ({ where: () => ({ first: async () => row }) }); c.raw = rawImpl; return c; };
  beforeAll(() => { process.env.VENDOR_CREDENTIAL_KEY = 'k1'; });
  afterAll(() => { delete process.env.VENDOR_CREDENTIAL_KEY; });

  test('a wrong key (pgcrypto 39000) is data: password null, no throw', async () => {
    const creds = await getVendorLoginCredentials(fakeConn(async () => { const e = new Error('Wrong key or corrupt data'); e.code = '39000'; throw e; }), 'v1');
    expect(creds).toMatchObject({ email: 'e@x.y', password: null });
  });

  test('a database failure during decrypt is rethrown, never read as "no password"', async () => {
    await expect(getVendorLoginCredentials(fakeConn(async () => { const e = new Error('terminating connection'); e.code = '57P01'; throw e; }), 'v1')).rejects.toMatchObject({ infrastructure: true, code: '57P01', message: 'vendor credential decrypt failed: database error 57P01' });
    await expect(getVendorLoginCredentials(fakeConn(async () => { throw new Error('Connection terminated unexpectedly'); }), 'v1')).rejects.toMatchObject({ infrastructure: true, message: 'vendor credential decrypt failed: database error' });
    expect(isInfrastructureError({ code: '08006' })).toBe(true);
    expect(isInfrastructureError({ code: 'ECONNRESET' })).toBe(true);
    expect(isInfrastructureError({ code: '39000' })).toBe(false);
    expect(isInfrastructureError({ code: '22023' })).toBe(false);
  });

  test('the rethrown error is SANITIZED: a Knex-shaped message embedding the bindings (ciphertext + key) never leaves this module (pre-push hook P0)', async () => {
    const knexErr = new Error("select pgp_sym_decrypt(dearmor('-----BEGIN PGP MESSAGE-----'), 'k1') AS pw - Connection terminated unexpectedly");
    knexErr.code = '08006';
    const err = await getVendorLoginCredentials(fakeConn(async () => { throw knexErr; }), 'v1').catch((e) => e);
    expect(err).toMatchObject({ infrastructure: true, code: '08006' });
    expect(err.message).not.toContain('k1');
    expect(err.message).not.toContain('PGP');
    expect(err.cause).toBeUndefined();
    expect(String(err.stack)).not.toContain('k1');
  });
});
