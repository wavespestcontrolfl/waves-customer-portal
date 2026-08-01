const {
  automatedDuplicateBlock,
  findDuplicateEstimateByPhone,
  listOpenEstimatesByPhone,
  phoneLookupValues,
  automatedEstimateLockKeys,
  withAutomatedEstimatePhoneLock,
  withAutomatedEstimatePhoneLocks,
} = require('../services/estimate-automation-duplicates');

describe('estimate automation duplicate guard', () => {
  test('normalizes formatted US phone numbers to a last-10 lookup key', () => {
    expect(phoneLookupValues('(941) 555-0101')).toMatchObject({
      normalized: '+19415550101',
      last10: '9415550101',
    });
    expect(phoneLookupValues('+1 941-555-0101')).toMatchObject({
      normalized: '+19415550101',
      last10: '9415550101',
    });
  });

  test('does not query estimates when the phone cannot produce a lookup key', async () => {
    const database = jest.fn();

    await expect(findDuplicateEstimateByPhone('not a phone', { database })).resolves.toBeNull();
    expect(database).not.toHaveBeenCalled();
  });

  test('looks up duplicates by normalized last-10 phone digits', async () => {
    const rows = [
      { id: 'est-1', status: 'draft', source: 'lead_webhook', address: '123 Example St' },
      { id: 'est-0', status: 'sent', source: 'quote_wizard', address: '456 Other Rd' },
    ];
    const calls = [];
    // Knex builders are thenables — the list function awaits the query
    // itself (no .first()), so the mock resolves to the full row set.
    const query = {
      select: jest.fn(function (...args) { calls.push(['select', args]); return this; }),
      whereRaw: jest.fn(function (sql, params) { calls.push(['whereRaw', sql, params]); return this; }),
      whereIn: jest.fn(function (...args) { calls.push(['whereIn', args]); return this; }),
      whereNull: jest.fn(function (...args) { calls.push(['whereNull', args]); return this; }),
      orderBy: jest.fn(function (...args) { calls.push(['orderBy', args]); return this; }),
      then: function (resolve, reject) { calls.push(['then']); return Promise.resolve(rows).then(resolve, reject); },
    };
    const database = jest.fn((table) => {
      calls.push(['table', table]);
      return query;
    });

    // The single-row guard returns the newest open estimate…
    await expect(findDuplicateEstimateByPhone('941.555.0101', { database })).resolves.toBe(rows[0]);
    // …and the property-level list returns every open row, address included.
    await expect(listOpenEstimatesByPhone('941.555.0101', { database })).resolves.toEqual(rows);
    expect(calls[0]).toEqual(['table', 'estimates']);
    expect(query.select).toHaveBeenCalledWith('id', 'status', 'source', 'address', 'created_at');
    expect(query.whereRaw).toHaveBeenCalledWith(expect.stringContaining('regexp_replace'), ['9415550101']);
    expect(query.whereIn).toHaveBeenCalledWith('status', ['draft', 'scheduled', 'sent', 'viewed']);
    // Archived rows keep their status but are closed courtships — they must
    // not block a genuinely new automated estimate.
    expect(query.whereNull).toHaveBeenCalledWith('archived_at');
  });

  test('list returns empty (and never queries) without a lookup key', async () => {
    const database = jest.fn();
    await expect(listOpenEstimatesByPhone('not a phone', { database })).resolves.toEqual([]);
    expect(database).not.toHaveBeenCalled();
  });

  test('builds the automation block payload without exposing phone details', () => {
    expect(automatedDuplicateBlock({ id: 'est-2', status: 'sent', source: 'quote_wizard' })).toMatchObject({
      blocked: true,
      reason: 'duplicate_phone',
      existingEstimateId: 'est-2',
      existingStatus: 'sent',
      existingSource: 'quote_wizard',
    });
  });

  test('serializes automated creation with a per-phone advisory transaction lock', async () => {
    const trx = { raw: jest.fn(async () => {}) };
    const database = jest.fn();
    database.transaction = jest.fn(async (callback) => callback(trx));

    const result = await withAutomatedEstimatePhoneLock(
      '+1 (941) 555-0101',
      async (lockedTrx, values) => ({ lockedTrx, values }),
      { database }
    );

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(trx.raw).toHaveBeenCalledWith(
      'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      ['estimate_automation_duplicate', '9415550101']
    );
    expect(result.lockedTrx).toBe(trx);
    expect(result.values.last10).toBe('9415550101');
  });

  test('multi-phone lock keys are unique and ASCENDING regardless of input order', () => {
    // The sort IS the deadlock guard: two runs that share a phone pair must
    // never grab the two locks in opposite orders.
    expect(automatedEstimateLockKeys(['+1 (941) 555-9999', '941.555.0101']))
      .toEqual(['9415550101', '9415559999']);
    expect(automatedEstimateLockKeys(['941.555.0101', '+1 (941) 555-9999']))
      .toEqual(['9415550101', '9415559999']);
    // Same number in two formats collapses to one key; unusable input drops.
    expect(automatedEstimateLockKeys(['+19415550101', '941-555-0101', 'not a phone']))
      .toEqual(['9415550101']);
  });

  test('locks EVERY dedupe phone in one transaction before the callback runs', async () => {
    const trx = { raw: jest.fn(async () => {}) };
    const database = jest.fn();
    database.transaction = jest.fn(async (callback) => callback(trx));

    const result = await withAutomatedEstimatePhoneLocks(
      ['+1 (941) 555-9999', '941.555.0101'],
      async (lockedTrx, values) => {
        // Both locks are held BEFORE any read the callback performs.
        expect(trx.raw).toHaveBeenCalledTimes(2);
        return { lockedTrx, values };
      },
      { database }
    );

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(trx.raw.mock.calls.map((c) => c[1][1])).toEqual(['9415550101', '9415559999']);
    expect(result.lockedTrx).toBe(trx);
    // Second arg stays the PRIMARY (first) phone's lookup values.
    expect(result.values.last10).toBe('9415559999');
  });

  test('no usable phone in the set → bare callback, no transaction, no lock', async () => {
    const database = jest.fn();
    database.transaction = jest.fn();

    const result = await withAutomatedEstimatePhoneLocks(
      ['not a phone', null],
      async (executor, values) => ({ executor, values }),
      { database }
    );

    expect(database.transaction).not.toHaveBeenCalled();
    expect(result.executor).toBe(database);
    expect(result.values.last10).toBeNull();
  });
});
