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
    'Waves Pest Control LLC', 'Waves Pest Control – LLC',
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
    'Waves Exterminating',
    'WaVeS ExTeRmInAtInG',
  ])('rejects a noncanonical service company name: %s', (brand) => rejected(`You contacted ${brand}.`));

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
