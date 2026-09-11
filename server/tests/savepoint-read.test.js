const { savepointRead } = require('../utils/savepoint-read');

describe('savepointRead', () => {
  test('serializes concurrent reads on one transaction', async () => {
    const events = [];
    const database = {
      isTransaction: true,
      async raw(sql) {
        events.push(sql.split(' ')[0] + (sql.includes('SAVEPOINT') ? `:${sql.split(' ')[1]}` : ''));
      },
    };
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    const first = savepointRead(database, async () => {
      events.push('first-start');
      await firstBlocked;
      events.push('first-end');
      return 'first';
    });
    const second = savepointRead(database, async () => {
      events.push('second-start');
      return 'second';
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(expect.arrayContaining(['first-start']));
    expect(events).not.toContain('second-start');
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events.indexOf('first-end')).toBeLessThan(events.indexOf('second-start'));
  });
});

describe('savepointScope', () => {
  const { savepointScope, failSoftRead } = require('../utils/savepoint-read');
  const fakeTransaction = (events) => ({ isTransaction: true, async raw(sql) { events.push(sql.split(' ')[0]); } });

  test('a body that performs its own fail-soft reads on the same transaction completes', async () => {
    const events = [];
    const result = await savepointScope(fakeTransaction(events), async (db) => {
      const inner = await failSoftRead(db, async () => 'catalog', null);
      return `plan:${inner}`;
    });
    expect(result).toBe('plan:catalog');
    expect(events).toEqual(['SAVEPOINT', 'SAVEPOINT', 'RELEASE', 'RELEASE']);
  });

  test('the queued savepointRead would wait on itself for that nesting (why the scope exists)', async () => {
    const nested = savepointRead(fakeTransaction([]), (db) => failSoftRead(db, async () => 'catalog', null));
    const outcome = await Promise.race([nested.then(() => 'resolved'), new Promise((resolve) => setTimeout(() => resolve('hung'), 50))]);
    expect(outcome).toBe('hung');
  });

  test('a failing body rolls its savepoint back and rethrows, leaving the transaction usable', async () => {
    const events = [];
    await expect(savepointScope(fakeTransaction(events), async () => { throw new Error('planner boom'); })).rejects.toThrow('planner boom');
    expect(events).toEqual(['SAVEPOINT', 'ROLLBACK', 'RELEASE']);
  });

  test('outside a transaction the body runs directly', async () => {
    expect(await savepointScope({ isTransaction: false }, async () => 'plain')).toBe('plain');
  });
});
