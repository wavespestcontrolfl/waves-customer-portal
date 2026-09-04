// The seeded payment.autopay_setup_link email (email arm of the standalone
// Auto Pay setup link) must resolve the variables the service sends and
// carry the CTA on the secure link — a drift here is a template render
// failure at the first office click.
const { __private } = require('../models/migrations/20260904000030_seed_autopay_setup_link_email');

test('template declares exactly the variables autopay-setup-link.js sends, with the CTA on secure_link', () => {
  const [t] = __private.TEMPLATES;
  expect(t.key).toBe('payment.autopay_setup_link');
  expect(__private.REQUIRED).toEqual(['first_name', 'secure_link']);
  expect(__private.VARIABLES.sort()).toEqual(['expires_on', 'first_name', 'secure_link']);
  const used = new Set(JSON.stringify(t.blocks).match(/\{\{(\w+)\}\}/g).map((m) => m.slice(2, -2)));
  for (const v of used) expect(__private.VARIABLES).toContain(v);
  const cta = t.blocks.find((b) => b.type === 'cta');
  expect(cta.url_variable).toBe('secure_link');
  const row = __private.templateRow(t);
  expect(row).toEqual(expect.objectContaining({
    status: 'active',
    audience: 'customer',
    // Operational outreach, like autopay.setup_invitation — honors that unsubscribe.
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
    default_cta_url_variable: 'secure_link',
    from_email: 'contact@wavespestcontrol.com',
  }));
  // Lane-neutral charge unit + no-card-numbers-by-phone promise, same as the SMS.
  const body = JSON.stringify(t.blocks);
  expect(body).toMatch(/each completed service is paid automatically/);
  expect(body).toMatch(/Nothing is charged today/);
  expect(body).not.toMatch(/each visit/);
  // Tender-neutral: the page is card-only unless ACH capture is on and healthy.
  expect(body).not.toMatch(/bank account/i);
});
