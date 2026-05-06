const fs = require('fs');
const path = require('path');

describe('legacy technician seed script', () => {
  test('does not write retired dispatch technician tables', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../../scripts/seed-techs.js'),
      'utf8'
    );

    expect(script).toContain('is retired');
    expect(script).not.toContain("db('dispatch_technicians')");
    expect(script).not.toContain('knex');
  });
});
