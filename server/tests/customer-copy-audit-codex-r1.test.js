const r1 = require('../models/migrations/20260926120300_customer_copy_audit_codex_r1');
const email = require('../models/migrations/20260926120100_customer_copy_audit_email');
const { _STEP_SWAPS: steps, _SMS_SWAPS: sms } = require('../models/migrations/20260926120200_customer_copy_audit_automations');
const { countSegments } = require('../services/messaging/segment-counter');
const baseline = require('./fixtures/customer-copy-audit-email-baseline.json');

const KEY = 'payment.microdeposit_verification';
const textOf = ({ subject, preview_text: preview, blocks }) => [
  subject, preview, ...blocks.map((b) => b.content).filter((s) => typeof s === 'string'),
].join('\n');

describe('micro-deposit email covers one deposit or two', () => {
  // The live version once 120100 has run over the production baseline.
  const after120100 = email.applyPatches(baseline.find((t) => t.template_key === KEY),
    email.PATCHES.filter((p) => p.key === KEY)).version;
  const { version, misses } = email.applyPatches(after120100, r1.PATCHES);

  test('every patch matches the 120100 output exactly once', () => {
    expect(misses).toEqual([]);
  });

  test('neither the one-deposit nor the two-deposit customer is told the wrong count', () => {
    const text = textOf(version);
    expect(text).toContain('one or two small test deposits');
    expect(text).toContain('a short code starting with SM, or the deposit amounts');
    expect(text).not.toMatch(/\ba small test deposit\b|\btwo small deposits\b|\bthe two amounts\b/);
  });

  test('placeholders and block structure are unchanged', () => {
    const vars = (s) => [...s.matchAll(/\{\{\s*\w+\s*\}\}/g)].map((m) => m[0]).sort();
    expect(vars(textOf(version))).toEqual(vars(textOf(after120100)));
    expect(version.blocks.map((b) => b.type)).toEqual(after120100.blocks.map((b) => b.type));
  });
});

describe('service_renewal asks a termite-bond customer to renew', () => {
  const { before, after } = r1.RENEWAL;

  test('accepts the original preview and the 120200 one, and nothing else', () => {
    const swapped = steps.find((s) => s.key === 'service_renewal' && s.field === 'preview_text');
    expect(before.preview_text).toEqual([swapped.before, swapped.after]);
    expect(r1.RENEWAL.sms.before).toEqual([sms.find((s) => s.key === 'service_renewal').before,
      sms.find((s) => s.key === 'service_renewal').after]);
  });

  test('no copy promises the bond continues on its own', () => {
    const all = [...Object.values(after), r1.RENEWAL.sms.after].join('\n');
    expect(all).not.toMatch(/continue[sd]? (on the same schedule|as is)|nothing (you need )?to do|not a bill|Nothing changes/i);
    expect(after.html_body).toMatch(/How to renew/);
    expect(r1.RENEWAL.sms.after).toMatch(/To keep coverage active/);
  });

  test('keeps placeholders, the call link, and makes no guarantee', () => {
    const vars = (s) => [...s.matchAll(/\{\{?\s*\w+\s*\}?\}/g)].map((m) => m[0]).sort();
    expect(vars(after.html_body)).toEqual(vars(before.html_body));
    expect(vars(after.text_body)).toEqual(vars(before.text_body));
    expect(after.html_body).toContain('href="tel:+19412975749"');
    expect(Object.values(after).join('\n')).not.toMatch(/guarant|\bsafe(ly)?\b/i);
  });

  test('companion text stays GSM-7 and one segment', () => {
    const rendered = r1.RENEWAL.sms.after.replace('{first_name}', 'Longtestname');
    expect(countSegments(rendered)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
  });
});
