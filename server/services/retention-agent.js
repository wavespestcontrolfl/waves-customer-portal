/**
 * Customer Retention Agent — Session Manager
 *
 * Usage:
 *   const RetentionAgent = require('./retention-agent');
 *   await RetentionAgent.run();                           // full weekly cycle
 *   await RetentionAgent.run({ focus: 'critical_only' }); // just critical customers
 *   await RetentionAgent.run({ customerId: 'uuid' });     // single customer deep-dive
 */

const logger = require('./logger');
const db = require('../models/db');
const { executeRetentionTool } = require('./retention-agent-tools');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RETENTION_AGENT_ID = process.env.RETENTION_AGENT_ID;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';

async function apiCall(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }
  return res.json();
}

async function* streamSessionEvents(sessionId) {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/events?stream=true`, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'accept': 'text/event-stream',
    },
  });
  if (!res.ok) throw new Error(`Stream error ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    let currentEvent = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
      else if (line.startsWith('data: ') && currentEvent) {
        try { yield { event: currentEvent, data: JSON.parse(line.slice(6)) }; } catch {}
        currentEvent = null;
      }
    }
  }
}

const RetentionAgent = {

  /**
   * Run the retention cycle.
   * @param {object} [opts]
   * @param {string} [opts.focus] — 'critical_only', 'upsells_only', or null for full cycle
   * @param {string} [opts.customerId] — Deep-dive a single customer
   * @param {function} [opts.onProgress] — Progress callback
   */
  async run(opts = {}) {
    if (!ANTHROPIC_API_KEY || !RETENTION_AGENT_ID) {
      throw new Error('Missing ANTHROPIC_API_KEY or RETENTION_AGENT_ID');
    }

    const startTime = Date.now();
    const notify = opts.onProgress || (() => {});

    let prompt = 'Run the weekly customer retention cycle.';

    if (opts.customerId) {
      prompt = `Deep-dive analysis on a single customer: ${opts.customerId}. Pull their full health detail, analyze all signals, decide the right intervention, and execute it. Report your findings and actions.`;
    } else if (opts.focus === 'critical_only') {
      prompt += ' Focus only on critical-risk customers — they need immediate attention. Skip watch-level customers.';
    } else if (opts.focus === 'upsells_only') {
      prompt += ' Focus on identifying and drafting upsell opportunities for healthy and watch-level customers. Skip churn interventions.';
    } else {
      prompt += ' Follow your full workflow: health check → prioritize → analyze → decide interventions → identify upsells → execute → report.';
    }

    prompt += '\n\nAt the end, save your retention report using the save_retention_report tool.';

    notify('starting', 'Creating retention session...');

    const session = await apiCall('POST', '/sessions', { agent_id: RETENTION_AGENT_ID });
    const sessionId = session.id;
    logger.info(`[retention-agent] Session ${sessionId}`);

    await apiCall('POST', `/sessions/${sessionId}/events`, {
      type: 'user',
      content: [{ type: 'text', text: prompt }],
    });

    let report = '';
    let toolsExecuted = [];
    let smsSent = 0;
    let callsQueued = 0;
    let sequencesEnrolled = 0;
    let upsellsIdentified = 0;
    let maxIterations = 80; // retention agent analyzes many customers

    notify('analyzing', 'Agent is scoring customer health...');

    for await (const { event, data } of streamSessionEvents(sessionId)) {
      if (--maxIterations <= 0) {
        logger.warn(`[retention-agent] Hit max iterations`);
        break;
      }

      if (event === 'assistant' || event === 'text') {
        if (data.text) report += data.text;
        if (data.content) {
          for (const block of data.content) {
            if (block.type === 'text') report += block.text;
          }
        }
      }

      if (event === 'tool_use' || data?.type === 'tool_use') {
        const toolName = data.name;
        const toolInput = data.input || {};
        const toolUseId = data.id;

        const stageMap = {
          run_health_scores: 'scoring health',
          detect_signals: 'detecting signals',
          get_at_risk_customers: 'identifying at-risk',
          get_customer_health_detail: 'analyzing customer',
          get_retention_metrics: 'pulling metrics',
          generate_retention_outreach: 'drafting outreach',
          send_retention_sms: 'sending SMS',
          queue_call_for_adam: 'scheduling call',
          enroll_save_sequence: 'enrolling sequence',
          identify_upsells: 'finding upsells',
          create_upsell_pitch: 'drafting upsell',
          save_retention_report: 'saving report',
        };
        notify(stageMap[toolName] || 'working', `Tool: ${toolName}`);
        logger.info(`[retention-agent] Tool: ${toolName}`);

        let toolResult;
        try {
          toolResult = await executeRetentionTool(toolName, toolInput);

          if (toolName === 'send_retention_sms' && toolResult.sent) smsSent++;
          if (toolName === 'queue_call_for_adam' && toolResult.queued) callsQueued++;
          if (toolName === 'enroll_save_sequence' && toolResult.enrolled) sequencesEnrolled++;
          if (toolName === 'identify_upsells') upsellsIdentified += (toolResult.opportunities?.length || 0);
        } catch (err) {
          toolResult = { error: `Tool failed: ${err.message}` };
          logger.error(`[retention-agent] Tool ${toolName} error: ${err.message}`);
        }

        toolsExecuted.push(toolName);

        await apiCall('POST', `/sessions/${sessionId}/events`, {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
        });
      }

      if (event === 'done' || event === 'session_complete' || data?.stop_reason === 'end_turn') break;
      if (event === 'error') { logger.error(`[retention-agent] Error: ${JSON.stringify(data)}`); break; }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    notify('complete', `Finished in ${durationSeconds}s`);

    const result = {
      sessionId, smsSent, callsQueued, sequencesEnrolled, upsellsIdentified,
      toolsExecuted, durationSeconds, report,
    };

    logger.info(`[retention-agent] Complete: ${smsSent} SMS, ${callsQueued} calls, ${sequencesEnrolled} sequences, ${upsellsIdentified} upsells, ${durationSeconds}s`);
    return result;
  },
};

module.exports = RetentionAgent;
