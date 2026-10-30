// GATE_CALL_EMAIL_CHECKS (owner 2026-10-29, after the call-agent audit): the
// deterministic checks on an email heard on a call. Fixtures are synthetic;
// the phrasings mirror real transcripts (hyphen-joined letters, "G as in good",
// digits said as a number, a word said between two spelled stretches).
const {
  callEmailChecksLive, emailMentions, spelledEmailMatches, checkEmailDomain, screenCallEmail,
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

describe('emailMentions', () => {
  const spelled = (local, domain, speaker = null) => ({ kind: 'spelled', local, domain, speaker });
  test.each([
    ['hyphen-joined letters across a space', 'It is B-R-I-G-H-T-O-N K-A-Y-L-A at gmail dot com', [spelled('brightonkayla', 'gmail.com')]],
    ['letters then a number', 'Okay. D-R-A-Y 22 at yahoo.com.', [spelled('dray22', 'yahoo.com')]],
    ['letters and digits all hyphen-joined', 'D-R-A-Y-2-2 at yahoo.com', [spelled('dray22', 'yahoo.com')]],
    ['phonetic markers', 'So T-H-E-B-A-I-T S-H-O-P, G as in good, M as in Mary, at iCloud.com', [spelled('thebaitshopgm', 'icloud.com')]],
    ['digit words and a spoken dot', 'J-A-N-E dot D-O-E one two at gmail dot com', [spelled('jane.doe12', 'gmail.com')]],
    ['a spoken multi-part domain is kept whole', 'J-A-N-E at yahoo dot co dot uk', [spelled('jane', 'yahoo.co.uk')]],
    ['a bare provider word stays bare', 'J-A-N-E at yahoo', [spelled('jane', 'yahoo')]],
    ['a name spelled elsewhere is not a mention', 'Clay, C-L-A-Y. And the email? D-R-A-Y 22 at yahoo.com', [spelled('dray22', 'yahoo.com')]],
    ['a spelled name followed by words is not a spelled mention', 'Let me spell my last name. S-M-I-T-H. My email is smith at yahoo dot com', [{ kind: 'said', local: 'smith', domain: 'yahoo.com', speaker: null }]],
    ['an interrupted spelling does not cover the address', 'T-A-M-I, Rowe, R-O-W-E, at hotmail.com', [spelled(null, 'hotmail.com')]],
    ['a spoken word right before the letters may be part of the address', 'my email is jane D-O-E at gmail.com', [spelled(null, 'gmail.com')]],
    ['speaker labels and curly apostrophes', 'Caller: Okay. It’s B-R-I-G-H-T at gmail.com. Agent: Thanks.', [spelled('bright', 'gmail.com', 'caller')]],
    ['a spelled name three words back is not an interruption', 'It is Rowe, R-O-W-E, and email is T-A-M-I at hotmail.com', [spelled('tami', 'hotmail.com')]],
    ['the pronoun I is not a spelled run', 'I think it is S-M-I-T-H at gmail.com', [spelled('smith', 'gmail.com')]],
    ['one word after a clean start is a said address', 'Agent: So sclay18 at yahoo.com, got it.', [{ kind: 'said', local: 'sclay18', domain: 'yahoo.com', speaker: 'agent' }]],
    ['times and places are not addresses', 'We are at 107 Rodeo Drive at 4 o\'clock.', []],
    ['fewer than three letters is not a spelling', 'J-O at gmail', []],
  ])('%s', (_label, text, mentions) => {
    expect(emailMentions(text).mentions).toEqual(mentions);
  });

  test('labeled is set when the transcript carries speaker labels', () => {
    expect(emailMentions('Agent: Hi. Caller: Hello.').labeled).toBe(true);
    expect(emailMentions('Hi. Hello.').labeled).toBe(false);
  });
});

describe('spelledEmailMatches — the 2026-10-05 rule without AI', () => {
  test.each([
    ['spelled letter by letter on gmail', ['Okay, B-R-I-G-H-T-O-N K-A-Y-L-A at gmail dot com.'], 'brightonkayla@gmail.com', true],
    ['spelled with a number on yahoo', ['D-R-A-Y 22 at yahoo.com'], 'dray22@yahoo.com', true],
    ['phonetic markers on iCloud', ['T-H-E-B-A-I-T S-H-O-P, G as in good, M as in Mary, at iCloud.com'], 'thebaitshopgm@icloud.com', true],
    ['only one of two transcripts needs the spelling', ['my email is the bait shop gm at icloud', 'T-H-E-B-A-I-T-S-H-O-P-G-M at iCloud.com'], 'thebaitshopgm@icloud.com', true],
    ['said, not spelled', ['My email is jane.doe@gmail.com'], 'jane.doe@gmail.com', false],
    ['a word between the spelled parts', ['T-A-M-I, Rowe, R-O-W-E, at hotmail.com'], 'tamirowe@hotmail.com', false],
    ['a custom domain is never trusted this way', ['J-A-Y at J-D-O-E dot me'], 'jay@jdoe.me', false],
    ['the provider was never named on the call', ['S-M-I-T-H-Y and then the rest'], 'smithy@gmail.com', false],
    ['the spelled letters are a different address', ['S-M-Y-T-H-E at gmail'], 'smithe@gmail.com', false],
    ['a spelled last name never vouches for a said email', ['Let me spell my last name. S-M-I-T-H. My email is smith at yahoo dot com'], 'smith@me.com', false],
    ['an interrupted spelling never vouches for its last part', ['T-A-M-I, Rowe, R-O-W-E, at hotmail.com'], 'rowe@hotmail.com', false],
    ['the caller rejects the agent\'s spelling', ['Agent: Is it J-A-N-E at gmail.com? Caller: No, jane two at gmail dot com.'], 'jane@gmail.com', false],
    ['the same rejection in an unlabeled dictation pass', ['Is it J-A-N-E at gmail.com? No, jane two at gmail dot com.'], 'jane@gmail.com', false],
    ['only the agent spelled it', ['Agent: So that is D-R-A-Y 22 at yahoo.com? Caller: Yes.'], 'dray22@yahoo.com', false],
    ['the caller spelled it and the agent read it back', ['Caller: D-R-A-Y 22 at yahoo.com. Agent: So dray22 at yahoo.com, got it.'], 'dray22@yahoo.com', true],
    ['our own address said on the call is not a conflict', ['Caller: D-R-A-Y 22 at yahoo.com. Agent: You can also email us at wavespestcontrol.com.'], 'dray22@yahoo.com', true],
    ['a second address on the call keeps the card', ['Caller: D-R-A-Y 22 at yahoo.com, and my husband is bob at gmail.com.'], 'dray22@yahoo.com', false],
    ['an interrupted spelling never vouches for the joined address either', ['T-A-M-I, Rowe, R-O-W-E, at hotmail.com'], 'tamirowe@hotmail.com', false],
    ['a mixed spoken and spelled address keeps the card', ['my email is jane D-O-E at gmail.com'], 'doe@gmail.com', false],
    ['the spelling names a different provider', ['B-R-I-G-H-T at yahoo dot com'], 'bright@gmail.com', false],
    ['a dotted foreign domain is not the .com address', ['J-A-N-E at yahoo.co.uk'], 'jane@yahoo.com', false],
    ['a spoken-dot foreign domain is not the .com address', ['J-A-N-E at yahoo dot co dot uk'], 'jane@yahoo.com', false],
    ['the full spoken domain matches', ['J-A-N-E at yahoo dot com'], 'jane@yahoo.com', true],
    ['a bare provider word is ambiguous and keeps the card', ['B-R-I-G-H-T at gmail'], 'bright@gmail.com', false],
  ])('%s', (_label, transcripts, email, want) => {
    expect(spelledEmailMatches({ transcripts, email })).toBe(want);
  });

  test('a corrected spelling keeps the card, whichever spelling was saved', () => {
    const transcripts = ['S-M-I-T-H at gmail.com, no sorry, S-M-Y-T-H at gmail.com'];
    expect(spelledEmailMatches({ transcripts, email: 'smith@gmail.com' })).toBe(false);
    expect(spelledEmailMatches({ transcripts, email: 'smyth@gmail.com' })).toBe(false);
  });

  test('a near-miss spelling in either transcript means the letters are not settled', () => {
    expect(spelledEmailMatches({
      transcripts: ['S-M-I-T-H-Y at gmail.com', 'S-M-I-T-H-Y-J at gmail.com'],
      email: 'smithy@gmail.com',
    })).toBe(false);
  });

  test('no email, or no transcript, is never a match', () => {
    expect(spelledEmailMatches({ transcripts: ['B-R-I-G-H-T at gmail'], email: null })).toBe(false);
    expect(spelledEmailMatches({ transcripts: [], email: 'bright@gmail.com' })).toBe(false);
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
    const note = await screenCallEmail(extracted, { transcripts: ['J-A-Y'], deps: deadDomain });
    expect(extracted).toEqual({ email: null, email_raw: 'jay@nosuchdomain.me' });
    expect(note.dead_domain).toMatchObject({ domain: 'nosuchdomain.me', deliverable: false });
  });
  test('an email_raw already present is kept', async () => {
    const extracted = { email: 'jay@nosuchdomain.me', email_raw: 'as heard' };
    await screenCallEmail(extracted, { deps: deadDomain });
    expect(extracted.email_raw).toBe('as heard');
  });
  test('a live domain keeps the address and notes the spelled match', async () => {
    const extracted = { email: 'brightonkayla@gmail.com' };
    const note = await screenCallEmail(extracted, { transcripts: ['B-R-I-G-H-T-O-N K-A-Y-L-A at gmail dot com'], deps: liveDomain });
    expect(extracted.email).toBe('brightonkayla@gmail.com');
    expect(note).toEqual({ spelled_match: true, domain_deliverable: true });
  });
  test('a resolver hiccup keeps the address (unknown is never a block)', async () => {
    const extracted = { email: 'brightonkayla@gmail.com' };
    const note = await screenCallEmail(extracted, { transcripts: [], deps: flakyDns });
    expect(extracted.email).toBe('brightonkayla@gmail.com');
    expect(note).toEqual({ spelled_match: false, domain_deliverable: null });
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
    ['', false],
  ])('%s', (reason, want) => {
    expect(isNoMailServerReason(reason)).toBe(want);
  });
});

test('deadDomainQuestion names the domain and the ask', () => {
  expect(deadDomainQuestion('nosuchdomain.me')).toBe('No mail server answers for "nosuchdomain.me". Ask the caller to spell the whole email again.');
});
