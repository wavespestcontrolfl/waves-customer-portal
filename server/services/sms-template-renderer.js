const smsTemplatesRouter = require('../routes/admin-sms-templates');

async function renderSmsTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* use fallback */ }
  return fallback;
}

module.exports = { renderSmsTemplate };
