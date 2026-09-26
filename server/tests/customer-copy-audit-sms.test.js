const { _SWAPS: swaps } = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { countSegments } = require('../services/messaging/segment-counter');

// Realistic, long-side personalization. Unknown placeholders render as a
// ten-character stand-in so every template can be measured.
const sample = {
  first_name: 'Longtestname', service_type: 'Quarterly Pest Control', service_label: 'Quarterly Pest Control',
  tech_name: 'Jonathan', day: 'Tuesday', date: 'Sep 15', time: '9:00 AM', when: 'this morning',
  window: 'between 9:00 AM and 11:00 AM', window_text: ', between 9:00 AM and 11:00 AM',
  start_date: 'Tuesday, Oct 7', resume_date: 'Oct 7', effective_date: 'Oct 1, 2026', visit_date: 'Oct 7',
  service_date: 'Sep 15', first_visit_date: 'Oct 7', new_expiry: 'Oct 30', service_timing: 'tomorrow',
  service_date_clause: ' completed on Sep 12', invoice_title: 'Quarterly Pest Control', invoice_number: 'INV-10442',
  amount: '186.40', deposit_amount: '50.00', amount_text: ' for $1,236.00', card_line: ' (Visa ending 4242)',
  eta_line: 'ETA: 25 minutes.\n', track_clause: 'Track live: https://portal.wavespestcontrol.com/t/abcdefghjk\n\n',
  pay_url: 'https://portal.wavespestcontrol.com/l/xxxxxxxxxxxxx-0915-abcdefghjk',
  pay_link: 'https://portal.wavespestcontrol.com/l/xxxxxxxxxxxxx-0915-abcdefghjk',
  portal_url: 'https://portal.wavespestcontrol.com/l/abcdefghjk',
  report_url: 'https://portal.wavespestcontrol.com/l/abcdefghjk',
  receipt_url: 'https://portal.wavespestcontrol.com/l/abcdefghjk',
  billing_url: 'https://portal.wavespestcontrol.com/l/abcdefghjk',
  estimate_url: 'https://portal.wavespestcontrol.com/e/abcdefghjk',
  booking_url: 'https://portal.wavespestcontrol.com/b/abcdefghjk',
  price_change_url: 'https://portal.wavespestcontrol.com/l/abcdefghjk',
  reschedule_line: 'Reschedule here: https://portal.wavespestcontrol.com/l/abcdefghjk\n\n',
  appointment_line: 'Everything about your visit: https://portal.wavespestcontrol.com/l/abcdefghjk\n\n',
  card_hold_policy_line: '\n\nYour card on file holds this visit - cancel free until September 14 at 9:00 AM. After that, a $50 fee applies only if you cancel or no one is home. Rescheduling is always free.',
};
const render = body => normalizeGsmPunctuation(stripSmsUrlScheme(body.replace(/\{(\w+)\}/g, (_, key) => (
  key in sample ? sample[key] : 'XXXXXXXXXX'
)))).replace(/\n{3,}/g, '\n\n').trim();
const placeholders = body => [...body.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();

// Templates whose sender or body carries a bad-news fact: no cheerful "!" opener.
const BAD_NEWS = [
  'appointment_cancelled', 'appointment_no_show', 'appointment_series_cancelled', 'payment_failed',
  'service_cancellation_received', 'service_cancellation_confirmation',
  'service_cancellation_end_of_term_confirmation', 'service_cancellation_scoped_confirmation',
  'previsit_balance_reminder', 'balance_reminder_gentle', 'balance_reminder_firm', 'balance_reminder_urgent',
  'invoice_followup_3day', 'invoice_followup_7day', 'invoice_followup_14day', 'invoice_followup_30day',
  'late_payment_7d', 'late_payment_14d', 'late_payment_30d', 'late_payment_60d', 'late_payment_90d',
];

test('covers 60 distinct templates, each an actual change', () => {
  expect(swaps).toHaveLength(60);
  expect(new Set(swaps.map(([key]) => key)).size).toBe(60);
  for (const [, before, after] of swaps) expect(after).not.toBe(before);
});

test.each(swaps)('%s keeps every placeholder, opt-out and link', (key, before, after) => {
  expect(placeholders(after)).toEqual(placeholders(before));
  expect(after.includes('Reply STOP to opt out.')).toBe(before.includes('Reply STOP to opt out.'));
});

test.each(swaps)('%s stays GSM-7 and adds no segment', (key, before, after) => {
  const rendered = render(after);
  expect(countSegments(rendered).encoding).toBe(countSegments(render(before)).encoding);
  expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(countSegments(render(before)).segmentCount);
  expect(after).not.toMatch(/[–—‘’“”]/);
});

test.each(swaps)('%s names Waves', (key, before, after) => {
  expect(after).toMatch(/\bWaves\b/);
});

test.each(BAD_NEWS)('%s does not open a bad-news text with an exclamation', key => {
  const after = swaps.find(([k]) => k === key)[2];
  expect(after.startsWith('Hello {first_name},')).toBe(true);
});

test('compliance idiom: no safety claims and no fixed re-entry times', () => {
  for (const [, , after] of swaps) {
    expect(after).not.toMatch(/\bsafe(ly)?\b/i);
    expect(after).not.toMatch(/\b\d+\s*(minutes?|hours?)\b.*\b(re-?enter|return|dry)\b/i);
  }
});

test('factual corrections', () => {
  const body = key => swaps.find(([k]) => k === key)[2];
  // stripe-webhook stamps expected clearing at five business days.
  expect(body('ach_payment_processing')).toContain('within 5 business days');
  expect(body('ach_payment_processing')).not.toContain('3-5');
  // Prep guide: 18 inches, follow-up visits (plural).
  expect(body('auto_bed_bug_no_email')).toContain('18 in.');
  expect(body('auto_bed_bug_no_email')).not.toContain('12-18');
  expect(body('auto_bed_bug_no_email')).toContain('before each follow-up visit');
  // Prep guide: every pet treated the same day.
  expect(body('auto_flea_no_email')).toContain('Treat every pet the same day');
  // The late-payment job sends 60- and 90-day notices after this one.
  expect(body('invoice_followup_30day')).not.toMatch(/final/i);
  expect(body('price_change_notice')).not.toContain('Nothing you need to do');
});
