// Applicator key component of the service-report PDF storage key (Poison
// Control lane, codex r2+r3 on #5032). The document prints
// "Applicator: <technicianName> · FDACS ID card #<id>", so the key signs that
// exact pair: the STORE side from the payload the render used, the LOOKUP
// side re-derived from the record by one loader — and the two must agree.
const {
  applicatorIdentityPdfSignature,
  applicatorRenderedPdfSignature,
} = require('../services/service-report/pdf-storage');

function knexReturning(row) {
  const builder = {
    leftJoin: jest.fn(() => builder),
    where: jest.fn(() => builder),
    first: jest.fn(async () => row),
  };
  return jest.fn(() => builder);
}

const pgDate = (ymd) => new Date(`${ymd}T00:00:00.000Z`);

describe('applicatorRenderedPdfSignature (store side)', () => {
  test('empty when no ID prints, so an ordinary key is unchanged', () => {
    expect(applicatorRenderedPdfSignature({ technicianName: 'Alex', applicatorFdacsId: null })).toBe('');
    expect(applicatorRenderedPdfSignature(null)).toBe('');
  });

  test('changes with the printed name as well as the ID', () => {
    const base = applicatorRenderedPdfSignature({ technicianName: 'Alex', applicatorFdacsId: 'JE000001' });
    expect(base).toMatch(/^-ap[0-9a-f]{8}$/);
    expect(applicatorRenderedPdfSignature({ technicianName: 'Alex', applicatorFdacsId: 'JE000001' })).toBe(base);
    expect(applicatorRenderedPdfSignature({ technicianName: 'Alexis', applicatorFdacsId: 'JE000001' })).not.toBe(base);
    expect(applicatorRenderedPdfSignature({ technicianName: 'Alex', applicatorFdacsId: 'JE000002' })).not.toBe(base);
  });
});

describe('applicatorIdentityPdfSignature (lookup side)', () => {
  test('re-derives exactly the pair the payload prints, from a pg-shaped row', async () => {
    const knex = knexReturning({
      service_date: pgDate('2026-06-11'),
      service_data: null,
      technician_name: 'Alex',
      technician_fdacs_id: ' JE000001 ',
      technician_license_expiry: pgDate('2026-12-31'),
    });
    expect(await applicatorIdentityPdfSignature('sr-1', knex))
      .toBe(applicatorRenderedPdfSignature({ technicianName: 'Alex', applicatorFdacsId: 'JE000001' }));
  });

  test('empty when the license had expired by the visit date', async () => {
    const knex = knexReturning({
      service_date: pgDate('2026-06-11'),
      service_data: null,
      technician_name: 'Alex',
      technician_fdacs_id: 'JE000001',
      technician_license_expiry: pgDate('2026-01-01'),
    });
    expect(await applicatorIdentityPdfSignature('sr-1', knex)).toBe('');
  });

  test('empty when the identity snapshot froze a different technician name', async () => {
    const knex = knexReturning({
      service_date: '2026-06-11',
      service_data: { reportIdentitySnapshot: { version: 1, technicianName: 'Someone Else' } },
      technician_name: 'Alex',
      technician_fdacs_id: 'JE000001',
      technician_license_expiry: null,
    });
    expect(await applicatorIdentityPdfSignature('sr-1', knex)).toBe('');
  });

  test('an unreadable lookup or missing record signs nothing', async () => {
    expect(await applicatorIdentityPdfSignature(null, knexReturning(null))).toBe('');
    expect(await applicatorIdentityPdfSignature('sr-1', knexReturning(undefined))).toBe('');
    const failing = jest.fn(() => { throw new Error('db down'); });
    expect(await applicatorIdentityPdfSignature('sr-1', failing)).toBe('');
  });
});
