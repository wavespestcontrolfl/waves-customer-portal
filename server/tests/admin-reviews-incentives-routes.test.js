const fs = require('fs');
const path = require('path');

describe('admin review incentive routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-reviews.js'), 'utf8');

  test.each([
    ['get', '/incentives'],
    ['get', '/incentives/attribution-queue'],
    ['get', '/incentives/attribution-candidates'],
    ['post', '/incentives/attribute'],
    ['post', '/incentives/sync'],
    ['patch', '/incentives/policy'],
    ['post', '/incentives/mark-paid'],
    ['get', '/incentives/export'],
  ])('%s %s is admin-only', (method, route) => {
    const pattern = new RegExp(`router\\.${method}\\('${route.replace(/\//g, '\\/')}',\\s*requireAdmin,`);
    expect(source).toMatch(pattern);
  });
});
