// Real Google SDK with an in-memory transporter. No OAuth or message request
// reaches the network; transport failures still traverse the real SDK paths.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const db = require('../models/db');
const { google } = require('googleapis');
const gmail = require('../services/email/gmail-client');
const { stripQuotedAndSignature, emailPlainText } = require('../services/email/email-strip');
const OAuth2 = google.auth.OAuth2;
let requests, providerFailure, expired, acceptedData;

beforeEach(() => {
  requests = []; expired = false; acceptedData = undefined;
  db.mockImplementation(() => ({ first: async () => ({ refresh_token: 'synthetic-refresh', access_token: 'synthetic-access',
    token_expires_at: new Date(Date.now() + (expired ? -3600000 : 3600000)) }) }));
  jest.spyOn(google.auth, 'OAuth2').mockImplementation((...args) => {
    const client = new OAuth2(...args);
    client.transporter = { request: async config => {
      requests.push(config);
      if (acceptedData !== undefined) return { data: acceptedData, status: 200, config };
      const error = Object.assign(new Error('Synthetic provider rejection'), providerFailure, { config });
      if (providerFailure.status) error.response = { status: providerFailure.status, config };
      throw error;
    } };
    return client;
  });
});
afterEach(() => jest.restoreAllMocks());

test('a valid accepted response retains its provider identifier', async () => {
  acceptedData = { id: 'synthetic-message', threadId: 'synthetic-thread' };
  await expect(gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture')).resolves.toEqual(acceptedData);
  expect(requests).toHaveLength(1);
});

test.each([{}, null])('an accepted response without an id stays uncertain for every caller: %j', async data => {
  acceptedData = data;
  await expect(gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture'))
    .rejects.toMatchObject({ providerOutcome: { outcomeUnknown: true } });
  expect(requests).toHaveLength(1);
});

test.each([
  ['response timeout', { code: 'ETIMEDOUT' }],
  ['connection reset', { code: 'ECONNRESET' }],
  ['HTTP 408', { status: 408 }],
  ['HTTP 503', { status: 503 }],
  ['unreadable accepted response', { status: 200 }],
])('%s after message submission remains uncertain without transport retry', async (_label, failure) => {
  providerFailure = failure;
  await expect(gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture'))
    .rejects.toMatchObject({ providerOutcome: { outcomeUnknown: true } });
  expect(requests).toHaveLength(1);
  expect(String(requests[0].url)).toContain('/messages/send');
  expect(requests[0].retry).toBe(false);
});

test.each([400, 401, 403, 429])('definitive HTTP %i is a failed send', async status => {
  providerFailure = { status };
  const error = await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture').catch(err => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.providerOutcome).toBeUndefined();
});

test.each(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'])('%s establishes no submission', async code => {
  providerFailure = { code };
  const error = await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture').catch(err => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.providerOutcome).toBeUndefined();
});

test.each([{ code: 'ETIMEDOUT' }, { status: 503 }])('OAuth failure before submission stays failed: %j', async failure => {
  expired = true; providerFailure = failure;
  const error = await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture').catch(err => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.providerOutcome).toBeUndefined();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => String(request.url).includes('/token'))).toBe(true);
});

test('an aborted request (timeoutMs) after submission stays uncertain and carries the deadline', async () => {
  providerFailure = { name: 'TimeoutError' };
  await expect(gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture', null, null, { timeoutMs: 60000 }))
    .rejects.toMatchObject({ providerOutcome: { outcomeUnknown: true } });
  expect(requests).toHaveLength(1);
  expect(requests[0].timeout).toBe(60000);
});

test('a beforeSend hook that refuses stops the send before any message request', async () => {
  acceptedData = { id: 'never' };
  const hook = jest.fn(async () => { throw Object.assign(new Error('claim no longer held'), { code: 'claim_lost' }); });
  const err = await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture', null, null, { beforeSend: hook }).catch((e) => e);
  expect(err).toMatchObject({ code: 'claim_lost' });
  expect(err.providerOutcome).toBeUndefined();
  expect(hook).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(0);
});

test('beforeSend runs after the token refresh and before the message request', async () => {
  expired = true;
  acceptedData = { id: 'fixture-sent', access_token: 'synthetic-new', expires_in: 3600 };
  let seenAtHook;
  await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture', null, null, { beforeSend: async () => { seenAtHook = requests.map((r) => String(r.url)); } });
  expect(seenAtHook).toHaveLength(1);
  expect(seenAtHook[0]).toMatch(/token/);
  expect(String(requests.at(-1).url)).toMatch(/messages\/send/);
});

test('sendMessage emits multipart/alternative MIME with base64-wrapped plain-text and HTML parts', async () => {
  acceptedData = { id: 'synthetic-message', threadId: 'synthetic-thread' };
  const longNote = 'A'.repeat(1200);
  const htmlBody = `<style>.a{color:red}</style><p>Hi Taylor &amp; Sam,</p><p><a href="https://portal.wavespestcontrol.com/estimate/abc?x=1&amp;y=2">View estimate</a> or <a href="mailto:billing@example.com">Contact &lt;billing@example.com&gt;</a> ${longNote}</p>`;
  await gmail.sendMessage('fixture@example.test', 'Visit confirmed', htmlBody);
  const payload = requests[0].data ?? requests[0].body;
  const sentBody = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const raw = Buffer.from(sentBody.raw, 'base64url').toString('utf8');
  expect(raw).not.toMatch(/(?<!\r)\n/);
  expect(raw.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 998)).toBe(true);
  const boundaryMatch = raw.match(/boundary="([^"]+)"/);
  expect(boundaryMatch).toBeTruthy();
  const sections = raw.split(`--${boundaryMatch[1]}`);
  const decodePart = (part) => {
    const [, bodyB64 = ''] = part.split('\r\n\r\n');
    return Buffer.from(bodyB64.replace(/\r\n/g, ''), 'base64').toString('utf8');
  };
  expect(sections[1]).toContain('Content-Type: text/plain; charset=utf-8');
  expect(sections[1]).toContain('Content-Transfer-Encoding: base64');
  expect(sections[2]).toContain('Content-Type: text/html; charset=utf-8');
  expect(sections[2]).toContain('Content-Transfer-Encoding: base64');
  const plainDecoded = decodePart(sections[1]);
  const htmlDecoded = decodePart(sections[2]);
  expect(plainDecoded).toContain(`Hi Taylor & Sam,\r\nView estimate (https://portal.wavespestcontrol.com/estimate/abc?x=1&y=2) or Contact <billing@example.com> (mailto:billing@example.com) ${longNote}`);
  expect(plainDecoded).not.toContain('.a{color:red}');
  expect(htmlDecoded).toBe(htmlBody);
});

test('sendMessage marks blockquotes and Gmail quote/signature containers so stripQuotedAndSignature strips quoted history', async () => {
  acceptedData = { id: 'synthetic-quote', threadId: 'synthetic-thread' };
  const htmlBody = [
    '<p>Thanks, we will see you Friday.</p>',
    '<div class="gmail_signature"><p>Waves Support</p></div>',
    '<div class="gmail_quote_container"><p>I promise to send the waiver by Tuesday.</p></div>',
  ].join('');
  await gmail.sendMessage('fixture@example.test', 'Re: Visit', htmlBody);
  const payload = requests[0].data ?? requests[0].body;
  const sentBody = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const raw = Buffer.from(sentBody.raw, 'base64url').toString('utf8');
  const boundaryMatch = raw.match(/boundary="([^"]+)"/);
  const sections = raw.split(`--${boundaryMatch[1]}`);
  const [, plainB64 = ''] = sections[1].split('\r\n\r\n');
  const plainDecoded = Buffer.from(plainB64.replace(/\r\n/g, ''), 'base64').toString('utf8');
  expect(plainDecoded).toContain('> I promise to send the waiver by Tuesday.');
  expect(stripQuotedAndSignature(plainDecoded)).toBe('Thanks, we will see you Friday.');
});

test('emailPlainText preserves a staff reply below an attributed quote container and strips Yahoo quote IDs and signatures', async () => {
  acceptedData = { id: 'synthetic-bottom-reply', threadId: 'synthetic-thread' };
  const htmlBody = [
    '<p>On Nov 28, Pat &lt;pat@example.com&gt; wrote:</p>',
    '<div class="gmail_quote"><blockquote><p>Can you send the termite report tomorrow?</p></blockquote></div>',
    '<p>Yes, I will send it by 10am tomorrow.</p>',
    '<div id="yahoo_quoted_998877"><p>Please cancel my Friday visit.</p></div>',
    '<div class="gmail_signature"><p>Adam, Waves Pest Control</p></div>',
  ].join('');
  await gmail.sendMessage('fixture@example.test', 'Re: Termite report', htmlBody);
  const payload = requests[0].data ?? requests[0].body;
  const sentBody = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const raw = Buffer.from(sentBody.raw, 'base64url').toString('utf8');
  const boundaryMatch = raw.match(/boundary="([^"]+)"/);
  const sections = raw.split(`--${boundaryMatch[1]}`);
  const decodePart = (part) => {
    const [, bodyB64 = ''] = part.split('\r\n\r\n');
    return Buffer.from(bodyB64.replace(/\r\n/g, ''), 'base64').toString('utf8');
  };
  const plainDecoded = decodePart(sections[1]);
  const htmlDecoded = decodePart(sections[2]);
  const extracted = stripQuotedAndSignature(emailPlainText({ body_text: plainDecoded, body_html: htmlDecoded }));
  expect(extracted).toBe('Yes, I will send it by 10am tomorrow.');
  expect(extracted).not.toContain('Adam, Waves Pest Control');
  expect(extracted).not.toContain('Please cancel my Friday visit.');

  const yahooOnly = stripQuotedAndSignature(emailPlainText({
    body_text: '> Please cancel my Friday visit.',
    body_html: '<div id="yahoo_quoted_12345"><p>Please cancel my Friday visit.</p></div>',
  }));
  expect(yahooOnly).toBe('');

  const keptAboveAttribution = stripQuotedAndSignature(emailPlainText({
    body_text: 'On Friday I can meet the technician.\nOn Nov 28, Pat wrote:\n> Old question',
    body_html: '<p>On Friday I can meet the technician.</p><p>On Nov 28, Pat wrote:</p><blockquote><p>Old question</p></blockquote>',
  }));
  expect(keptAboveAttribution).toBe('On Friday I can meet the technician.');

  const wrappedInGmailQuote = stripQuotedAndSignature(emailPlainText({
    body_text: 'Please reschedule to Thursday.\n> Old thread',
    body_html: '<div class="gmail_quote"><p>Please reschedule to Thursday.</p><blockquote>Old thread</blockquote></div>',
  }));
  expect(wrappedInGmailQuote).toBe('Please reschedule to Thursday.');

  const wrappedWithTrailing = stripQuotedAndSignature(emailPlainText({
    body_text: 'Please reschedule to Thursday.\n> Old thread\nThanks',
    body_html: '<div class="gmail_quote"><p>Please reschedule to Thursday.</p><blockquote>Old thread</blockquote></div><p>Thanks</p>',
  }));
  expect(wrappedWithTrailing).toBe('Please reschedule to Thursday.\nThanks');

  const linkedReply = stripQuotedAndSignature(emailPlainText({
    body_text: 'Check the estimate (https://portal.wavespestcontrol.com/e/1) here.\n> Old thread',
    body_html: '<p>Check the <a href="https://portal.wavespestcontrol.com/e/1">estimate</a> here.</p><blockquote>Old thread</blockquote>',
  }));
  expect(linkedReply).toBe('Check the estimate here.');

  const quotedTableCell = stripQuotedAndSignature(emailPlainText({
    body_text: '> Old table request',
    body_html: '<table><tr><td class="gmail_quote">Old table request</td></tr></table>',
  }));
  expect(quotedTableCell).toBe('');

  const textQuotedHtmlUnquoted = stripQuotedAndSignature(emailPlainText({
    body_text: 'Hi\n> Please cancel my service\n> > older quote',
    body_html: '<p>Hi</p><p>Please cancel my service</p><blockquote>older quote</blockquote>',
  }));
  expect(textQuotedHtmlUnquoted).toBe('Hi');
});
