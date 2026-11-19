const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin-leads.js'), 'utf8');

describe('admin leads source evidence contract', () => {
  test('list and detail both add the same source_evidence presentation', () => {
    expect(source).toMatch(/leads:\s*withSourceEvidence\(await withServiceDisplay\(leads\)\)/);
    expect(source).toMatch(/lead:\s*withSourceEvidence\(await withServiceDisplay\(\[lead\]\)\)\[0\]/);
  });

  test('source sort uses the displayed evidence label before limit/offset', () => {
    expect(source).toMatch(/source:\s*sourceEvidenceLabelSql\(db\)/);
    const orderAt = source.indexOf(".orderBy(sortCol, order === 'asc' ? 'asc' : 'desc')");
    const limitAt = source.indexOf('.limit(lim)', orderAt);
    expect(orderAt).toBeGreaterThan(-1);
    expect(limitAt).toBeGreaterThan(orderAt);
    expect(source.slice(orderAt, limitAt)).toContain(".orderBy('leads.id', 'asc')");
  });

  test('received aliases preserve the established first_contact_at sort', () => {
    expect(source).toMatch(/received:\s*'leads\.first_contact_at'/);
    expect(source).toMatch(/received_at:\s*'leads\.first_contact_at'/);
    expect(source).toMatch(/first_contact_at:\s*'leads\.first_contact_at'/);
  });
});
