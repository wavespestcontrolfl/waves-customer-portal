const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { normalizeGsmPunctuation } = require('./messaging/gsm-normalize');

async function renderSmsTemplate(templateKey, vars, context = {}, opts = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context, opts);
      // Normalize at render time, not just at send time: callers use the
      // rendered body for content-level dedup against sms_log (e.g. the
      // call-recording processor's 10-minute confirmation guard), and the
      // send path stores the normalized form — a curly quote from an
      // interpolated variable (a name like O'Brien pasted with a smart
      // apostrophe) would otherwise make the dedup probe miss its own send.
      if (body) return normalizeGsmPunctuation(body);
    }
  } catch { /* missing template */ }
  return undefined;
}

async function renderRequiredSmsTemplate(templateKey, vars, context = {}) {
  const body = await renderSmsTemplate(templateKey, vars, context);
  if (body) return body;
  throw new Error(`SMS template ${templateKey} is missing, inactive, or invalid`);
}

module.exports = { renderSmsTemplate, renderRequiredSmsTemplate };
