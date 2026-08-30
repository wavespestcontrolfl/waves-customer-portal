// Callbacks are recap-ineligible under the re-service copy gate (codex P1
// r3 on the no-schematic PR, owner 2026-08-30): the recap video is a
// routine-visit celebration script whose WhereWeProtected beat renders the
// schematic barrier the callback REPORT suppresses. Gate off keeps the
// pre-lane behavior byte-identical.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(),
  ensureReportToken: jest.fn(),
}));
jest.mock('../services/service-report/report-data', () => ({
  buildReportV1Data: jest.fn(),
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn(),
}));
jest.mock('../services/service-report/recap-media', () => ({
  getMediaForRecap: jest.fn().mockResolvedValue([]),
}));

const { loadServiceRecordForPdf } = require('../services/service-report/pdf-queue');
const { buildRecapPayload } = require('../services/service-report/recap-payload');

function fakeKnex(record) {
  const chain = {
    where: () => chain,
    orderBy: () => chain,
    first: async () => record,
  };
  return () => chain;
}

describe('buildRecapPayload — callback ineligibility', () => {
  const OLD_GATE = process.env.GATE_RESERVICE_REPORT_COPY;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY;
    else process.env.GATE_RESERVICE_REPORT_COPY = OLD_GATE;
    jest.clearAllMocks();
  });

  it('gate on: a callback pest record composes no recap', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    loadServiceRecordForPdf.mockResolvedValue({
      id: 'rec-1', service_line: 'pest', is_callback: true,
    });
    const out = await buildRecapPayload('ss-1', { knex: fakeKnex({ id: 'rec-1' }) });
    expect(out).toBeNull();
  });

  it('gate off: the callback proceeds past the ineligibility guard (pre-lane behavior)', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    loadServiceRecordForPdf.mockResolvedValue({
      id: 'rec-1', service_line: 'pest', is_callback: true,
    });
    const { buildReportV1Data } = require('../services/service-report/report-data');
    buildReportV1Data.mockResolvedValue({ typedReport: null });
    const { buildServiceReportDynamicContext } = require('../services/service-report/dynamic-context');
    // No premium experience → the build returns null AFTER the guard, which
    // is enough to prove the callback was not turned away at the gate.
    buildServiceReportDynamicContext.mockResolvedValue({ premiumExperience: null });
    const { ensureReportToken } = require('../services/service-report/pdf-queue');
    ensureReportToken.mockResolvedValue('tok');
    const out = await buildRecapPayload('ss-1', { knex: fakeKnex({ id: 'rec-1' }) });
    expect(out).toBeNull();
    expect(buildReportV1Data).toHaveBeenCalled();
  });
});
