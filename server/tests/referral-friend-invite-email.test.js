const engine = require('../services/referral-engine');
const { renderTemplate } = require('../services/email-template-library');

describe('referee offer line (referral.friend_invite copy)', () => {
  test('states the configured referee discount from live settings', () => {
    const line = engine.buildRefereeOfferLine({ referee_discount_cents: 2500 });
    expect(line).toContain('$25 off');
    expect(line).toContain('referral link');
  });

  test('renders non-whole-dollar discounts with cents', () => {
    expect(engine.buildRefereeOfferLine({ referee_discount_cents: 4999 })).toContain('$49.99 off');
  });

  test('drops the amount cleanly when no referee discount is configured', () => {
    const line = engine.buildRefereeOfferLine({ referee_discount_cents: 0 });
    expect(line).not.toMatch(/\$\d/);
    expect(line).toContain('referral link');
  });

  test('treats missing settings as no discount rather than throwing', () => {
    expect(() => engine.buildRefereeOfferLine()).not.toThrow();
    expect(engine.buildRefereeOfferLine({})).not.toMatch(/\$\d/);
  });
});

describe('referral.friend_invite renders as a branded friend-facing email', () => {
  // Mirrors the seeded template (20260708000002). Pinned to service glass
  // chrome while riding the marketing_referral stream, exactly like
  // referral.invite.
  const template = {
    template_key: 'referral.friend_invite',
    name: 'Referral Invite (to a friend)',
    mode: 'service',
    layout_wrapper_id: 'service_pinned_v1',
    send_stream: 'marketing_referral',
    suppression_group_key: 'marketing_referral',
    allowed_variables: JSON.stringify(['company_phone', 'company_email', 'referrer_name', 'referral_url', 'referral_offer_line', 'friend_name']),
    required_variables: JSON.stringify(['referrer_name', 'referral_url', 'referral_offer_line']),
  };
  const version = {
    id: 1,
    subject: '{{referrer_name}} thinks you’ll like Waves Pest Control',
    preview_text: 'A referral from {{referrer_name}} — and a little something for your first service.',
    blocks: JSON.stringify([
      { type: 'paragraph', content: 'Hi {{friend_name}}, {{referrer_name}} is a Waves Pest Control customer and thought you might want our info.' },
      { type: 'paragraph', content: '{{referral_offer_line}}' },
      { type: 'small_note', content: 'Waves is a family-owned pest control and lawn care company serving Manatee, Sarasota, and Charlotte counties — we treat your home like our own.' },
      { type: 'cta', label: 'See your referral offer', url_variable: 'referral_url' },
      { type: 'signature', content: 'Hope to see you soon. — The Waves Team' },
    ]),
    text_body: null,
  };

  const payload = {
    friend_name: 'Jordan',
    referrer_name: 'Taylor',
    referral_url: 'https://portal.wavespestcontrol.com/r/WAVES-J4KM',
    referral_offer_line: engine.buildRefereeOfferLine({ referee_discount_cents: 2500 }),
  };

  test('greets the friend, names the referrer, and carries the referral link', () => {
    const rendered = renderTemplate({ template, version, payload });
    expect(rendered.subject).toBe('Taylor thinks you’ll like Waves Pest Control');
    expect(rendered.html).toContain('Hi Jordan');
    expect(rendered.html).toContain('Taylor');
    expect(rendered.html).toContain('$25 off');
    // CTA points at the promoter's referral link.
    expect(rendered.html).toContain('href="https://portal.wavespestcontrol.com/r/WAVES-J4KM"');
    // No unresolved template variables leaked into the send.
    expect(rendered.html).not.toContain('{{');
    expect(rendered.missingPayload).toEqual([]);
  });

  test('renders in the branded glass chrome', () => {
    const rendered = renderTemplate({ template, version, payload });
    // The glass wrapper stamps the 2026 logo + the cool page wash.
    expect(rendered.html).toContain('waves-logo-2026.png');
    expect(rendered.html.toLowerCase()).toContain('background');
  });
});
