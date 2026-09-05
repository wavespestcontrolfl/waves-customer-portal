jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/link-worker-auth', () => ({
  linkWorkerAuth: jest.fn(() => (req, res, next) => next()),
  finalizeWorkerRequest: jest.fn(async () => true),
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true), isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-commitments', () => ({ listOpenCommitments: jest.fn(async () => []), implicitDueAt: jest.fn(() => null) }));
const router = require('../routes/integrations-commitments-worker');
const { listOpenCommitments } = require('../services/call-commitments');
const { gateEnvValue } = require('../config/feature-gates');
const { finalizeWorkerRequest } = require('../middleware/link-worker-auth');
const handler = router.stack.find((l) => l.route?.path === '/open').route.stack[0].handle;
function res() {
  return { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { Object.assign(this.headers, typeof k === 'object' ? k : { [k]: v }); return this; } };
}
beforeEach(() => { jest.clearAllMocks(); gateEnvValue.mockReturnValue(true); finalizeWorkerRequest.mockResolvedValue(true); listOpenCommitments.mockResolvedValue([]); });
test('dark gate precedes auth and limiter, and all responses carry privacy headers', () => {
  const response = res(); const next = jest.fn();
  router.stack[0].handle({}, response, next);
  expect(response.headers['Cache-Control']).toContain('no-store');
  expect(response.headers['Referrer-Policy']).toBe('no-referrer');
  gateEnvValue.mockReturnValue(false); next.mockClear();
  router.stack[1].handle({}, response, next);
  expect(response.statusCode).toBe(404); expect(next).not.toHaveBeenCalled();
  expect(listOpenCommitments).not.toHaveBeenCalled();
  expect(router.stack[1].name).toBe('commitmentsGate');
  expect(router.stack[3].handle).toBeDefined();
});
test.each([{limit:'101'}, {limit:'0'}, {limit:['1','2']}, {offset:'-1'}, {offset:'1000000'}, {customer_id:'synthetic'}, {limit:'1.5'}])('rejects invalid or expanded query %p before reads', async (query) => {
  const response = res(); await handler({ query }, response, jest.fn());
  expect(response.statusCode).toBe(400); expect(listOpenCommitments).not.toHaveBeenCalled();
});
test('bounded page includes necessary evidence but never unrelated customer fields or JSON', async () => {
  const item = { id:'commitment-test', call_log_id:'call-test', customer_id:'customer-test', party:'waves', kind:'callback', channel:'phone', status:'open', description:'Call tomorrow', updated_at:'version', from_phone:'DO_NOT_EXPORT', customer_first_name:'DO_NOT_EXPORT', transcript:'DO_NOT_EXPORT', evidence:[{ quote:'I will call tomorrow', matched:true, speaker:'agent', start_ms:1000, char_offset:42, hidden:'DO_NOT_EXPORT' }], fulfillment:{strength:'association', record_id:'record-test', secret:'DO_NOT_EXPORT'} };
  listOpenCommitments.mockResolvedValue([item, {id:'probe'}]);
  const response = res(); await handler({query:{limit:'1',offset:'2'}},response,jest.fn());
  expect(listOpenCommitments.mock.calls[0][1]).toMatchObject({party:'waves',limit:2,offset:2,includeHints:true});
  expect(response.body).toMatchObject({has_more:true,next_offset:3,fulfillment_refreshed:false,pagination_is_snapshot:false,absence_proves_completion:false});
  expect(response.body.commitments).toHaveLength(1);
  expect(response.body.commitments[0].channel).toBe('phone');
  expect(response.body.commitments[0].evidence[0]).toMatchObject({quote:'I will call tomorrow',start_ms:1000,char_offset:42});
  expect(JSON.stringify(response.body)).not.toContain('DO_NOT_EXPORT');
  expect(finalizeWorkerRequest).toHaveBeenCalledWith(expect.anything(),'observed');
});
test('empty stored queue has explicit limited coverage, not a claim of all channels resolved', async () => {
  const response=res(); await handler({query:{}},response,jest.fn());
  expect(response.body).toMatchObject({coverage:'stored_open_waves_call_commitments',has_more:false,next_offset:null,commitments:[]});
});
test('read failure propagates and audit failure returns no evidence', async () => {
  const next=jest.fn(); listOpenCommitments.mockRejectedValueOnce(new Error('read failed'));
  await handler({query:{}},res(),next); expect(next).toHaveBeenCalledWith(expect.any(Error));
  finalizeWorkerRequest.mockResolvedValue(false); const response=res();
  await handler({query:{}},response,jest.fn()); expect(response.statusCode).toBe(503); expect(response.body.commitments).toBeUndefined();
});
test('oversized recorded evidence is bounded and explicitly marked incomplete', async () => {
  listOpenCommitments.mockResolvedValue([{description:'d'.repeat(2100), evidence:Array.from({length:9},()=>({quote:'q'.repeat(1300)}))}]);
  const response=res(); await handler({query:{}},response,jest.fn());
  const item=response.body.commitments[0];
  expect(item.description).toHaveLength(2000); expect(item.description_truncated).toBe(true);
  expect(item.evidence).toHaveLength(8); expect(item.evidence_truncated).toBe(true);
  expect(item.evidence[0].quote).toHaveLength(1200); expect(item.evidence[0].quote_truncated).toBe(true);
});
test('flat-transcript evidence keeps its sole character anchor and human rows keep their channel', async () => {
  listOpenCommitments.mockResolvedValue([
    { evidence:[{quote:'I will send it', matched:true, char_offset:87}] },
    {source:'human', description:'Send the report', channel:'email', evidence:[]},
  ]);
  const response=res(); await handler({query:{}},response,jest.fn());
  expect(response.body.commitments[0].evidence[0]).toMatchObject({matched:true,char_offset:87});
  expect(response.body.commitments[0].evidence[0].start_ms).toBeUndefined();
  expect(response.body.commitments[1]).toMatchObject({source:'human',channel:'email',evidence:[]});
});
