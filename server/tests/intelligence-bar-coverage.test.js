const { frontendSourceCensus, checkCoverage, coverageCounts } = require('../../scripts/check-ib-coverage');

const source = `
const save = async () => {
  await adminPostStrict('/admin/knowledge/sources', body);
  await adminFetch('/admin/knowledge/sources');
  await api.patch('/admin/customers/' + customerId, body);
  await aFetch(endpoint, { method: 'POST', body });
  await adminPost(endpoint, body);
  await api.patch(path, body);
  await admin_post(endpoint, body);
  await api_patch('/admin/customers/' + customerId, body);
  await adminFetch?.('/admin/optional-fetch');
  await api?.post('/admin/optional-post', body);
  cache.get(key);
  navigate('/admin/customers');
  URL.createObjectURL(blob);
};`;
const census = frontendSourceCensus(source, 'client/src/pages/admin/Fixture.jsx');

test('census includes writes through wrappers, dynamic endpoints, navigation and local exports', () => {
  expect(census).toHaveLength(12);
  expect(census.map(a => [a.operation.method, a.operation.endpoint])).toEqual(expect.arrayContaining([
    ['POST', '/admin/knowledge/sources'], ['GET', '/admin/knowledge/sources'],
    ['PATCH', '/admin/customers/:param'], ['POST', null], ['GET', '/admin/customers'], ['LOCAL_EXPORT', null],
  ]));
  expect(new Set(census.map(a => a.id)).size).toBe(census.length);
  expect(census.filter(a => a.operation.method === 'POST' && !a.operation.endpoint)).toHaveLength(3);
  expect(census.filter(a => a.operation.method === 'PATCH' && a.operation.endpoint)).toHaveLength(2);
  expect(census.map(a => [a.operation.method, a.operation.endpoint])).toEqual(expect.arrayContaining([
    ['GET', '/admin/optional-fetch'], ['POST', '/admin/optional-post'],
  ]));
});

test('new and changed actions cannot hide behind a baseline or a stale review', () => {
  const action = census[0];
  expect(checkCoverage([action], { actions: [] }, {})).toHaveLength(1);
  const baseline = { ...action, baselineFingerprint: action.fingerprint, status: 'unmapped' };
  // An arbitrary matching baseline row is not evidence that source existed.
  expect(checkCoverage([action], { actions: [baseline] }, {})).toHaveLength(1);
  const proof = new Set([`${action.id}:${action.fingerprint}`]);
  expect(checkCoverage([action], { actions: [baseline] }, {}, proof)).toEqual([]);
  const changed = { ...action, fingerprint: 'changed' };
  expect(checkCoverage([changed], { actions: [baseline] }, {})).toHaveLength(1);
  const reviewed = { ...baseline, status: 'reviewed_exception', reviewedFingerprint: action.fingerprint,
    exception: { review: 'PR review of synthetic fixture', reason: 'Navigation affordance' } };
  expect(checkCoverage([changed], { actions: [reviewed] }, {})).toHaveLength(1);
  expect(checkCoverage([changed], { actions: [{ ...reviewed, reviewedFingerprint: 'changed' }] }, {})).toEqual([]);
});

test('verified coverage requires actual policy and evidence for the reviewed implementation', () => {
  const action = census[0];
  const record = { ...action, baselineFingerprint: 'old', status: 'verified', reviewedFingerprint: action.fingerprint, tools: ['save'], evidence: ['database test'], permission: 'admin', approval: 'ui_confirm', inputsAndEffects: 'Validated source name; persists a source' };
  expect(checkCoverage([action], { actions: [record] }, {})).toHaveLength(1);
  expect(checkCoverage([action], { actions: [record] }, { save: {} })).toEqual([]);
  expect(checkCoverage([action], { actions: [{ ...record, evidence: [] }] }, { save: {} })).toHaveLength(1);
  for (const key of ['permission', 'approval', 'inputsAndEffects']) {
    for (const value of [undefined, '', ' ', 'requires_action_review', ' requires_action_review ']) {
      expect(checkCoverage([action], { actions: [{ ...record, [key]: value }] }, { save: {} })).toHaveLength(1);
    }
  }
  for (const evidence of ['fixture', [''], [{}]]) {
    expect(checkCoverage([action], { actions: [{ ...record, evidence }] }, { save: {} })).toHaveLength(1);
  }
});

test('acknowledging an exact request fingerprint does not remove an unsupported capability', () => {
  const action = census[0];
  const reviewed = { ...action, status: 'reviewed_unmapped', reviewedFingerprint: action.fingerprint,
    exception: { review: 'Fixture source review', reason: 'Same request; formatting only, no tool parity' } };
  expect(checkCoverage([action], { actions: [reviewed] }, {})).toEqual([]);
  expect(checkCoverage([{ ...action, fingerprint: 'changed' }], { actions: [reviewed] }, {})).toHaveLength(1);
  expect(checkCoverage([action], { actions: [{ ...reviewed, exception: {} }] }, {})).toHaveLength(1);
  expect(coverageCounts([
    { status: 'unmapped' }, reviewed, { status: 'reviewed_exception' }, { status: 'verified' },
  ])).toEqual({ recorded: 4, unsupported: 2 });
});


test('baseline provenance cannot silently promote unsupported coverage to a reviewed status', () => {
  const action = census[0], proof = new Set([`${action.id}:${action.fingerprint}`]);
  for (const status of ['verified', 'reviewed_exception', 'reviewed_unmapped', 'invented']) {
    const record = { ...action, baselineFingerprint: action.fingerprint, status };
    expect(checkCoverage([action], { actions: [record] }, {}, proof)).toHaveLength(1);
  }
});


test('stale or incomplete reviewed metadata cannot use an otherwise valid baseline', () => {
  const action = census[0], proof = new Set([`${action.id}:${action.fingerprint}`]);
  const base = { ...action, baselineFingerprint: action.fingerprint, reviewedFingerprint: action.fingerprint };
  for (const extra of [
    { status: 'verified', tools: ['missing'], evidence: ['fixture'] },
    { status: 'verified', tools: ['save'], evidence: [] },
    { status: 'verified', tools: ['save'], evidence: ['fixture'], reviewedFingerprint: 'stale' },
    { status: 'reviewed_exception', exception: { reason: 'fixture' } },
    { status: 'reviewed_exception', exception: { review: 'fixture' } },
    ...['review', 'reason'].flatMap(key => [undefined, '', ' ', {}, []].map(value => ({
      status: 'reviewed_exception', exception: { review: 'fixture', reason: 'fixture', [key]: value },
    }))),
    { status: 'reviewed_exception', exception: { reason: 'fixture', review: 'fixture' }, reviewedFingerprint: 'stale' },
  ]) expect(checkCoverage([action], { actions: [{ ...base, ...extra }] }, { save: {} }, proof)).toHaveLength(1);
});


test('shared admin wrappers with variable endpoints stay covered outside admin directories', () => {
  const shared = frontendSourceCensus(`
    async function load() {
      await adminFetch(url);
      await adminPost(endpoint, body);
      await adminRequest?.(path, { method: 'DELETE' });
      await fetch(publicUrl);
      cache.get(key);
    }
  `, 'client/src/components/equipment/Fixture.jsx');
  expect(shared).toHaveLength(3);
  expect(shared.map(row => row.operation.method).sort()).toEqual(['DELETE', 'GET', 'POST']);
  expect(shared.every(row => row.operation.resolution === 'unresolved')).toBe(true);
  expect(checkCoverage(shared, { actions: [] }, {})).toHaveLength(3);
});

test('React state setters and lazy module imports are not requests', () => {
  const rows = frontendSourceCensus(`
    function Panel() {
      const [linkRequest, setLinkRequest] = useState(0);
      const load = async () => {
        setLinkRequest(0);
        setLinkRequest((value) => value + 1);
        const Page = lazy(() => import('../../pages/admin/CommunicationsPageV2'));
        await adminFetch(dynamic);
      };
    }
  `, 'client/src/components/admin/Fixture.jsx');
  expect(rows).toHaveLength(1);
  expect(rows[0].operation).toEqual({ method: 'GET', endpoint: null, resolution: 'unresolved' });
});
