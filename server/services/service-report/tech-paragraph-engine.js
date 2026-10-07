'use strict';

/**
 * The shared plumbing of the "From your technician" paragraph (owner 2026-10-05):
 * ONE model call at completion, validated in code, frozen first-writer-wins on
 * the service record, read back at render. The lawn report
 * (lawn-tech-paragraph.js) and the tree & shrub report
 * (tree-shrub-tech-paragraph.js) each hand this factory their own prompt,
 * validator, freeze key and lane; everything below the prompt is the same code,
 * so the deadline, the freeze race and the read-time guards cannot drift between
 * service lines.
 *
 * Trust model and timing rules are documented where they are enforced:
 *  - generate: one call, never throws, the whole call races its own deadline.
 *  - freeze: a single atomic UPDATE; the key's absence is in the predicate.
 *  - createAndFreeze: the completion step under ONE deadline; a stage that
 *    starts after expiry does not run, and the freeze is only ever issued after
 *    a validated paragraph exists.
 *
 * Pure except for generate's model call and freeze's write. No gate read:
 * callers decide.
 */

const crypto = require('crypto');
const logger = require('../logger');
const MODELS = require('../../config/models');

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

/**
 * @param {object} cfg
 * @param {string} cfg.logTag            logger prefix, e.g. 'lawn-tech-paragraph'
 * @param {string} cfg.laneId            LLM ledger / switchboard lane
 * @param {string} cfg.promptVersion
 * @param {string} cfg.freezeKey         top-level structured_notes key (never changes once shipped)
 * @param {number} cfg.freezeVersion
 * @param {number} cfg.budgetMs          the technician is waiting at Complete: ONE deadline for the step
 * @param {Function} cfg.normalizeInputs (raw) => canonical inputs (idempotent)
 * @param {Function} cfg.buildPrompt     (inputs) => { system, text, jsonSchema, promptVersion }
 * @param {Function} cfg.validateParagraph (answer, inputs) => { ok, paragraph, slots, problems }
 * @param {Function} cfg.frozenEntryProblem (entry) => null | reason (read-time guard; both
 *   paragraphs re-render the entry from its slots)
 * @param {Function} cfg.precheck (inputs) => null | reason; a reason means no model call
 * @param {number} [cfg.reserveMs] slice of the step's deadline the model call may not use (default 0)
 * @param {boolean} [cfg.freezeNothing] also freeze a text-less marker when the step has nothing to say, so a retried completion spends no second call (default false)
 */
function createTechParagraphEngine(cfg) {
  const {
    logTag, laneId, promptVersion, freezeKey, freezeVersion, budgetMs: BUDGET_MS,
    normalizeInputs, buildPrompt, validateParagraph, frozenEntryProblem,
    precheck, reserveMs = 0, freezeNothing = false,
  } = cfg;

  function inputsHash(inputs) {
    const { knownProductNames, ...shown } = inputs; // eslint-disable-line no-unused-vars
    return crypto.createHash('sha1').update(`${promptVersion}|${JSON.stringify(shown)}`).digest('hex').slice(0, 12);
  }

  /**
   * One model call, validated in code. Never throws. `deps.callModel` is injectable
   * for tests (and receives the exact payload the dispatcher would).
   * @returns {Promise<{ ok: boolean, paragraph?: string, slots?: object, reason?: string, problems?: string[] }>}
   */
  async function generateTechParagraph(rawInputs, deps = {}) {
    const inputs = normalizeInputs(rawInputs);
    const missing = precheck(inputs);
    if (missing) return { ok: false, reason: missing };
    // What is left of the step's one deadline (createAndFreezeTechParagraph passes it);
    // a call with under a second to run is not made.
    const budgetMs = Math.min(BUDGET_MS, deps.budgetMs ?? BUDGET_MS);
    if (budgetMs < 1000) return { ok: false, reason: 'timeout' };
    const prompt = buildPrompt(inputs);
    const payload = {
      laneId, promptVersion, system: prompt.system, text: prompt.text, jsonMode: true,
      jsonSchema: prompt.jsonSchema, maxTokens: 900, timeoutMs: budgetMs,
    };
    let verdict = null;
    const validate = (result) => {
      verdict = validateParagraph(result && result.json, inputs);
      return verdict.ok ? null : `tech_paragraph:${verdict.problems.join('|')}`;
    };
    try {
      const call = async () => {
        if (typeof deps.callModel === 'function') {
          const res = await deps.callModel(payload);
          if (res && res.ok) { const reason = validate(res); if (reason) return { ok: false, reason }; }
          return res;
        }
        const { dispatchWithFallback } = require('../llm/call');
        return dispatchWithFallback(MODELS.TEXT_POLICIES.report, payload, { validate, hardDeadline: true, reserveFallbackBudget: true });
      };
      let timer;
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), budgetMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const racing = call();
      racing.catch(() => {}); // a late settle after the ceiling is never an unhandled rejection
      let result;
      try { result = await Promise.race([racing, expired]); } finally { clearTimeout(timer); }
      if (!result || !result.ok) {
        const problems = verdict && !verdict.ok ? verdict.problems : [];
        logger.warn(`[${logTag}] no paragraph (${(result && result.reason) || 'unavailable'})`);
        return { ok: false, reason: problems.length ? 'rejected' : ((result && result.reason) || 'unavailable'), problems };
      }
      if (!verdict || !verdict.ok) return { ok: false, reason: 'rejected', problems: verdict ? verdict.problems : ['unvalidated'] };
      return {
        ok: true, paragraph: verdict.paragraph, inputsHash: inputsHash(inputs),
        ...(verdict.slots !== undefined ? { slots: verdict.slots } : {}),
      };
    } catch (err) {
      logger.warn(`[${logTag}] generation failed: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  }

  // ── Freeze (first writer wins, per assessment) ────────────────────────────

  /** One assessment's frozen entry out of a record's structured_notes, or null. */
  function storedTechParagraphFor(structuredNotes, assessmentId) {
    if (!assessmentId) return null;
    const map = parseJsonObject(structuredNotes)[freezeKey];
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const entry = map[assessmentId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (entry.v !== freezeVersion || String(entry.assessmentId) !== String(assessmentId)) return null;
    if (typeof entry.text !== 'string' || !entry.text.trim()) return null;
    return entry;
  }

  /**
   * The paragraph a render may print: the frozen text if the entry is whole and the
   * text passes the read-time guards, else null. Never throws.
   */
  function readFrozenTechParagraph(structuredNotes, assessmentId) {
    try {
      const entry = storedTechParagraphFor(structuredNotes, assessmentId);
      if (!entry) return null;
      const text = clean(entry.text);
      if (frozenEntryProblem(entry)) return null;
      return text;
    } catch { return null; }
  }

  /** PDF cache-key component: '' when nothing is frozen, else a short hash of the text. */
  function techParagraphSignature(structuredNotes, assessmentId) {
    const text = readFrozenTechParagraph(structuredNotes, assessmentId);
    return text ? `:tp=${crypto.createHash('sha1').update(text).digest('hex').slice(0, 8)}` : '';
  }

  /**
   * Freeze the entry under structured_notes[freezeKey][assessmentId], first
   * writer wins (the key's absence is in the UPDATE predicate, no preceding read; a
   * lost race adopts the winner). Copies freezeLawnCopyV6. Returns the entry the
   * record is now frozen to, or null on failure.
   */
  async function freezeTechParagraph(serviceRecordId, entry, knex) {
    if (!serviceRecordId || !entry || !entry.assessmentId || !knex) return null;
    const { assessmentId } = entry;
    try {
      const updated = await knex('service_records')
        .where({ id: serviceRecordId })
        .whereRaw(`COALESCE(structured_notes::jsonb, '{}'::jsonb) -> '${freezeKey}' -> ? IS NULL`, [assessmentId])
        .update({
          structured_notes: knex.raw(
            `COALESCE(structured_notes::jsonb, '{}'::jsonb) || jsonb_build_object('${freezeKey}',`
            + ` COALESCE(COALESCE(structured_notes::jsonb, '{}'::jsonb) -> '${freezeKey}', '{}'::jsonb) || ?::jsonb)`,
            [JSON.stringify({ [assessmentId]: entry })],
          ),
        });
      if (updated > 0) return entry;
      const row = await knex('service_records').where({ id: serviceRecordId }).first('structured_notes');
      return storedTechParagraphFor(row && row.structured_notes, assessmentId);
    } catch (err) {
      logger.warn(`[${logTag}] freeze failed for ${serviceRecordId}: ${err.message}`);
      return null;
    }
  }

  /**
   * The completion step: record read, input gather, model call, validation and
   * freeze, all under ONE deadline of BUDGET_MS from the call (the technician is
   * waiting at Complete). Never throws. `gatherInputs` and `deps.generate` are
   * injectable for tests.
   *
   * Deadline rule. Every await checks the deadline before the next stage starts,
   * and a stage that starts after expiry does not run. The freeze is the one
   * stage that cannot be cut short: it is a single atomic, first-writer-wins
   * UPDATE, so once issued it finishes whole or not at all, and it only ever
   * starts after a validated paragraph exists (so one in flight at the deadline is
   * necessarily past the model call). Expiry returns { status: 'timeout' }
   * without waiting for it. Nothing is ever written after expiry that was not
   * already issued before it.
   *
   * Either `structuredNotes` (already read) or `getStructuredNotes` (an async read
   * of the row's CURRENT notes, so it is under the deadline too) says whether a
   * paragraph is already frozen.
   * Returns { status, entry? }; entry is the frozen entry, for the caller's in-memory notes.
   */
  async function createAndFreezeTechParagraph({
    serviceRecordId, assessmentId, structuredNotes, getStructuredNotes, gatherInputs, knex, deps = {}, budgetMs,
  }) {
    if (!serviceRecordId || !assessmentId || typeof gatherInputs !== 'function') return { status: 'skipped' };
    // A caller that spent part of the step's one deadline before this point (the T&S
    // assessment lookup) passes what is left; the default is the whole budget.
    const budget = Number.isFinite(budgetMs) ? Math.min(BUDGET_MS, budgetMs) : BUDGET_MS;
    const startedAt = Date.now();
    let expired = false;
    const remaining = () => budget - (Date.now() - startedAt);
    const live = () => !expired && remaining() > 0;

    const run = async () => {
      const notes = typeof getStructuredNotes === 'function' ? await getStructuredNotes() : structuredNotes;
      if (!live()) return { status: 'timeout' };
      // First writer wins and a retry must not spend a second call. Any entry under
      // the key counts (a text-less "nothing to say" marker too), the same test the
      // freeze's UPDATE predicate uses.
      if (parseJsonObject(parseJsonObject(notes)[freezeKey])[assessmentId] != null) return { status: 'already_frozen' };
      let inputs;
      try {
        inputs = await gatherInputs();
      } catch (err) {
        logger.warn(`[${logTag}] input read failed for ${serviceRecordId}: ${err.message}`);
        return { status: 'read_failed' };
      }
      if (!live()) return { status: 'timeout' };
      if (!inputs) return { status: 'no_inputs' };
      // The model gets what is left minus cfg.reserveMs: a caller with a deterministic
      // fallback keeps a slice of the deadline for its build and the atomic freeze.
      const generated = await (deps.generate || generateTechParagraph)(inputs, { ...deps, budgetMs: remaining() - reserveMs });
      if (!live()) return { status: 'timeout' };
      if (!generated.ok && freezeNothing && generated.reason === 'nothing_to_say') {
        // A marker, never printed (storedTechParagraphFor needs text): the step ran.
        await freezeTechParagraph(serviceRecordId, {
          v: freezeVersion, promptVersion, assessmentId: String(assessmentId), text: '', nothingToSay: true,
          frozenAt: (deps.now ? deps.now() : new Date()).toISOString(),
        }, knex);
        return { status: 'nothing_to_say' };
      }
      if (!generated.ok) return { status: generated.reason || 'no_paragraph', problems: generated.problems };
      const entry = {
        v: freezeVersion,
        promptVersion,
        assessmentId: String(assessmentId),
        text: generated.paragraph,
        ...(generated.slots !== undefined ? { slots: generated.slots } : {}),
        inputsHash: generated.inputsHash || null,
        frozenAt: (deps.now ? deps.now() : new Date()).toISOString(),
      };
      const frozen = await freezeTechParagraph(serviceRecordId, entry, knex);
      if (!frozen) return { status: 'freeze_failed' };
      return { status: 'frozen', entry: frozen };
    };

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => { expired = true; resolve({ status: 'timeout' }); }, Math.max(0, budget));
      if (typeof timer.unref === 'function') timer.unref();
    });
    const stepping = run().catch((err) => {
      logger.warn(`[${logTag}] step failed for ${serviceRecordId}: ${err.message}`);
      return { status: 'error' };
    });
    try {
      return await Promise.race([stepping, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    generateTechParagraph,
    storedTechParagraphFor,
    readFrozenTechParagraph,
    techParagraphSignature,
    freezeTechParagraph,
    createAndFreezeTechParagraph,
    inputsHash,
  };
}

module.exports = { createTechParagraphEngine, clean, parseJsonObject };
