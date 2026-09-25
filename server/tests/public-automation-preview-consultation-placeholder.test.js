/**
 * The tokenized public preview of an automation step must never show the
 * consultation-booking template syntax (Codex #4813 r4 P2) — it renders the
 * step as a non-recurring lead receives it.
 */
jest.mock('../models/db', () => jest.fn());
const preview = require('../routes/public-automation-preview');

const fill = preview._test?.fill;

describe('public automation preview — consultation placeholders', () => {
  test('fill() strips both placeholders (spaced or not) and their trailing newline', () => {
    expect(typeof fill).toBe('function');
    const html = "<h2>Hi {{first_name}}</h2>\n{{consultation_booking}}\n<h2>What's next</h2>";
    const text = 'Hi {{first_name}}. {{ consultation_booking_text }}\nReply with your address.';
    expect(fill(html)).toBe("<h2>Hi Friend</h2>\n<h2>What's next</h2>");
    expect(fill(text)).toBe('Hi Friend. Reply with your address.');
    expect(fill(html)).not.toContain('{{');
  });
});
