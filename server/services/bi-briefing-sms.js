/**
 * The Monday BI briefing text to the owner, sent at most once per ET week.
 *
 * The runner's per-run dedupe (bi-agent.js SIDE_EFFECT_DONE) covers a single
 * session only. It cannot cover a second instance firing the same tick
 * during a deploy overlap, a run that hit its deadline while this send was
 * still in flight, or a re-run from the admin page. So this send takes an
 * atomic sms_send_claims row first, the same cross-process gate that
 * tech-line, estimate-public and outbound-voicemail use, keyed to the ET
 * week the text belongs to. Only the claim holder reaches the provider.
 *
 * Whether the text left is read with the canonical classifier,
 * classifyDeliveryCertainty (send-customer-message.js), for a returned
 * result and for a thrown error's .providerOutcome alike:
 *
 *  - 'sent': the claim is kept, so the week is done.
 *  - 'not_sent' (a policy block, a pre-dispatch throw, a definitive provider
 *    rejection, a suppression sentinel): the claim is released, so the agent
 *    or a later run may send.
 *  - 'unknown': the claim is kept, because the provider may still hold the
 *    text. The report is saved either way, and a missed text beats a doubled
 *    one.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etWeekStart } = require('../utils/datetime-et');
const { sendCustomerMessage, classifyDeliveryCertainty } = require('./messaging/send-customer-message');

const CLAIM_PREFIX = 'bi_briefing_sms:';

function claimKeyFor(weekOf = etWeekStart()) {
  return `${CLAIM_PREFIX}${weekOf}`;
}

async function claimWeek(claimKey) {
  const claim = await db.raw(
    `INSERT INTO sms_send_claims (claim_key) VALUES (?)
     ON CONFLICT (claim_key) DO NOTHING
     RETURNING id`,
    [claimKey],
  );
  return (claim?.rows || []).length > 0;
}

function releaseWeek(claimKey) {
  return db('sms_send_claims').where({ claim_key: claimKey }).del()
    .catch((err) => logger.warn(`[bi-agent] Briefing SMS claim release failed (${err?.code || err?.name || 'error'})`));
}

async function sendBriefingSmsOnce(message) {
  if (!process.env.ADAM_PHONE) return { error: 'ADAM_PHONE not set' };

  const claimKey = claimKeyFor();
  if (!(await claimWeek(claimKey))) {
    logger.info(`[bi-agent] Briefing SMS already sent or in flight for ${claimKey} — skipped`);
    return { sent: false, skipped: true, reason: 'The briefing text already went out this week. Do not send it again.' };
  }

  // Internal-audience send. Routed through the wrapper so the BI
  // SMS gets the same audit trail as customer/lead messages, but
  // the policy profile for purpose='internal_briefing' allows
  // emoji + dollar amounts + 3-segment bodies (the BI Monday SMS
  // intentionally uses 📊 ↑ ↓ and quotes MRR / revenue figures).
  // identityTrustLevel='admin_operator' is required for the
  // internal_briefing policy row.
  let result;
  try {
    result = await sendCustomerMessage({
      to: process.env.ADAM_PHONE,
      body: message,
      channel: 'sms',
      audience: 'internal',
      purpose: 'internal_briefing',
      identityTrustLevel: 'admin_operator',
      entryPoint: 'bi_agent_send_briefing_sms',
    });
  } catch (err) {
    // sendCustomerMessage tags every throw with the provider outcome it saw
    // (the pre-dispatch default is 'not_sent'); only a definite no-send frees
    // the week.
    if (classifyDeliveryCertainty(err?.providerOutcome) === 'not_sent') {
      await releaseWeek(claimKey);
      logger.error(`[bi-agent] Briefing SMS send threw before reaching the provider; claim released for ${claimKey}: ${err.message}`);
    } else {
      logger.error(`[bi-agent] Briefing SMS send threw with delivery unknown; claim kept for ${claimKey}: ${err.message}`);
    }
    throw err;
  }

  const certainty = classifyDeliveryCertainty(result);
  if (result.sent) {
    // sent:true with a definite no-send is a suppression sentinel (kill
    // switch, gate): nothing left, so the week stays open for a later run.
    if (certainty === 'not_sent') await releaseWeek(claimKey);
    logger.info(`[bi-agent] Monday briefing SMS sent (segs=${result.segmentCount}, encoding=${result.encoding})`);
    return { sent: true, segmentCount: result.segmentCount, encoding: result.encoding };
  }
  if (certainty !== 'not_sent') {
    logger.warn(`[bi-agent] Briefing SMS outcome uncertain (${result.code || 'unknown'}); claim kept for ${claimKey}`);
    return { sent: false, uncertain: true, code: result.code, reason: 'Delivery is uncertain. Do not send the text again this week.' };
  }
  await releaseWeek(claimKey);
  logger.warn(`[bi-agent] Briefing SMS BLOCKED: ${result.code} — ${result.reason}`);
  return { sent: false, blocked: !!result.blocked, code: result.code, reason: result.reason };
}

module.exports = { sendBriefingSmsOnce, claimKeyFor };
