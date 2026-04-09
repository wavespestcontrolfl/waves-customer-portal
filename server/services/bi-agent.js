/**
 * Weekly BI Agent — Session Manager
 *
 * Usage:
 *   const BIAgent = require('./bi-agent');
 *   await BIAgent.run(); // full Monday briefing
 */

const logger = require('./logger');
const db = require('../models/db');
const { executeBITool } = require('./bi-agent-tools');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BI_AGENT_ID = process.env.BI_AGENT_ID;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';

async function apiCall(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers: {
      'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER, 'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function* streamSessionEvents(sessionId) {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/events?stream=true`, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER, 'accept': 'text/event-stream',
    },
  });
  if (!res.ok) throw new Error(`Stream ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    let ev = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) ev = line.slice(7).trim();
      else if (line.startsWith('data: ') && ev) {
        try { yield { event: ev, data: JSON.parse(line.slice(6)) }; } catch {}
        ev = null;
      }
    }
  }
}

const BIAgent = {
  async run(opts = {}) {
    if (!ANTHROPIC_API_KEY || !BI_AGENT_ID) throw new Error('Missing ANTHROPIC_API_KEY or BI_AGENT_ID');

    const startTime = Date.now();
    const notify = opts.onProgress || (() => {});

    let prompt = 'Run the Monday morning business intelligence briefing. Pull all metrics, analyze trends, identify anomalies, send the SMS to Adam, and save the full report.';
    if (opts.skipSMS) prompt += '\n\nSkip the SMS — just generate and save the report.';

    notify('starting', 'Creating BI session...');

    const session = await apiCall('POST', '/sessions', { agent_id: BI_AGENT_ID });
    const sessionId = session.id;
    logger.info(`[bi-agent] Session ${sessionId}`);

    await apiCall('POST', `/sessions/${sessionId}/events`, {
      type: 'user', content: [{ type: 'text', text: prompt }],
    });

    let report = '';
    let toolsExecuted = [];
    let smsSent = false;
    let maxIterations = 25;

    for await (const { event, data } of streamSessionEvents(sessionId)) {
      if (--maxIterations <= 0) break;

      if (event === 'assistant' || event === 'text') {
        if (data.text) report += data.text;
        if (data.content) { for (const b of data.content) { if (b.type === 'text') report += b.text; } }
      }

      if (event === 'tool_use' || data?.type === 'tool_use') {
        const toolName = data.name;
        const toolInput = data.input || {};
        const toolUseId = data.id;

        notify('pulling', `Tool: ${toolName}`);
        logger.info(`[bi-agent] Tool: ${toolName}`);

        let toolResult;
        try {
          toolResult = await executeBITool(toolName, toolInput);
          if (toolName === 'send_briefing_sms' && toolResult.sent) smsSent = true;
        } catch (err) {
          toolResult = { error: `Tool failed: ${err.message}` };
          logger.error(`[bi-agent] Tool ${toolName} error: ${err.message}`);
        }

        toolsExecuted.push(toolName);

        await apiCall('POST', `/sessions/${sessionId}/events`, {
          type: 'tool_result', tool_use_id: toolUseId,
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
        });
      }

      if (event === 'done' || event === 'session_complete' || data?.stop_reason === 'end_turn') break;
      if (event === 'error') { logger.error(`[bi-agent] Error: ${JSON.stringify(data)}`); break; }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    notify('complete', `Done in ${durationSeconds}s`);

    logger.info(`[bi-agent] Complete: SMS=${smsSent}, ${toolsExecuted.length} tools, ${durationSeconds}s`);
    return { sessionId, smsSent, toolsExecuted, durationSeconds, report };
  },
};

module.exports = BIAgent;
