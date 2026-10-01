/** 20260930200000_tech_status_location_received_at: additive, idempotent (IF NOT EXISTS / IF EXISTS). */
const migration = require('../models/migrations/20260930200000_tech_status_location_received_at');

test('up adds a nullable timestamptz column defaulting to NOW(), idempotently', async () => {
  const raw = jest.fn(async () => undefined);
  await migration.up({ raw });
  expect(raw).toHaveBeenCalledTimes(1);
  expect(raw.mock.calls[0][0]).toBe('ALTER TABLE tech_status ADD COLUMN IF NOT EXISTS location_received_at timestamptz DEFAULT NOW()');
});

test('down drops it only if present', async () => {
  const raw = jest.fn(async () => undefined);
  await migration.down({ raw });
  expect(raw.mock.calls[0][0]).toBe('ALTER TABLE tech_status DROP COLUMN IF EXISTS location_received_at');
});
