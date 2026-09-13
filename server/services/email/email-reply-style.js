const db = require('../../models/db');
const { gateEnvValue } = require('../../config/feature-gates');
const { savepointRead } = require('../../utils/savepoint-read');
const { parseEmailSelection } = require('../sms-voice-corpus-miner');
const { fetchVoiceExemplars, exemplarLooksClean } = require('../sms-shadow-drafter');
const { classifyCustomerSmsTriageIntent } = require('../estimate-conversion-agent');
const { getApprovedVoiceProfile } = require('../voice-profile-distiller');
const { sanitizeProfileForPrompt } = require('../voice-agent/relay-conversation');

const MAX_EXEMPLARS = 4;

function cleanExample(row) {
  const inbound = String(row.inbound_text || '').trim();
  const reply = String(row.reply_text || '').trim();
  if (!inbound || !reply || inbound.length > 4000 || reply.length > 4000
    || !exemplarLooksClean(inbound, reply)) return null;
  return { inbound_text: inbound, reply_text: reply };
}

async function emailExemplars(context, intent, database) {
  const setting = await savepointRead(database, (connection) => connection('system_settings')
    .where({ key: 'email_voice_corpus_selection' }).first('value'));
  const selection = parseEmailSelection(setting?.value);
  if (!selection || !selection.replyIds.length || selection.reviewedAtMs > Date.now()) return [];
  const rows = await savepointRead(database, (connection) => connection('voice_corpus_examples')
    .join('emails as source_email', 'source_email.id', 'voice_corpus_examples.source_id')
    .whereRaw('(source_email.customer_id IS NULL OR source_email.customer_id = voice_corpus_examples.customer_id)')
    .whereNotIn('source_email.gmail_thread_id', [...selection.heldOutThreadIds])
    .whereRaw("source_email.gmail_thread_id = voice_corpus_examples.outcome->>'gmailThreadId'")
    .where({ source: 'email_human_reply', intent })
    .whereIn('source_id', selection.replyIds)
    .whereNot('voice_corpus_examples.customer_id', context.identity.customerId)
    .whereNotIn('voice_corpus_examples.customer_id', [...selection.heldOutCustomerIds])
    .whereNotNull('inbound_text').whereNotNull('reply_text')
    .orderBy('occurred_at', 'desc').limit(500)
    .select('source_id', 'voice_corpus_examples.customer_id', 'inbound_text', 'reply_text', 'outcome', 'occurred_at'));
  return rows.filter((row) => {
    let provenance = row.outcome;
    try { if (typeof provenance === 'string') provenance = JSON.parse(provenance); } catch { return false; }
    const occurredAt = new Date(row.occurred_at).getTime();
    return row.customer_id && provenance?.gmailThreadId && provenance?.inboundId
      && !selection.heldOutThreadIds.has(provenance.gmailThreadId)
      && Number.isFinite(occurredAt) && occurredAt <= selection.reviewedAtMs;
  }).map(cleanExample).filter(Boolean).slice(0, MAX_EXEMPLARS);
}

// Examples are quoted USER-channel style data. Re-read the selection every
// time: revoking a reply or holding out its customer/thread withdraws it even
// when the append-only corpus still contains the previously approved row.
async function loadEmailReplyStyle(context, { database = db } = {}) {
  const result = { exemplars: [], profileText: '', profileId: null, profileVersion: null, sourceHealth: {} };
  const inbound = context.untrusted.emailThread.messages.find((message) => message.currentInbound)?.text || '';
  const intent = classifyCustomerSmsTriageIntent(inbound, { customer: {
    id: context.identity.customerId, first_name: context.customer?.firstName,
  } })?.intent;
  result.sourceHealth.emailExamples = 'disabled';
  if (gateEnvValue('GATE_VOICE_CORPUS_EMAIL_SOURCE')) {
    try {
      result.exemplars = await emailExemplars(context, intent, database);
      result.sourceHealth.emailExamples = result.exemplars.length ? 'present' : 'absent';
    } catch { result.sourceHealth.emailExamples = 'unavailable'; }
  }
  if (!result.exemplars.length) {
    try {
      const rows = await savepointRead(database, (connection) => fetchVoiceExemplars({ intent, limit: MAX_EXEMPLARS, dbi: connection,
        excludeCustomerIds: [context.identity.customerId], throwOnError: true }));
      result.exemplars = rows.map(cleanExample).filter(Boolean);
      result.sourceHealth.smsExamples = result.exemplars.length ? 'present' : 'absent';
    } catch { result.sourceHealth.smsExamples = 'unavailable'; }
  }
  result.sourceHealth.profile = 'disabled';
  if (gateEnvValue('GATE_EMAIL_VOICE_PROFILE')) {
    try {
      const profile = await savepointRead(database, (connection) => getApprovedVoiceProfile({ dbi: connection }));
      const text = sanitizeProfileForPrompt(profile?.profile_text);
      if (text) Object.assign(result, { profileText: text, profileId: profile.id, profileVersion: profile.version });
      result.sourceHealth.profile = text ? 'present' : 'absent';
    } catch { result.sourceHealth.profile = 'unavailable'; }
  }
  return result;
}

module.exports = { loadEmailReplyStyle };
