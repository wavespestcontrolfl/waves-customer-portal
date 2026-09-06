'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');

// Execute the real doctor and shared migration preflight. Only Git identity,
// local selection and Railway responses are synthetic; SSH and DB must not run.
function run(mode) {
  return spawnSync(process.execPath, ['-e', `
    const fs=require('node:fs');const cp=require('node:child_process');
    const mode=${JSON.stringify(mode)};
    const id='44444444-4444-4444-4444-444444444444';
    const project='5a674c8a-d443-4126-8bfd-3d4775464448';
    const config={environmentId:'11111111-1111-1111-1111-111111111111',
      serviceId:'22222222-2222-2222-2222-222222222222',databaseServiceId:'33333333-3333-3333-3333-333333333333'};
    if(mode==='production')config.environmentId='8fb20379-5f3d-4590-b39c-19c03079afdd';
    if(mode==='missing-key')config.identityFile='/no-such-waves-key';
    const context=require('./scripts/dev/context');
    context.git=()=>mode==='dirty'?' M file':'';
    context.identity=()=>({sha:'a'.repeat(40)});
    context.childEnvironment=()=>({DATABASE_URL:'postgres://fixture:secret@test.proxy.rlwy.net:1234/'+
      (mode==='foreign-db'?'foreign':'waves_qa_'+id.replaceAll('-',''))});
    const read=fs.readFileSync;
    fs.readFileSync=(file,...args)=>{
      if(!String(file).endsWith('/remote.json'))return read(file,...args);
      if(mode==='missing-config')throw new Error('ENOENT');
      if(mode==='invalid-config')return '{secret';
      return JSON.stringify(config);
    };
    cp.execFileSync=(_exe,args)=>{
      if(args[0]==='--version')return mode==='old-cli'?'railway 5.48.0':'railway 5.49.0';
      if(mode==='lookup-error')throw new Error('credential=secret');
      if(args[0]==='status')return JSON.stringify({id:project,environments:{edges:[{node:{
        id:config.environmentId,name:'preview',canAccess:true,serviceInstances:{edges:[
          {node:{serviceId:config.databaseServiceId}},
          {node:{serviceId:config.serviceId,activeDeployments:[{id:'deployment',status:'SUCCESS',
            meta:{repo:'wavespestcontrolfl/waves-customer-portal',commitHash:(mode==='stale'?'b':'a').repeat(40)},
            instances:[{id:'instance',status:'RUNNING'}]}]}}
        ]}}}]}});
      if(args[0]==='variable')return JSON.stringify({RAILWAY_PROJECT_ID:project,RAILWAY_ENVIRONMENT_ID:config.environmentId,
        RAILWAY_SERVICE_ID:config.databaseServiceId,RAILWAY_TCP_PROXY_DOMAIN:'test.proxy.rlwy.net',RAILWAY_TCP_PROXY_PORT:'1234',
        RAILWAY_TCP_APPLICATION_PORT:'5432',RAILWAY_PRIVATE_DOMAIN:'postgres.railway.internal'});
      throw new Error('Unexpected command '+args[0]);
    };
    cp.spawn=()=>{throw new Error('Doctor must not spawn SSH or migrations');};
    require.cache[require.resolve('knex')]={exports:()=>{throw new Error('Doctor must not connect to DB');}};
    require('./scripts/dev/doctor').doctor({root:process.cwd(),id,ports:{}},{ports:false,remote:true})
      .then(report=>console.log(JSON.stringify(report)))
      .catch(error=>{console.error(error.message);process.exitCode=1});
  `], { cwd: root, encoding: 'utf8' });
}

test('remote doctor gives actionable failures without exposing credentials or writing', () => {
  for (const [mode, message] of [
    ['missing-config', /Create valid JSON/], ['invalid-config', /Create valid JSON/],
    ['production', /Production is forbidden/], ['missing-key', /existing SSH private key/],
    ['dirty', /Commit all checkout changes/], ['old-cli', /CLI 5.49/],
    ['lookup-error', /railway whoami/], ['stale', /Wait for its PR preview/],
    ['foreign-db', /private QA database/],
  ]) {
    const result = run(mode);
    assert.equal(result.status, 1, mode);
    assert.match(result.stderr, message, mode);
    assert.doesNotMatch(result.stdout + result.stderr, /secret|postgres:\/\//);
  }
});

test('remote doctor verifies configuration before migrations and distinguishes unchecked SSH/runtime', () => {
  const result = run('valid');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.remote.configuration, 'verified');
  assert.equal(report.remote.sshAndRuntime, 'not checked');
  assert.match(report.remote.database, /connectivity and migrations not checked/);
  assert.match(report.remote.nextSteps[1], /'--deployment-instance' 'instance'.*'--version'/);
  assert.ok(report.remote.nextSteps.includes('npm run dev:migrate -- --remote'));
  assert.doesNotMatch(result.stdout, /secret|postgres:\/\//);
});

test('doctor rejects conflicting or unknown CLI modes', () => {
  for (const options of [['--frontend', '--remote'], ['--remtoe']]) {
    // Unknown flags fail even before worktree setup. Conflicting flags are
    // also checked by the public doctor function independent of local setup.
    const result = options.length === 2
      ? spawnSync(process.execPath, ['-e', "require('./scripts/dev/doctor').doctor({}, {frontend:true, remote:true}).catch(e=>{console.error(e.message);process.exitCode=1})"], { cwd: root, encoding: 'utf8' })
      : spawnSync(process.execPath, ['scripts/dev/doctor.js', ...options], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not both|Usage:/);
  }
});
