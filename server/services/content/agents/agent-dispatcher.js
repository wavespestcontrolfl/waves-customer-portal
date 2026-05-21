/**
 * agent-dispatcher.js — picks the right brief-driven agent for a
 * content_briefs row and invokes it via the Anthropic Managed Agents
 * API. Returns the draft the agent emitted (or an explanation of why
 * it didn't).
 *
 * Pure routing + payload composition is testable without an API key.
 * The actual session invocation requires:
 *   - ANTHROPIC_API_KEY env
 *   - One of the three agents registered with Anthropic (CONTENT_WRITER_AGENT_ID
 *     / CONTENT_REFRESHER_AGENT_ID / CONTENT_META_REWRITER_AGENT_ID).
 *     Registration is a deploy task — handled by an out-of-band script
 *     that takes the configs from writer-agent-config / refresh-agent-config /
 *     meta-rewriter-config and POSTs them to /v1/agents.
 *
 * If the relevant agent ID is missing from env, dispatch() returns
 * `{ ok: false, reason: 'agent_not_registered' }` so the runner can
 * fall back to the legacy waves-content-engine path or queue for
 * human handling.
 */

const logger = require('../../logger');
const { executeBriefTool, getDraft, clearDraft } = require('./brief-driven-tools');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';

// ── action → agent map ──────────────────────────────────────────────

const ACTION_TO_AGENT = {
  create_or_refresh_city_service_page: {
    role: 'writer',
    envVar: 'CONTENT_WRITER_AGENT_ID',
    configName: 'waves-content-writer',
  },
  create_customer_question_page: {
    role: 'writer',
    envVar: 'CONTENT_WRITER_AGENT_ID',
    configName: 'waves-content-writer',
  },
  new_supporting_blog: {
    role: 'writer',
    envVar: 'CONTENT_WRITER_AGENT_ID',
    configName: 'waves-content-writer',
  },
  refresh_existing_page: {
    role: 'refresh',
    envVar: 'CONTENT_REFRESHER_AGENT_ID',
    configName: 'waves-content-refresher',
  },
  rewrite_title_meta: {
    role: 'meta',
    envVar: 'CONTENT_META_REWRITER_AGENT_ID',
    configName: 'waves-content-meta-rewriter',
  },
  // Non-LLM actions — no agent dispatch.
  add_internal_links: { role: 'none', reason: 'handled by internal-link-planner' },
  gbp_post: { role: 'none', reason: 'handled by gbp distributor' },
  do_not_publish: { role: 'none', reason: 'blocked by router' },
};

// ── pure routing helpers (test-friendly) ────────────────────────────

function pickAgent(brief) {
  if (!brief) throw new Error('agent-dispatcher: brief required');
  const route = ACTION_TO_AGENT[brief.action_type];
  if (!route) {
    return { ok: false, reason: `unknown_action_type:${brief.action_type}` };
  }
  if (route.role === 'none') {
    return { ok: false, reason: route.reason, role: 'none' };
  }
  const agentId = process.env[route.envVar] || null;
  if (!agentId) {
    return {
      ok: false,
      reason: 'agent_not_registered',
      role: route.role,
      env_var_missing: route.envVar,
      config_name: route.configName,
    };
  }
  return { ok: true, role: route.role, agent_id: agentId, config_name: route.configName };
}

function buildInputPayload(brief) {
  // What the agent sees when its session opens — a structured JSON
  // representation of the brief plus an explicit instruction to start
  // with get_content_brief() for the full row.
  return {
    instruction: `You have been dispatched to produce a draft for opportunity ${brief.opportunity_id}. Start by calling get_content_brief(opportunity_id="${brief.opportunity_id}") to load the full brief. The shape summary below is what was composed; the get_content_brief call returns the canonical JSON to work from.`,
    brief_summary: {
      opportunity_id: brief.opportunity_id,
      action_type: brief.action_type,
      page_type: brief.page_type,
      target_url: brief.target_url || null,
      target_keyword: brief.target_keyword || null,
      city: brief.city || null,
      service: brief.service || null,
      word_count_target: brief.word_count_target,
      human_review_required: !!brief.human_review_required,
      router_notes: brief.router_notes || null,
    },
  };
}

// ── Anthropic API helpers ───────────────────────────────────────────

async function apiCall(method, path, body) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
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
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 400)}`);
  }
  return res.json();
}

// ── main dispatch ───────────────────────────────────────────────────

class AgentDispatcher {
  /**
   * runWithBrief(brief, { dryRun=false, sessionTimeoutMs=300000 })
   *
   * brief: row from content_briefs (or compose result from brief-builder).
   * dryRun: skip the API call; return the routing decision + input
   *   payload only. Used by preview CLI + tests.
   *
   * Returns:
   *   { ok: true, draft, agent_id, session_id, duration_ms }
   *   { ok: false, reason, ... }  // including reason='dry_run'
   */
  async runWithBrief(brief, { dryRun = false, sessionTimeoutMs = 5 * 60 * 1000 } = {}) {
    const route = pickAgent(brief);
    if (!route.ok) return { ok: false, ...route };

    const payload = buildInputPayload(brief);
    if (dryRun) {
      return {
        ok: false,
        reason: 'dry_run',
        role: route.role,
        agent_id: route.agent_id,
        config_name: route.config_name,
        input_payload: payload,
      };
    }

    const t0 = Date.now();
    let session;
    try {
      session = await apiCall('POST', '/sessions', {
        agent_id: route.agent_id,
        metadata: { source: 'autonomous-content-engine', opportunity_id: brief.opportunity_id },
      });
    } catch (err) {
      return { ok: false, reason: `session_create_failed: ${err.message}` };
    }
    const sessionId = session.id;

    // Post the initial input to the session.
    try {
      await apiCall('POST', `/sessions/${sessionId}/events`, {
        type: 'user_message',
        content: JSON.stringify(payload),
      });
    } catch (err) {
      return { ok: false, reason: `initial_message_failed: ${err.message}`, session_id: sessionId };
    }

    // Stream events; execute tool calls; capture emit_draft / emit_metadata_only.
    try {
      await this._streamAndExecute(sessionId, sessionTimeoutMs);
    } catch (err) {
      const partial = getDraft(sessionId);
      clearDraft(sessionId);
      return {
        ok: false,
        reason: `streaming_failed: ${err.message}`,
        session_id: sessionId,
        partial_draft: partial || null,
        duration_ms: Date.now() - t0,
      };
    }

    const draft = getDraft(sessionId);
    clearDraft(sessionId);
    if (!draft) {
      return {
        ok: false,
        reason: 'agent_did_not_emit_draft',
        session_id: sessionId,
        agent_id: route.agent_id,
        duration_ms: Date.now() - t0,
      };
    }

    return {
      ok: true,
      draft,
      role: route.role,
      agent_id: route.agent_id,
      session_id: sessionId,
      duration_ms: Date.now() - t0,
    };
  }

  /**
   * Internal: poll session events, execute custom tool calls,
   * stop when the agent emits draft / metadata OR the session
   * completes.
   */
  async _streamAndExecute(sessionId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let cursor = null;
    while (Date.now() < deadline) {
      const events = await apiCall(
        'GET',
        `/sessions/${sessionId}/events${cursor ? `?after=${cursor}` : ''}`
      );
      for (const evt of events.events || []) {
        cursor = evt.id;
        if (evt.type === 'tool_use') {
          const result = await executeBriefTool(evt.tool_name, evt.input, { sessionId });
          await apiCall('POST', `/sessions/${sessionId}/events`, {
            type: 'tool_result',
            tool_use_id: evt.id,
            content: JSON.stringify(result),
          });
          if (getDraft(sessionId)) return; // sink fired; agent finished
        }
        if (evt.type === 'session_end' || evt.type === 'turn_end') {
          if (getDraft(sessionId)) return;
        }
      }
      // Brief poll cadence — Managed Agents typically push faster than
      // we poll, but this is a backstop. Real production wiring will
      // use SSE streaming (managed-assistant.js pattern).
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new Error(`session ${sessionId} timed out after ${timeoutMs}ms`);
  }
}

module.exports = new AgentDispatcher();
module.exports.AgentDispatcher = AgentDispatcher;
module.exports._internals = {
  ACTION_TO_AGENT,
  pickAgent,
  buildInputPayload,
};
