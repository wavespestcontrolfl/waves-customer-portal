/**
 * Collections script: every fixed line speaks the number the call presented
 * as caller ID (call_log.from_phone — the customer's home line under
 * GATE_HOME_LINE), falling back to the main line when it is absent/unknown.
 */
const script = require('../services/collections/outbound-voice/script');

describe('collections script callback number', () => {
  const PARRISH = '+19412972817';
  const lines = (callerId) => [
    script.callbackNumberOnly(callerId),
    script.callbackPromise(callerId),
    script.transferMissedCallback(callerId),
    script.genericCallbackVoicemail(callerId),
    script.verificationFailedClose(callerId),
  ];

  test('speaks the caller-ID line in every fixed line', () => {
    for (const line of lines(PARRISH)) expect(line).toContain('(941) 297-2817');
  });

  test('no / unknown caller ID → the main line, as before', () => {
    for (const line of [...lines(undefined), ...lines('+15550000000')]) expect(line).toContain('(941) 297-5749');
  });
});
