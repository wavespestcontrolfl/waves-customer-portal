// The pest Service Details guide (estimate-service-details.js pest_control) and the estimate card's included line
// (PriceCard.jsx) follow the owner's later rulings. Found by the pest outline review (2026-10-26).
//
// Pins: the inside rule (owner 2026-10-22: first visit inside, then whenever the customer asks; someone home or
// access); rain speaks to effectiveness only, with no re-service promise or call-back prompt (owner 2026-10-22 "rain
// washing a treatment off = we do NOT come back", 2026-10-24 "i dont want to prompt them to call us back because of
// rain"); no re-service timing (owner 2026-09-28); the bifenthrin is Atticus Talak 7.9 F, not Talstar P (owner
// 2026-09-11, 2026-10-24); no microencapsulated claim (owner 2026-10-26: no Demand CS); no surfactant image (owner
// walkthrough 2026-10-03: surfactant dropped from pest stops). Every new line passes the customer-copy screens.

const fs = require('fs');
const path = require('path');
const { SERVICE_DETAILS_COPY } = require('../services/estimate-service-details');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const pest = SERVICE_DETAILS_COPY.pest_control;
const faq = (pattern) => pest.faq.find((item) => pattern.test(item.q)).a;
const row = (label) => pest.systemBox.rows.find(([name]) => name === label)[1];
const text = JSON.stringify(pest);

describe('pest guide follows the owner rulings', () => {
  test('inside service: the first visit, then whenever the customer asks', () => {
    expect(row('Interior service')).toBe('Your first visit includes an inside spray; after that, inside whenever you ask. Someone home or access needed. Exterior-only plans: ask the office to add it.');
    expect(pest.included).toContain('Interior treatment on the first visit, then whenever you ask');
    expect(faq(/interior included/)).toMatch(/^Included for the pests your recurring plan covers — your first visit includes an inside spray, and on later visits we treat inside whenever you ask/);
    expect(faq(/need to be home/)).toContain('For the inside, someone needs to be home or you leave us access; with nobody home, we treat the outside and note it.');
    // A recurring customer can turn interior spraying off on the estimate (estimate-public.js SERVICE_PREFS): the
    // inside promise keeps the exterior-only exception, as sms-company-facts.js does (Codex #6447 r4).
    expect(faq(/interior included/)).toContain('If you chose exterior-only service, you can ask the office to add inside service back.');
    expect(pest.process.find((line) => line.startsWith('Interior service is included'))).toContain('If you chose exterior-only service, ask the office to add inside service.');
    expect(text).not.toMatch(/whenever you report activity|when activity is reported|part of your pest visits/);
  });

  test('the estimate card says the same inside rule', () => {
    const card = fs.readFileSync(path.join(__dirname, '../../client/src/components/estimate/PriceCard.jsx'), 'utf8');
    expect(card).toContain("'Interior treatment on the first visit, then whenever you ask',");
    expect(card).not.toContain('Interior service support when activity is reported');
  });

  test('rain: effectiveness only, no re-service and no prompt to contact us', () => {
    const rain = faq(/rains/);
    expect(rain).toContain('No application is weatherproof: a treatment needs to dry and bond to surfaces, and after that it holds up to weather.');
    // What the technician does at a rainy stop is not decided (walkthrough 2026-10-03 "left open"), so no line says.
    expect(rain).not.toMatch(/re-service|contact us|text us|call us|microencapsulated|dry window|come back/i);
  });

  test('ants: no re-service timing; a photo between visits', () => {
    const ants = faq(/still see ants/);
    expect(ants).toContain('If you still see activity between visits, text us a photo — a re-service between visits is free and doesn’t move your next visit.');
    expect(ants).not.toMatch(/\d\s*(–|-|to)\s*\d+\s*days|several days/);
  });

  test('no die, dead, dying or kill words (owner 2026-10-01)', () => {
    expect(text).not.toMatch(/\b(kill|kills|killed|killing|die|dies|dead|dying)\b/i);
  });

  test('the bifenthrin is Atticus Talak 7.9 F, and the images are Taurus only', () => {
    expect(text).not.toMatch(/Talstar/);
    expect(row('Primary solutions')).toContain('Atticus Talak 7.9 F (bifenthrin)');
    expect(pest.productImages.images.map((image) => image.file)).toEqual(['product-taurus-sc.png']);
  });

  test('the outside band line: a normal visit, the label, the inspection', () => {
    expect(pest.process).toContain('On a normal visit, where the label allows, the technician treats a residual band around the house and on the covered eaves, the garage and the lanai or pool cage, placed from the inspection — never an automatic pass over every wall, plant, and surface.');
  });

  test('every changed line passes the customer-copy screens', () => {
    const changed = [
      row('Interior service'),
      row('Primary solutions'),
      'Interior treatment on the first visit, then whenever you ask',
      pest.process.find((line) => line.startsWith('On a normal visit')),
      pest.process.find((line) => line.startsWith('Interior service is included')),
      faq(/interior included/),
      faq(/rains/),
      faq(/still see ants/),
      faq(/need to be home/),
    ];
    for (const line of changed) {
      expect({ line, banned: findBannedCustomerCopy(line) }).toEqual({ line, banned: [] });
      expect({ line, valid: validateCustomerCopy(line) }).toEqual({ line, valid: true });
    }
  });
});
