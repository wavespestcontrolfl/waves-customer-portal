// serviceHasLinkedProject: the direct and legacy project links behind the pest sheet record. Synthetic data; a fake knex.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn().mockResolvedValue({ category: 'pest_control' }),
}));

describe('serviceHasLinkedProject (the lookup behind the pest sheet record)', () => {
  const { serviceHasLinkedProject } = require('../services/pest-recap');
  const recording = (answer) => {
    const wheres = [];
    const chain = {};
    for (const m of ['leftJoin']) chain[m] = () => chain;
    chain.where = (arg) => { if (typeof arg === 'function') { const inner = { where: (c) => { wheres.push(c); return inner; }, orWhere: (c) => { wheres.push(c); return inner; } }; arg(inner); } return chain; };
    chain.first = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
    const knex = jest.fn(() => chain);
    knex.wheres = wheres;
    return knex;
  };

  test('looks at the direct link and the legacy link through the service record', async () => {
    const knex = recording(undefined);
    expect(await serviceHasLinkedProject('svc-1', knex)).toBe(false);
    expect(knex.wheres).toEqual(['projects.scheduled_service_id', 'service_records.scheduled_service_id']);
  });
  test('a found project is linked; a failed read counts as linked', async () => {
    expect(await serviceHasLinkedProject('svc-1', recording({ id: 'p' }))).toBe(true);
    expect(await serviceHasLinkedProject('svc-1', recording(new Error('boom')))).toBe(true);
  });
});
