const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const processorPath = path.join(__dirname, '..', 'services', 'call-recording-processor.js');
const processorSource = fs.readFileSync(processorPath, 'utf8');
const processorAst = parse(processorSource, { sourceType: 'script' });

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

function sourceForVariable(name) {
  let found;
  walk(processorAst, (node) => {
    if (!found && node.type === 'VariableDeclarator' && node.id?.name === name) found = node.init;
  });
  if (!found) throw new Error(`Could not find ${name} in call-recording-processor.js`);
  return processorSource.slice(found.start, found.end);
}

function sourceForFunction(name) {
  let found;
  walk(processorAst, (node) => {
    if (!found && node.type === 'FunctionDeclaration' && node.id?.name === name) found = node;
  });
  if (!found) throw new Error(`Could not find ${name} in call-recording-processor.js`);
  return processorSource.slice(found.start, found.end);
}

function sourceForStatement(containing) {
  let found;
  walk(processorAst, (node) => {
    if (found || node.type !== 'ExpressionStatement') return;
    const source = processorSource.slice(node.start, node.end);
    if (source.includes(containing)) found = source;
  });
  if (!found) throw new Error(`Could not find statement containing ${containing}`);
  return found;
}

function sourceForRecoveredInsert() {
  const candidates = [];
  walk(processorAst, (node) => {
    if (node.type !== 'IfStatement') return;
    const source = processorSource.slice(node.start, node.end);
    if (source.includes("flag: 'address_recovered'")
      && source.includes("bridgeNeedsConfirmation.push('address_recovered')")) candidates.push(source);
  });
  const found = candidates.sort((a, b) => a.length - b.length)[0];
  if (!found) throw new Error('Could not find the dedicated address_recovered insert');
  return found;
}

const initialMarkerReconcileSource = sourceForStatement('recovery-marker reconcile failed');
const addressRecoveryPayloadSource = sourceForVariable('addressRecoveryPayload');
const finalEvidenceReconcileSource = sourceForVariable('reconcileAddressRecoveryEvidence');
const recoveredInsertSource = sourceForRecoveredInsert();
const recoveryMarkerPayloadSource = sourceForFunction('recoveryMarkerPayload');

function compileAsync(names, body) {
  return Function(...names, `'use strict'; return (async () => { ${body} })();`);
}

const runInitialMarkerReconcile = compileAsync(
  ['db', 'call', 'procToken', 'addressRecovery', 'recoveryPassStamp', 'recoveryMarkerPayload', 'logger', 'maskSid', 'callSid'],
  initialMarkerReconcileSource,
);

const runFinalEvidenceReconcile = compileAsync(
  ['db', 'call', 'procToken', 'addressRecovery', 'recoveryPassStamp', 'recoveryMarkerPayload', 'logger', 'maskSid', 'callSid', 'rawStreetBeforeAdopt'],
  `const reconcileAddressRecoveryEvidence = ${finalEvidenceReconcileSource}; await reconcileAddressRecoveryEvidence();`,
);

const runRecoveredInsert = compileAsync(
  ['db', 'call', 'addressRecovery', 'v2Extraction', 'rawStreetBeforeAdopt', 'contactDictation', 'buildTriageItem', 'bridgeNeedsConfirmation'],
  recoveredInsertSource,
);

const buildAddressRecoveryPayload = Function(
  'addressRecovery',
  'rawStreetBeforeAdopt',
  `'use strict'; const addressRecoveryPayload = ${addressRecoveryPayloadSource}; return addressRecoveryPayload;`,
);

const recoveryMarkerPayload = Function(
  `'use strict'; ${recoveryMarkerPayloadSource}; return recoveryMarkerPayload;`,
)();

function makeDatabase({ token = 'replacement-token', cards = [] } = {}) {
  const state = {
    callLog: [{ id: 'call-1', processing_token: token }],
    cards: cards.map((card) => ({ status: 'open', ...card, payload: { ...card.payload } })),
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.exists = [];
      this.inserted = null;
    }

    select() { return this; }
    from(table) { this.table = table; return this; }
    where(arg, value) {
      if (typeof arg === 'object') {
        Object.entries(arg).forEach(([key, expected]) => this.filters.push([key, expected]));
      } else {
        this.filters.push([String(arg).replace(/^call_log\./, ''), value]);
      }
      return this;
    }
    whereRaw(sql, bindings) {
      if (sql === 'call_log.id = ?') this.filters.push(['id', bindings[0]]);
      else throw new Error(`Unexpected whereRaw in recovery claim test: ${sql}`);
      return this;
    }
    whereIn(column, values) { this.filters.push([column, new Set(values)]); return this; }
    whereExists(callback) {
      const subquery = new Query();
      callback.call(subquery);
      this.exists.push(subquery);
      return this;
    }
    insert(row) { this.inserted = row; return this; }
    onConflict() { return this; }
    async ignore() {
      const duplicate = state.cards.some((row) => row.call_log_id === this.inserted.call_log_id
        && row.reason_code === this.inserted.reason_code
        && ['open', 'in_progress'].includes(row.status));
      if (!duplicate) state.cards.push({ status: 'open', ...this.inserted });
      return duplicate ? 0 : 1;
    }
    rows() {
      const rows = this.table === 'call_log' ? state.callLog : state.cards;
      return rows.filter((row) => this.filters.every(([column, expected]) => (
        expected instanceof Set ? expected.has(row[column]) : row[column] === expected
      )));
    }
    async update(patch) {
      if (!this.exists.every((subquery) => subquery.rows().length > 0)) return 0;
      const rows = this.rows();
      rows.forEach((row) => {
        for (const [column, value] of Object.entries(patch)) {
          row[column] = value?.__raw ? applyPayloadRaw(row[column], value) : value;
        }
      });
      return rows.length;
    }
  }

  function db(table) { return new Query(table); }
  db.raw = (sql, bindings = []) => ({ __raw: true, sql, bindings });
  db.state = state;
  return db;
}

function applyPayloadRaw(payload, raw) {
  const next = { ...(payload || {}) };
  if (raw.sql.includes("- 'recovery_superseded_at'")) delete next.recovery_superseded_at;
  if (raw.sql.includes("- 'extraction_model'")) delete next.extraction_model;
  if (raw.sql.includes("- 'extraction_prompt_version'")) delete next.extraction_prompt_version;
  return { ...next, ...JSON.parse(raw.bindings[0]) };
}

const logger = { warn: jest.fn() };
const maskSid = (value) => value;
const recoveryPassStamp = { extraction_model: 'extractor-a', extraction_prompt_version: 'prompt-a' };
const recovered = {
  attempted: true,
  recovered: { address_line1: '100 4th Avenue East' },
  candidates: ['100 4th Avenue East'],
  method: 'phonetic',
};

describe('address-recovery evidence claim fencing', () => {
  beforeEach(() => logger.warn.mockClear());

  test('a stale successful pass cannot revive the card retired by its failed replacement', async () => {
    const originalPayload = {
      address_as_heard: '100 Fort Avenue East',
      address_recovered: '100 4th Avenue East',
      recovery_superseded_at: 'replacement-failed',
    };
    const db = makeDatabase({
      cards: [{ call_log_id: 'call-1', reason_code: 'address_recovered', payload: originalPayload }],
    });

    await runInitialMarkerReconcile(
      db,
      { id: 'call-1' },
      'stale-token',
      recovered,
      recoveryPassStamp,
      recoveryMarkerPayload,
      logger,
      maskSid,
      'CA-1',
    );

    expect(db.state.cards[0].payload).toEqual(originalPayload);
  });

  test('a stale late insert after replacement failure starts retired and cannot activate itself', async () => {
    const db = makeDatabase();
    const bridgeNeedsConfirmation = [];
    const buildTriageItem = ({ callLogId, flag, extraPayload }) => ({
      call_log_id: callLogId,
      reason_code: flag,
      payload: extraPayload,
    });

    await runRecoveredInsert(
      db,
      { id: 'call-1' },
      recovered,
      {},
      '100 Fort Avenue East',
      null,
      buildTriageItem,
      bridgeNeedsConfirmation,
    );
    const inserted = db.state.cards[0];
    expect(inserted.payload.recovery_superseded_at).toEqual(expect.any(String));
    expect(inserted.payload.extraction_model).toBeUndefined();
    expect(inserted.payload.extraction_prompt_version).toBeUndefined();

    await runFinalEvidenceReconcile(
      db,
      { id: 'call-1' },
      'stale-token',
      recovered,
      recoveryPassStamp,
      recoveryMarkerPayload,
      logger,
      maskSid,
      'CA-1',
      '100 Fort Avenue East',
    );

    expect(inserted.payload.recovery_superseded_at).toEqual(expect.any(String));
    expect(inserted.payload.extraction_model).toBeUndefined();
    expect(inserted.payload.extraction_prompt_version).toBeUndefined();
  });

  test('the owning failed attempt merges evidence without clearing retirement', async () => {
    const db = makeDatabase({
      token: 'owning-token',
      cards: [{
        call_log_id: 'call-1',
        reason_code: 'address_recovered',
        payload: { recovery_superseded_at: 'replacement-failed', address_recovered: '100 4th Avenue East' },
      }],
    });
    const attemptedFailure = {
      attempted: true,
      recovered: null,
      candidates: ['100 40th Avenue East'],
      method: 'phonetic',
    };

    await runFinalEvidenceReconcile(
      db,
      { id: 'call-1' },
      'owning-token',
      attemptedFailure,
      recoveryPassStamp,
      recoveryMarkerPayload,
      logger,
      maskSid,
      'CA-1',
      '100 Fort Avenue East',
    );

    expect(db.state.cards[0].payload).toMatchObject({
      recovery_superseded_at: 'replacement-failed',
      address_as_heard: '100 Fort Avenue East',
      address_candidates: ['100 40th Avenue East'],
      recovery_method: 'phonetic',
    });
    expect(db.state.cards[0].payload.extraction_model).toBeUndefined();
    expect(db.state.cards[0].payload.extraction_prompt_version).toBeUndefined();
  });

  test('only the owning successful pass activates recovered evidence', async () => {
    const db = makeDatabase({
      token: 'owning-token',
      cards: [{
        call_log_id: 'call-1',
        reason_code: 'address_recovered',
        payload: { recovery_superseded_at: 'retired', address_recovered: '100 4th Avenue East' },
      }],
    });

    await runFinalEvidenceReconcile(
      db,
      { id: 'call-1' },
      'owning-token',
      recovered,
      recoveryPassStamp,
      recoveryMarkerPayload,
      logger,
      maskSid,
      'CA-1',
      '100 Fort Avenue East',
    );

    expect(db.state.cards[0].payload).toMatchObject({
      ...recoveryPassStamp,
      address_as_heard: '100 Fort Avenue East',
      address_candidates: ['100 4th Avenue East'],
      recovery_method: 'phonetic',
    });
    expect(db.state.cards[0].payload.recovery_superseded_at).toBeUndefined();
  });

  test('a new successful recovery replaces the old matched street as well as its candidates', async () => {
    const db = makeDatabase({
      token: 'owning-token',
      cards: [{
        call_log_id: 'call-1',
        reason_code: 'address_recovered',
        payload: { ...recoveryPassStamp, address_recovered: '100 40th Avenue East' },
      }],
    });
    await runFinalEvidenceReconcile(
      db, { id: 'call-1' }, 'owning-token', recovered, recoveryPassStamp,
      recoveryMarkerPayload, logger, maskSid, 'CA-1', '100 Fort Avenue East',
    );
    expect(db.state.cards[0].payload).toMatchObject({
      address_recovered: '100 4th Avenue East',
      address_candidates: ['100 4th Avenue East'],
    });
  });

  test('the shared recovered-card payload also starts retired', () => {
    const payload = buildAddressRecoveryPayload(recovered, '100 Fort Avenue East')('address_recovered');

    expect(payload.recovery_superseded_at).toEqual(expect.any(String));
    expect(payload.extraction_model).toBeUndefined();
    expect(payload.extraction_prompt_version).toBeUndefined();
  });
});
