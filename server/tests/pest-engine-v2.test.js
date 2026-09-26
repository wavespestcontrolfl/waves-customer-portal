/**
 * Photo ID v2 pest engine tests (PR-2a).
 *
 * Model calls are mocked at `llm/call`'s `dispatch` — nothing here hits a
 * real provider. The species catalog is mocked with the small, hand-built
 * fixture in `helpers/pest-engine-fixtures.js` rather than the live
 * `species-catalog-v1` data (per the 2026-09-26 contract delta note: the
 * live entry files are being revised in parallel by content workers, so
 * engine tests target fixtures, never the live files).
 *
 * `TEXT_POLICIES.photoIdVision` is mocked in too (PR #4865 adds the real
 * one; this engine reads it at call time either way) so this suite runs
 * independently of whether that PR has landed on main yet.
 */

jest.mock('../services/species-catalog', () => require('./helpers/pest-engine-fixtures').FIXTURE);
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatch: jest.fn(),
}));
jest.mock('../config/models', () => {
  const actual = jest.requireActual('../config/models');
  return {
    ...actual,
    TEXT_POLICIES: {
      ...actual.TEXT_POLICIES,
      photoIdVision: {
        name: 'photoIdVision',
        primary: { provider: 'gemini', model: 'gemini-3.8-flash-test' },
        fallback: { provider: 'openai', model: 'gpt-6-astra-test' },
      },
    },
  };
});

const { dispatch } = require('../services/llm/call');
const catalog = require('../services/species-catalog');
const engine = require('../services/photo-id-v2/pest-engine');

const {
  buildAnswer, mapToV1, resolveCandidate, dedupeCandidates, isConsequential, isApproved,
  identifyPestV2, REFERRAL_TEMPLATES,
} = engine;

// ── ctx-builder helpers for buildAnswer unit tests ─────────────────────────

function cand(slug, confidence, { traitsVisible = [], traitsNotVisible = [] } = {}) {
  const entry = catalog.getEntry(slug);
  if (!entry) throw new Error(`fixture has no entry "${slug}"`);
  return { slug: entry.slug, offCatalogName: null, groupId: entry.group, confidence, entry, traitsVisible, traitsNotVisible };
}

function candOff(offCatalogName, groupId, confidence) {
  return { slug: null, offCatalogName, groupId, confidence, entry: null, traitsVisible: [], traitsNotVisible: [] };
}

function baseCtx(overrides = {}) {
  return {
    candidates: [],
    disagreed: false,
    disagreementNode: null,
    escalationTriggered: false,
    openaiAnswered: false,
    qualityUsable: true,
    qualityIssue: 'none',
    currentMonth: 6,
    ...overrides,
  };
}

const CURRENT_MONTH = 6; // June — inside every fixture entry's active_months

beforeEach(() => {
  dispatch.mockReset();
});

// ── buildAnswer: naming thresholds ─────────────────────────────────────────

describe('buildAnswer — entry-level naming', () => {
  test('pretty_sure at >= 0.80 for an approved entry', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.85)] }));
    expect(built.answer).toMatchObject({
      level: 'entry', wording: 'pretty_sure', node_id: 'fire-ant', headline: "We're pretty sure: Fire Ant", subhead: 'Solenopsis invicta',
    });
    expect(built.entry.slug).toBe('fire-ant');
    expect(built.tier).toBe('ai_suggestion');
    expect(built.nextPhoto).toBeNull();
  });

  test('likely at 0.55–0.80 for an approved entry', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('ghost-ant', 0.65)] }));
    expect(built.answer.wording).toBe('likely');
    expect(built.answer.headline).toBe('Likely: Ghost Ant');
    expect(built.tier).toBe('ai_suggestion');
  });

  test('harmless/ally entry reaches pretty_sure at 0.70 when no consequential alt is close (decision #2)', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('gopher-tortoise', 0.72)] }));
    expect(built.answer.wording).toBe('pretty_sure');
    expect(built.entry.slug).toBe('gopher-tortoise');
  });

  test('decision #2 guard: the SAME 0.70 ally confidence does NOT reach pretty_sure when a consequential alt is close (>=0.20)', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('gopher-tortoise', 0.72), cand('fire-ant', 0.55)],
    }));
    expect(built.answer.wording).toBe('likely'); // 0.72 still clears the general LIKELY_MIN bar
    expect(built.entry.slug).toBe('gopher-tortoise');
  });

  test('a consequential alt below 0.20 does NOT block the harmless-plainly bar', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('gopher-tortoise', 0.72), cand('fire-ant', 0.10)],
    }));
    expect(built.answer.wording).toBe('pretty_sure');
  });

  test('an UNAPPROVED entry never gets named, however high its confidence — climbs to group instead', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('unreviewed-ant', 0.95)] }));
    expect(built.answer.level).toBe('group');
    expect(built.answer.node_id).toBe('ants');
    expect(built.answer.headline).toBe('Looks like an ant');
    expect(built.entry).toBeNull();
    expect(built.tier).toBe('needs_more_evidence');
  });

  test('owner_approved but fact-check pending (non-empty verification) is ALSO unapproved', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('pending-verification-ant', 0.95)] }));
    expect(built.entry).toBeNull();
    expect(built.answer.level).toBe('group');
  });

  test('an escalation trigger with no OpenAI answer can never read pretty_sure, even at 0.90', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('fire-ant', 0.90)], escalationTriggered: true, openaiAnswered: false,
    }));
    expect(built.answer.wording).toBe('likely'); // capped down from pretty_sure, still clears LIKELY_MIN
  });

  test('an escalation trigger WITH an OpenAI answer is not capped', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('fire-ant', 0.90)], escalationTriggered: true, openaiAnswered: true,
    }));
    expect(built.answer.wording).toBe('pretty_sure');
  });
});

describe('buildAnswer — lineage climb', () => {
  test('climbs to GROUP when the top entry alone is under 0.60 but the group sum clears it', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('fire-ant', 0.35), candOff('a stinging ant', 'ants', 0.30)],
    }));
    expect(built.answer.level).toBe('group');
    expect(built.answer.node_id).toBe('ants');
    expect(built.answer.headline).toBe('Looks like an ant');
  });

  test('climbs to CATEGORY when neither group clears 0.60 but the category sum does', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('ghost-ant', 0.35), cand('roof-rat', 0.30)],
    }));
    expect(built.answer.level).toBe('category');
    expect(built.answer.node_id).toBe('insect');
    expect(built.answer.subhead).toBeNull();
  });

  test('unknown when nothing clears any lineage rung', () => {
    const built = buildAnswer(baseCtx({ candidates: [candOff('something unrecognizable', null, 0.1)] }));
    expect(built.answer).toMatchObject({ level: 'unknown', wording: 'unknown', node_id: null, headline: "We couldn't tell from these photos" });
    expect(built.tier).toBe('needs_more_evidence');
  });
});

describe('buildAnswer — disagreement', () => {
  test('a shared node from the two disagreeing lineages, tier needs_more_evidence, entry null', () => {
    const node = { level: 'group', id: 'ants', label: 'Ants', generic: 'an ant' };
    const built = buildAnswer(baseCtx({
      candidates: [cand('fire-ant', 0.6), cand('ghost-ant', 0.5)], disagreed: true, disagreementNode: node,
    }));
    expect(built.answer).toMatchObject({ level: 'group', node_id: 'ants', wording: 'group_only', headline: 'Looks like an ant' });
    expect(built.entry).toBeNull();
    expect(built.tier).toBe('needs_more_evidence');
  });

  test('no shared node at all reads unknown', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.6)], disagreed: true, disagreementNode: null }));
    expect(built.answer.level).toBe('unknown');
  });
});

describe('buildAnswer — tier', () => {
  test('unusable photo quality forces needs_more_evidence even at pretty_sure', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.9)], qualityUsable: false }));
    expect(built.answer.wording).toBe('pretty_sure');
    expect(built.tier).toBe('needs_more_evidence');
  });

  test('multiple_subjects forces needs_more_evidence', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.9)], qualityIssue: 'multiple_subjects' }));
    expect(built.tier).toBe('needs_more_evidence');
  });

  test('a chosen look-alike pair with photo_can_confirm:false forces needs_more_evidence even at entry level', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('no-photo-pair-a', 0.60), cand('no-photo-pair-b', 0.55)], currentMonth: CURRENT_MONTH,
    }));
    expect(built.answer.level).toBe('entry'); // 'likely' — still entry level
    expect(built.nextPhoto.photo_can_confirm).toBe(false);
    expect(built.tier).toBe('needs_more_evidence');
  });
});

describe('buildAnswer — next_photo', () => {
  test('null when pretty_sure', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.85)] }));
    expect(built.nextPhoto).toBeNull();
  });

  test('a curated look-alike pair supplies ask/why with photo_can_confirm true by default', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('ghost-ant', 0.65), cand('white-footed-ant', 0.30)] }));
    expect(built.nextPhoto).toEqual({
      ask: 'A close-up from the side.', why: 'White-footed ants are black all over.', photo_can_confirm: true,
    });
  });

  test('falls back to the node next_photo when there is no curated pair', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('unreviewed-ant', 0.95)] }));
    expect(built.nextPhoto).toEqual({ ask: 'Ant group node photo', why: 'Ant group why', photo_can_confirm: true });
  });

  test('a single entry-level candidate (no second candidate) preserves its own first look-alike\'s photo_can_confirm:false — Codex round-0 P1', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('no-photo-pair-a', 0.60)] }));
    expect(built.answer.level).toBe('entry');
    expect(built.nextPhoto.photo_can_confirm).toBe(false);
    expect(built.tier).toBe('needs_more_evidence');
  });
});

describe('buildAnswer — look-alike identities respect the review gate (Codex round-0 P1)', () => {
  test('an approved entry\'s look_alikes list DROPS an UNAPPROVED look-alike entirely — name, slug, AND comparison prose', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.85)] }));
    expect(built.entry.look_alikes).toHaveLength(0);
    expect(JSON.stringify(built.entry)).not.toContain('Unreviewed Ant');
    expect(JSON.stringify(built.entry)).not.toContain('two-node waist'); // the comparison prose itself
  });

  test('next_photo does not surface a curated pair\'s comparison prose when the OTHER side is unapproved', () => {
    // no-photo-pair-a's ONLY look-alike (no-photo-pair-b) is approved in the
    // base fixture; this test's point is the SINGLE-candidate fallback path
    // when that one look-alike is swapped for an unapproved target.
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.55)] })); // fire-ant's only look-alike is unapproved
    expect(built.answer.wording).toBe('likely');
    expect(built.nextPhoto).toBeNull(); // no approved look-alike to fall back to, and no node-level prompt at entry level
  });
});

describe('buildAnswer — referral', () => {
  test('bee relocation referral for an approved honey-bee-wall-colony entry', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('honey-bee-wall-colony', 0.85)] }));
    expect(built.referral).toEqual({ kind: 'bee_relocation', text: REFERRAL_TEMPLATES.bee_relocation });
  });

  test('protected_leave_alone referral for the gopher tortoise', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('gopher-tortoise', 0.85)] }));
    expect(built.referral).toEqual({ kind: 'protected_leave_alone', text: REFERRAL_TEMPLATES.protected_leave_alone });
  });

  test('null referral for an entry with no referral kind', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.85)] }));
    expect(built.referral).toBeNull();
  });
});

describe('buildAnswer — role/risk/action + verdict labels (contract delta #2)', () => {
  test('roof rat (rodent, inspection-first hard rule) carries fixed labels', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('roof-rat', 0.85)] }));
    expect(built.entry).toMatchObject({
      role: 'health_pest', role_label: 'Health pest',
      risk: 'medical', risk_label: 'Can cause a medically significant reaction',
      action: 'inspection', action_label: 'Get an inspection',
      verdict_label: 'Worth a pro look',
    });
  });
});

describe('buildAnswer — candidates block hides an unapproved candidate\'s identity', () => {
  test('an unapproved second candidate shows the group generic, not its name', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('fire-ant', 0.85), cand('unreviewed-ant', 0.30)], currentMonth: CURRENT_MONTH,
    }));
    const unreviewed = built.candidatesBlock.find((c) => c.common_name === 'an ant');
    expect(unreviewed).toBeTruthy();
    expect(unreviewed.slug).toBeNull();
    expect(unreviewed.scientific_name).toBeNull();
    expect(JSON.stringify(built)).not.toContain('Unreviewed Ant');
  });
});

describe('buildAnswer — evidence', () => {
  test('matches/still_need are cited catalog traits, capped at 3, from the top candidate\'s trait numbers', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('fire-ant', 0.85, { traitsVisible: [1, 3], traitsNotVisible: [2] })],
    }));
    expect(built.evidence).toEqual({
      matches: ['Reddish-brown mound builders', 'Two-node waist'],
      still_need: ['Aggressive when disturbed'],
    });
  });

  test('out-of-range/duplicate trait numbers are dropped, never invented', () => {
    const built = buildAnswer(baseCtx({
      candidates: [cand('fire-ant', 0.85, { traitsVisible: [1, 1, 99, -1] })],
    }));
    expect(built.evidence.matches).toEqual(['Reddish-brown mound builders']);
  });
});

describe('buildAnswer — local label', () => {
  test('common_here_now when range is common and the month is active', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.85)], currentMonth: 6 }));
    expect(built.candidatesBlock[0].local).toBe('common_here_now');
  });

  test('uncommon_here for a rare-range entry', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('gopher-tortoise', 0.85)], currentMonth: 6 }));
    expect(built.candidatesBlock[0].local).toBe('uncommon_here');
  });
});

// ── isConsequential / isApproved ───────────────────────────────────────────

describe('isConsequential', () => {
  test('venomous makes a candidate consequential', () => {
    expect(isConsequential({ verdict: 'watch', safety: { venomous: true } })).toBe(true);
  });
  test('irritant (contract delta #5) makes a candidate consequential', () => {
    expect(isConsequential({ verdict: 'watch', safety: { irritant: true } })).toBe(true);
  });
  test('disease_vector makes a candidate consequential', () => {
    expect(isConsequential({ verdict: 'watch', safety: { disease_vector: true } })).toBe(true);
  });
  test('inspection-first makes a candidate consequential', () => {
    expect(isConsequential({ verdict: 'watch', safety: {}, service: { inspection_first: true } })).toBe(true);
  });
  test('a plain nuisance entry is not consequential', () => {
    expect(isConsequential({ verdict: 'watch', safety: {}, service: {} })).toBe(false);
  });
  test('null entry is not consequential', () => {
    expect(isConsequential(null)).toBe(false);
  });
});

describe('isApproved', () => {
  test('owner_approved + empty verification is approved', () => {
    expect(isApproved(catalog.getEntry('fire-ant'))).toBe(true);
  });
  test('draft status is not approved', () => {
    expect(isApproved(catalog.getEntry('unreviewed-ant'))).toBe(false);
  });
  test('owner_approved with a pending verification entry is not approved', () => {
    expect(isApproved(catalog.getEntry('pending-verification-ant'))).toBe(false);
  });
});

// ── resolveCandidate / dedupeCandidates ────────────────────────────────────

describe('resolveCandidate', () => {
  test('resolves a real catalog slug', () => {
    const c = resolveCandidate({ slug: 'fire-ant', confidence: 0.7 });
    expect(c.entry.slug).toBe('fire-ant');
    expect(c.confidence).toBe(0.7);
  });

  test('a hallucinated/unknown slug degrades to off-catalog rather than being dropped', () => {
    const c = resolveCandidate({ slug: 'not-a-real-slug', off_catalog_name: 'Some bug', group_id: 'ants', confidence: 0.4 });
    expect(c.entry).toBeNull();
    expect(c.offCatalogName).toBe('Some bug');
    expect(c.groupId).toBe('ants');
  });

  test('confidence is clamped to [0,1]', () => {
    expect(resolveCandidate({ slug: 'fire-ant', confidence: 5 }).confidence).toBe(1);
    expect(resolveCandidate({ slug: 'fire-ant', confidence: -5 }).confidence).toBe(0);
    expect(resolveCandidate({ slug: 'fire-ant', confidence: 'nonsense' }).confidence).toBe(0);
  });
});

describe('dedupeCandidates', () => {
  test('keeps the higher-confidence instance of a duplicate slug and caps at 3, ranked', () => {
    const list = [
      cand('fire-ant', 0.3), cand('fire-ant', 0.9), cand('ghost-ant', 0.5),
      cand('white-footed-ant', 0.4), cand('roof-rat', 0.2),
    ];
    const out = dedupeCandidates(list);
    expect(out).toHaveLength(3);
    expect(out[0].slug).toBe('fire-ant');
    expect(out[0].confidence).toBe(0.9);
    expect(out.map((c) => c.slug)).toEqual(['fire-ant', 'ghost-ant', 'white-footed-ant']);
  });
});

// ── mapToV1 ────────────────────────────────────────────────────────────────

describe('mapToV1', () => {
  test('a v2 entry with a v1 legacy slug maps through the REAL v1 PEST_LIBRARY entry', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.85)] }));
    const v1 = mapToV1({ ...built, disagreed: false });
    expect(v1.species_slug).toBe('fire-ant');
    expect(v1.report_contract.identification.slug).toBe('fire-ant');
    expect(v1.report_contract.safety.stinging).toBe(true);
    expect(v1.report_contract.safety.venomous).toBe(true);
    expect(v1.report_contract.contract_version).toBe('pest_id_v1');
  });

  test('a v2-only entry (no v1 legacy slug) degrades to v1\'s own unmatched default — never a fabricated v1 identity', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('roof-rat', 0.85)] }));
    const v1 = mapToV1({ ...built, disagreed: false });
    expect(v1.species_slug).toBeNull();
    expect(v1.report_contract.identification.slug).toBeNull();
    expect(v1.report_contract.service.inspection_required).toBe(true);
    expect(v1.report_contract.urgency).toBe('high');
  });

  test('an unapproved/climbed answer (no named entry at all) maps to the fully generic v1 default', () => {
    const built = buildAnswer(baseCtx({ candidates: [cand('unreviewed-ant', 0.95)] }));
    const v1 = mapToV1({ ...built, disagreed: false });
    expect(v1.species_slug).toBeNull();
    expect(v1.category).toBe('other');
    expect(v1.report_contract.service.inspection_required).toBe(true);
  });

  test('contested is true only on a disagreed needs_more_evidence result', () => {
    const node = { level: 'group', id: 'ants', label: 'Ants', generic: 'an ant' };
    const built = buildAnswer(baseCtx({ candidates: [cand('fire-ant', 0.6)], disagreed: true, disagreementNode: node }));
    const v1 = mapToV1({ ...built, disagreed: true });
    expect(v1.report_contract.identification.contested).toBe(true);
  });
});

// ── orchestration (identifyPestV2) — escalation triggers + combining ──────

const PHOTO = { data: 'AAAA', mimeType: 'image/jpeg' };

function candidatesReply(candidates, quality = { usable: true, issue: 'none' }, shows = 'organism') {
  return { ok: true, json: { quality, shows, candidates } };
}

describe('identifyPestV2 — escalation triggers', () => {
  test('Gemini missed entirely (candidates call fails) escalates, and skips the verify call', async () => {
    dispatch
      .mockResolvedValueOnce({ ok: false, reason: 'gemini_500' }) // candidates
      .mockResolvedValueOnce({ ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'organism', candidates: [{ slug: 'fire-ant', confidence: 0.9 }] } }); // escalation

    const result = await identifyPestV2([PHOTO]);
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2); // candidates + escalation only (no verify — no catalog candidate from call 1)
    expect(result.internal.escalation_reasons).toContain('gemini_missed');
    expect(result.internal.models.verify).toBeNull();
    expect(result.v2.answer.wording).toBe('pretty_sure');
    expect(result.v2.entry.slug).toBe('fire-ant');
  });

  test('low confidence after verify escalates; OpenAI agreement bumps confidence to the higher of the two', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([{ slug: 'fire-ant', confidence: 0.5 }])) // candidates
      .mockResolvedValueOnce({ ok: true, json: { candidates: [{ slug: 'fire-ant', confidence: 0.5, traits_visible: [1], traits_not_visible: [] }] } }) // verify
      .mockResolvedValueOnce({ ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'organism', candidates: [{ slug: 'fire-ant', confidence: 0.85 }] } }); // escalation

    const result = await identifyPestV2([PHOTO]);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.internal.escalation_reasons).toContain('low_confidence');
    expect(result.internal.disagreed).toBe(false);
    expect(result.v2.answer.wording).toBe('pretty_sure'); // bumped to the higher (0.85) of the two
  });

  test('self-contradiction (candidates-call top != verify-call top) triggers escalation', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([
        { slug: 'fire-ant', confidence: 0.9 }, { slug: 'ghost-ant', confidence: 0.4 },
      ])) // candidates: fire-ant raw-top
      .mockResolvedValueOnce({
        ok: true,
        json: {
          candidates: [
            { slug: 'fire-ant', confidence: 0.3, traits_visible: [], traits_not_visible: [1, 2, 3] },
            { slug: 'ghost-ant', confidence: 0.85, traits_visible: [1, 2], traits_not_visible: [] },
          ],
        },
      }) // verify: ghost-ant is now top — contradicts the candidates-call top
      .mockResolvedValueOnce({ ok: false, reason: 'openai_timeout' }); // escalation unavailable

    const result = await identifyPestV2([PHOTO]);
    expect(result.internal.escalation_reasons).toContain('self_contradiction');
    // OpenAI never answered after a trigger fired — ghost-ant's 0.85 can never read pretty_sure.
    expect(result.v2.answer.wording).toBe('likely');
    expect(result.v2.entry.slug).toBe('ghost-ant');
  });

  test('a consequential look-alike close (top two within 0.25, one risky one not) triggers escalation', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([
        { slug: 'fire-ant', confidence: 0.55 }, { slug: 'ghost-ant', confidence: 0.45 },
      ]))
      .mockResolvedValueOnce({
        ok: true,
        json: {
          candidates: [
            { slug: 'fire-ant', confidence: 0.55, traits_visible: [1], traits_not_visible: [] },
            { slug: 'ghost-ant', confidence: 0.45, traits_visible: [1], traits_not_visible: [] },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: false, reason: 'openai_timeout' });

    const result = await identifyPestV2([PHOTO]);
    expect(result.internal.escalation_reasons).toContain('consequential_lookalike_close');
  });

  test('a verify call that answers ok but omits a requested candidate is treated as gemini_missed, not a silent unverified confidence — Codex round-0 P1', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([{ slug: 'fire-ant', confidence: 0.95 }]))
      .mockResolvedValueOnce({ ok: true, json: { candidates: [] } }) // verify answered ok, but verified nothing
      .mockResolvedValueOnce({ ok: false, reason: 'openai_timeout' }); // escalation unavailable

    const result = await identifyPestV2([PHOTO]);
    expect(result.internal.escalation_reasons).toContain('gemini_missed');
    // The unverified 0.95 can never read pretty_sure once a trigger fired
    // with no OpenAI answer.
    expect(result.v2.answer.wording).toBe('likely');
  });

  test('an escalation call that answers ok but names NO candidate does not count as OpenAI confirmation — Codex round-0 P1 (round 2)', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([{ slug: 'fire-ant', confidence: 0.95 }]))
      .mockResolvedValueOnce({ ok: true, json: { candidates: [{ slug: 'fire-ant', confidence: 0.4, traits_visible: [], traits_not_visible: [1, 2, 3] }] } }) // verify tanks the confidence
      .mockResolvedValueOnce({ ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'organism', candidates: [] } }); // escalation answers ok, names nothing

    const result = await identifyPestV2([PHOTO]);
    expect(result.internal.models.escalation.ok).toBe(true);
    // Confidence is unchanged (still 0.4 from verify) AND the trigger has no
    // real OpenAI answer to lift the pretty_sure cap either way.
    expect(result.v2.answer.wording).not.toBe('pretty_sure');
  });

  test('no trigger fires on a clean, confident, uncontested read — no escalation call at all', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([{ slug: 'fire-ant', confidence: 0.9 }]))
      .mockResolvedValueOnce({ ok: true, json: { candidates: [{ slug: 'fire-ant', confidence: 0.9, traits_visible: [1, 2], traits_not_visible: [] }] } });

    const result = await identifyPestV2([PHOTO]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.internal.escalation_triggered).toBe(false);
    expect(result.internal.escalation_reasons).toEqual([]);
    expect(result.v2.answer.wording).toBe('pretty_sure');
  });
});

describe('identifyPestV2 — Gemini/OpenAI disagreement', () => {
  test('a real disagreement (different top slugs) drops to the shared lineage node, tier needs_more_evidence', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([{ slug: 'fire-ant', confidence: 0.5 }]))
      .mockResolvedValueOnce({ ok: true, json: { candidates: [{ slug: 'fire-ant', confidence: 0.5, traits_visible: [], traits_not_visible: [] }] } })
      .mockResolvedValueOnce({ ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'organism', candidates: [{ slug: 'ghost-ant', confidence: 0.9 }] } });

    const result = await identifyPestV2([PHOTO]);
    expect(result.internal.disagreed).toBe(true);
    expect(result.v2.answer.level).toBe('group');
    expect(result.v2.answer.node_id).toBe('ants');
    expect(result.v2.entry).toBeNull();
    expect(result.v2.tier).toBe('needs_more_evidence');
  });
});

describe('identifyPestV2 — off-catalog and no-photos', () => {
  test('no usable photos returns ok:false without calling any model', async () => {
    const result = await identifyPestV2([]);
    expect(result).toEqual({ ok: false, reason: 'no_photos' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('an off-catalog answer never leaks model prose into the customer object', async () => {
    dispatch.mockResolvedValueOnce(candidatesReply([
      { slug: '', off_catalog_name: 'XYZ_MODEL_PROSE_MARKER', rank: 'genus', group_id: 'ants', confidence: 0.9 },
    ]));

    const result = await identifyPestV2([PHOTO]);
    expect(dispatch).toHaveBeenCalledTimes(1); // no catalog candidate ⇒ no verify call
    expect(result.v2.answer.level).toBe('group');
    expect(result.v2.answer.headline).toBe('Looks like an ant');
    expect(JSON.stringify(result.v2)).not.toContain('XYZ_MODEL_PROSE_MARKER');
  });
});

describe('identifyPestV2 — internal object never reaches v2', () => {
  test('the returned v2 object has no `models`/`internal` keys', async () => {
    dispatch
      .mockResolvedValueOnce(candidatesReply([{ slug: 'fire-ant', confidence: 0.9 }]))
      .mockResolvedValueOnce({ ok: true, json: { candidates: [{ slug: 'fire-ant', confidence: 0.9, traits_visible: [1], traits_not_visible: [] }] } });

    const result = await identifyPestV2([PHOTO]);
    expect(result.v2.models).toBeUndefined();
    expect(result.v2.internal).toBeUndefined();
    expect(result.internal).toBeDefined();
  });
});
