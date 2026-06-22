const { passwordWriteAction, vendorCredentialKey } = require('../services/vendor-credentials');

describe('passwordWriteAction', () => {
  test('absent field -> skip (leave stored value untouched)', () => {
    expect(passwordWriteAction(undefined, true)).toBe('skip');
    expect(passwordWriteAction(undefined, false)).toBe('skip');
  });
  test('empty string -> clear (set NULL)', () => {
    expect(passwordWriteAction('', true)).toBe('clear');
    expect(passwordWriteAction('', false)).toBe('clear');
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
});
