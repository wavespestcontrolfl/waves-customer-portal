'use strict';

const { stripQuotedAndSignature } = require('../services/email/email-strip');

describe('stripQuotedAndSignature', () => {
  test('cuts a Gmail-style "On ... wrote:" quote header and everything after it', () => {
    const body = 'Can you send the estimate by Friday?\n\nOn Mon, Sep 28, 2026 at 3:00 PM, Waves <contact@wavespestcontrol.com> wrote:\n> Sure thing, working on it.';
    expect(stripQuotedAndSignature(body)).toBe('Can you send the estimate by Friday?');
  });

  test('cuts an Outlook "-----Original Message-----" block', () => {
    const body = 'Please call me back today.\n\n-----Original Message-----\nFrom: Waves\nSent: Monday';
    expect(stripQuotedAndSignature(body)).toBe('Please call me back today.');
  });

  test('drops a trailing run of >-quoted lines the header did not catch', () => {
    const body = 'One more thing — can you reschedule?\n> old message line 1\n> old message line 2';
    expect(stripQuotedAndSignature(body)).toBe('One more thing — can you reschedule?');
  });

  test('cuts an RFC 3676 signature delimiter', () => {
    const body = "I'll send the photos tomorrow.\n--\nJane Doe\n555-1234";
    expect(stripQuotedAndSignature(body)).toBe("I'll send the photos tomorrow.");
  });

  test('drops a "Sent from my iPhone" trailer', () => {
    const body = 'Reschedule to Friday please.\nSent from my iPhone';
    expect(stripQuotedAndSignature(body)).toBe('Reschedule to Friday please.');
  });

  test('an ordinary short email with none of these markers passes through unchanged', () => {
    expect(stripQuotedAndSignature('Can you send the estimate?')).toBe('Can you send the estimate?');
  });

  test('empty/null input returns empty string', () => {
    expect(stripQuotedAndSignature(null)).toBe('');
    expect(stripQuotedAndSignature('')).toBe('');
  });
});
