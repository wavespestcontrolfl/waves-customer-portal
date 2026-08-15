// call_log has no uniqueness on twilio_call_sid, and the /voice insert was
// not serialized with the /call-status inbound fallback — an instantly-
// terminal call (no-answer/busy) whose status callback beat the /voice
// delivery double-inserted the SID (14 sub-second race pairs in prod, all
// bare rows: no recording/transcript/extraction). Merge each duplicate group
// into one canonical row, re-point any FK references, delete the merged-away
// rows, then add the partial unique index as the permanent backstop for the
// now-serialized webhook writers.
//
// Nothing is discarded silently: EVERY column is folded into the kept row
// (adopt where the winner is blank; equal values are redundant; terminal
// status outranks a transient snapshot; counters take the max; metadata
// unions keys with conflicting values preserved under `dedupe_conflicts`),
// and FK references are moved, not orphaned. Any genuine
// conflict — differing non-null values, two terminal statuses, or two rows
// both carrying recording/transcript/extraction artifacts — throws,
// deliberately failing the migration for manual resolution rather than
// guessing which call history to keep.

const TERMINAL_CALL_STATUSES = ['completed', 'no-answer', 'busy', 'failed', 'canceled'];

function hasArtifacts(row) {
  return Boolean(row.recording_sid || row.transcription || row.ai_extraction || row.ai_extraction_enriched);
}

// Columns that never participate in the generic merge.
const MERGE_IGNORED_COLUMNS = new Set(['id', 'twilio_call_sid', 'created_at', 'updated_at']);
// Monotonic counters: differing values merge as the max, not a conflict.
const MERGE_MAX_COLUMNS = new Set(['duration_seconds', 'extraction_attempts', 'retranscribe_attempts', 'processing_generation']);
// Columns with bespoke merge rules handled before the generic pass.
const MERGE_SPECIAL_COLUMNS = new Set(['status', 'metadata']);

function isBlank(value) {
  return value === null || value === undefined;
}

// Loose equality across the pg driver's return shapes: Dates by timestamp,
// jsonb objects/arrays by canonical JSON, everything else strictly.
function sameValue(a, b) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

function asMetaObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;

  const dupGroups = await knex('call_log')
    .select('twilio_call_sid')
    .whereNotNull('twilio_call_sid')
    .groupBy('twilio_call_sid')
    .havingRaw('count(*) > 1');

  if (dupGroups.length > 0) {
    // FK set discovered live from pg_constraint so a future referencing table
    // can never be silently orphaned by this migration running elsewhere.
    const { rows: fks } = await knex.raw(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.confrelid = 'call_log'::regclass AND c.contype = 'f'
    `);

    // Child tables can carry their OWN uniqueness on the FK column
    // (call_spam_verdicts (call_log_id, classifier_version), route_feedback
    // (call_log_id), triage_items' partial open-unique, …) — a blind repoint
    // of loser-referencing rows onto the winner collides with the winner's
    // sibling row and aborts the whole migration (prod 2026-08-15). Discover
    // every unique index on each referencing table that includes the FK
    // column, partial predicates included, so the collision handling below
    // covers referencing tables added after this migration was written.
    const uniqueIdxByTable = {};
    for (const fk of fks) {
      if (uniqueIdxByTable[fk.tbl]) continue;
      const { rows } = await knex.raw(`
        SELECT pg_get_expr(i.indpred, i.indrelid) AS pred,
               -- ::text[] — attname is the "name" type, and the pg driver
               -- returns name[] as an unparsed string, not a JS array.
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
        FROM pg_index i
        WHERE i.indrelid = ?::regclass AND i.indisunique
      `, [fk.tbl]);
      uniqueIdxByTable[fk.tbl] = rows.filter((r) => Array.isArray(r.cols));
    }

    for (const group of dupGroups) {
      const rows = await knex('call_log')
        .where('twilio_call_sid', group.twilio_call_sid)
        .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]);

      // Canonical row: the artifact-bearing one if exactly one exists,
      // otherwise the first-created. Two artifact-bearing rows = unresolvable.
      const withArtifacts = rows.filter(hasArtifacts);
      if (withArtifacts.length > 1) {
        throw new Error(
          `[migration call_log_twilio_sid_unique] twilio_call_sid ${group.twilio_call_sid} has ${withArtifacts.length} rows carrying recording/transcript/extraction artifacts — resolve by hand before this migration can dedupe.`
        );
      }
      const winner = withArtifacts[0] || rows[0];
      const losers = rows.filter((r) => r.id !== winner.id);

      // Fold EVERY column into the winner, not a hand-picked subset — a
      // loser value is either adopted (winner blank), redundant (equal),
      // covered by a bespoke rule (status/metadata/counters), or a genuine
      // conflict that throws for manual resolution. Nothing is discarded
      // silently.
      const update = {};

      // status: a terminal status wins over a transient one ('ringing'/
      // 'in-progress' from the /voice leg); two DIFFERENT terminal statuses
      // conflict.
      const loserTerminals = [...new Set(losers.map((r) => r.status).filter((s) => TERMINAL_CALL_STATUSES.includes(s)))];
      if (TERMINAL_CALL_STATUSES.includes(winner.status)) {
        const disagreeing = loserTerminals.filter((s) => s !== winner.status);
        if (disagreeing.length > 0) {
          throw new Error(
            `[migration call_log_twilio_sid_unique] twilio_call_sid ${group.twilio_call_sid}: conflicting terminal statuses (${winner.status} vs ${disagreeing.join(',')}) — resolve by hand.`
          );
        }
      } else if (loserTerminals.length === 1) {
        update.status = loserTerminals[0];
      } else if (loserTerminals.length > 1) {
        throw new Error(
          `[migration call_log_twilio_sid_unique] twilio_call_sid ${group.twilio_call_sid}: conflicting terminal statuses (${loserTerminals.join(',')}) — resolve by hand.`
        );
      }

      // metadata: adopt keys only a loser wrote; where a shared key holds a
      // DIFFERENT value (the two webhook snapshots legitimately disagree on
      // e.g. resolved location), the winner's value stays live and the
      // loser's is preserved verbatim under `dedupe_conflicts` — nothing is
      // silently overwritten and nothing blocks the migration on ephemeral
      // snapshot drift.
      const winnerMeta = asMetaObject(winner.metadata);
      const mergedMeta = { ...winnerMeta };
      const metaConflicts = {};
      for (const loser of losers) {
        for (const [key, value] of Object.entries(asMetaObject(loser.metadata))) {
          if (isBlank(value)) continue;
          if (!(key in mergedMeta) || isBlank(mergedMeta[key])) {
            mergedMeta[key] = value;
            continue;
          }
          if (sameValue(mergedMeta[key], value)) continue;
          if (!metaConflicts[key]) metaConflicts[key] = [];
          metaConflicts[key].push(value);
        }
      }
      if (Object.keys(metaConflicts).length > 0) mergedMeta.dedupe_conflicts = metaConflicts;
      if (!sameValue(mergedMeta, winnerMeta)) {
        update.metadata = JSON.stringify(mergedMeta);
      }

      for (const col of Object.keys(winner)) {
        if (MERGE_IGNORED_COLUMNS.has(col) || MERGE_SPECIAL_COLUMNS.has(col)) continue;
        if (MERGE_MAX_COLUMNS.has(col)) {
          const values = rows.map((r) => r[col]).filter((v) => !isBlank(v));
          if (values.length > 0) {
            const max = Math.max(...values.map(Number));
            if (isBlank(winner[col]) || Number(winner[col]) < max) update[col] = max;
          }
          continue;
        }
        for (const loser of losers) {
          if (isBlank(loser[col]) || sameValue(winner[col], loser[col]) || sameValue(update[col], loser[col])) continue;
          if (isBlank(winner[col]) && isBlank(update[col])) {
            // jsonb/date values round-trip through knex.update as-is; objects
            // must be re-serialized for the driver.
            update[col] = (typeof loser[col] === 'object' && !(loser[col] instanceof Date))
              ? JSON.stringify(loser[col])
              : loser[col];
            continue;
          }
          throw new Error(
            `[migration call_log_twilio_sid_unique] twilio_call_sid ${group.twilio_call_sid}: column "${col}" holds different non-null values across duplicate rows — resolve by hand.`
          );
        }
      }

      if (Object.keys(update).length > 0) {
        update.updated_at = knex.fn.now();
        await knex('call_log').where({ id: winner.id }).update(update);
      }

      const loserIds = losers.map((r) => r.id);
      const groupIds = [winner.id, ...loserIds];
      for (const fk of fks) {
        // Merge collision families under each unique index BEFORE the blind
        // repoint. Same doctrine as the call_log fold above: a colliding row
        // is deleted only when it is provably redundant (every column except
        // identity/timestamps/the FK equal to the kept row); a genuine
        // difference throws for manual resolution rather than guessing.
        for (const uniq of uniqueIdxByTable[fk.tbl] || []) {
          if (!uniq.cols.includes(fk.col)) continue;
          const keyCols = uniq.cols.filter((c) => c !== fk.col);
          const predSql = uniq.pred ? ` AND (${uniq.pred})` : '';
          const { rows: family } = await knex.raw(
            `SELECT t.ctid::text AS __ctid, t.* FROM "${fk.tbl}" t
             WHERE t."${fk.col}" = ANY(?::uuid[])${predSql}`,
            [groupIds]
          );
          // Default unique semantics: a NULL key column never collides.
          const collidable = family.filter((r) => keyCols.every((c) => !isBlank(r[c])));
          const buckets = new Map();
          for (const row of collidable) {
            const key = JSON.stringify(keyCols.map((c) => {
              const v = row[c];
              return v instanceof Date ? v.getTime() : v;
            }));
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(row);
          }
          for (const bucket of buckets.values()) {
            if (bucket.length < 2) continue;
            // Keep the winner-pointing row when one exists (it survives the
            // repoint untouched), else the first-created.
            bucket.sort((a, b) => {
              const aw = a[fk.col] === winner.id ? 0 : 1;
              const bw = b[fk.col] === winner.id ? 0 : 1;
              if (aw !== bw) return aw - bw;
              const at = a.created_at instanceof Date ? a.created_at.getTime() : 0;
              const bt = b.created_at instanceof Date ? b.created_at.getTime() : 0;
              return at - bt || String(a.__ctid).localeCompare(String(b.__ctid));
            });
            const keeper = bucket[0];
            for (const extra of bucket.slice(1)) {
              for (const col of Object.keys(keeper)) {
                if (col === '__ctid' || col === 'id' || col === fk.col
                  || col === 'created_at' || col === 'updated_at') continue;
                if (!sameValue(keeper[col], extra[col])) {
                  throw new Error(
                    `[migration call_log_twilio_sid_unique] twilio_call_sid ${group.twilio_call_sid}: `
                    + `"${fk.tbl}" rows collide on (${uniq.cols.join(', ')}) with differing "${col}" — resolve by hand.`
                  );
                }
              }
              await knex.raw(`DELETE FROM "${fk.tbl}" WHERE ctid = ?::tid`, [extra.__ctid]);
            }
          }
        }
        await knex.raw(
          `UPDATE "${fk.tbl}" SET "${fk.col}" = ? WHERE "${fk.col}" = ANY(?::uuid[])`,
          [winner.id, loserIds]
        );
      }
      await knex('call_log').whereIn('id', loserIds).del();
    }
  }

  // No skip path: if a duplicate somehow survives, index creation throws and
  // the migration retries on the next deploy instead of being marked applied
  // without its backstop.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS call_log_twilio_call_sid_unique
    ON call_log (twilio_call_sid)
    WHERE twilio_call_sid IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  // Merged-away race-artifact rows are not restorable; down only removes the index.
  await knex.raw('DROP INDEX IF EXISTS call_log_twilio_call_sid_unique');
};
