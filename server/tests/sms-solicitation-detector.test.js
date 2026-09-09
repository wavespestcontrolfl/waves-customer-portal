const { isSolicitationPitch } = require('../services/sms-solicitation-detector');

describe('shared SMS vendor-pitch detector', () => {
  test.each([
    null,
    '',
    '   ',
    'Do you offer exclusive rates for new customers?',
    'Can I get unlimited estimates for my rental properties?',
    'Do qualified customers get a discount on pest control?',
    'Our network offers exclusive lawn jobs.',
    'Do you offer unlimited estimates for contractors managing rentals?',
    'We provide housing for contractors. Can we get unlimited estimates for our rentals?',
    'We manage several rentals and can fill your schedule; please quote pest control',
    'We can fill your calendar with rental pest services. Want more details?',
    'I need pest control while we grow our business. Is there a free trial?',
    'Can I get termite service with no upfront cost? Would you like more details?',
    'Can you handle more lawn jobs or handle extra pest estimates?',
    'I need pest control Tuesday; reply NO if you cannot make it.',
  ])('ambiguous customer wording does not establish a pitch: %s', (body) => {
    expect(isSolicitationPitch(body)).toBe(false);
  });

  test.each([
    'Our network offers exclusive lawn leads.',
    'We provide unlimited leads for contractors.',
    'We provide unlimited estimates for contractors.',
    'Our network offers exclusive lawn jobs for local contractors.',
    'Our network offers exclusive lawn jobs. Reply NO to opt out.',
    'We can fill your schedule with our pest marketing service.',
    'We can grow your business. Reply STOP to opt out.',
    'We can fill your calendar with pest jobs. Reply NO if you want us to stop.',
    '$0 upfront cost for our marketing package. Want more details?',
    'Are you open to more booked jobs? Reply "NO" if you need me to stop texting',
  ])('explicit vendor evidence retains the veto: %s', (body) => {
    expect(isSolicitationPitch(body)).toBe(true);
  });
});
