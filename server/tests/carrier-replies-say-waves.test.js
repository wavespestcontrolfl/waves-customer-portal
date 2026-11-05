/**
 * The HELP / STOP / START replies name the company "Waves", never "Waves Pest
 * Control" (owner 2026-11-04, "for all texts ... just use waves", then "change"
 * for the consent and carrier texts). Covers the shared reply templates and
 * every TwiML <Message> reply the inbound webhook answers with.
 */
const fs = require('fs');
const path = require('path');
const { HELP_RESPONSE_TEMPLATE, STOP_CONFIRMATION_TEMPLATE } = require('../services/messaging/opt-out-detector');

test('the HELP and STOP replies say "Waves" and keep their carrier wording', () => {
  expect(HELP_RESPONSE_TEMPLATE).toBe('Waves: text or call (941) 297-5749 for support. Reply STOP to opt out. Msg & data rates may apply.');
  expect(STOP_CONFIRMATION_TEMPLATE).toBe("You've been unsubscribed from Waves SMS. Reply START to re-subscribe.");
});

test('every TwiML <Message> reply in the inbound webhook says "Waves", never "Waves Pest Control"', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/twilio-webhook.js'), 'utf8');
  const replies = [...source.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map((m) => m[1]);
  expect(replies.length).toBeGreaterThanOrEqual(3);
  expect(replies.filter((text) => /Waves Pest Control/.test(text))).toEqual([]);
  expect(replies).toEqual(expect.arrayContaining([
    "You've been unsubscribed from Waves SMS. Reply START to re-subscribe.",
    "You've been re-subscribed to Waves SMS.",
    'We received your request to receive texts from Waves. Our office will confirm your subscription shortly.',
  ]));
});
