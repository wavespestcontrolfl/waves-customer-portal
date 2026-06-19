jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { invalidateServiceReportPdfCache } = require('../services/service-report/pdf-storage');

function makeKnex({ throwOnUpdate = false } = {}) {
  const calls = { table: null, where: null, update: null };
  const knex = jest.fn((table) => {
    calls.table = table;
    const builder = {
      where: jest.fn((w) => { calls.where = w; return builder; }),
      update: jest.fn((patch) => {
        calls.update = patch;
        return throwOnUpdate ? Promise.reject(new Error('db down')) : Promise.resolve(1);
      }),
    };
    return builder;
  });
  knex._calls = calls;
  return knex;
}

describe('invalidateServiceReportPdfCache', () => {
  test('nulls pdf_storage_key for the given service record', async () => {
    const knex = makeKnex();
    await invalidateServiceReportPdfCache('rec-1', knex);
    expect(knex).toHaveBeenCalledWith('service_records');
    expect(knex._calls.where).toEqual({ id: 'rec-1' });
    expect(knex._calls.update).toEqual({ pdf_storage_key: null });
  });

  test('no-ops when no service record id is provided', async () => {
    const knex = makeKnex();
    await invalidateServiceReportPdfCache(null, knex);
    expect(knex).not.toHaveBeenCalled();
  });

  test('is best-effort: swallows db errors and never throws', async () => {
    const knex = makeKnex({ throwOnUpdate: true });
    await expect(invalidateServiceReportPdfCache('rec-1', knex)).resolves.toBeUndefined();
  });
});
