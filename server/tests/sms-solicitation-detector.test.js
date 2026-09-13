const { isSolicitationPitch } = require('../services/sms-solicitation-detector');

describe('shared SMS vendor-pitch detector', () => {
  test.each([
    null,
    '',
    '   ',
    'I have two leads for you: my neighbors both need pest control. Can you quote them?',
    'I have more lawn leads for you from my neighbors. Can you quote them?',
    'I can send extra pest leads from my neighborhood. Can you contact them?',
    'I can send you more pest-control leads from my neighbors. Can you quote them?',
    'I can bring you extra lawn leads from my neighborhood. Can you contact them?',
    'We can provide you with more lawn leads from our neighbors who need service.',
    'I can send you more pest leads: my neighbors both need service.',
    'My neighbors need service; I can send you more pest leads.',
    'My neighbors need service. I can send you more pest-control leads; can you quote them?',
    'I can provide you with more lawn leads. They are my neighbors and need quotes.',
    'I can send you more pest leads.\nThey are from my neighborhood.',
    'I can provide you with estimates from other pest companies; do you price match?',
    'My company can send more lawn leads from our neighbors. Can you quote them?',
    'My company can provide measurements of our rentals. Can we get unlimited estimates?',
    'Our company can fill your schedule with pest service for our rentals. Can you quote it?',
    'Can you send me more details about pest-control leads at my rental?',
    'Do you offer exclusive rates for new customers?',
    'Can I get unlimited estimates for my rental properties?',
    'Do qualified customers get a discount on pest control?',
    'We have qualified pest customers at our rentals. Can you quote service?',
    'Do you provide qualified pest customers with a discount?',
    'We provide housing; can qualified pest customers get estimates?',
    'We provide exclusive housing for customers and need pest control.',
    'Our network offers exclusive lawn jobs.',
    'Do you offer unlimited estimates for contractors managing rentals?',
    'We provide housing for contractors. Can we get unlimited estimates for our rentals?',
    'We provide estimates for contractors and need pest control for our office. Would you like more details?',
    'My company can offer estimates for local contractors. Can you quote termite treatment for our office? Want more details?',
    'I provide lawn-care estimates for contractors; our office needs pest control. Want more details?',
    'We provide housing; can you send pest control estimates for contractors staying here? Would you like more details?',
    'We provide housing and need estimates for contractors staying here. Want more details?',
    'We manage several rentals and can fill your schedule; please quote pest control',
    'We can fill your calendar with rental pest services. Want more details?',
    'I need pest control while we grow our business. Is there a free trial?',
    'Can you quote pest control while we grow our business?',
    'We have more pest jobs at our rentals. Can you quote service?',
    'Can I get termite service with no upfront cost? Would you like more details?',
    'Can you handle more lawn jobs or handle extra pest estimates?',
    'I need pest control Tuesday; reply NO if you cannot make it.',
    // Codex P1, 2026-09-11: a strong marker ("qualified/exclusive/unlimited
    // leads") had no neighbor-context veto, so a genuine referral phrased
    // with that wording was misread as a confident vendor pitch.
    'I have three qualified leads for you—my neighbors all need pest control. Can you quote them?',
    'My neighbors all need pest control. I have three qualified leads for you. Can you quote them?',
    'I have unlimited leads for you from our neighbors who need lawn care.',
    // Codex P1, 2026-09-11: lead_supplier's own veto covered neighbor
    // context only, so a friend/family referral still enforced.
    'I can provide you with more pest-control leads. They are my friends who need quotes. Can you quote them?',
    'I can send you more lawn leads. They are my family and need service.',
    // Codex P1, 2026-09-11: a strong marker (sender_work_offer) hit a
    // genuine multi-property service request at confidence 1 — the veto
    // now applies to the whole class of strong markers, not just the
    // referral-shaped ones.
    'We have qualified pest control jobs available at five rental homes we manage. Can you quote all of them?',
    "I'm the property manager for three units; can you quote pest control for all of them?",
    'We manage several rental properties and need service for all of them. Can we get unlimited estimates?',
    // Codex P1 follow-up, 2026-09-11: first-person "I manage" (not just
    // "we manage") and scheduling language (not just "quote") are also
    // service-request wording, not vendor-pitch evidence.
    'I manage five apartment buildings; we have qualified pest-control jobs available. Can you schedule them?',
    'I manage this property. We have exclusive pest-control jobs available. Can we schedule service?',
  ])('ambiguous customer wording does not establish a pitch: %s', (body) => {
    expect(isSolicitationPitch(body)).toBe(false);
  });

  test.each([
    // Paired negative for the friend/family veto above: the same
    // lead_supplier wording with no referral context still enforces.
    'I can provide you with more pest-control leads for your business.',
    // Paired negative for the multi-property veto above: a pure vendor
    // pitch with no request for our own service still enforces.
    'We have qualified pest control jobs available. Want to partner with us?',
    'Our network offers exclusive lawn leads.',
    'We can provide more lawn leads.',
    'We can send you more pest-control leads.',
    'We can provide you with more lawn leads.',
    'We can bring you extra pest control leads.',
    'I can offer you more lawn leads.',
    'Our company can send more lawn leads.',
    'My company can send you more lawn leads.',
    'My team can bring you extra pest-control leads.',
    'My network can provide qualified pest customers.',
    'My company can offer unlimited pest jobs available.',
    'My team can provide unlimited estimates for contractors.',
    'We have extra qualified pest leads.',
    'More pest leads for you. Reply STOP to opt out.',
    'We provide unlimited leads for contractors.',
    'We provide unlimited estimates for contractors.',
    'We provide you with estimates for contractors. Want more details?',
    'Our company could offer you pest-control estimates for local contractors. Reply STOP to opt out.',
    'We can provide unlimited estimates for contractors.',
    'I provide unlimited estimates for contractors.',
    'Our company could offer qualified pest jobs for local contractors.',
    'We provide you with unlimited estimates for local contractors.',
    'I can offer you qualified pest-control customers.',
    'Our network can provide you with qualified pest jobs available.',
    'We can offer you unlimited lawn-care jobs available.',
    'We provide you with unlimited pest-control estimates for contractors.',
    'Our network offers exclusive lawn jobs for local contractors.',
    'Our network offers exclusive lawn jobs. Reply NO to opt out.',
    'We can fill your schedule with our pest marketing service.',
    'We can grow your business. Reply STOP to opt out.',
    'We can grow your business with booked pest jobs',
    'Our company can grow your business with booked pest jobs',
    'My network could help you scale your business',
    'We have unlimited pest jobs available in your area',
    'We provide qualified pest customers in your area',
    'I offer exclusive lawn care customers in your area',
    'Our network provides unlimited new customers',
    'We can offer qualified local customers',
    'We can fill your calendar with pest jobs. Reply NO if you want us to stop.',
    '$0 upfront cost for our marketing package. Want more details?',
    'Are you open to more booked jobs? Reply "NO" if you need me to stop texting',
  ])('explicit vendor evidence retains the veto: %s', (body) => {
    expect(isSolicitationPitch(body)).toBe(true);
  });
});
