const { sourceSchema, policySchema, validate, renderSource, checkRelease, hash } = require('../services/staff-document-source');
const { recordAnswers, parseSignedName, hasSignatureField } = require('../services/staff-documents');
const { validateTemplatePayload } = require('../services/document-template-library');
const starters = require('../services/staff-document-starters');

const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const source = (body = '## PTO {#pto-accrual}\nAccrual: {{policy.pto_accrual}}.') => ({ title: 'QA policy', body,
  metadata: { owner_role: 'Office Manager', review_on: day(30), citations: [], fields: [] } });
const values = { pay_frequency: 'weekly', pay_schedule: 'QA schedule', pto_accrual: [{ after_years: 0, hours_per_year: 40 }], paid_holidays: [], unpaid_holidays: [], equipment_deduction_terms: 'QA terms' };

test('all starters are valid, have stable anchors and remain blocked by explicit owner decisions', () => {
  for (const starter of starters) {
    validate(sourceSchema, starter.source);
    const rendered = renderSource(starter.source, values);
    expect(rendered.sections.length).toBeGreaterThan(0);
    expect(rendered.unresolved.join(' ')).toMatch(/DECISION/);
    expect(() => checkRelease(starter.source, rendered, new Date())).toThrow(/owner/);
  }
});
test('shared values render consistently while prior rendered copies and hashes remain unchanged', () => {
  const original = renderSource(source(), values);
  const originalHash = hash(original);
  const revision = renderSource(source(), { ...values, pto_accrual: [{ after_years: 0, hours_per_year: 80 }] });
  expect(original.body).toContain('40 hours');
  expect(revision.body).toContain('80 hours');
  expect(hash(original)).toBe(originalHash);
  expect(hash(revision)).not.toBe(originalHash);
  expect(hash({ b: 2, a: 1 })).toBe(hash({ a: 1, b: 2 }));
});
test('unresolved shared values and owner decisions fail issuance', () => {
  expect(() => checkRelease(source(), renderSource(source()), new Date())).toThrow(/Resolve/);
  for (const marker of [
    '[DECISION: choose the approver]',
    '[OWNER: confirm 15% and 40%]',
    '[CPA: overtime check]',
    '[LAWYER/CPA: regular rate]',
    '[To write: level rules]',
    '[BAR]',
  ]) {
    const blocked = source(`## Authority {#authority}\n${marker}`);
    expect(() => checkRelease(blocked, renderSource(blocked, values), new Date())).toThrow(/Resolve/);
  }
});
test('renders markdown pipe tables, ordered lists, and mixed paragraph+bullet blocks safely', () => {
  const md = [
    '## Pay examples {#pay-examples}',
    '**1. Step one.**',
    '- Bullet A',
    '- Bullet B',
    '',
    '1. First item',
    '2. Second item',
    '',
    '| Week | Pay |',
    '|---|---|',
    '| Slow | **$920** |',
    '| Strong | <script>alert(1)</script> |',
  ].join('\n');
  const html = renderSource(source(md), values).sections[0].html;
  expect(html).toContain('<p><strong>1. Step one.</strong></p>');
  expect(html).toContain('<ul><li>Bullet A</li><li>Bullet B</li></ul>');
  expect(html).toContain('<ol><li value="1">First item</li><li value="2">Second item</li></ol>');
  expect(html).toContain('<table><thead><tr><th>Week</th><th>Pay</th></tr></thead>');
  expect(html).toContain('<td><strong>$920</strong></td>');
  expect(html).not.toContain('<script>');
  expect(html).toMatch(/&(?:lt|#x3C);script/);
});
test('shared values cannot issue with embedded decision markers or merge placeholders', () => {
  for (const pay_schedule of ['[DECISION: approve the pay dates]', '[DECISION: confirm payday', '[OWNER: pick one', '{{approved.pay_dates}}']) {
    expect(() => validate(policySchema, { ...values, pay_schedule })).toThrow(/Resolve placeholders/);
  }
  const draft = source('## Pay dates {#pay-dates}\n{{policy.pay_schedule}}');
  const rendered = renderSource(draft, { ...values, pay_schedule: '[DECISION: approve pay dates]' });
  expect(() => checkRelease(draft, rendered, new Date())).toThrow(/Resolve/);
  const unterminated = renderSource(source('## Pay dates {#pay-dates}\nPaid [DECISION: confirm payday'), values);
  expect(unterminated.unresolved).toEqual(['[DECISION: confirm payday']);
  expect(() => checkRelease(draft, unterminated, new Date())).toThrow(/Resolve/);
});
test('oversized Markdown tables are rejected before HTML expansion', () => {
  const wideHeaders = Array.from({ length: 13 }, (_, i) => `C${i}`).join(' | ');
  const wideSep = Array.from({ length: 13 }, () => '---').join(' | ');
  expect(() => renderSource(source(`## Wide {#wide}\n| ${wideHeaders} |\n| ${wideSep} |\n| ${wideHeaders} |`), values))
    .toThrow(/maximum of 12 columns/);
  const tenHeaders = Array.from({ length: 10 }, (_, i) => `C${i}`).join(' | ');
  const tenSep = Array.from({ length: 10 }, () => '---').join(' | ');
  const manyRows = Array.from({ length: 105 }, () => '| a |').join('\n');
  expect(() => renderSource(source(`## Tall {#tall}\n| ${tenHeaders} |\n| ${tenSep} |\n${manyRows}`), values))
    .toThrow(/maximum of 1000 rendered cells/);
});
test('HTML, scripts, images and unsafe links cannot become executable content', () => {
  const html = renderSource(source('## Example {#example}\n<img src=x onerror=alert(1)> [bad](javascript:alert) [good](https://example.com/?q="x") **Bold**')).sections[0].html;
  expect(html).not.toContain('<img');
  expect(html).not.toContain('href="javascript:');
  expect(html).toMatch(/&(?:lt|#x3C);img/);
  expect(html).toContain('<strong>Bold</strong>');
  expect(html).toMatch(/q=&(?:quot|#x22);x&(?:quot|#x22);/);
});
test('duplicate anchors and orphan citations are rejected', () => {
  expect(() => renderSource(source('## A {#same}\nA\n\n## B {#same}\nB'))).toThrow(/Duplicate/);
  const cited = source(); cited.metadata.citations = [{ anchor: 'missing', label: 'Reference', url: 'https://example.com', verified_on: day(-1), review_on: day(30) }];
  expect(() => renderSource(cited, values)).toThrow(/no matching clause/);
});
test('citation review dates constrain the document cadence', () => {
  const cited = source(); cited.metadata.citations = [{ anchor: 'pto-accrual', label: 'Reference', url: 'https://example.com', verified_on: day(-1), review_on: day(31) }];
  expect(() => checkRelease(cited, renderSource(cited, values), new Date())).not.toThrow();
  cited.metadata.citations[0].review_on = day(100);
  expect(() => checkRelease(cited, renderSource(cited, values), new Date())).toThrow(/90-day/);
});
test('form records reject extra fields and require a completed required checkbox', () => {
  const version = { staff_metadata: { fields: [{ id: 'reviewed', label: 'Reviewed', type: 'checkbox', required: true }] }, content_snapshot: { kind: 'form', sections: [{ id: 'review' }] } };
  expect(() => recordAnswers(version, { answers: { unknown: 'x' }, completed_steps: [], complete: false })).toThrow();
  expect(() => recordAnswers(version, { answers: { reviewed: false }, completed_steps: [], complete: true })).toThrow();
  expect(recordAnswers(version, { answers: { reviewed: true }, completed_steps: [], complete: true }).answers).toBe('{"reviewed":true}');
});
test('signature fields require a full name (first and last) when completing a form', () => {
  expect(parseSignedName('x')).toBeNull();
  expect(parseSignedName('Jordan')).toBeNull();
  expect(parseSignedName('  Jordan   Rivera  ')).toBe('Jordan Rivera');
  expect(hasSignatureField([{ id: 'signed-name', label: 'Typed name', type: 'text', required: false }])).toBe(false);
  expect(hasSignatureField([{ id: 'signed-name', label: 'Typed name', type: 'checkbox', required: true }])).toBe(false);
  expect(hasSignatureField([{ id: 'signed-name', label: 'Typed name', type: 'date', required: true }])).toBe(false);
  expect(hasSignatureField([{ id: 'signed-name', label: 'Typed name', type: 'text', required: true }])).toBe(true);
  const nonTextSigVersion = {
    staff_metadata: { fields: [{ id: 'signed-name', label: 'Signed check', type: 'checkbox', required: true }] },
    content_snapshot: { kind: 'form', sections: [{ id: 'sig' }] },
  };
  expect(recordAnswers(nonTextSigVersion, { answers: { 'signed-name': true }, completed_steps: [], complete: true }).answers)
    .toBe('{"signed-name":true}');
  const version = {
    staff_metadata: {
      fields: [
        { id: 'agree', label: 'I agree', type: 'checkbox', required: true },
        { id: 'signed-name', label: 'Typed name', type: 'text', required: true },
      ],
    },
    content_snapshot: { kind: 'form', sections: [{ id: 'sig' }] },
  };
  expect(() => recordAnswers(version, { answers: { agree: true, 'signed-name': 'x' }, completed_steps: [], complete: true })).toThrow(/full name/);
  expect(recordAnswers(version, { answers: { agree: true, 'signed-name': '  Jordan Rivera ' }, completed_steps: [], complete: true }).answers)
    .toBe('{"agree":true,"signed-name":"Jordan Rivera"}');
});
test('procedure completion requires every step and rejects duplicate or invented steps', () => {
  const version = { staff_metadata: { fields: [] }, content_snapshot: { kind: 'procedure', sections: [{ id: 'first' }, { id: 'second' }] } };
  for (const completed_steps of [[], ['first'], ['first', 'first'], ['first', 'invented']]) {
    expect(() => recordAnswers(version, { answers: {}, completed_steps, complete: true })).toThrow();
  }
  expect(recordAnswers(version, { answers: {}, completed_steps: ['first', 'second'], complete: true })).toMatchObject({ completed_steps: '["first","second"]' });
});
test('customer template authoring cannot create or reclassify a staff document', () => {
  expect(() => validateTemplatePayload({ audience: 'staff' }, { partial: true })).toThrow(/controlled Staff/);
});

test('titles resolve policy bindings and block unresolved decisions or unsupported bindings', () => {
  const draft = { ...source('## Pay {#pay}\nRead the schedule.'), title: '{{policy.pay_frequency}} pay' };
  const rendered = renderSource(draft, values);
  expect(rendered.title).toBe('weekly pay');
  expect(rendered.used_variables).toContain('policy.pay_frequency');
  expect(() => checkRelease(draft, renderSource(draft), new Date())).toThrow(/Resolve/);
  draft.title = '[DECISION: choose title]';
  expect(() => checkRelease(draft, renderSource(draft, values), new Date())).toThrow(/Resolve/);
  draft.title = '{{unknown.title}}';
  expect(() => renderSource(draft, values)).toThrow(/binding/);
});
