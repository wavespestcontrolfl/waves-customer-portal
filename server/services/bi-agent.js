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
const { BI_AGENT_CONFIG } = require('./bi-agent-config');
const { recordSessionUsage } = require('./llm-dispatch-metrics');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BI_AGENT_ID = process.env.BI_AGENT_ID;
const BI_AGENT_ENVIRONMENT_ID = process.env.BI_AGENT_ENVIRONMENT_ID || process.env.ANTHROPIC_ENVIRONMENT_ID;
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
  if (!res.ok) throw Object.assign(new Error(`API ${res.status}: ${await res.text()}`), { status: res.status, code: `anthropic_${res.status}` });
  return res.json();
}

async function* streamSessionEvents(sessionId) {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/events?stream=true`, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER, 'accept': 'text/event-stream',
    },
  });
  if (!res.ok) throw Object.assign(new Error(`Stream ${res.status}: ${await res.text()}`), { status: res.status, code: `anthropic_${res.status}` });
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
    if (!BI_AGENT_ENVIRONMENT_ID) throw new Error('Missing BI_AGENT_ENVIRONMENT_ID (or ANTHROPIC_ENVIRONMENT_ID)');

    const startTime = Date.now();
    const notify = opts.onProgress || (() => {});

    let prompt = 'Run the Monday morning business intelligence briefing. Pull all metrics, analyze trends, identify anomalies, send the SMS to Adam, and save the full report.';
    if (opts.skipSMS) prompt += '\n\nSkip the SMS — just generate and save the report.';

    notify('starting', 'Creating BI session...');

    const session = await apiCall('POST', '/sessions', {
      agent: BI_AGENT_ID,
      environment_id: BI_AGENT_ENVIRONMENT_ID,
    });
    const sessionId = session.id;
    logger.info(`[bi-agent] Session ${sessionId}`);
    let report = '';
    let toolsExecuted = [];
    let smsSent = false;
    let maxIterations = 25;

    // Call ledger (never throws): one session row with the session's token
    // usage, written however the session ends from here on — a failed first
    // event, a stream that throws or times out, all still consumed tokens —
    // carrying this runner's own outcome. Upserted by session id, so
    // re-billing is safe.
    let failure = null;
    // Set only by a terminal event: any other stream exit is a failure.
    let sessionEnded = false;
    // The run's own end — the ledger's usage GET after it is observability
    // time, not agent time, and stays out of the reported duration.
    let runEndedAt = null;
    try {
      await apiCall('POST', `/sessions/${sessionId}/events`, {
        type: 'user', content: [{ type: 'text', text: prompt }],
      });

      for await (const { event, data } of streamSessionEvents(sessionId)) {
        if (--maxIterations <= 0) { logger.warn(`[bi-agent] Hit max iterations for session ${sessionId}`); failure = 'max_events'; break; }

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

        // stop_reason arrives as a string or as { type } — read both (Codex r9).
        const stopReason = typeof data?.stop_reason === 'string' ? data.stop_reason : data?.stop_reason?.type;
        if (event === 'done' || event === 'session_complete' || stopReason === 'end_turn') { sessionEnded = true; break; }
        if (event === 'error' || event === 'session.error') { logger.error(`[bi-agent] Error: ${JSON.stringify(data)}`); failure = 'session_error_event'; break; }
      }
      // The stream closed (or was left) before the session said it ended:
      // not a success, whatever the session GET reports later.
      if (!failure && !sessionEnded) { logger.error(`[bi-agent] Stream ended without a terminal event for session ${sessionId}`); failure = 'session_stream_eof'; }

    } catch (err) {
      failure = err;
      throw err;
    } finally {
      runEndedAt = Date.now();
      await recordSessionUsage({ laneId: 'agent_bi', sessionId, agentId: BI_AGENT_ID, model: BI_AGENT_CONFIG.model, startedAt: startTime, failure });
    }

    const durationSeconds = Math.round((runEndedAt - startTime) / 1000);
    notify('complete', `Done in ${durationSeconds}s`);

    logger.info(`[bi-agent] Complete: SMS=${smsSent}, ${toolsExecuted.length} tools, ${durationSeconds}s`);
    return { sessionId, smsSent, toolsExecuted, durationSeconds, report };
  },
};

module.exports = BIAgent;
