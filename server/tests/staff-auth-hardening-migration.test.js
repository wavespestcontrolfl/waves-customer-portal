const migration = require('../models/migrations/20260714000000_staff_auth_hardening');

function fakeColumn() {
  const column = {
    notNullable: jest.fn(() => column),
    defaultTo: jest.fn(() => column),
  };
  return column;
}

function makeKnex({
  activeTimer = false,
  duplicateEmail = false,
  invalidStaffIdentity = false,
  emptyStaffDatabase = false,
  missingActiveAdmin = false,
  missingTable = null,
  missingColumn = null,
} = {}) {
  const updates = [];
  const droppedColumns = [];
  const droppedIndexes = [];
  const integerColumn = fakeColumn();
  const knex = jest.fn((tableName) => {
    const query = {
      where: jest.fn(() => query),
      whereIn: jest.fn(() => query),
      whereNotNull: jest.fn(() => query),
      update: jest.fn(async (values) => {
        updates.push({ tableName, values });
        return 1;
      }),
    };
    return query;
  });
  knex.schema = {
    alterTable: jest.fn(async (_name, callback) => {
      callback({
        integer: jest.fn(() => integerColumn),
        boolean: jest.fn(() => fakeColumn()),
        timestamp: jest.fn(() => fakeColumn()),
        string: jest.fn(() => fakeColumn()),
        index: jest.fn(),
        dropColumn: jest.fn((columnName) => droppedColumns.push(columnName)),
        dropIndex: jest.fn((_columns, indexName) => droppedIndexes.push(indexName)),
      });
    }),
    hasTable: jest.fn(async (tableName) => tableName !== missingTable),
    hasColumn: jest.fn(async (tableName, columnName) => (
      `${tableName}.${columnName}` !== missingColumn
    )),
  };
  knex.fn = { now: jest.fn(() => 'NOW') };
  knex.raw = jest.fn((sql) => {
    if (sql.includes('staff_account_count')) {
      return { rows: [{
        staff_account_count: emptyStaffDatabase ? 0 : 2,
        active_admin_count: missingActiveAdmin ? 0 : (emptyStaffDatabase ? 0 : 1),
      }] };
    }
    if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: activeTimer }] };
    if (sql.includes('Active Staff accounts') || sql.includes('SELECT id\n    FROM technicians')) {
      return { rows: invalidStaffIdentity ? [{ id: 'tech-invalid' }] : [] };
    }
    if (sql.includes('canonical_email')) {
      return { rows: duplicateEmail ? [{ canonical_email: 'duplicate@example.test' }] : [] };
    }
    return { sql };
  });
  return {
    knex,
    integerColumn,
    updates,
    droppedColumns,
    droppedIndexes,
  };
}

describe('staff auth hardening migration', () => {
  test.each([
    [{ NODE_ENV: 'production' }, true],
    [{ NODE_ENV: 'production', STAFF_MAINTENANCE_MODE: 'false' }, true],
    [{ NODE_ENV: 'production', STAFF_MAINTENANCE_MODE: 'true' }, false],
    [{ RAILWAY_ENVIRONMENT_NAME: 'production' }, true],
    [{ NODE_ENV: 'development', RAILWAY_ENVIRONMENT_NAME: 'Production' }, true],
    [{
      NODE_ENV: 'development',
      RAILWAY_ENVIRONMENT_NAME: ' production ',
      STAFF_MAINTENANCE_MODE: 'true',
    }, false],
    [{ NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'staging' }, false],
    [{ NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'waves-customer-portal-pr-2727' }, false],
    [{ NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: '   ' }, true],
    [{ NODE_ENV: 'development', RAILWAY_ENVIRONMENT_NAME: 'staging' }, false],
    [{ NODE_ENV: 'development' }, false],
    [{ NODE_ENV: 'test' }, false],
  ])('requires the exact maintenance interlock only in production (%p)', (env, shouldThrow) => {
    if (shouldThrow) {
      expect(() => migration.assertMaintenanceInterlock(env)).toThrow(
        /STAFF_MAINTENANCE_MODE=true/,
      );
    } else {
      expect(() => migration.assertMaintenanceInterlock(env)).not.toThrow();
    }
  });

  test.each([
    [{ missingTable: 'push_subscriptions' }, /push_subscriptions table/],
    [{ missingColumn: 'push_subscriptions.admin_user_id' }, /push_subscriptions\.admin_user_id/],
    [{ missingColumn: 'push_subscriptions.active' }, /push_subscriptions\.active/],
  ])('fails preflight before the writer fence when push revocation schema is incomplete', async (options, error) => {
    const { knex, updates } = makeKnex(options);

    await expect(migration.up(knex)).rejects.toThrow(error);

    expect(knex.raw).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid Staff writer generation %p before querying schema',
    async (generation) => {
      const { knex } = makeKnex();
      await expect(migration.setActiveWriteGeneration(knex, generation)).rejects.toThrow(
        /positive integer/,
      );
      expect(knex.schema.hasTable).not.toHaveBeenCalled();
    },
  );

  test('adds a nonzero version, revokes sessions/push, and never rewrites password hashes', async () => {
    const { knex, integerColumn, updates } = makeKnex();

    await migration.up(knex);

    expect(integerColumn.notNullable).toHaveBeenCalled();
    expect(integerColumn.defaultTo).toHaveBeenCalledWith(1);
    expect(knex.schema.alterTable).toHaveBeenCalledWith(
      'push_subscriptions',
      expect.any(Function),
    );
    expect(knex.raw.mock.calls.map(([sql]) => sql).join('\n')).toMatch(
      /LOCK TABLE time_entries[\s\S]*staff_write_generation IS NOT DISTINCT FROM 2/,
    );
    expect(knex.raw.mock.calls.map(([sql]) => sql).join('\n')).toMatch(
      /LOCK TABLE technicians IN EXCLUSIVE MODE[\s\S]*UPDATE technicians[\s\S]*LOWER\(BTRIM\(email\)\)[\s\S]*CREATE UNIQUE INDEX technicians_staff_email_canonical_uidx/,
    );
    expect(updates).toEqual([
      {
        tableName: 'technicians',
        values: {
          auth_token_version: { sql: 'auth_token_version + 1' },
          updated_at: 'NOW',
        },
      },
      { tableName: 'push_subscriptions', values: { active: false } },
    ]);
    expect(JSON.stringify(updates)).not.toMatch(/password_hash|waves2026/);
  });

  test('allows a truly empty database to bootstrap while the audit remains responsible for admin setup', async () => {
    const { knex } = makeKnex({ emptyStaffDatabase: true });

    await expect(migration.up(knex)).resolves.toBeUndefined();

    expect(knex.schema.alterTable).toHaveBeenCalledWith('technicians', expect.any(Function));
  });

  test('does not revoke sessions while a Staff timer is active', async () => {
    const { knex, updates } = makeKnex({ activeTimer: true });

    await expect(migration.up(knex)).rejects.toThrow(/Active Staff timers/);

    expect(updates).toEqual([]);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test.each([
    [{ missingActiveAdmin: true }, /active Staff admin/],
    [{ invalidStaffIdentity: true }, /valid email/],
    [{ duplicateEmail: true }, /collision/],
  ])('fails before changing the writer fence for unsafe Staff identity state', async (options, error) => {
    const { knex, updates } = makeKnex(options);

    await expect(migration.up(knex)).rejects.toThrow(error);

    const rawSql = knex.raw.mock.calls.map(([sql]) => sql).join('\n');
    expect(rawSql).not.toMatch(/LOCK TABLE time_entries|CREATE UNIQUE INDEX/);
    expect(updates).toEqual([]);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('is forward-only and refuses to remove the revocation boundary', async () => {
    const { knex } = makeKnex();

    await expect(migration.down(knex)).rejects.toThrow(/forward-only/);

    expect(knex.raw).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });
});
