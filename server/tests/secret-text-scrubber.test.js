/**
 * Best-effort scrubber for credentials pasted into free text. Every fake key
 * below is built by concatenation so a secret scanner does not flag the repo.
 */
const { SECRET_PATTERNS, scrubSecretText } = require('../utils/secret-text-scrubber');
const { redactSecrets, newState } = require('../utils/signed-link-redaction');

const x = (n, ch = 'x') => ch.repeat(n);
const b64 = n => 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3'.slice(0, n);

const FORMATS = {
  stripe_secret_key: ['sk_' + 'live_' + x(24), 'sk_' + 'test_' + x(24), 'rk_' + 'live_' + x(24), 'rk_' + 'test_' + x(24)],
  stripe_webhook_secret: ['whsec' + '_' + x(32)],
  aws_access_key_id: ['AK' + 'IA' + x(16, 'A'), 'AS' + 'IA' + x(16, 'B')],
  github_token: ['gh' + 'p_' + x(36, 'a'), 'gh' + 'o_' + x(36, 'a'), 'gh' + 'u_' + x(36, 'a'), 'gh' + 's_' + x(36, 'a')],
  github_fine_grained_token: ['github' + '_pat_' + x(40, 'a')],
  slack_token: ['xo' + 'xb-' + x(12, '1') + '-' + x(12, '2'), 'xo' + 'xp-' + x(20, '3')],
  twilio_api_key_sid: ['S' + 'K' + x(32, 'a')],
  sendgrid_api_key: ['S' + 'G.' + x(22, 'a') + '.' + x(22, 'b')],
  anthropic_api_key: ['sk-' + 'ant-' + x(30, 'a')],
  openai_api_key: ['sk-' + x(30, 'a'), 'sk-' + 'proj-' + x(30, 'a')],
  google_api_key: ['AI' + 'za' + x(35, 'a')],
  jwt: ['ey' + 'Jhbgci0i.' + 'eyJ' + 'zdWIiOjEy.' + b64(20)],
  pem_private_key: ['-----BEGIN ' + 'PRIVATE KEY-----\n' + b64(30) + '\n-----END ' + 'PRIVATE KEY-----', '-----BEGIN RSA ' + 'PRIVATE KEY-----\n' + b64(30)],
  bearer_token: ['Bearer ' + x(24, 'a')],
};

describe('known secret formats', () => {
  test('the format list is exactly the one documented', () => {
    expect(SECRET_PATTERNS.map(p => p.name).sort()).toEqual(Object.keys(FORMATS).sort());
  });
  for (const [name, samples] of Object.entries(FORMATS)) {
    test.each(samples.map(sample => [sample.slice(0, 12), sample]))(`${name}: %s... is removed inside a sentence`, (_label, secret) => {
      const { text, removed } = scrubSecretText(`Customer said to use ${secret}. Call back.`);
      expect(text).not.toContain(secret.slice(0, 30));
      expect(text).toContain('[removed]');
      expect(text.startsWith('Customer said to use ')).toBe(true);
      expect(removed).toBeGreaterThanOrEqual(1);
    });
  }
  test('a bearer token keeps its label', () => {
    expect(scrubSecretText('Header Bearer ' + x(24, 'a') + ' sent').text).toBe('Header Bearer [removed] sent');
  });
  test('a publishable key and a Twilio account id are public identifiers and stay', () => {
    const pub = 'pk_' + 'live_' + x(24);
    const sid = 'A' + 'C' + x(32, 'a');
    expect(scrubSecretText(`Keys ${pub} and ${sid}`)).toEqual({ text: `Keys ${pub} and ${sid}`, removed: 0 });
  });
  test('short look-alikes stay', () => {
    expect(scrubSecretText('sk-short, AKIA123, ghp_abc, Bearer abc').removed).toBe(0);
  });
});

describe('labelled secrets in prose', () => {
  test.each([
    ['Portal password: hunter22 (changed)', 'Portal password: [removed] (changed)'],
    ['password=Sunshine1#', 'password=[removed]'],
    ['His PIN is 4821 for the app', 'His PIN is [removed] for the app'],
    ['pin: 0042.', 'pin: [removed].'],
    ['api key = abc-123-def', 'api key = [removed]'],
    ['API_KEY: zz9', 'API_KEY: [removed]'],
    ['access key: K9d82', 'access key: [removed]'],
    ['OTP: 123456', 'OTP: [removed]'],
    ['verification code is 654321', 'verification code is [removed]'],
    ['login code: 778899', 'login code: [removed]'],
    ['the passcode is "blue-fox"', 'the passcode is "[removed]"'],
    ['secret: s3cr3t,next', 'secret: [removed],next'],
    ['token = abcdef12', 'token = [removed]'],
    ['pwd: Tr0ub4dor', 'pwd: [removed]'],
  ])('%s', (input, expected) => {
    const { text, removed } = scrubSecretText(input);
    expect(text).toBe(expected);
    expect(removed).toBe(1);
  });

  test.each([
    'gate code: 4821',
    'Gate code is 1234#',
    'access code: 5522',
    'door code 7788 at the side',
    'lockbox code: 0912',
    'Lockbox code is 3344',
    'gate PIN: 1234',
    'lockbox PIN is 4455',
    'the gate pin is 8890',
  ])('a gate, access, door or lockbox code is kept: %s', (text) => {
    expect(scrubSecretText(text)).toEqual({ text, removed: 0 });
  });

  test.each([
    'PIN the note to the top of the board',
    'A token of appreciation for the crew',
    'Password reset requested by the customer',
    'Customer forgot the password',
    'The pin is required before booking',
    'Password is required',
    'secret garden pest plan',
    'otp',
    'pin: none',
    'Token: n/a',
    'The code is 4411',
    'Please set a pin',
    'verification code was sent',
  ])('ordinary prose stays: %s', (text) => {
    expect(scrubSecretText(text)).toEqual({ text, removed: 0 });
  });

  test('a separator across a line break does not swallow the next line', () => {
    expect(scrubSecretText('password:\nnext line stays').text).toBe('password:\nnext line stays');
  });
});

describe('the walk over a response', () => {
  test('every string value is scrubbed, counted with the credential fields, and non-strings pass', () => {
    const state = newState();
    const out = redactSecrets({
      payers: [{ id: 3, notes: 'AP clerk: portal password: hunter22. Backup key ' + 'sk_' + 'live_' + x(24), nested: { list: ['ok', 'PIN is 4821'] } }],
      count: 2, flag: true, none: null,
    }, state);
    expect(out.payers[0].notes).toBe('AP clerk: portal password: [removed]. Backup key [removed]');
    expect(out.payers[0].nested.list).toEqual(['ok', 'PIN is [removed]']);
    expect(out.count).toBe(2);
    expect(state.fields).toBe(3);
  });
  test('the gate code stays in the answer', () => {
    const state = newState();
    expect(redactSecrets({ instructions: 'Gate code: 4821, side door' }, state).instructions).toBe('Gate code: 4821, side door');
    expect(state.fields).toBe(0);
  });
});
