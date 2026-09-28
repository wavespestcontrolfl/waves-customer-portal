const { billingLegDeliveryState } = require('./billing-channel-routing');

function validOriginalTime(value) {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}

function latestOriginalTime(values) {
  const times = values.map(validOriginalTime).filter(Boolean);
  return times.length ? new Date(Math.max(...times.map((time) => time.getTime()))) : null;
}

function settledLegTimes(result) {
  const channels = result.channelResults || {};
  const entries = Object.entries(channels);
  const oldLegs = entries.filter(([channel, leg]) => billingLegDeliveryState(channel, leg) === 'deduped');
  const freshLeg = entries.some(([channel, leg]) => billingLegDeliveryState(channel, leg) === 'delivered');
  const fallback = result.deduped ? result : null;
  const oldEmail = oldLegs.find(([channel]) => channel === 'email')?.[1]
    || (result.channel === 'email' ? fallback : null);
  const oldText = oldLegs.find(([channel]) => channel === 'sms')?.[1]
    || (result.channel === 'sms' ? fallback : null);
  const oldApp = oldLegs.find(([channel]) => channel === 'push')?.[1]
    || (result.reason === 'app_event_already_visible' ? result : null);
  const emailAt = latestOriginalTime([oldEmail?.sentAt, oldEmail?.eventVisibleAt]);
  const smsAt = latestOriginalTime([oldText?.sentAt, oldText?.eventVisibleAt, oldApp?.eventVisibleAt]);
  const eventAt = latestOriginalTime([emailAt, smsAt, result.sentAt, result.eventVisibleAt]);
  const freshEmail = billingLegDeliveryState('email', channels.email) === 'delivered';
  const freshSms = ['sms', 'push'].some((channel) => billingLegDeliveryState(channel, channels[channel]) === 'delivered');
  return { oldEmail, oldText, oldApp, emailAt, smsAt, eventAt, freshLeg, freshEmail, freshSms,
    emailAccepted: !!oldEmail || freshEmail,
    smsAccepted: !!(oldText || oldApp) || freshSms };
}

// A scheduled invoice row must retain the original accepted event even when
// its finalizer runs after a restart with no dispatch result in memory.
function scheduledPriorInvoiceEvidence(meta, result, msg) {
  const legs = settledLegTimes(result);
  const old = result.deduped === true && !legs.freshLeg;
  const bindings = [];
  let metadataSql = '';
  if (old && [result.reason, result.channelResults?.push?.reason].includes('app_event_already_visible')) {
    metadataSql += " || jsonb_build_object('app_event_already_visible_at', ?::timestamptz)";
    bindings.push(result.eventVisibleAt || null);
  }
  if ((meta.mark_invoice_delivery === true || meta.entry_point === 'autopay_completion_decline_deferred')
    && [legs.emailAccepted, legs.smsAccepted].includes(true)) {
    metadataSql += " || jsonb_build_object('invoice_delivery_legs_recorded', true, 'invoice_prior_delivery_deduped', ?::boolean, 'invoice_prior_delivery_at', ?::timestamptz, 'invoice_delivery_email', ?::boolean, 'invoice_prior_email', ?::boolean, 'invoice_prior_email_at', ?::timestamptz, 'invoice_delivery_sms', ?::boolean, 'invoice_prior_sms', ?::boolean, 'invoice_prior_sms_at', ?::timestamptz)";
    bindings.push(old, old ? legs.eventAt : null,
      legs.emailAccepted, !!legs.oldEmail && !legs.freshEmail, legs.freshEmail ? null : legs.emailAt,
      legs.smsAccepted, !!(legs.oldText || legs.oldApp) && !legs.freshSms, legs.freshSms ? null : legs.smsAt);
  }
  return { metadataSql, bindings,
    createdAt: old ? (legs.eventAt || validOriginalTime(result.eventVisibleAt) || meta.queued_at || msg.created_at) : null };
}

function priorInvoiceFinalizeOptions(meta) {
  if (meta.invoice_delivery_legs_recorded === true) return {
    sms: meta.invoice_delivery_sms === true,
    ...(meta.invoice_delivery_email === true ? { email: true } : {}),
    deduped: meta.invoice_prior_delivery_deduped === true,
    eventVisibleAt: meta.invoice_prior_delivery_at || null,
    ...(meta.invoice_prior_sms === true ? { smsEventVisibleAt: meta.invoice_prior_sms_at || null } : {}),
    ...(meta.invoice_prior_email === true ? { emailEventVisibleAt: meta.invoice_prior_email_at || null } : {}),
  };
  return { sms: true,
    ...(meta.app_event_already_visible_at
      ? { eventVisibleAt: meta.app_event_already_visible_at, deduped: true } : {}) };
}

function invoiceDeliveryTimestamps({ deduped, eventVisibleAt, smsEventVisibleAt, emailEventVisibleAt, now }) {
  const aggregate = deduped ? validOriginalTime(eventVisibleAt) : now;
  return {
    aggregate,
    sms: smsEventVisibleAt !== undefined ? validOriginalTime(smsEventVisibleAt) : aggregate,
    email: emailEventVisibleAt !== undefined ? validOriginalTime(emailEventVisibleAt) : aggregate,
  };
}

function invoiceDeliveryStampUpdates(db, options) {
  const times = invoiceDeliveryTimestamps(options);
  return {
    sent_at: db.raw('COALESCE(sent_at, ?)', [times.aggregate]),
    ...(options.sms ? { sms_sent_at: db.raw('COALESCE(sms_sent_at, ?)', [times.sms]) } : {}),
    ...(options.email
      ? { email_sent_at: db.raw('COALESCE(email_sent_at, ?)', [times.email]) } : {}),
  };
}

module.exports = { scheduledPriorInvoiceEvidence, priorInvoiceFinalizeOptions, invoiceDeliveryStampUpdates,
  settledLegTimes };
