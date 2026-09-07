/** READ-ONLY source model; no database, environment credentials, app startup, or sends.
 * Replays SMS data transformations over in-memory default rows. This is NOT
 * a live database inventory or PostgreSQL migration verification.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const dir = path.join(root, 'server/models/migrations');
let source = '';
let nextId = 1;
const tables = { sms_templates: [], sms_template_variants: [] };
const events = [];
const columns = Object.fromEntries(['id','template_key','name','category','body','description','variables','trigger_event_key','sort_order','is_active','is_internal','created_at','updated_at','status','metadata'].map(k => [k, {}]));
function query(table) {
  const filters = [];
  let op = 'select', patch, inserted, conflict, conflictMode, conflictPatch, single = false;
  const q = {
    where(a,b,c) {
      if (typeof a === 'function') { a.call(q,q); return q; }
      if (typeof a === 'object') filters.push(row => Object.entries(a).every(([k,v]) => row[k] === v));
      else if (c === undefined) filters.push(row => row[a] === b);
      else if (b === 'like') filters.push(row => new RegExp('^'+c.replace(/%/g,'.*').replace(/_/g,'.')+'$').test(row[a]));
      else if (b === '=' || b === '==') filters.push(row => row[a] === c);
      else if (b === '!=' || b === '<>') filters.push(row => row[a] !== c);
      else throw Error(`Unsupported WHERE ${a} ${b}`);
      return q;
    },
    whereNot(a,b) { filters.push(row => typeof a === 'object' ? !Object.entries(a).every(([k,v]) => row[k] === v) : row[a] !== b); return q; },
    whereIn(k,v) { filters.push(row => v.includes(row[k])); return q; },
    whereNotIn(k,v) { filters.push(row => !v.includes(row[k])); return q; },
    whereNull(k) { filters.push(row => row[k] == null); return q; },
    whereNotNull(k) { filters.push(row => row[k] != null); return q; },
    select() { return q; },
    first() { single = true; return q; },
    orderBy() { return q; },
    columnInfo() { return Promise.resolve(columns); },
    insert(rows) { op = 'insert'; inserted = Array.isArray(rows) ? rows : [rows]; return q; },
    onConflict(key) { conflict = key; return q; },
    ignore() { conflictMode = 'ignore'; return q; },
    merge(values) { conflictMode = 'merge'; conflictPatch = values; return q; },
    update(values) { op = 'update'; patch = values; return q; },
    del() { op = 'delete'; return q; },
    returning() { return q; },
    then(resolve,reject) {
      try {
        // Unrelated email/config tables are outside this source model.
        if (!(table in tables)) return Promise.resolve(single ? undefined : []).then(resolve,reject);
        const rows = tables[table];
        const matched = rows.filter(row => filters.every(f => f(row)));
        if (op === 'select') return Promise.resolve(single ? matched[0] && {...matched[0]} : matched.map(r => ({...r}))).then(resolve,reject);
        if (op === 'insert') {
          for (const data of inserted) {
            const existing = conflict && rows.find(row => row[conflict] === data[conflict]);
            if (existing && conflictMode === 'ignore') continue;
            if (existing && conflictMode === 'merge') {
              const update = Array.isArray(conflictPatch) ? Object.fromEntries(conflictPatch.map(k => [k,data[k]])) : conflictPatch || data;
              Object.assign(existing,update,{_source:source,...('body' in update ? {_bodySource:source} : {})});
            } else {
              if (rows.some(r => r.template_key === data.template_key) && table === 'sms_templates') throw Error('duplicate key '+data.template_key);
              rows.push({id:'source-'+nextId++,is_active:true,is_internal:false,...data,_source:source,_bodySource:source});
            }
          }
        } else if (op === 'update') {
          for (const row of matched) { const values = Object.fromEntries(Object.entries(patch).map(([k,v]) => [k, typeof v === 'function' ? v(row) : v])); Object.assign(row,values,{_source:source,...('body' in patch ? {_bodySource:source} : {})}); }
        } else if (op === 'delete') tables[table] = rows.filter(row => !matched.includes(row));
        events.push({source,table,op,matched:matched.length});
        return Promise.resolve(matched.length).then(resolve,reject);
      } catch(e) { return Promise.reject(e).then(resolve,reject); }
    },
  };
  q.andWhere = q.where;
  q.delete = q.del;
  return q;
}
const field = new Proxy(function(){ return field; }, { get:()=>field });
query.schema = {
  hasTable: async name => name in tables || name === 'appointment_card_requests',
  hasColumn: async () => true,
  createTable: async (name,cb) => cb(field),
  alterTable: async (name,cb) => cb(field),
};
query.fn = {now:()=>new Date('2026-09-07T16:00:00Z')};
query.raw = sql => {
  if (sql === "replace(body, '—', ':')") return row => row.body.replace(/—/g, ':');
  if (/sms_templates|sms_template_variants/i.test(sql)) throw Error('Unsupported SMS raw SQL');
  return Promise.resolve({rows:[]});
};
query.transaction = async cb => cb(query);
const cache = new Map();
function load(filename) {
  const resolved = path.resolve(filename);
  if (!resolved.startsWith(dir+path.sep)) throw Error('Blocked import outside migration sources: '+resolved);
  if (resolved.endsWith('.json')) return JSON.parse(fs.readFileSync(resolved,'utf8'));
  if (cache.has(resolved)) return cache.get(resolved);
  const module = {exports:{}};
  const context = vm.createContext({module,exports:module.exports,console:{log(){},warn(){}},Date,Set,Map,JSON,
    require(spec) { if (!spec.startsWith('.')) throw Error('Blocked external import: '+spec); const f=path.resolve(path.dirname(resolved),spec); return load(path.extname(f) ? f : f+'.js'); },
  });
  new vm.Script(fs.readFileSync(resolved,'utf8'),{filename:resolved}).runInContext(context,{timeout:1000});
  cache.set(resolved,module.exports);
  return module.exports;
}
async function catalogue() {
  const first='20260414000002_upsert_sms_templates.js';
  const files=fs.readdirSync(dir).filter(f => f.endsWith('.js') && f >= first && /sms_templates/.test(fs.readFileSync(path.join(dir,f),'utf8'))).sort();
  for (const file of files) {
    source=file;
    try { await load(path.join(dir,file)).up(query); }
    catch(e) { throw Error(file+': '+e.message); }
  }
  return {templates:tables.sms_templates, migrations:files, events};
}
if (require.main === module) catalogue().then(result => {
  const out=path.join(__dirname,'sms-template-audit-2026-09-07-catalogue.json');
  fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({templates:result.templates.length,migrations:result.migrations.length,out}));
}).catch(e => { console.error(e.message); process.exitCode=1; });
module.exports={catalogue};
