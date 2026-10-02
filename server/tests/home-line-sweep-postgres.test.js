/**
 * Home line sweep against real PostgreSQL: the compare-and-set covers every
 * input the line was derived from, so a geocode or address edit that lands
 * between the sweep's read and its write is never stamped over.
 */

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { stampHomeLines } = require('../services/home-line');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('home line sweep on PostgreSQL', () => {
  const schema = `home_line_${randomUUID().replaceAll('-', '')}`;
  const ORIGINAL = process.env.GATE_HOME_LINE;
  let database;

  beforeAll(async () => {
    process.env.GATE_HOME_LINE = 'true';
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.customers (
      id uuid PRIMARY KEY, deleted_at timestamptz,
      address_line1 varchar(255), address_line2 varchar(255), city varchar(100), zip varchar(20),
      latitude decimal(10,7), longitude decimal(10,7),
      home_line_location_id varchar(30), home_line_address_key text, home_line_source varchar(16), home_line_set_at timestamptz)`, [schema]);
  });
  afterAll(async () => {
    if (ORIGINAL === undefined) delete process.env.GATE_HOME_LINE;
    else process.env.GATE_HOME_LINE = ORIGINAL;
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });

  // Runs `between` after the sweep's read resolves and before its writes.
  const withEditAfterRead = (between) => {
    let fired = false;
    return (table) => {
      const builder = database(table);
      const select = builder.select.bind(builder);
      builder.select = (...args) => {
        const pending = select(...args);
        return {
          then: (resolve, reject) => pending.then(async (rows) => {
            if (!fired) { fired = true; await between(); }
            return rows;
          }).then(resolve, reject),
        };
      };
      return builder;
    };
  };

  test('stamps an unchanged row, skips one whose geocode moved after the read', async () => {
    const steady = randomUUID();
    const moving = randomUUID();
    // Blank city, no ZIP: only the geocode decides the line.
    await database('customers').insert([
      { id: steady, address_line1: '1 A St', city: '', latitude: 27.09, longitude: -82.41 },
      { id: moving, address_line1: '2 B St', city: '', latitude: 27.09, longitude: -82.41 },
    ]);
    const result = await stampHomeLines({
      database: withEditAfterRead(() => database('customers').where({ id: moving }).update({ latitude: 27.52, longitude: -82.39 })),
    });

    expect(result).toEqual({ stamped: 1, unchanged: 0, lostRace: 1 });
    expect(await database('customers').where({ id: steady }).first('home_line_location_id', 'home_line_source'))
      .toEqual({ home_line_location_id: 'venice', home_line_source: 'derived' });
    expect((await database('customers').where({ id: moving }).first('home_line_location_id')).home_line_location_id).toBeNull();

    // The next run derives from the new geocode.
    expect(await stampHomeLines({ database })).toEqual({ stamped: 1, unchanged: 1, lostRace: 0 });
    expect((await database('customers').where({ id: moving }).first('home_line_location_id')).home_line_location_id).not.toBe('venice');
  });
});
