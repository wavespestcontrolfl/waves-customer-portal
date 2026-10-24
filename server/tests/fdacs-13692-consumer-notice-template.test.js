// The FDACS-13692 Consumer Notice Form template reproduces the state form
// (Rev. 07/21) and fills only the company name, the consumer's printed name
// and the representative's typed electronic signature and date.
const { TEMPLATE } = require('../models/migrations/20261024140000_seed_fdacs_13692_consumer_notice');
const { renderDocumentTemplate } = require('../services/document-template-library');

describe('FDACS-13692 consumer notice template', () => {
  test('carries the state form text, both pages, and its revision footer', () => {
    const body = TEMPLATE.body;
    expect(body).toContain('**CONSUMER NOTICE FORM**');
    expect(body).toContain('**Formulario de Aviso al Consumidor**');
    expect(body).toContain('A pest control company must give you a written contract prior to any treatment of each wood-destroying organism.');
    expect(body).toContain('**BASIC REQUIREMENTS FOR CONTRACTS**');
    expect(body).toContain('**REQUIREMENTS FOR STATING WHEN TREATMENT OR REPAIR WILL NOT BE COVERED BY THE CONTRACT**');
    expect(body).toContain('The law does require that companies notify you if they see conditions which would void the repair promise');
    expect(body).toContain('850-617-7996 or email: biircomplaints@fdacs.gov.');
    expect(body.match(/FDACS-13692 Rev\. 07\/21/g)).toHaveLength(2);
    expect(body).toContain('I understand that I am entering into a contract with Waves Pest Control, LLC (fill in company name)');
    expect(body).toContain('Entiendo que estoy aceptando el contrato establecido por Waves Pest Control, LLC (coloque el nombre de la compania)');
  });

  test('declares every field it fills, and renders with nothing left unresolved', () => {
    const used = [...new Set([...TEMPLATE.body.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();
    expect(used).toEqual([...TEMPLATE.variables].sort());
    const rendered = renderDocumentTemplate({
      template: TEMPLATE,
      version: { title: TEMPLATE.title, body: TEMPLATE.body },
      context: { customer: { name: 'Example Homes LLC' }, issuer: { name: 'Pat Office', date: '10/24/2026' } },
    });
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).toContain('Print Name of Consumer: Example Homes LLC');
    expect(rendered.body).toContain('Signature of Pest Control Representative: /s/ Pat Office (electronic signature for the company)');
    expect(rendered.body).toContain('Title: Property Owner or authorized agent');
  });
});
