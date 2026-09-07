const { frontendSourceCensus, checkCoverage } = require('../../scripts/check-ib-coverage');

const source = `
const save = async () => {
  await adminPostStrict('/admin/knowledge/sources', body);
  await adminFetch('/admin/knowledge/sources');
  await api.patch('/admin/customers/' + customerId, body);
  await aFetch(endpoint, { method: 'POST', body });
  navigate('/admin/customers');
  URL.createObjectURL(blob);
};`;
const census = frontendSourceCensus(source, 'client/src/pages/admin/Fixture.jsx');

test('census includes writes through wrappers, dynamic endpoints, navigation and local exports', () => {
  expect(census).toHaveLength(6);
  expect(census.map(a => [a.operation.method, a.operation.endpoint])).toEqual(expect.arrayContaining([
    ['POST', '/admin/knowledge/sources'], ['GET', '/admin/knowledge/sources'],
    ['PATCH', '/admin/customers/:param'], ['POST', null], ['GET', '/admin/customers'], ['LOCAL_EXPORT', null],
  ]));
  expect(new Set(census.map(a => a.id)).size).toBe(census.length);
});

test('new and changed actions cannot hide behind a baseline or a stale review', () => {
  const action = census[0];
  expect(checkCoverage([action], { actions: [] }, {})).toHaveLength(1);
  const baseline = { ...action, baselineFingerprint: action.fingerprint, status: 'unmapped' };
  expect(checkCoverage([action], { actions: [baseline] }, {})).toEqual([]);
  const changed = { ...action, fingerprint: 'changed' };
  expect(checkCoverage([changed], { actions: [baseline] }, {})).toHaveLength(1);
  const reviewed = { ...baseline, status: 'reviewed_exception', reviewedFingerprint: action.fingerprint,
    exception: { review: 'PR review of synthetic fixture', reason: 'Navigation affordance' } };
  expect(checkCoverage([changed], { actions: [reviewed] }, {})).toHaveLength(1);
  expect(checkCoverage([changed], { actions: [{ ...reviewed, reviewedFingerprint: 'changed' }] }, {})).toEqual([]);
});

test('verified coverage requires actual policy and evidence for the reviewed implementation', () => {
  const action = census[0];
  const record = { ...action, baselineFingerprint: 'old', status: 'verified', reviewedFingerprint: action.fingerprint, tools: ['save'], evidence: ['database test'] };
  expect(checkCoverage([action], { actions: [record] }, {})).toHaveLength(1);
  expect(checkCoverage([action], { actions: [record] }, { save: {} })).toEqual([]);
  expect(checkCoverage([action], { actions: [{ ...record, evidence: [] }] }, { save: {} })).toHaveLength(1);
});
