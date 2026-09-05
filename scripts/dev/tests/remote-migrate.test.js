'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selectDeployment, privateDatabaseUrl, PROJECT_ID } = require('../remote-migrate');
const root = path.resolve(__dirname, '../../..');
const config = { environmentId: '11111111-1111-1111-1111-111111111111',
  serviceId: '22222222-2222-2222-2222-222222222222', databaseServiceId: '33333333-3333-3333-3333-333333333333' };
const id = '44444444-4444-4444-4444-444444444444';
const sha = 'a'.repeat(40);
function status() {
  return { id: PROJECT_ID, environments: { edges: [{ node: { id: config.environmentId, name: 'preview', canAccess: true,
    serviceInstances: { edges: [{ node: { serviceId: config.databaseServiceId } }, { node: { serviceId: config.serviceId,
      activeDeployments: [{ id: 'deployment', status: 'SUCCESS', meta: { commitHash: sha, repo: 'wavespestcontrolfl/waves-customer-portal' },
        instances: [{ id: 'instance', status: 'RUNNING' }] }] } }] } } }] } };
}

test('remote selection refuses production, missing services and stale commits', () => {
  assert.equal(selectDeployment(status(), config, sha).instanceId, 'instance');
  const production = status(); production.environments.edges[0].node.name = 'production';
  assert.throws(() => selectDeployment(production, config, sha), /dev\/preview/);
  assert.throws(() => selectDeployment(status(), config, 'b'.repeat(40)), /matches this checkout/);
  assert.throws(() => selectDeployment(status(), { ...config, databaseServiceId: id }, sha), /absent/);
  const renamed = status(); renamed.environments.edges[0].node.id = '8fb20379-5f3d-4590-b39c-19c03079afdd';
  assert.throws(() => selectDeployment(renamed, { ...config, environmentId: renamed.environments.edges[0].node.id }, sha), /dev\/preview/);
});

test('private network conversion binds the worktree database to the verified service and rejects URL overrides', () => {
  const variables = { RAILWAY_PROJECT_ID: PROJECT_ID, RAILWAY_ENVIRONMENT_ID: config.environmentId,
    RAILWAY_SERVICE_ID: config.databaseServiceId, RAILWAY_TCP_PROXY_DOMAIN: 'test.proxy.rlwy.net',
    RAILWAY_TCP_PROXY_PORT: '1234', RAILWAY_TCP_APPLICATION_PORT: '5432', RAILWAY_PRIVATE_DOMAIN: 'postgres.railway.internal' };
  const url = `postgres://fixture:secret@test.proxy.rlwy.net:1234/waves_qa_${id.replaceAll('-', '')}`;
  assert.equal(new URL(privateDatabaseUrl({ id }, url, variables, config)).hostname, 'postgres.railway.internal');
  for (const wrong of [url.replace('test.proxy', 'other.proxy'), url.replace('waves_qa_', 'foreign_'), `${url}?host=other`, `${url}#override`]) {
    assert.throws(() => privateDatabaseUrl({ id }, wrong, variables, config), /private QA database/);
  }
  assert.throws(() => privateDatabaseUrl({ id }, url, { ...variables, RAILWAY_ENVIRONMENT_ID: id }, config), /identity mismatch/);
});

test('remote worker rejects mismatches before Knex and passes only the isolated environment to successful runs', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-remote-worker-'));
  fs.cpSync(path.join(root, 'scripts/dev'), path.join(fixture, 'scripts/dev'), { recursive: true });
  fs.writeFileSync(path.join(fixture, '.nvmrc'), '20\n');
  const marker = path.join(fixture, 'spawn.json');
  const preload = path.join(fixture, 'preload.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs');const {EventEmitter}=require('node:events');
    Object.defineProperty(process.versions,'node',{value:process.env.TEST_NODE_VERSION||'20.20.2'});
    require('node:child_process').spawn=(exe,args,options)=>{
      fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({exe,args,env:options.env}));
      const child=new EventEmitter();child.kill=()=>{};process.nextTick(()=>child.emit('exit',Number(process.env.TEST_EXIT||0)));return child;
    };`);
  const request = { ...config, projectId: PROJECT_ID, deploymentId: 'deployment', sha, worktreeId: id, nonce: id,
    databaseUrl: `postgres://fixture:secret@postgres.railway.internal:5432/waves_qa_${id.replaceAll('-', '')}` };
  const remote = { PATH: process.env.PATH, RAILWAY_PROJECT_ID: PROJECT_ID, RAILWAY_ENVIRONMENT_ID: config.environmentId,
    RAILWAY_ENVIRONMENT_NAME: 'preview', RAILWAY_SERVICE_ID: config.serviceId, RAILWAY_DEPLOYMENT_ID: 'deployment',
    RAILWAY_GIT_COMMIT_SHA: sha, STRIPE_SECRET_KEY: 'must-not-inherit', DATABASE_URL: 'must-not-inherit' };
  function run(payload = request, overrides = {}) {
    fs.rmSync(marker, { force: true });
    return spawnSync(process.execPath, ['--require', preload, 'scripts/dev/remote-migrate-worker.js'], {
      cwd: fixture, env: { ...remote, ...overrides }, input: JSON.stringify(payload), encoding: 'utf8' });
  }
  try {
    for (const [payload, overrides] of [
      [{ ...request, sha: 'b'.repeat(40) }, {}], [request, { RAILWAY_ENVIRONMENT_NAME: 'production' }],
      [request, { TEST_NODE_VERSION: '26.8.1' }], [{ ...request, databaseUrl: request.databaseUrl + '?host=other' }, {}],
      [{ ...request, databaseUrl: request.databaseUrl.replace('/waves_qa_', '/other_') }, {}],
    ]) {
      const result = run(payload, overrides);
      assert.equal(result.status, 1); assert.equal(fs.existsSync(marker), false);
      assert.doesNotMatch(result.stderr, /secret|postgres:\/\//);
    }
    fs.writeFileSync(path.join(fixture, '.env'), 'STRIPE_SECRET_KEY=must-not-load');
    assert.equal(run().status, 1); assert.equal(fs.existsSync(marker), false);
    fs.unlinkSync(path.join(fixture, '.env'));
    assert.equal(run().status, 0);
    const child = JSON.parse(fs.readFileSync(marker));
    assert.deepEqual(child.args, ['node_modules/knex/bin/cli.js', 'migrate:latest', '--knexfile', 'server/knexfile.js']);
    assert.equal(child.env.DATABASE_URL, request.databaseUrl);
    assert.equal(child.env.WAVES_LOCAL_DEV, '1'); assert.equal(child.env.GATE_CRON_JOBS, 'false');
    for (const key of ['STRIPE_SECRET_KEY', 'NODE_OPTIONS', 'RAILWAY_DEPLOYMENT_ID']) assert.equal(child.env[key], undefined);
    assert.equal(run(request, { TEST_EXIT: '7' }).status, 7);
    assert.equal(run().status, 0, 'An explicit retry must remain available after a failed migration process');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('SSH exit zero requires this invocation’s worker acknowledgment', () => {
  for (const mode of ['complete', 'missing', 'stale']) {
    const result = spawnSync(process.execPath, ['-e', `
      const {EventEmitter}=require('node:events');
      const context=require('./scripts/dev/context');
      context.git=()=>'';context.identity=()=>({sha:${JSON.stringify(sha)}});
      const fs=require('node:fs');const read=fs.readFileSync;
      fs.readFileSync=(file,...args)=>String(file).endsWith('/remote.json')?JSON.stringify(${JSON.stringify(config)}):read(file,...args);
      const cp=require('node:child_process');
      cp.execFileSync=(_command,args)=>args[0]==='--version'?'railway 5.49.0':JSON.stringify(args[0]==='status'?${JSON.stringify(status())}:{
        RAILWAY_PROJECT_ID:${JSON.stringify(PROJECT_ID)},RAILWAY_ENVIRONMENT_ID:${JSON.stringify(config.environmentId)},
        RAILWAY_SERVICE_ID:${JSON.stringify(config.databaseServiceId)},RAILWAY_TCP_PROXY_DOMAIN:'test.proxy.rlwy.net',
        RAILWAY_TCP_PROXY_PORT:'1234',RAILWAY_TCP_APPLICATION_PORT:'5432',RAILWAY_PRIVATE_DOMAIN:'postgres.railway.internal'});
      cp.spawn=(_command,args)=>{
        if(args.some(a=>a.includes('secret')))throw new Error('credential in argv');
        const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};
        child.stdin=new EventEmitter();child.stdin.end=input=>{
          const request=JSON.parse(input);
          process.nextTick(()=>{
            if(${JSON.stringify(mode)}!=='missing')child.stdout.emit('data',JSON.stringify({remoteMigration:'complete',nonce:${JSON.stringify(mode)}==='complete'?request.nonce:'stale'})+'\\n');
            child.emit('close',0);
          });
        };return child;
      };
      require('./scripts/dev/remote-migrate').remoteMigration({root:process.cwd(),id:${JSON.stringify(id)}},
        {DATABASE_URL:'postgres://fixture:secret@test.proxy.rlwy.net:1234/waves_qa_${id.replaceAll('-', '')}'})
        .then(code=>{process.exitCode=code});
    `], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, mode === 'complete' ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /postgres:\/\/|fixture:secret/);
  }
});
