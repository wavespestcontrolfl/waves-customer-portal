test('suggestion staleness and newer-inbound probes exclude recruiting rows (source guard)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/sms-suggest-mode'), 'utf8');
  expect(src.split("NOT LIKE 'job").length - 1).toBeGreaterThanOrEqual(2);
});
