const verifier = require('../services/email/email-reply-company-verifier');

const { verifyEmailReplyCompanyName } = verifier;
const verdict = (text) => verifyEmailReplyCompanyName({ text });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply company-name policy', () => {
  test('exports only the company-name policy', () => {
    expect(verifier).toEqual({ verifyEmailReplyCompanyName });
    expect(verdict('')).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Waves Lawn & Pest', 'Waves Lawn and Pest', 'Waves  Lawn & Pest',
    'Waves Lawn-Pest', 'Waves Lawn + Pest', 'Waves Lawn/Pest',
    'Waves Pest & Lawn', 'Waves Pest Control and Lawn', 'Waves Pest / Lawn',
    'Waves Pest Control & Lawn Care',
    'Waves Pest Control LLC', 'Waves Pest Control – LLC', 'Waves Pest Control \\- LLC',
    'Waves Pest Control Group', 'Waves Pest Control Florida',
    'Waves Pest Control Pest Services',
    'Waves Lawn Care', 'Waves Pest Services', 'Waves **Lawn Care**',
    'Waves Lawn Services', 'Waves Pest', 'Waves Lawn',
  ])('rejects a retired or alternate company name: %s', (brand) => rejected(`You contacted ${brand}.`));

  test.each([
    'Waves Termite Control',
    'WAVES TERMITE CONTROL',
    'Waves Mosquito Services',
    'waves mosquito services',
    'Waves Rodent Control',
    'Waves Wildlife Services',
    'Waves Exterminating',
    'WaVeS ExTeRmInAtInG',
  ])('rejects a noncanonical service company name: %s', (brand) => rejected(`You contacted ${brand}.`));

  test('screens the rendered company name through nested emphasis and inline code', () => {
    rejected('You contacted **Waves *Termite* Control**.');
    rejected('You contacted Waves `Termite` Control.');
    rejected('You contacted Waves ``Termite`` Control.');
    expect(verdict('You contacted **Waves *Pest* Control**.'))
      .toEqual({ ok: true, violations: [] });
    expect(verdict('You contacted Waves `Pest` Control.'))
      .toEqual({ ok: true, violations: [] });
    expect(verdict('You contacted Waves ``Pest`` Control.'))
      .toEqual({ ok: true, violations: [] });
    expect(verdict('You contacted Waves `Pest Control.'))
      .toEqual({ ok: true, violations: [] });
    expect(verdict('The note contains Waves ``Termite` Control punctuation.'))
      .toEqual({ ok: true, violations: [] });
    expect(verdict('The note contains Waves `Termite`` Control punctuation.'))
      .toEqual({ ok: true, violations: [] });
  });

  test('distinguishes name-shaped aliases from ordinary waves prose', () => {
    expect(verdict('Sound waves pest repellers can be ineffective.'))
      .toEqual({ ok: true, violations: [] });
    expect(verdict('Sound waves mosquito control devices can be ineffective.'))
      .toEqual({ ok: true, violations: [] });
    rejected('You contacted waves mosquito services.');
    rejected('You contacted waves pest.');
    rejected('The company name is waves wildlife services.');
    rejected('waves MOSQUITO SERVICES will follow up.');
    rejected('Thank you for choosing waves Termite Control.');
  });

  test('allows service descriptors only when they lead into a canonical company team role', () => {
    expect(verdict('The Waves Pest Control lawn care team will follow up.'))
      .toEqual({ ok: true, violations: [] });
    expect(verdict('The Waves Pest Control wildlife services crew will follow up.'))
      .toEqual({ ok: true, violations: [] });
    rejected('You contacted Waves Pest Control lawn care.');
    rejected('The Waves Pest Control lawn care division will follow up.');
  });

  test.each([
    'Waves Pest Control will follow up.',
    'The Waves Pest Control lawn team will follow up.',
    'The Waves Pest Control termite team will follow up.',
    'The Waves Pest Control mosquito team will follow up.',
    'The ocean waves are calm today.',
    'The waves may affect the shoreline.',
    'Service is USD 98 per visit.',
    'This treatment has the EPA’s certification.',
  ])('accepts the canonical company name and ordinary prose: %s', (copy) => {
    expect(verdict(copy)).toEqual({ ok: true, violations: [] });
  });
});
