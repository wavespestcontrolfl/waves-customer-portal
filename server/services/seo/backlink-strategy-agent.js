/**
 * Backlink Strategy Agent — Session Manager
 *
 * Runs a weekly autonomous SEO strategy cycle:
 * audit → competitor gaps → target discovery → queue prioritization → report
 *
 * Usage:
 *   const BacklinkStrategyAgent = require('./backlink-strategy-agent');
 *   const result = await BacklinkStrategyAgent.run();
 *   // or: await BacklinkStrategyAgent.run({ competitors: ['turnerpest.com'], skipScan: true });
 */

const logger = require('../logger');
const db = require('../../models/db');
const { executeBacklinkTool } = require('./backlink-strategy-tools');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BACKLINK_STRATEGY_AGENT_ID = process.env.BACKLINK_STRATEGY_AGENT_ID;
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
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stream error ${res.status}: ${err}`);
  }

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
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ') && currentEvent) {
        try {
          yield { event: currentEvent, data: JSON.parse(line.slice(6)) };
        } catch { /* skip */ }
        currentEvent = null;
      }
    }
  }
}

const BacklinkStrategyAgent = {

  /**
   * Run the weekly backlink strategy cycle.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.competitors] — Override competitor list
   * @param {boolean} [opts.skipScan=false] — Skip the DataForSEO backlink scan (saves credits)
   * @param {boolean} [opts.skipLLM=false] — Skip LLM mentions check (saves credits)
   * @param {string} [opts.focus] — Specific focus area (e.g., "editorial outreach", "citation cleanup")
   * @param {function} [opts.onProgress] — Progress callback: (stage, detail) => void
   *
   * @returns {object} { sessionId, report, targetsAdded, gapsFound, durationSeconds }
   */
  async run(opts = {}) {
    if (!ANTHROPIC_API_KEY || !BACKLINK_STRATEGY_AGENT_ID) {
      throw new Error('Missing ANTHROPIC_API_KEY or BACKLINK_STRATEGY_AGENT_ID');
    }

    const startTime = Date.now();
    const notify = opts.onProgress || (() => {});

    // Build prompt
    let prompt = 'Run the weekly backlink strategy cycle. Follow your full workflow: audit → competitor gaps → target discovery → queue prioritization → editorial outreach → LLM visibility → report.';

    if (opts.competitors) {
      prompt += `\n\nFocus competitor analysis on: ${opts.competitors.join(', ')}`;
    }
    if (opts.skipScan) {
      prompt += '\n\nSkip the fresh DataForSEO backlink scan — use the existing dashboard data to save credits.';
    }
    if (opts.skipLLM) {
      prompt += '\n\nSkip the LLM mentions check to save credits.';
    }
    if (opts.focus) {
      prompt += `\n\nPay special attention to: ${opts.focus}`;
    }

    prompt += '\n\nAt the end, save your strategy report using the save_strategy_report tool.';

    notify('starting', 'Creating backlink strategy session...');

    const session = await apiCall('POST', '/sessions', {
      agent_id: BACKLINK_STRATEGY_AGENT_ID,
    });

    const sessionId = session.id;
    logger.info(`[backlink-strategy] Session created: ${sessionId}`);

    await apiCall('POST', `/sessions/${sessionId}/events`, {
      type: 'user',
      content: [{ type: 'text', text: prompt }],
    });

    let finalReport = '';
    let toolsExecuted = [];
    let targetsAdded = 0;
    let gapsFound = 0;
    let maxIterations = 60; // strategy agent may need lots of tool calls

    notify('auditing', 'Agent is auditing the backlink profile...');

    for await (const { event, data } of streamSessionEvents(sessionId)) {
      if (--maxIterations <= 0) {
        logger.warn(`[backlink-strategy] Hit max iterations for session ${sessionId}`);
        break;
      }

      if (event === 'assistant' || event === 'text') {
        if (data.text) finalReport += data.text;
        if (data.content) {
          for (const block of data.content) {
            if (block.type === 'text') finalReport += block.text;
          }
        }
      }

      if (event === 'tool_use' || data?.type === 'tool_use') {
        const toolName = data.name;
        const toolInput = data.input || {};
        const toolUseId = data.id;

        const stageMap = {
          get_backlink_dashboard: 'auditing',
          scan_backlinks: 'auditing',
          get_signup_agent_stats: 'auditing',
          get_citation_dashboard: 'auditing',
          scan_competitor_gaps: 'analyzing competitors',
          get_competitor_gap_opportunities: 'analyzing competitors',
          add_targets_to_queue: 'adding targets',
          get_queue_status: 'reviewing queue',
          get_completed_profiles: 'reviewing profiles',
          check_search_volume: 'checking keywords',
          check_llm_mentions: 'checking LLM visibility',
          save_strategy_report: 'saving report',
        };
        notify(stageMap[toolName] || 'working', `Executing: ${toolName}`);

        logger.info(`[backlink-strategy] Tool: ${toolName}(${JSON.stringify(toolInput).slice(0, 200)})`);

        let toolResult;
        try {
          toolResult = await executeBacklinkTool(toolName, toolInput);

          if (toolName === 'add_targets_to_queue' && toolResult.added) {
            targetsAdded += toolResult.added;
          }
          if (toolName === 'scan_competitor_gaps' && toolResult.gaps) {
            gapsFound += toolResult.gaps;
          }
        } catch (err) {
          toolResult = { error: `Tool failed: ${err.message}` };
          logger.error(`[backlink-strategy] Tool ${toolName} error: ${err.message}`);
        }

        toolsExecuted.push({ tool: toolName, input: toolInput, result: toolResult });

        await apiCall('POST', `/sessions/${sessionId}/events`, {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
        });
      }

      if (event === 'done' || event === 'session_complete' || data?.stop_reason === 'end_turn') {
        break;
      }

      if (event === 'error') {
        logger.error(`[backlink-strategy] Agent error: ${JSON.stringify(data)}`);
        break;
      }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    notify('complete', `Finished in ${durationSeconds}s`);

    const result = {
      sessionId,
      targetsAdded,
      gapsFound,
      toolsExecuted: toolsExecuted.map(t => t.tool),
      durationSeconds,
      report: finalReport,
    };

    logger.info(`[backlink-strategy] Complete: ${targetsAdded} targets added, ${gapsFound} gaps found, ${durationSeconds}s`);
    return result;
  },
};

module.exports = BacklinkStrategyAgent;
