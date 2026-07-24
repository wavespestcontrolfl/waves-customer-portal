// Plan-choice invite copy variants (migration 20260724120000) — copy
// contracts for the SMS + email templates the card-request funnel selects
// when the /secure link opens the plan picker. Pins the dark posture (SMS
// seeded INACTIVE), the truth rules (no dollar amounts, prepay-conditioned
// charge copy), and the same GSM-7/segment budget the base template obeys.

const {
  _SMS_TEMPLATE,
  _TEMPLATES,
} = require('../models/migrations/20260724120000_plan_choice_invite_copy');

describe('SMS variant (secure_appointment_card_plans)', () => {
  test('seeded INACTIVE — the owner reviews the copy in /admin templates before it can ever send', () => {
    expect(_SMS_TEMPLATE.template_key).toBe('secure_appointment_card_plans');
    expect(_SMS_TEMPLATE.is_active).toBe(false);
  });

  test('same variable contract as the base template — the sender renders both with one vars object', () => {
    expect(JSON.parse(_SMS_TEMPLATE.variables)).toEqual(['first_name', 'service_type', 'date_line', 'secure_link']);
  });

  test('copy contract: plan choice framed truthfully, policy + opt-out lines kept, GSM-7 safe, no prices', () => {
    const body = _SMS_TEMPLATE.body;
    expect(body).toContain("pick how you'd like to pay");
    // Truth rule: prepay charges when chosen — "nothing today" must carry
    // the condition, unlike the base template's unconditional line.
    expect(body).toContain('Nothing is charged today unless you choose to prepay');
    expect(body).toContain('{secure_link}');
    expect(body).toContain('We never take card numbers by phone');
    expect(body).toContain('Reply STOP to opt out');
    // GSM-7: an em-dash or curly quote flips the send to UCS-2 and cuts the
    // per-segment budget from 153 to 67 chars.
    expect(body).not.toMatch(/[—’“”]/);
    // card_request policy is allowExactPrice: false — and page pricing is
    // live-derived, so a snapshot price in the text could go stale anyway.
    expect(body).not.toMatch(/\$\s*\d/);
  });

  test('rendered body fits the card_request 3-segment budget with worst-case vars', () => {
    const rendered = _SMS_TEMPLATE.body
      .replace('{first_name}', 'Alexandria')
      .replace('{service_type}', 'Quarterly Pest Control')
      .replace('{date_line}', ' on Wed, Sep 30')
      .replace('{secure_link}', `https://portal.wavespestcontrol.com/secure/${'a'.repeat(64)}`);
    // 3 concatenated GSM-7 segments = 153 × 3 chars.
    expect(rendered.length).toBeLessThanOrEqual(459);
  });
});

describe('email variant (autopay.plan_choice_invitation)', () => {
  const variant = _TEMPLATES.find((t) => t.key === 'autopay.plan_choice_invitation');

  test('exists on the operational stream with financial sensitivity inside the admin enum', () => {
    expect(variant).toBeTruthy();
    const allowed = new Set(['normal', 'financial', 'account', 'health_safety', 'property_sensitive']);
    expect(allowed.has(variant.sensitivity)).toBe(true);
    // An INVITATION must respect operational suppression — never the
    // transactional_required stream the confirmation copies ride.
    expect(variant.stream).toBe('service_operational');
  });

  test('declares the sender-passed variables (charge_timing_line allowed — the sender passes one payload to either template)', () => {
    expect(variant.required).toEqual(expect.arrayContaining(['first_name', 'service_type', 'secure_link']));
    expect(variant.optional).toEqual(expect.arrayContaining(['date_line', 'charge_timing_line']));
  });

  test('truth rules: prepay-conditioned charge copy, no unconditional timing claim, no dollar amounts, CTA rides secure_link', () => {
    const text = variant.blocks.map((b) => String(b.content || '')).join('\n');
    expect(text).toContain('Nothing is charged today unless you choose to prepay');
    // The per-visit auto-charge sentence must be CONDITIONED on the
    // pay-per-visit choice (Codex #2952 class: never promise a charge
    // cadence the customer hasn't picked).
    expect(text).not.toMatch(/only charged after a completed service/i);
    expect(text).toMatch(/pay per visit — a card on file means each completed service is charged automatically/);
    expect(text).not.toMatch(/\$\s*\d/);
    expect(variant.subject).not.toMatch(/\$\s*\d/);
    const cta = variant.blocks.find((b) => b.type === 'cta');
    expect(cta).toMatchObject({ url_variable: 'secure_link' });
    // Bearer-link hygiene line kept from the base invite.
    expect(text).toContain('We never take card numbers by phone');
    expect(text).toContain('please do not forward it');
  });
});
