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
const BACKLINK_STRATEGY_AGENT_ENVIRONMENT_ID = process.env.BACKLINK_STRATEGY_AGENT_ENVIRONMENT_ID
  || process.env.MANAGED_AGENT_ENVIRONMENT_ID
  || process.env.ANTHROPIC_ENVIRONMENT_ID;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';
const REQUIRED_TOOL_NAMES = ['list_prospects', 'create_link_prospects'];

function buildSessionCreateBody(agentId, environmentId) {
  return { agent: agentId, environment_id: environmentId };
}

function buildUserMessageEvent(text) {
  return { type: 'user.message', content: [{ type: 'text', text }] };
}

function buildToolResultEvent(toolUseId, toolResult, { custom = true } = {}) {
  if (custom) {
    return {
      type: 'user.custom_tool_result',
      custom_tool_use_id: toolUseId,
      content: [{ type: 'text', text: JSON.stringify(toolResult) }],
      ...(toolResult?.error ? { is_error: true } : {}),
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: JSON.stringify(toolResult) }],
  };
}

function sendSessionEvents(sessionId, events) {
  return apiCall('POST', `/sessions/${sessionId}/events`, { events });
}

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
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
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
  async assertAgentConfigSynced() {
    const agent = await apiCall('GET', `/agents/${BACKLINK_STRATEGY_AGENT_ID}`);
    const configuredTools = new Set((agent.tools || []).map((tool) => tool && tool.name).filter(Boolean));
    const missingTools = REQUIRED_TOOL_NAMES.filter((name) => !configuredTools.has(name));
    if (missingTools.length) {
      throw new Error(
        `BACKLINK_STRATEGY_AGENT_ID=${BACKLINK_STRATEGY_AGENT_ID} is missing required M2 tools: ${missingTools.join(', ')}. `
        + 'Run `npm run backlink:sync-strategy-agent` with ANTHROPIC_API_KEY before running the strategist.'
      );
    }
    return { ok: true, agentId: agent.id, requiredTools: REQUIRED_TOOL_NAMES };
  },

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
    if (!ANTHROPIC_API_KEY || !BACKLINK_STRATEGY_AGENT_ID || !BACKLINK_STRATEGY_AGENT_ENVIRONMENT_ID) {
      throw new Error('Missing ANTHROPIC_API_KEY, BACKLINK_STRATEGY_AGENT_ID, or BACKLINK_STRATEGY_AGENT_ENVIRONMENT_ID/MANAGED_AGENT_ENVIRONMENT_ID');
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
    await this.assertAgentConfigSynced();

    const session = await apiCall('POST', '/sessions', buildSessionCreateBody(
      BACKLINK_STRATEGY_AGENT_ID,
      BACKLINK_STRATEGY_AGENT_ENVIRONMENT_ID
    ));

    const sessionId = session.id;
    logger.info(`[backlink-strategy] Session created: ${sessionId}`);

    await sendSessionEvents(sessionId, [buildUserMessageEvent(prompt)]);

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

      const isCustomToolUse = event === 'agent.custom_tool_use' || data?.type === 'agent.custom_tool_use';
      const isLegacyToolUse = event === 'tool_use' || data?.type === 'tool_use';
      if (isCustomToolUse || isLegacyToolUse) {
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
          list_prospects: 'reviewing prospects',
          create_link_prospects: 'adding prospects',
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
          if (toolName === 'create_link_prospects' && toolResult.added) {
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

        await sendSessionEvents(sessionId, [
          buildToolResultEvent(toolUseId, toolResult, { custom: isCustomToolUse }),
        ]);
      }

      const stopReason = typeof data?.stop_reason === 'string' ? data.stop_reason : data?.stop_reason?.type;
      if (event === 'done' || event === 'session_complete' || event === 'session.status_idle' || stopReason === 'end_turn') {
        break;
      }

      if (event === 'error' || event === 'session.error') {
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
module.exports._test = { buildSessionCreateBody, buildUserMessageEvent, buildToolResultEvent };
