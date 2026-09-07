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
