/**
 * Admin bell for a refund the production share asks the owner about (PR 3a). One bell the first time a draft or a preview sees a refund
 * signal on a stop it must ask about, deduped by (visit, sorted signals, own week or paid week): the same refund never rings twice, a
 * new signal on the same visit does. Raised through raiseAdminAlert (docs/admin-notifications.md), category `payroll`, who: person. The
 * headline and the why carry no customer name, no amount and no id. Only while GATE_PAYROLL_PRODUCTION_SHARE is on. A bell never blocks a
 * draft or a preview: every error is swallowed and logged.
 */
const { payrollProductionShareLive } = require('../config/feature-gates');
const logger = require('./logger');
const { flagKeyOf } = require('./production-share-refunds');

// A stop flagged for a refund, and a stop whose owner credit a new refund put aside.
const OWN_KINDS = new Set(['refund_flagged', 'owner_override_refund_changed']);
const CATEGORY = 'payroll';
const LINK = '/admin/timetracking?tab=payroll';

const KINDS = {
  paid: {
    action: 'set the production share take-back for a refund',
    why: 'A refund landed on a stop a pay run already paid; open the production share preview.',
    doneWhen: 'take_back_set',
  },
  changed: {
    action: 'check the take-back after a refund change',
    why: 'A refund you answered changed on a paid stop, so nothing more is taken; open the production share preview.',
    doneWhen: 'take_back_set',
  },
  own: {
    action: 'set the production share credit for a refund',
    why: 'A refund is on a stop in a share week not yet paid; open the production share preview.',
    doneWhen: 'stop_credit_set',
  },
};

// The refund flags in a technician's week: [{ kind: 'own' | 'paid', visitId, signals }]. Pure.
function flagsOf({ stops = [], takeBackToSet = [] }) {
  return [
    // The stop's kind and the answer revision are in the key, so the same refund rings once and a changed state rings again.
    ...stops.filter((stop) => OWN_KINDS.has(stop.kind)).map((stop) => ({ kind: 'own', visitId: stop.visitId, signals: [...(stop.refundSignals || []), `kind:${stop.kind}`] })),
    ...takeBackToSet.map((one) => ({
      kind: one.reason === 'changed' ? 'changed' : 'paid', visitId: one.visitId, signals: [...(one.newSignals || []), `answer:${one.answerRevision || 'none'}`],
    })),
  ];
}

/** Raises one bell for each flag not raised before. Never throws. Returns the number of bells written. */
async function raiseRefundFlagAlerts(week, { raise = null } = {}) {
  if (!(typeof payrollProductionShareLive === 'function' && payrollProductionShareLive())) return 0;
  let written = 0;
  for (const flag of flagsOf(week || {})) {
    try {
      const def = KINDS[flag.kind];
      const send = raise || require('./admin-alert-compose').raiseAdminAlert;
      const result = await send(CATEGORY, {
        area: 'Billing', action: def.action, why: def.why, severity: 'needs-you', link: LINK,
        subject: { type: 'visit', id: flag.visitId }, doneWhen: def.doneWhen, who: 'person',
      }, {
        dedupeKey: `production-share-refund:${flag.kind}:${flagKeyOf(flag.visitId, flag.signals)}`,
        bellDefault: true,
        metadata: { event: 'production_share_refund', kind: flag.kind, visitId: flag.visitId, technicianId: (week || {}).technicianId || null },
      });
      if (result && result.id) written += 1;
    } catch (err) {
      logger.error(`[production-share] refund bell not raised (${(err && (err.code || err.name)) || 'error'})`);
    }
  }
  return written;
}

module.exports = { raiseRefundFlagAlerts, flagsOf, KINDS };
