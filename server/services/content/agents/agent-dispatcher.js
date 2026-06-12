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
// Managed Agents now require an environment_id at session creation.
// Same fallback chain as server/services/lead-response-agent.js so
// operators can set CONTENT_AGENT_ENVIRONMENT_ID per-agent or fall
// back to the org-wide ANTHROPIC_ENVIRONMENT_ID.
const CONTENT_AGENT_ENVIRONMENT_ID =
  process.env.CONTENT_AGENT_ENVIRONMENT_ID || process.env.ANTHROPIC_ENVIRONMENT_ID;

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

// voice_constraints arrives as an object from a fresh compose() but as a
// JSON string when the brief was re-read from content_briefs. Normalize.
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function buildInputPayload(brief) {
  // Operator-authored intercept briefs carry their binding editorial plan in
  // voice_constraints.operator_brief (a persisted jsonb column, so it also
  // survives the get_content_brief round-trip). Surface it in the opening
  // message so the agent treats it as binding from the first token, not as
  // one more signal to weigh.
  const voice = parseMaybeJson(brief.voice_constraints);
  const operatorBrief = (voice && typeof voice === 'object' && voice.operator_brief) || null;

  // What the agent sees when its session opens — a structured JSON
  // representation of the brief plus an explicit instruction to start
  // with get_content_brief() for the full row.
  return {
    instruction: `You have been dispatched to produce a draft for opportunity ${brief.opportunity_id}. Start by calling get_content_brief(opportunity_id="${brief.opportunity_id}") to load the full brief. The shape summary below is what was composed; the get_content_brief call returns the canonical JSON to work from.${brief.facts_pack ? ' This brief includes a facts_pack: every local claim in your body must be grounded in one of its fact ids, and you must emit a claims_ledger.' : ''}${operatorBrief ? ' IMPORTANT: this is an OPERATOR-AUTHORED intercept brief. The operator_brief block below (also at voice_constraints.operator_brief in the canonical brief) is BINDING: follow its binding_instructions exactly — the working title/thesis/outline are the content plan, required_sources must be linked in-post with explicit attribution, verify_notes are mandatory verification steps, and the internal links and author block are required as given. Do not re-derive the topic, angle, slug, or sources.' : ''}`,
    brief_summary: {
      operator_brief: operatorBrief,
      opportunity_id: brief.opportunity_id,
      action_type: brief.action_type,
      page_type: brief.page_type,
      target_url: brief.target_url || null,
      target_keyword: brief.target_keyword || null,
      city: brief.city || null,
      service: brief.service || null,
      word_count_target: brief.word_count_target,
      seo_requirements: brief.seo_requirements || null,
      human_review_required: !!brief.human_review_required,
      router_notes: brief.router_notes || null,
      facts_pack: brief.facts_pack || null,
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

    if (!CONTENT_AGENT_ENVIRONMENT_ID) {
      return {
        ok: false,
        reason: 'agent_environment_not_configured',
        env_var_missing: 'CONTENT_AGENT_ENVIRONMENT_ID (or ANTHROPIC_ENVIRONMENT_ID)',
      };
    }

    const t0 = Date.now();
    let session;
    try {
      // Field is `agent`, not `agent_id`, per the live API contract
      // already exercised by server/services/lead-response-agent.js:159.
      session = await apiCall('POST', '/sessions', {
        agent: route.agent_id,
        environment_id: CONTENT_AGENT_ENVIRONMENT_ID,
        metadata: { source: 'autonomous-content-engine', opportunity_id: brief.opportunity_id },
      });
    } catch (err) {
      return { ok: false, reason: `session_create_failed: ${err.message}` };
    }
    const sessionId = session.id;

    // Post the initial input to the session. Schema mirrors the
    // live Managed Agents contract used by lead-response-agent.js:
    // events POST is wrapped in { events: [...] } and the event
    // type is 'user.message' with content as text blocks.
    try {
      await apiCall('POST', `/sessions/${sessionId}/events`, {
        events: [{
          type: 'user.message',
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        }],
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
   * Internal: stream session events via SSE (same pattern as the
   * legacy content-agent.js), execute custom tool calls, stop when
   * the agent emits draft / metadata OR the session completes.
   *
   * Earlier iteration polled GET /sessions/{id}/events with an
   * `?after=` cursor and read `evt.type === 'tool_use'`. The Managed
   * Agents API exposes those events over SSE (text/event-stream)
   * where each frame is `event: <name>` + `data: {...}`. The legacy
   * agent (already running in prod) consumes them that way; polling
   * would never see a tool_use event and sessions would deadlock.
   */
  async _streamAndExecute(sessionId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for await (const { event, data } of streamSessionEvents(sessionId, deadline)) {
      // Tool use surfaces in three shapes depending on the agent
      // config: the legacy SDK tools emit `event: tool_use`, custom
      // `type:'custom'` tools (which is what all three new agents
      // declare) emit `event: agent.custom_tool_use`, and some
      // server builds put the discriminator on the data payload
      // instead of the event name. All three are accepted.
      const isCustomToolUse =
        event === 'agent.custom_tool_use' || data?.type === 'agent.custom_tool_use';
      const isLegacyToolUse =
        event === 'tool_use' || data?.type === 'tool_use';
      if (isCustomToolUse || isLegacyToolUse) {
        const toolName = data?.name;
        const toolInput = data?.input || {};
        const toolUseId = data?.id;
        const result = await executeBriefTool(toolName, toolInput, { sessionId });
        // Reply schema differs by tool kind:
        //   - custom tools → user.custom_tool_result with custom_tool_use_id
        //   - legacy tools → tool_result with tool_use_id, content blocks
        // Mirrors managed-agents-2026-04-01 contract used by
        // server/services/lead-response-agent.js.
        if (isCustomToolUse) {
          // Mirrors lead-response-agent.js:331-335 — events wrapped,
          // content as text blocks, not a bare JSON string.
          await apiCall('POST', `/sessions/${sessionId}/events`, {
            events: [{
              type: 'user.custom_tool_result',
              custom_tool_use_id: toolUseId,
              content: [{ type: 'text', text: JSON.stringify(result) }],
            }],
          });
        } else {
          await apiCall('POST', `/sessions/${sessionId}/events`, {
            events: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: [{ type: 'text', text: JSON.stringify(result) }],
            }],
          });
        }
        if (getDraft(sessionId)) return; // sink fired; agent finished
        continue;
      }
      // Terminal session/turn events — always exit the stream. If a
      // draft was captured runWithBrief returns it; if not it returns
      // agent_did_not_emit_draft.
      //
      // session.status_idle is intentionally NOT terminal on its own:
      // Managed Agents emit it with stop_reason: requires_action while
      // the agent waits for the tool_result we just sent. Treating it
      // as terminal makes multi-tool runs (e.g. get_content_brief then
      // emit_draft) exit after the first tool and report
      // agent_did_not_emit_draft even though the agent was about to
      // continue. Only end_turn (handled below) is the real terminal.
      const stopReason = typeof data?.stop_reason === 'string' ? data.stop_reason : data?.stop_reason?.type;
      if (event === 'done' || event === 'session_complete' || event === 'turn_end' || event === 'session_end') return;
      if (stopReason === 'end_turn') return;
      if (event === 'error' || event === 'session.error') {
        // Don't mask infrastructure failures as a content-quality
        // outcome — throw so runWithBrief surfaces streaming_failed
        // instead of agent_did_not_emit_draft.
        const detail = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200);
        logger.error(`[agent-dispatcher] session ${sessionId} error: ${detail}`);
        throw new Error(`session_error: ${detail}`);
      }
    }
    throw new Error(`session ${sessionId} timed out after ${timeoutMs}ms`);
  }
}

// ── SSE streaming helper (mirrors content-agent.js production pattern) ─

async function* streamSessionEvents(sessionId, deadline) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const controller = new AbortController();
  const timeoutMs = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Dedicated streaming endpoint per the live API (used by
    // lead-response-agent.js:75). The earlier `?stream=true` form was
    // a misread of the legacy content-agent prototype.
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
      method: 'GET',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
        accept: 'text/event-stream',
      },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const errText = res.body ? await res.text() : '';
      throw new Error(`SSE open failed ${res.status}: ${errText.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentEvent = 'message';
    while (true) {
      if (Date.now() >= deadline) throw new Error('SSE deadline exceeded');
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line. The spec allows LF,
      // CRLF, or bare CR boundaries — only matching \n\n loses frames
      // on servers that emit \r\n\r\n and the dispatcher times out
      // with streaming_failed even though events were arriving.
      const FRAME_SEP = /\r\n\r\n|\n\n|\r\r/;
      let m;
      while ((m = FRAME_SEP.exec(buf))) {
        const frame = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let evName = currentEvent;
        let dataLines = [];
        for (const rawLine of frame.split('\n')) {
          const line = rawLine.replace(/\r$/, '');
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');
        let data = null;
        try { data = JSON.parse(dataStr); } catch { data = dataStr; }
        yield { event: evName, data };
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = new AgentDispatcher();
module.exports.AgentDispatcher = AgentDispatcher;
module.exports._internals = {
  ACTION_TO_AGENT,
  pickAgent,
  buildInputPayload,
};
