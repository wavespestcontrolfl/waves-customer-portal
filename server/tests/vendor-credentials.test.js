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
