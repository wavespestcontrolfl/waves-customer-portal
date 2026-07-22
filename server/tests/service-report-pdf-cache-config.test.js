const mockBuildReportV1Data = jest.fn(async () => ({}));
const mockBuildServiceReportDynamicContext = jest.fn(async () => ({}));
const mockRenderServiceReportV1Pdf = jest.fn(async () => Buffer.from('%PDF-1.4'));
const mockGetHealthyStoredReportPdf = jest.fn(async () => null);
const mockPutReportPdf = jest.fn(async (recordId, pdf, { visibilitySignature } = {}) => (
  `reports/${recordId}/report-${visibilitySignature}.pdf`
));
const mockReportPdfStorageKey = jest.fn((recordId, { visibilitySignature } = {}) => (
  `reports/${recordId}/report-${visibilitySignature}.pdf`
));
let mockActivePestPressureConfig;
const mockLoadActiveConfig = jest.fn(async () => mockActivePestPressureConfig);
const mockPestPressureVisibilitySignature = jest.fn((config) => `sig-${config.key}`);

jest.mock('../services/service-report/report-data', () => ({
  buildReportV1Data: mockBuildReportV1Data,
  // Real implementation: pure, synchronous, and part of the render path
  // (queued PDFs must never fossilize live-only schedule fields).
  stripLiveOnlyScheduleFields: jest.requireActual('../services/service-report/report-data').stripLiveOnlyScheduleFields,
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: mockBuildServiceReportDynamicContext,
}));
jest.mock('../services/service-report/pdf', () => ({
  renderServiceReportV1Pdf: mockRenderServiceReportV1Pdf,
}));
jest.mock('../services/service-report/pdf-storage', () => ({
  getHealthyStoredReportPdf: mockGetHealthyStoredReportPdf,
  putReportPdf: mockPutReportPdf,
  reportPdfStorageKey: mockReportPdfStorageKey,
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: mockLoadActiveConfig,
  pestPressureVisibilitySignature: mockPestPressureVisibilitySignature,
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const {
  getOrRenderServiceReportPdf,
  renderAndStoreServiceReportPdf,
} = require('../services/service-report/pdf-queue');

function makeService(overrides = {}) {
  return {
    id: 'service-1',
    status: 'completed',
    report_template_version: 'service_report_v1',
    report_view_token: 'token-1',
    pdf_storage_key: 'old-key',
    ...overrides,
  };
}

function makeKnex(service) {
  const updates = [];
  const knex = jest.fn(() => {
    const query = {
      where: jest.fn(() => query),
      leftJoin: jest.fn(() => query),
      select: jest.fn(() => query),
      first: jest.fn(() => Promise.resolve(service)),
      update: jest.fn((payload) => {
        updates.push(payload);
        return Promise.resolve(1);
      }),
    };
    return query;
  });
  knex.updates = updates;
  // loadServiceRecordForPdf selects knex.raw(...) stamped-address
  // expressions — mirror knex's raw so building the select can't throw.
  knex.raw = (sql) => ({ toString: () => sql });
  return knex;
}

describe('service report PDF Pest Pressure cache config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActivePestPressureConfig = { key: 'current', showOnCustomerReport: true };
  });

  test('renderAndStoreServiceReportPdf keys storage with the same config used to build report data', async () => {
    const knex = makeKnex(makeService());

    const result = await renderAndStoreServiceReportPdf('service-1', {
      token: 'token-1',
      knex,
    });

    expect(mockLoadActiveConfig).toHaveBeenCalledTimes(2);
    expect(mockBuildReportV1Data).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'service-1' }),
      'token-1',
      knex,
      { pestPressureConfig: mockActivePestPressureConfig },
    );
    expect(mockBuildServiceReportDynamicContext).toHaveBeenCalledWith(expect.objectContaining({
      recordId: 'service-1',
      pestPressureConfig: mockActivePestPressureConfig,
      knex,
    }));
    expect(mockPestPressureVisibilitySignature).toHaveBeenCalledWith(mockActivePestPressureConfig);
    expect(mockPutReportPdf).toHaveBeenCalledWith(
      'service-1',
      Buffer.from('%PDF-1.4'),
      // '-tn0' = the narrative sentinel for payloads that rendered no
      // narrative (mocked data carries none).
      { visibilitySignature: 'sig-current-tn0' },
    );
    expect(result.key).toBe('reports/service-1/report-sig-current-tn0.pdf');
  });

  test('getOrRenderServiceReportPdf reuses the cache-check config when it has to render', async () => {
    const knex = makeKnex(makeService({ pdf_storage_key: 'reports/service-1/report-sig-old.pdf' }));

    const result = await getOrRenderServiceReportPdf('service-1', {
      token: 'token-1',
      knex,
    });

    expect(mockLoadActiveConfig).toHaveBeenCalledTimes(2);
    expect(mockReportPdfStorageKey).toHaveBeenCalledWith(
      'service-1',
      { visibilitySignature: 'sig-current' },
    );
    expect(mockBuildReportV1Data).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'service-1' }),
      'token-1',
      knex,
      { pestPressureConfig: mockActivePestPressureConfig },
    );
    expect(mockGetHealthyStoredReportPdf).not.toHaveBeenCalled();
    expect(result.rendered).toBe(true);
    expect(result.key).toBe('reports/service-1/report-sig-current-tn0.pdf');
  });

  test('renderAndStoreServiceReportPdf retries instead of storing when config changes during render', async () => {
    const firstConfig = { key: 'first', showOnCustomerReport: true };
    const secondConfig = { key: 'second', showOnCustomerReport: false };
    mockActivePestPressureConfig = secondConfig;
    mockLoadActiveConfig.mockResolvedValueOnce(firstConfig);
    const knex = makeKnex(makeService());

    const result = await renderAndStoreServiceReportPdf('service-1', {
      token: 'token-1',
      knex,
    });

    expect(mockRenderServiceReportV1Pdf).toHaveBeenCalledTimes(2);
    expect(mockBuildReportV1Data.mock.calls[0][3]).toEqual({ pestPressureConfig: firstConfig });
    expect(mockBuildReportV1Data.mock.calls[1][3]).toEqual({ pestPressureConfig: secondConfig });
    expect(mockPutReportPdf).toHaveBeenCalledWith(
      'service-1',
      Buffer.from('%PDF-1.4'),
      { visibilitySignature: 'sig-second-tn0' },
    );
    expect(result.key).toBe('reports/service-1/report-sig-second-tn0.pdf');
  });
});
