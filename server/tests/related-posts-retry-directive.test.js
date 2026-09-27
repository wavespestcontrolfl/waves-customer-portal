/**
 * Related-post link minimum → redraft directive wiring (owner rule
 * 2026-09-26, Codex round-1 P2 on #4984).
 *
 * checkRelatedPostsLinked (content-quality-gate.js) is now a HARD check —
 * this file pins the wiring that turns a failure into an ACTIONABLE
 * redraft directive through the existing gate-retry mechanism, so the
 * writer's one feedback-informed redraft gets more than a bare check name.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { aggregateGateFindings, relatedPostsNotLinkedFinding } = require('../services/content/autonomous-runner')._internals;
const { buildRetryDirectives, GATE_RETRY_INSTRUCTIONS } = require('../services/content/gate-retry-directives');

describe('relatedPostsNotLinkedFinding', () => {
  test('returns null when the check is absent, passing, or the quality result is missing entirely', () => {
    expect(relatedPostsNotLinkedFinding(null)).toBeNull();
    expect(relatedPostsNotLinkedFinding({})).toBeNull();
    expect(relatedPostsNotLinkedFinding({ checks: {} })).toBeNull();
    expect(relatedPostsNotLinkedFinding({ checks: { related_posts_linked: { ok: true } } })).toBeNull();
  });

  test('returns a P1 RELATED_POSTS_NOT_LINKED finding carrying the check\'s own reason when it fails', () => {
    const reason = 'Add natural in-text links to at least 3 of the 4 related posts in voice_constraints.related_posts where the topic comes up (linked 1 so far) — e.g. "B" (/termite/b/).';
    const finding = relatedPostsNotLinkedFinding({ checks: { related_posts_linked: { ok: false, reason } } });
    expect(finding).toEqual({ severity: 'P1', code: 'RELATED_POSTS_NOT_LINKED', message: reason });
  });

  test('falls back to a generic message if the check somehow carries no reason', () => {
    const finding = relatedPostsNotLinkedFinding({ checks: { related_posts_linked: { ok: false } } });
    expect(finding.message).toBe('related-post link minimum not met');
  });
});

describe('aggregateGateFindings — related_posts_linked surfaces its own specific finding', () => {
  test('a passing quality gate with no related_posts_linked failure adds nothing', () => {
    const blocking = aggregateGateFindings({
      uniquenessResult: { ok: true },
      qualityResult: { ok: true, checks: { related_posts_linked: { ok: true } } },
      seoCompletionResult: { passed: true },
      prePublishVisibilityResult: { passed: true },
      summary: '',
    });
    expect(blocking).toEqual([]);
  });

  test('a quality-gate failure driven ONLY by related_posts_linked emits BOTH the generic QUALITY_GATE finding and the specific one', () => {
    const reason = 'Add natural in-text links to at least 2 of the 2 related posts in voice_constraints.related_posts where the topic comes up (linked 0 so far) — e.g. "A" (/termite/a/).';
    const blocking = aggregateGateFindings({
      uniquenessResult: { ok: true },
      qualityResult: { ok: false, checks: { related_posts_linked: { ok: false, reason } }, hard_failures: [{ name: 'related_posts_linked', reason }] },
      seoCompletionResult: { passed: true },
      prePublishVisibilityResult: { passed: true },
      summary: 'quality: hard=related_posts_linked soft=none score=51/51',
    });
    const codes = blocking.map((f) => f.code);
    expect(codes).toContain('QUALITY_GATE');
    expect(codes).toContain('RELATED_POSTS_NOT_LINKED');
    const specific = blocking.find((f) => f.code === 'RELATED_POSTS_NOT_LINKED');
    expect(specific.message).toBe(reason);
  });

  test('other quality-gate hard failures (e.g. hub_link_present) do NOT trigger the related-posts finding', () => {
    const blocking = aggregateGateFindings({
      uniquenessResult: { ok: true },
      qualityResult: { ok: false, checks: { hub_link_present: { ok: false, reason: 'no_hub_link_found' }, related_posts_linked: { ok: true } } },
      seoCompletionResult: { passed: true },
      prePublishVisibilityResult: { passed: true },
      summary: '',
    });
    expect(blocking.some((f) => f.code === 'RELATED_POSTS_NOT_LINKED')).toBe(false);
  });
});

describe('buildRetryDirectives — RELATED_POSTS_NOT_LINKED has a canonical instruction', () => {
  test('UNKNOWN_INTERNAL_ROUTE preserves the brief-approved related-post set', () => {
    expect(GATE_RETRY_INSTRUCTIONS.UNKNOWN_INTERNAL_ROUTE).toMatch(/voice_constraints\.related_posts/);
    expect(GATE_RETRY_INSTRUCTIONS.UNKNOWN_INTERNAL_ROUTE).toMatch(/preserve valid related-post links/);
  });

  test('the canonical text is always-actionable on its own (never depends on the specific message surviving truncation)', () => {
    expect(GATE_RETRY_INSTRUCTIONS.RELATED_POSTS_NOT_LINKED).toMatch(/voice_constraints\.related_posts/);
    expect(GATE_RETRY_INSTRUCTIONS.RELATED_POSTS_NOT_LINKED).toMatch(/natural in-text links/);
  });

  test('a RELATED_POSTS_NOT_LINKED finding produces the canonical directive PLUS the gate-reported specific detail', () => {
    const message = 'Add natural in-text links to at least 3 of the 4 related posts in voice_constraints.related_posts where the topic comes up (linked 1 so far) — e.g. "B" (/termite/b/).';
    const directives = buildRetryDirectives({ findings: [{ severity: 'P1', code: 'RELATED_POSTS_NOT_LINKED', message }] });
    const directive = directives[1];
    expect(directive).toContain(GATE_RETRY_INSTRUCTIONS.RELATED_POSTS_NOT_LINKED);
    expect(directive).toContain(`[Gate reported: ${message}]`);
  });
});
