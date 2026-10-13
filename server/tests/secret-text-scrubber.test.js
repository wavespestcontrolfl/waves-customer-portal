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
  authorization_header: ['Authorization: Basic ' + x(12, 'b')],
  basic_credentials: ['Basic ' + x(12, 'c')],
  bearer_token: ['Bearer ' + x(24, 'a')],
  credential_identifier_assignment: ['AWS_SECRET' + '_ACCESS_KEY=' + x(40, 'q')],
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
    ['Portal password: hunter22 (changed)', 'Portal password: [removed]'],
    ['password=Sunshine1#', 'password=[removed]'],
    ['His PIN is 4821 for the app', 'His PIN is [removed]'],
    ['pin: 0042.', 'pin: [removed].'],
    ['api key = abc-123-def', 'api key = [removed]'],
    ['API_KEY: zz9', 'API_KEY: [removed]'],
    ['access key: K9d82', 'access key: [removed]'],
    ['OTP: 123456', 'OTP: [removed]'],
    ['verification code is 654321', 'verification code is [removed]'],
    ['login code: 778899', 'login code: [removed]'],
    ['the passcode is "blue-fox"', 'the passcode is "[removed]"'],
    ['secret: s3cr3t,next', 'secret: [removed]'],
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

describe('credential-named identifiers (environment-style assignments)', () => {
  const V = x(24, 'q'); // a synthetic value with no distinctive prefix
  test.each([
    ['AWS_SECRET' + '_ACCESS_KEY=' + x(40, 'q'), 'AWS_SECRET' + '_ACCESS_KEY=[removed]'],
    ['DB_PASS' + 'WORD=' + V, 'DB_PASS' + 'WORD=[removed]'],
    ['STRIPE_WEBHOOK_' + 'SECRET: ' + V, 'STRIPE_WEBHOOK_' + 'SECRET: [removed]'],
    ['export API_' + 'TOKEN="' + V + '"', 'export API_' + 'TOKEN="[removed]"'],
    ["export API_" + "TOKEN='" + V + " with space'", "export API_" + "TOKEN='[removed]'"],
    ['db.pass' + 'word = ' + V, 'db.pass' + 'word = [removed]'],
    ['api-' + 'key: ' + V, 'api-' + 'key: [removed]'],
    ['MY_PRIVATE_' + 'KEY=' + V, 'MY_PRIVATE_' + 'KEY=[removed]'],
    ['SIGNING_' + 'KEY: ' + V + '.', 'SIGNING_' + 'KEY: [removed].'],
    ['encryption_' + 'key=' + V, 'encryption_' + 'key=[removed]'],
    ['CERT_' + 'KEY=' + V, 'CERT_' + 'KEY=[removed]'],
    ['client_' + 'secret=' + V + ' next', 'client_' + 'secret=[removed] next'],
    ['SMTP_PWD:' + V, 'SMTP_PWD:[removed]'],
    ['GIT_' + 'PASSPHRASE = "' + V + '"', 'GIT_' + 'PASSPHRASE = "[removed]"'],
    ['AUTH_' + 'HEADER=' + V, 'AUTH_' + 'HEADER=[removed]'],
    ['SERVICE_CREDENTIALS=' + V, 'SERVICE_CREDENTIALS=[removed]'],
    ['page_' + 'token_hint=' + V, 'page_' + 'token_hint=[removed]'],
  ])('%s', (input, expected) => {
    const { text, removed } = scrubSecretText(`Pasted: ${input}`);
    expect(text).toBe(`Pasted: ${expected}`);
    expect(removed).toBe(1);
  });

  test('several assignments in one note, one per line', () => {
    const note = ['DB_PASS' + 'WORD=' + V, 'DB_HOST=db.internal.example', 'API_' + 'TOKEN: ' + V].join('\n');
    expect(scrubSecretText(note).text).toBe(['DB_PASS' + 'WORD=[removed]', 'DB_HOST=db.internal.example', 'API_' + 'TOKEN: [removed]'].join('\n'));
  });

  test.each([
    'gate_code=1234', 'access_code: 55', 'door_code=7788', 'lockbox_code: 0912', 'GATE_CODE=1234', 'KEYPAD=front', 'KEYPAD: 4411',
    'monkey=banana', 'turkey: sandwich', 'author=Pat', 'authority=county', 'tokens_used=12', 'tokens: 40', 'page_token_count: 3',
    'token_count=7', 'secret_ttl=3600', 'password_length=12', 'auth_max=5', 'key=value', 'sort_key: name', 'primary_key=id',
    'pin: none', 'password=required', 'api_key: n/a', 'DB_HOST=localhost', 'order=desc', 'status: open', 'note=see PIN above',
  ])('kept: %s', (text) => {
    expect(scrubSecretText(text)).toEqual({ text, removed: 0 });
  });

  test('a counter-named identifier with a non-numeric value is still removed; a counter with a long number is not a counter', () => {
    expect(scrubSecretText('token_count=' + V).text).toBe('token_count=[removed]');
    expect(scrubSecretText('secret_total=1234567').text).toBe('secret_total=[removed]');
  });

  test('prose and code that merely mention credential words are left alone', () => {
    for (const text of ['The token of appreciation', 'Reset the password and try again', 'Set auth to the new value', 'secret garden', 'key: value pairs']) {
      expect(scrubSecretText(text)).toEqual({ text, removed: 0 });
    }
  });

  test('a value already removed is not removed twice', () => {
    expect(scrubSecretText('DB_PASS' + 'WORD=[removed]')).toEqual({ text: 'DB_PASS' + 'WORD=[removed]', removed: 0 });
    expect(scrubSecretText('password: ' + V)).toEqual({ text: 'password: [removed]', removed: 1 });
  });
});

// Codex round 8: a plain word after " is " is a value when it is one token of 6+ characters.
describe('labelled secrets after " is " with a plain word', () => {
  const secretWord = word => scrubSecretText(word).text;
  test.each([
    ['portal pass' + 'word is swords' + 'fish', 'swords' + 'fish'],
    ['API tok' + 'en is correcthorse' + 'battery', 'correcthorse' + 'battery'],
    ['the pass' + 'word is Hunter' + 'two', 'Hunter' + 'two'],
  ])('%s is removed', (input, value) => {
    const out = secretWord(input);
    expect(out).not.toContain(value);
    expect(out).toContain('[removed]');
  });
  test.each([
    'password is required', 'the token is expired', 'pin is wrong', 'password is invalid', 'password is missing',
    'the passcode is the same', 'password is on file', 'password is set', 'password is changed', 'password is updated',
    'password is unknown', 'password is none', 'password is n/a', 'the token is needed', 'pin is blue', 'password is reset',
  ])('"%s" is kept', phrase => {
    expect(secretWord(phrase)).toBe(phrase);
  });
});

// Codex: a passphrase is several words; the whole labelled clause is the value.
describe('multi-word labelled values', () => {
  const { scrubSecretText } = require('../utils/secret-text-scrubber');
  test.each([
    ['API token: alpha beta gamma', 'API token: [removed]'],
    ['password is correct horse battery staple', 'password is [removed]'],
    ['Wifi passphrase: blue river nine. Ask at the desk.', 'Wifi passphrase: [removed]. Ask at the desk.'],
    ['token = "my long pass phrase" ok', 'token = "[removed]" ok'],
  ])('%s', (text, expected) => {
    expect(scrubSecretText(text).text).toBe(expected);
  });
  test.each(['password is correct', 'The pin is required before booking', 'password is on file', 'Password is not set', 'gate PIN: 1234', 'pin is blue'])('prose stays: %s', (text) => {
    expect(scrubSecretText(text).text).toBe(text);
  });
});

// Codex r11: an Authorization header carries a reusable credential in any scheme.
describe('authorization headers and Basic credentials', () => {
  const { scrubSecretText } = require('../utils/secret-text-scrubber');
  const payload = ['dXNl', 'cjpw', 'YXNz'].join('');
  test.each([
    [`Authorization: Basic ${payload}`, 'Authorization: [removed]'],
    [`Send the header authorization: Digest username="a", response="${payload}"\nthen retry`, null],
    [`Proxy-Authorization: Basic ${payload}`, 'Proxy-Authorization: [removed]'],
    [`curl -u is not needed; use Basic ${payload} instead`, 'curl -u is not needed; use Basic [removed] instead'],
  ])('%s', (text, expected) => {
    const out = scrubSecretText(text).text;
    expect(out).not.toContain(payload);
    if (expected) expect(out).toBe(expected);
    else expect(out).toContain('then retry');
  });
  test.each(['Basic lawn care plan', 'Authorization is required before the visit', 'The Basic package covers ants'])('prose stays: %s', (text) => {
    expect(scrubSecretText(text).text).toBe(text);
  });
});
