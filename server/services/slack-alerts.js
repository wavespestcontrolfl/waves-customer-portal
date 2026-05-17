const logger = require('./logger');

function alertWebhookUrl() {
  return process.env.WAVES_ALERTS_SLACK_WEBHOOK_URL
    || process.env.SLACK_TOOL_HEALTH_WEBHOOK_URL
    || process.env.SLACK_WEBHOOK_URL
    || null;
}

async function slackAlert({ channel = '#waves-alerts', text, metadata } = {}) {
  const url = alertWebhookUrl();
  if (!url) {
    logger.warn(`[slack-alerts] Slack webhook not configured; skipped alert for ${channel}: ${text || ''}`);
    return { ok: false, skipped: true, error: 'slack_webhook_not_configured' };
  }
  if (!text) return { ok: false, skipped: true, error: 'text_required' };

  const body = {
    text,
    channel,
  };
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    body.blocks = [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `\`${JSON.stringify(metadata).slice(0, 1500)}\`` },
        ],
      },
    ];
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Slack webhook failed: ${res.status} ${errText.slice(0, 200)}`);
    }
    return { ok: true };
  } catch (err) {
    logger.error(`[slack-alerts] ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  slackAlert,
};
