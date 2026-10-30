// GATE_CALL_EMAIL_CHECKS (owner 2026-10-29, after the call-agent audit): the
// deterministic checks on an email heard on a call. Fixtures are synthetic.
const {
  callEmailChecksLive, checkEmailDomain, screenCallEmail,
  deadDomainQuestion, isNoMailServerReason,
} = require('../services/call-email-checks');

const dnsError = (code) => Object.assign(new Error(code), { code });
const liveDomain = { resolveMx: async () => [{ exchange: 'mx1.example.net', priority: 10 }] };
const deadDomain = {
  resolveMx: async () => { throw dnsError('ENOTFOUND'); },
  resolve4: async () => { throw dnsError('ENOTFOUND'); },
  resolve6: async () => { throw dnsError('ENOTFOUND'); },
};
const flakyDns = { resolveMx: async () => { throw dnsError('ETIMEOUT'); } };

describe('callEmailChecksLive', () => {
  afterEach(() => { delete process.env.GATE_CALL_EMAIL_CHECKS; });
  test('off unless exactly "true"', () => {
    expect(callEmailChecksLive()).toBe(false);
    process.env.GATE_CALL_EMAIL_CHECKS = '1';
    expect(callEmailChecksLive()).toBe(false);
    process.env.GATE_CALL_EMAIL_CHECKS = 'true';
    expect(callEmailChecksLive()).toBe(true);
  });
});

describe('checkEmailDomain', () => {
  test('a domain with a mail server is deliverable', async () => {
    await expect(checkEmailDomain('a@example.net', liveDomain)).resolves.toMatchObject({ domain: 'example.net', deliverable: true });
  });
  test('an authoritative "no such domain" on every lookup is not deliverable', async () => {
    await expect(checkEmailDomain('jay@nosuchdomain.me', deadDomain)).resolves.toMatchObject({ domain: 'nosuchdomain.me', deliverable: false });
  });
  test('a null MX record is not deliverable', async () => {
    await expect(checkEmailDomain('a@nomail.example', { resolveMx: async () => [{ exchange: '.', priority: 0 }] }))
      .resolves.toMatchObject({ deliverable: false, dns_error: 'NULL_MX' });
  });
  test('a resolver hiccup is unknown, never a block', async () => {
    await expect(checkEmailDomain('a@example.net', flakyDns)).resolves.toMatchObject({ deliverable: null });
  });
  test('a malformed address is not checked', async () => {
    await expect(checkEmailDomain('not-an-email', liveDomain)).resolves.toBeNull();
  });
});

describe('screenCallEmail', () => {
  test('a dead domain is set aside to email_raw and reported', async () => {
    const extracted = { email: 'jay@nosuchdomain.me' };
    const note = await screenCallEmail(extracted, { deps: deadDomain });
    expect(extracted).toEqual({ email: null, email_raw: 'jay@nosuchdomain.me' });
    expect(note.dead_domain).toMatchObject({ domain: 'nosuchdomain.me', deliverable: false });
  });
  test('an email_raw already present is kept', async () => {
    const extracted = { email: 'jay@nosuchdomain.me', email_raw: 'as heard' };
    await screenCallEmail(extracted, { deps: deadDomain });
    expect(extracted.email_raw).toBe('as heard');
  });
  test('a live domain keeps the address', async () => {
    const extracted = { email: 'brightonkayla@gmail.com' };
    const note = await screenCallEmail(extracted, { deps: liveDomain });
    expect(extracted.email).toBe('brightonkayla@gmail.com');
    expect(note).toEqual({ domain_deliverable: true });
  });
  test('a resolver hiccup keeps the address (unknown is never a block)', async () => {
    const extracted = { email: 'brightonkayla@gmail.com' };
    const note = await screenCallEmail(extracted, { deps: flakyDns });
    expect(extracted.email).toBe('brightonkayla@gmail.com');
    expect(note).toEqual({ domain_deliverable: null });
  });
  test('no email, nothing to check', async () => {
    await expect(screenCallEmail({ email: null })).resolves.toBeNull();
  });
});

describe('isNoMailServerReason', () => {
  test.each([
    ['unable to get mx info: failed to get IPs from PTR record: lookup <nil>: unrecognized address', true],
    ['550 5.1.2 Host or domain name not found. Name service error', true],
    ['DNS lookup failed: NXDOMAIN', true],
    ['550 5.1.1 The email account that you tried to reach does not exist', false],
    ['554 5.7.1 Service unavailable; client host blocked using a DNS block list', false],
    ['unable to get mx info: lookup example.net on 10.0.0.2:53: read udp 10.0.0.1:5353->10.0.0.2:53: i/o timeout', false],
    ['unable to get mx info: lookup example.net: server misbehaving', false],
    ['DNS lookup failed: SERVFAIL', false],
    ['550 5.1.2 Host or domain name not found. Name service error for name=example.net type=MX: Host not found, try again', false],
    ['', false],
  ])('%s', (reason, want) => {
    expect(isNoMailServerReason(reason)).toBe(want);
  });
});

test('deadDomainQuestion names the domain and the ask', () => {
  expect(deadDomainQuestion('nosuchdomain.me')).toBe('No mail server answers for "nosuchdomain.me". Ask the caller to spell the whole email again.');
});
