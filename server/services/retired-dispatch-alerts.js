'use strict';

// Dispatch alert types whose producer was removed. Their open rows are closed
// by a data migration, which bypasses resolveAlert and so never broadcasts
// dispatch:alert_resolved. A dispatch board left open across that deploy
// hydrates only on mount, so it would keep showing the retired cards until a
// reload. Each staff socket that (re)connects — every board reconnects after a
// deploy — is told those cards are resolved, which drops them the same way a
// live resolve does. Read-only; nothing is written.
//
// completed_with_open_comms: the completion comms guard, removed 2026-10-22
// (owner 2026-10-21; migration 20261022020000_retire_completion_comms_alerts).

const db = require('../models/db');
const logger = require('./logger');
const { EVENT_RESOLVED } = require('./dispatch-alerts');

const RETIRED_TYPES = Object.freeze(['completed_with_open_comms']);
// Long enough for any board open across the deploy; after that the event is
// pointless, so the per-connect read stops returning rows.
const WINDOW_DAYS = 14;
const MAX_IDS = 500;

async function emitRetiredAlertResolutions(socket, { knex = db, now = new Date() } = {}) {
  try {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86400000);
    const rows = await knex('dispatch_alerts')
      .whereIn('type', RETIRED_TYPES)
      .whereNotNull('resolved_at')
      .where('resolved_at', '>=', since)
      .limit(MAX_IDS)
      .select('id', 'resolved_at');
    for (const row of rows) socket.emit(EVENT_RESOLVED, { id: row.id, resolved_at: row.resolved_at, resolved_by: null });
    return rows.length;
  } catch (err) {
    logger.warn(`[retired-dispatch-alerts] could not send retired card resolutions: ${err.message}`);
    return 0;
  }
}

module.exports = { RETIRED_TYPES, emitRetiredAlertResolutions };
