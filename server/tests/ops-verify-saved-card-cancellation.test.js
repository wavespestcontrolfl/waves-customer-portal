const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const { databaseConfig, databaseDriverConfig } = require('../../ops/agents/verify-saved-card-cancellation');

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

  expect(config.connection).toMatchObject({
    host: 'db.example', port: 6543,
    ssl: { rejectUnauthorized: true, servername: 'db.example', checkServerIdentity: expect.any(Function) },
  });
  expect(config.connection.ssl.ca).toBeUndefined();
  expect(config.connection.ssl.checkServerIdentity('ignored.example', {
    subjectaltname: 'DNS:db.example',
  })).toBeUndefined();
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

test('the PostgreSQL handshake through a DNS proxy sends the requested database hostname', async () => {
  const tls = require('node:tls');
  const net = require('node:net');
  const { Client } = require('pg');
  const receivedName = jest.fn();
  const tlsServer = tls.createServer({ SNICallback(name, done) {
    receivedName(name);
    done(new Error('Synthetic handshake ends after SNI'));
  } });
  const gateway = net.createServer((socket) => {
    socket.once('data', (packet) => {
      if (packet.length !== 8 || packet.readUInt32BE(4) !== 80877103) return socket.destroy();
      socket.write('S');
      tlsServer.emit('connection', socket);
    });
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const resolveProxy = jest.fn(async () => ({ address: '127.0.0.1' }));
    const config = await withEnv({ PGSSL_SERVER_NAME: 'database.provider.test' }, () =>
      databaseDriverConfig(`postgres://synthetic:synthetic@proxy.provider.test:${gateway.address().port}/billing`, resolveProxy));
    const client = new Client({ ...config.connection, connectionTimeoutMillis: 5000 });
    try {
      await expect(client.connect()).rejects.toThrow();
      expect(resolveProxy).toHaveBeenCalledWith('proxy.provider.test');
      expect(receivedName).toHaveBeenCalledWith('database.provider.test');
    } finally {
      await client.end();
    }
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
  }
});

test('a remote IP verifies its IP SAN without sending an IP literal as SNI', () => {
  const config = withEnv({ PGSSL_SERVER_NAME: undefined }, () =>
    databaseConfig('postgres://u:p@203.0.113.8/app'));

  expect(config.connection.ssl).toMatchObject({
    rejectUnauthorized: true,
    checkServerIdentity: expect.any(Function),
  });
  expect(config.connection.ssl.servername).toBeUndefined();
  expect(config.connection.ssl.checkServerIdentity('ignored.example', {
    subjectaltname: 'IP Address:203.0.113.8',
  })).toBeUndefined();
  expect(config.connection.ssl.checkServerIdentity('ignored.example', {
    subjectaltname: 'IP Address:203.0.113.9',
  })).toHaveProperty('message', expect.stringContaining('does not match'));
});

test('the CLI refuses ambient DATABASE_URL in place of its verifier-specific URL', () => {
  const script = path.resolve(__dirname, '../../ops/agents/verify-saved-card-cancellation.js');
  const run = spawnSync(process.execPath, [script, '--attempt', '00000000-0000-4000-8000-000000000000', '--intent', 'pi_synthetic'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgresql://must-not-be-used.invalid/app',
      STRIPE_SECRET_KEY: 'sk_test_not_used',
    },
  });

  expect(run.status).toBe(1);
  expect(run.stderr).toContain('Supply SAVED_CARD_CANCELLATION_DATABASE_URL and STRIPE_SECRET_KEY');
  expect(run.stderr).not.toContain('must-not-be-used');
});
