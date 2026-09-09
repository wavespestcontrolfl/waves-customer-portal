const { isSolicitationPitch } = require('../services/sms-solicitation-detector');

describe('shared SMS vendor-pitch detector', () => {
  test.each([
    null,
    '',
    '   ',
    'I have two leads for you: my neighbors both need pest control. Can you quote them?',
    'I have more lawn leads for you from my neighbors. Can you quote them?',
    'I can send extra pest leads from my neighborhood. Can you contact them?',
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
  ])('ambiguous customer wording does not establish a pitch: %s', (body) => {
    expect(isSolicitationPitch(body)).toBe(false);
  });

  test.each([
    'Our network offers exclusive lawn leads.',
    'We can provide more lawn leads.',
    'We have extra qualified pest leads.',
    'More pest leads for you. Reply STOP to opt out.',
    'We provide unlimited leads for contractors.',
    'We provide unlimited estimates for contractors.',
    'Our network offers exclusive lawn jobs for local contractors.',
    'Our network offers exclusive lawn jobs. Reply NO to opt out.',
    'We can fill your schedule with our pest marketing service.',
    'We can grow your business. Reply STOP to opt out.',
    'We can grow your business with booked pest jobs',
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
