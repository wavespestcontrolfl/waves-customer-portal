/**
 * Blog Content Agent — Session Manager
 *
 * Creates a Managed Agent session for content production,
 * streams events, executes custom tool calls against your
 * existing services, and returns the final report.
 *
 * Usage:
 *   const ContentAgent = require('./content-agent');
 *   const result = await ContentAgent.run({
 *     topic: 'chinch bug damage',
 *     city: 'Lakewood Ranch',
 *   });
 *   // result = { postId, title, wordCount, qaScore, wordpressUrl, socialStatus, report }
 */

const logger = require('../logger');
const db = require('../../models/db');
const { executeContentTool } = require('./content-agent-tools');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CONTENT_AGENT_ID = process.env.CONTENT_AGENT_ID;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';

// ─── API helpers (shared with managed-assistant) ────────────────

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
          const data = JSON.parse(line.slice(6));
          yield { event: currentEvent, data };
        } catch { /* skip malformed */ }
        currentEvent = null;
      }
    }
  }
}

// ─── Content Agent ──────────────────────────────────────────────

const ContentAgent = {

  /**
   * Run the content agent to produce a blog post.
   *
   * @param {object} opts
   * @param {string} opts.topic — Topic or keyword (e.g. "chinch bug damage", "lawn fertilization schedule")
   * @param {string} [opts.city] — Target city (optional — agent will pick if not specified)
   * @param {string} [opts.angle] — Specific angle or differentiation (optional)
   * @param {boolean} [opts.publishDraft=true] — Whether to publish to WordPress as draft
   * @param {boolean} [opts.distributeSocial=true] — Whether to queue social distribution
   * @param {function} [opts.onProgress] — Callback for progress updates: (stage, detail) => void
   *
   * @returns {object} { postId, title, wordCount, qaScore, wordpressUrl, socialStatus, report, sessionId }
   */
  async run({ topic, city, angle, publishDraft = true, distributeSocial = true, onProgress }) {
    if (!ANTHROPIC_API_KEY || !CONTENT_AGENT_ID) {
      throw new Error('Missing ANTHROPIC_API_KEY or CONTENT_AGENT_ID');
    }

    const startTime = Date.now();
    const notify = onProgress || (() => {});

    // Build the prompt
    let prompt = `Produce a complete blog post about: ${topic}`;
    if (city) prompt += `\n\nTarget city: ${city}`;
    if (angle) prompt += `\n\nSpecific angle: ${angle}`;
    prompt += `\n\nPublish to WordPress: ${publishDraft ? 'yes, as draft' : 'no, just write and QA score it'}`;
    prompt += `\nDistribute to social: ${distributeSocial ? 'yes, queue for all platforms' : 'no'}`;
    prompt += `\n\nFollow your full workflow: research → plan → write → QA → publish → distribute → report.`;

    notify('starting', `Creating content session for: ${topic}`);

    // Create session
    const session = await apiCall('POST', '/sessions', {
      agent_id: CONTENT_AGENT_ID,
    });

    const sessionId = session.id;
    logger.info(`[content-agent] Session created: ${sessionId} for topic: ${topic}`);

    // Send the user prompt
    await apiCall('POST', `/sessions/${sessionId}/events`, {
      type: 'user',
      content: [{ type: 'text', text: prompt }],
    });

    // Stream events and handle tool calls
    let finalReport = '';
    let toolsExecuted = [];
    let postId = null;
    let maxIterations = 50; // content agent needs more room than chat

    notify('researching', 'Agent is researching the topic...');

    for await (const { event, data } of streamSessionEvents(sessionId)) {
      if (--maxIterations <= 0) {
        logger.warn(`[content-agent] Hit max iterations for session ${sessionId}`);
        break;
      }

      // ── Text output ──
      if (event === 'assistant' || event === 'text') {
        if (data.text) finalReport += data.text;
        if (data.content) {
          for (const block of data.content) {
            if (block.type === 'text') finalReport += block.text;
          }
        }
      }

      // ── Custom tool call ──
      if (event === 'tool_use' || data?.type === 'tool_use') {
        const toolName = data.name;
        const toolInput = data.input || {};
        const toolUseId = data.id;

        // Progress notifications
        const stageMap = {
          get_fawn_weather: 'researching',
          get_pest_pressure: 'researching',
          search_knowledge_base: 'researching',
          check_existing_content: 'researching',
          get_content_gaps: 'researching',
          create_blog_post: 'writing',
          generate_blog_content: 'writing',
          run_content_qa: 'scoring',
          publish_to_wordpress: 'publishing',
          distribute_to_social: 'distributing',
          schedule_content: 'scheduling',
        };
        notify(stageMap[toolName] || 'working', `Executing: ${toolName}`);

        logger.info(`[content-agent] Tool: ${toolName}(${JSON.stringify(toolInput).slice(0, 200)})`);

        let toolResult;
        try {
          toolResult = await executeContentTool(toolName, toolInput);

          // Track post ID when it's created
          if (toolName === 'create_blog_post' && toolResult.post_id) {
            postId = toolResult.post_id;
          }
        } catch (err) {
          toolResult = { error: `Tool failed: ${err.message}` };
          logger.error(`[content-agent] Tool ${toolName} error: ${err.message}`);
        }

        toolsExecuted.push({ tool: toolName, input: toolInput, result: toolResult });

        // Send result back
        await apiCall('POST', `/sessions/${sessionId}/events`, {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
        });
      }

      // ── Session complete ──
      if (event === 'done' || event === 'session_complete' || data?.stop_reason === 'end_turn') {
        break;
      }

      // ── Error ──
      if (event === 'error') {
        logger.error(`[content-agent] Agent error: ${JSON.stringify(data)}`);
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    notify('complete', `Finished in ${Math.round(durationMs / 1000)}s`);

    // Gather results from the post record
    let postData = null;
    if (postId) {
      postData = await db('blog_posts').where('id', postId).first();
    }

    const result = {
      sessionId,
      postId,
      title: postData?.title || null,
      wordCount: postData?.word_count || null,
      qaScore: null,
      wordpressUrl: postData?.wordpress_url || null,
      socialDistributed: toolsExecuted.some(t => t.tool === 'distribute_to_social'),
      toolsExecuted: toolsExecuted.map(t => t.tool),
      durationSeconds: Math.round(durationMs / 1000),
      report: finalReport,
    };

    // Extract QA score from tool results
    const qaResult = toolsExecuted.find(t => t.tool === 'run_content_qa');
    if (qaResult?.result?.total_score) {
      result.qaScore = qaResult.result.total_score;
    }

    // Log the run
    try {
      await db('content_agent_runs').insert({
        session_id: sessionId,
        blog_post_id: postId,
        topic,
        city: city || postData?.city,
        status: postData?.wordpress_url ? 'published' : (postId ? 'drafted' : 'failed'),
        tools_executed: JSON.stringify(result.toolsExecuted),
        qa_score: result.qaScore,
        word_count: result.wordCount,
        duration_seconds: result.durationSeconds,
        report: finalReport.substring(0, 10000),
        created_at: new Date(),
      });
    } catch (err) {
      // Table may not exist yet — non-fatal
      logger.debug(`[content-agent] Run log failed (table may not exist): ${err.message}`);
    }

    logger.info(`[content-agent] Complete: "${result.title}" | ${result.wordCount} words | QA: ${result.qaScore}/50 | ${result.durationSeconds}s`);

    return result;
  },

  /**
   * Run a batch of content generation — e.g., produce 5 posts at once.
   * Each runs as a separate Managed Agent session (parallelizable).
   */
  async runBatch(topics, opts = {}) {
    const results = [];
    for (const topicSpec of topics) {
      const spec = typeof topicSpec === 'string' ? { topic: topicSpec } : topicSpec;
      try {
        const result = await this.run({ ...opts, ...spec });
        results.push({ success: true, ...result });
      } catch (err) {
        results.push({ success: false, topic: spec.topic, error: err.message });
        logger.error(`[content-agent] Batch item failed: ${err.message}`);
      }
    }
    return results;
  },
};

module.exports = ContentAgent;
