const smsTemplatesRouter = require('../routes/admin-sms-templates');

async function renderSmsTemplate(templateKey, vars) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* missing template */ }
  return undefined;
}

async function renderRequiredSmsTemplate(templateKey, vars) {
  const body = await renderSmsTemplate(templateKey, vars);
  if (body) return body;
  throw new Error(`SMS template ${templateKey} is missing, inactive, or invalid`);
}

module.exports = { renderSmsTemplate, renderRequiredSmsTemplate };
