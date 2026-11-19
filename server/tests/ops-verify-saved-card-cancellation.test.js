const fs = require('fs');
const os = require('os');
const path = require('path');

const { databaseConfig } = require('../../ops/agents/verify-saved-card-cancellation');

const ENV_KEYS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PG_CA_FILE', 'PGSSLROOTCERT', 'PGSSL_SERVER_NAME'];

function withEnv(values, fn) {
  const before = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  }
  try { return fn(); } finally {
    for (const key of ENV_KEYS) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test('databaseConfig uses PGHOST for an empty URL host and keeps loopback synthetic Postgres plain', () => {
  const config = withEnv({ PGHOST: '127.0.0.1', PGPORT: '55432' }, () =>
    databaseConfig('postgres://url-user:url-password@/synthetic?ssl=false&options=-c%20search_path%3Dsynthetic'));

  expect(config.connection).toMatchObject({ host: '127.0.0.1', port: 55432, user: 'url-user', database: 'synthetic', ssl: false });
  expect(config.connection.options).toBe('-c search_path=synthetic');
  const tls = databaseConfig('postgres://localhost/synthetic?sslmode=verify-full');
  expect(tls.connection.ssl).toEqual({});
});

test('remote config verifies with Node public roots and ignores URL downgrade options', () => {
  const config = withEnv({ PGHOST: undefined, PG_CA_FILE: undefined, PGSSLROOTCERT: undefined, PGSSL_SERVER_NAME: undefined }, () =>
    databaseConfig('postgres://url-user:url-password@db.example:6543/app?sslmode=no-verify&ssl=false'));

  expect(config.connection).toMatchObject({ host: 'db.example', port: 6543, ssl: { rejectUnauthorized: true } });
  expect(config.connection.ssl.ca).toBeUndefined();
  expect(config.connection.ssl.checkServerIdentity).toBeUndefined();
});

test('a provider root can come from PGSSLROOTCERT or URL sslrootcert', () => {
  const root = path.join(os.tmpdir(), `verify-saved-card-root-${process.pid}.pem`);
  fs.writeFileSync(root, 'synthetic provider root\n');
  try {
    const fromEnv = withEnv({ PG_CA_FILE: undefined, PGSSLROOTCERT: root }, () =>
      databaseConfig('postgres://u:p@db.example/app'));
    expect(fromEnv.connection.ssl.ca).toBe('synthetic provider root\n');

    const fromUrl = withEnv({ PG_CA_FILE: undefined, PGSSLROOTCERT: undefined }, () =>
      databaseConfig(`postgres://u:p@db.example/app?sslrootcert=${encodeURIComponent(root)}`));
    expect(fromUrl.connection.ssl.ca).toBe('synthetic provider root\n');
  } finally {
    fs.unlinkSync(root);
  }
});

test('a provider proxy can verify its database certificate name without weakening the chain', () => {
  const root = path.join(os.tmpdir(), `verify-saved-card-proxy-root-${process.pid}.pem`);
  fs.writeFileSync(root, 'synthetic provider root\n');
  try {
    const config = withEnv({ PG_CA_FILE: undefined, PGSSLROOTCERT: root, PGSSL_SERVER_NAME: 'database.provider.test' }, () =>
      databaseConfig('postgres://u:p@proxy.provider.test/app'));

    expect(config.connection.ssl).toMatchObject({
      ca: 'synthetic provider root\n',
      rejectUnauthorized: true,
      servername: 'database.provider.test',
    });
    const certificate = { subjectaltname: 'DNS:database.provider.test' };
    expect(config.connection.ssl.checkServerIdentity('proxy.provider.test', certificate)).toBeUndefined();
    expect(config.connection.ssl.checkServerIdentity('proxy.provider.test', {
      subjectaltname: 'DNS:wrong.provider.test',
    })).toHaveProperty('message', expect.stringContaining('does not match'));
  } finally {
    fs.unlinkSync(root);
  }
});
