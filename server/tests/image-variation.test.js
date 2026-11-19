/**
 * Image variation plan + text/logo screen (owner direction 2026-09-05: the
 * autopublished pictures all read as the same postcard; three images per
 * post stay, but they must vary in style and setting, carry no invented
 * labels or logos or text; the infographic style was removed 2026-11-19).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { visionAnalysis: 'visionAnalysis', imageScreen: 'imageScreen' }, GEMINI_IMAGE_BEST: 'gemini-x', GEMINI_IMAGE_STABLE: 'gemini-y' }));

const { dispatchWithFallback } = require('../services/llm/call');
const gen = require('../services/content/image-generator')._internals;
const { screenGeneratedImage, parseScreen, buildScreenPrompt } = require('../services/content/hero-alt-vision');

const SLUG = 'lawn-care/rain-bird-sprinkler-timer-guide';

describe('planFor — deterministic variation per post and slot', () => {
  test('same slug + slot → same plan; different slots → different plans', () => {
    const a = gen.planFor({ slug: SLUG, mode: 'blog-hero', index: 0 });
    const b = gen.planFor({ slug: SLUG, mode: 'blog-hero', index: 0 });
    const c = gen.planFor({ slug: SLUG, mode: 'blog-body', index: 1 });
    expect(a).toEqual(b);
    expect([a.style, a.setting, a.timeOfDay, a.vantage].join('|')).not.toBe([c.style, c.setting, c.timeOfDay, c.vantage].join('|'));
    for (const p of [a, c]) {
      expect(Object.keys(gen.IMAGE_STYLES)).toContain(p.style);
      expect(p.setting).toBeTruthy(); expect(p.timeOfDay).toBeTruthy(); expect(p.vantage).toBeTruthy();
    }
  });

  test('different posts get different settings across a handful of slugs (no single postcard)', () => {
    const slugs = ['a-post', 'b-post', 'c-post', 'd-post', 'e-post', 'f-post', 'g-post', 'h-post'];
    const settings = new Set(slugs.map((slug) => gen.planFor({ slug, mode: 'blog-hero', index: 0 }).setting));
    const styles = new Set(slugs.map((slug) => gen.planFor({ slug, mode: 'blog-hero', index: 0 }).style));
    expect(settings.size).toBeGreaterThanOrEqual(4);
    expect(styles.size).toBeGreaterThanOrEqual(2);
  });

  test('there are three styles and none is an infographic (owner 2026-11-19)', () => {
    expect(Object.keys(gen.IMAGE_STYLES)).toEqual(['photo', 'illustration', 'cartoon']);
    expect(gen.retryStyleFor).toBeUndefined(); // three styles for three slots: no unused style to retry in
  });

  test('hero, body-1 and body-2 never share a style within one post, and no slot is ever an infographic (Codex r1 P2 on #3964; owner 2026-11-19)', () => {
    const slugs = Array.from({ length: 520 }, (_, i) => `section/post-${i}-${(i * 7919) % 1000}`);
    let photoHeroes = 0;
    for (const slug of slugs) {
      const styles = [
        gen.planFor({ slug, mode: 'blog-hero', index: 0 }).style,
        gen.planFor({ slug, mode: 'blog-body', index: 1 }).style,
        gen.planFor({ slug, mode: 'blog-body', index: 2 }).style,
      ];
      expect(new Set(styles).size).toBe(3);
      for (const index of [0, 1, 2, 3]) {
        expect(gen.planFor({ slug, mode: index ? 'blog-body' : 'blog-hero', index }).style).not.toBe('infographic');
      }
      if (styles[0] === 'photo') photoHeroes += 1;
    }
    expect(photoHeroes / slugs.length).toBeGreaterThan(0.6); // the hero still leans photo: two posts in three
  });

  test('every slot keeps the style the four-style planner gave it, so a kept older picture and its new sibling differ (pre-push audit P1 on 5608d79a6a)', () => {
    // A frozen copy of the rotation before 2026-11-19 (photo, illustration, cartoon, infographic).
    const before = (slug) => {
      const seed = gen.hashString(`${slug || 'post'}:styles`);
      const pool = ['photo', 'illustration', 'cartoon', 'infographic'];
      const out = [];
      let h = seed;
      while (pool.length) {
        h = Math.imul(h ^ (h >>> 13), 16777619) >>> 0;
        out.push(pool.splice(h % pool.length, 1)[0]);
      }
      if (seed % 3 !== 0) {
        out.splice(out.indexOf('photo'), 1);
        out.unshift('photo');
      }
      return out;
    };
    const now = (slug, slot) => gen.planFor({ slug, mode: slot ? 'blog-body' : 'blog-hero', index: slot }).style;
    for (let i = 0; i < 600; i++) {
      const slug = `section/post-${i}`;
      const old = before(slug);
      for (const slot of [0, 1, 2]) {
        // A slot keeps its style; the infographic slot takes the fourth style no other slot uses.
        expect(now(slug, slot)).toBe(old[slot] === 'infographic' ? old[3] : old[slot]);
      }
      // A refresh that keeps an older picture in one body slot and adds the other: two styles.
      for (const [kept, added] of [[1, 2], [2, 1]]) {
        if (old[kept] !== 'infographic') expect(now(slug, added)).not.toBe(old[kept]);
      }
    }
    // The audit's example: this post's older body-1 is an illustration, and a new body-2 is not.
    expect(before('pest-control/my-post')[1]).toBe('illustration');
    expect(now('pest-control/my-post', 2)).not.toBe('illustration');
  });

  test('a screen retry (index + 1000) keeps the slot\'s style and cast under a fresh scene seed (Codex r2 P2 on #3964)', () => {
    let freshScenes = 0;
    for (let i = 0; i < 40; i += 1) {
      const slug = `post-${i}`;
      for (const index of [0, 1, 2]) {
        const mode = index ? 'blog-body' : 'blog-hero';
        const first = gen.planFor({ slug, mode, index, subject: 'lawn' });
        const retry = gen.planFor({ slug, mode, index: index + 1000, subject: 'lawn' });
        expect(retry.style).toBe(first.style);
        expect(retry.cast).toBe(first.cast);
        expect(retry.van).toBe(first.van);
        if (`${retry.setting}|${retry.timeOfDay}|${retry.vantage}` !== `${first.setting}|${first.timeOfDay}|${first.vantage}`) freshScenes += 1;
      }
    }
    expect(freshScenes).toBeGreaterThan(100); // of 120: the retry is a new scene, not the same prompt again
  });

  test('the setting pool follows the subject: turf posts stay outdoors, equipment posts may use the garage, indoor pests may look out from the kitchen; no setting carries a time of day', () => {
    const all = Object.values(gen.SETTINGS).flat();
    for (const setting of all) expect(setting).not.toMatch(/\b(dusk|dawn|first light|noon|morning|afternoon|golden hour|night|day)\b/i);
    expect(gen.settingsFor('Tropical sod webworm damage in St. Augustine lawns')).toEqual(gen.SETTINGS.yard);
    expect(gen.settingsFor('Ficus whitefly on hedges in Sarasota')).toEqual(gen.SETTINGS.yard);
    // An equipment or indoor subject SELECTS its pool — no outdoor leftovers (Codex r3 P2 on #3964).
    expect(gen.settingsFor('Rain Bird sprinkler timer: run it by hand')).toEqual(gen.SETTINGS.equipment);
    expect(gen.settingsFor('Which Tiny Ant Is in Your Kitchen?')).toEqual(gen.SETTINGS.indoor);
    // A pest noun alone is not an indoor cue, and a lawn/yard cue wins over one (Codex r4 P2 on #3964).
    expect(gen.settingsFor('What Made That Mound? Fire Ants, Pavement Ants, and Mole Crickets Compared mounds in lawn identification')).toEqual(gen.SETTINGS.yard);
    expect(gen.settingsFor('Bed bug bites: what they look like')).toEqual(gen.SETTINGS.indoor);
    expect(gen.settingsFor('Ghost ants: where they come from')).toEqual(gen.SETTINGS.yard);
    expect(gen.settingsFor('Ants in the kitchen after rain')).toEqual(gen.SETTINGS.indoor);
    expect(gen.settingsFor('Ants along the patio and lanai')).toEqual(gen.SETTINGS.yard);
    for (let i = 0; i < 30; i += 1) {
      expect(gen.SETTINGS.indoor).toContain(gen.planFor({ slug: `ant-${i}`, mode: 'blog-hero', index: 0, subject: 'Which Tiny Ant Is in Your Kitchen?' }).setting);
      expect(gen.SETTINGS.equipment).toContain(gen.planFor({ slug: `timer-${i}`, mode: 'blog-body', index: 1, subject: 'Hunter sprinkler timer guide' }).setting);
    }
    for (let i = 0; i < 30; i += 1) {
      const plan = gen.planFor({ slug: `turf-${i}`, mode: 'blog-hero', index: 0, subject: 'Chinch bug damage in a St. Augustine lawn' });
      expect(gen.SETTINGS.yard).toContain(plan.setting);
    }
  });
});

describe('module surface', () => {
  test('planFor and IMAGE_STYLES are public on the module (the publisher calls them on the default export)', () => {
    const mod = require('../services/content/image-generator');
    expect(typeof mod.planFor).toBe('function');
    expect(mod.IMAGE_STYLES).toBe(gen.IMAGE_STYLES);
    expect(mod.planFor({ slug: 'x', mode: 'blog-hero', index: 0 })).toEqual(gen.planFor({ slug: 'x', mode: 'blog-hero', index: 0 }));
  });
});

describe('buildPrompt with a plan', () => {
  test('names the style, setting, time and vantage; forbids text and logos; carries the brief\'s guards', () => {
    const plan = { style: 'photo', setting: 'inside a residential garage, controller and tools on the wall', timeOfDay: 'late afternoon', vantage: 'over the shoulder' };
    const p = gen.buildPrompt({ title: 'Rain Bird', keyword: 'How to run it by hand', topic: 'Turn the dial.', mode: 'blog-body', shot: 'action', avoid: 'a timer', plan, avoidDepicting: ['irrigation repair scenes'] });
    expect(p).toMatch(/\(photorealistic scene\)/);
    expect(p).toMatch(/inside a residential garage/);
    expect(p).toMatch(/late afternoon/);
    expect(p).toMatch(/Vantage: over the shoulder/);
    expect(p).toMatch(/No text, words, letters, numbers, watermarks, or logos/);
    expect(p).toMatch(/Must not depict: .*no company logos.*; .*no invented control-panel labels.*; irrigation repair scenes\./);
    // The fixed postcard is gone: no "palm trees, tropical landscaping, sunny afternoon" line.
    expect(p).not.toMatch(/palm trees, tropical landscaping, sunny afternoon/);
    expect(p).toMatch(/do not fill the frame with palms and a tile roof/);
  });

  test('every style forbids text and logos', () => {
    for (const style of ['photo', 'cartoon', 'illustration']) {
      const p = gen.buildPrompt({ title: 'T', keyword: 'K', mode: 'blog-hero', plan: { style, setting: 's', timeOfDay: 't', vantage: 'v' } });
      expect(p).toMatch(/No text, words, letters, numbers, watermarks, or logos/);
    }
  });

  test('no plan → the legacy prompt shape (callers that pass none keep their old picture)', () => {
    const p = gen.buildPrompt({ title: 'Pest Control Bradenton', city: 'Bradenton', mode: 'blog-hero' });
    expect(p).toMatch(/Bradenton-area home or yard with characteristic SWFL landscaping/);
    expect(p).toMatch(/Must not depict: .*no company logos/);
  });

  test('alt text names the style AND the planned setting so it describes the picture that was asked for', () => {
    const plan = { style: 'cartoon', setting: 'inside a residential garage, controller and tools on the wall', timeOfDay: 'dusk', vantage: 'eye level' };
    const alt = gen.buildAltText({ title: 'T', keyword: 'K', city: 'Venice', mode: 'blog-hero', plan });
    expect(alt).toMatch(/^Cartoon illustration of inside a residential garage, dusk, at a Venice-area Southwest Florida home, illustrating K\./);
    expect(alt).not.toMatch(/palm trees/);
    expect(gen.buildAltText({ title: 'T', keyword: 'K', mode: 'blog-hero' })).toMatch(/^Photorealistic scene of a sunny Southwest Florida home with palm trees/);
  });

  test('the request timeout is long enough for gpt-image-2 (was 60 s: every image fell to gpt-image-1.5)', () => {
    expect(gen.IMAGE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});

// ── A cast for every planned picture (owner 2026-11-19) ──────────────

const YARD_SUBJECT = 'Chinch bug damage in a St. Augustine lawn';
const slotPlan = (slug, slot, extra = {}) => gen.planFor({ slug, mode: slot ? 'blog-body' : 'blog-hero', index: slot, subject: YARD_SUBJECT, ...extra });
const slugsOf = (n) => Array.from({ length: n }, (_, i) => `section-${i % 7}/post-${i}-${(i * 7919) % 1000}`);

describe('planFor cast', () => {
  test('a post shows at most one technician across hero, body-1 and body-2; about one hero in four', () => {
    const slugs = slugsOf(400);
    let techHeroes = 0;
    let techPictures = 0;
    for (const slug of slugs) {
      const casts = [0, 1, 2].map((slot) => slotPlan(slug, slot).cast);
      expect(casts.filter((c) => c === 'technician').length).toBeLessThanOrEqual(1);
      for (const c of casts) expect(['technician', 'homeowner', 'none']).toContain(c);
      if (casts[0] === 'technician') techHeroes += 1;
      techPictures += casts.filter((c) => c === 'technician').length;
    }
    expect(techHeroes / slugs.length).toBeGreaterThanOrEqual(0.15);
    expect(techHeroes / slugs.length).toBeLessThanOrEqual(0.35);
    expect(techPictures / (slugs.length * 3)).toBeLessThan(0.3); // 3 posts in 4 show one technician: a quarter of pictures
  });

  test('the van shows in at most 12% of yard pictures and never twice in one post', () => {
    const slugs = slugsOf(400);
    let vans = 0;
    for (const slug of slugs) {
      const plans = [0, 1, 2].map((slot) => slotPlan(slug, slot));
      const n = plans.filter((p) => p.van).length;
      expect(n).toBeLessThanOrEqual(1);
      vans += n;
    }
    expect(vans / (slugs.length * 3)).toBeLessThanOrEqual(0.12);
    expect(vans).toBeGreaterThan(0);
    // An indoor subject never gets a van.
    for (const slug of slugs.slice(0, 80)) {
      expect([0, 1, 2].every((slot) => !gen.planFor({ slug, mode: slot ? 'blog-body' : 'blog-hero', index: slot, subject: 'German cockroaches in the kitchen' }).van)).toBe(true);
    }
  });

  test('a near-duplicate retry (index + 100) and a screen retry (index + 1000) keep the slot\'s cast and style; the scene seed may change', () => {
    for (const slug of slugsOf(120)) {
      for (const slot of [1, 2]) {
        const base = slotPlan(slug, slot);
        for (const index of [slot + 100, slot + 1000, slot + 1100]) {
          const retry = gen.planFor({ slug, mode: 'blog-body', index, subject: YARD_SUBJECT });
          expect(retry.cast).toBe(base.cast);
          expect(retry.style).toBe(base.style);
          expect(retry.van).toBe(base.van);
        }
      }
      const hero = slotPlan(slug, 0);
      const heroRetry = gen.planFor({ slug, mode: 'blog-hero', index: 1000, subject: YARD_SUBJECT });
      expect(heroRetry.cast).toBe(hero.cast);
      expect(heroRetry.style).toBe(hero.style);
    }
    // A fresh scene on retry: across many slugs the setting or time changes for some.
    const changed = slugsOf(60).filter((slug) => {
      const a = slotPlan(slug, 1);
      const b = gen.planFor({ slug, mode: 'blog-body', index: 101, subject: YARD_SUBJECT });
      return a.setting !== b.setting || a.timeOfDay !== b.timeOfDay;
    });
    expect(changed.length).toBeGreaterThan(20);
  });

  test('an identification post never gets a people-free picture, and the plan carries the flag', () => {
    const slugs = slugsOf(300);
    let nonId = 0;
    for (const slug of slugs) {
      for (const slot of [0, 1, 2]) {
        const plan = slotPlan(slug, slot, { identification: true });
        expect(plan.cast).not.toBe('none');
        expect(plan.identification).toBe(true);
        if (slotPlan(slug, slot).cast === 'none') nonId += 1;
      }
    }
    expect(nonId).toBeGreaterThan(0); // the same slots are people-free on a normal post
    expect(slotPlan('x', 0).identification).toBe(false);
  });

  test('the cast mix on a normal post is mostly empty scenes with some homeowners', () => {
    const tally = { technician: 0, homeowner: 0, none: 0 };
    for (const slug of slugsOf(400)) for (const slot of [0, 1, 2]) tally[slotPlan(slug, slot).cast] += 1;
    const total = tally.technician + tally.homeowner + tally.none;
    expect(tally.none / total).toBeGreaterThan(0.4);
    expect(tally.homeowner / total).toBeGreaterThan(0.15);
  });
});

describe('buildPrompt cast', () => {
  const PLAN = { style: 'photo', setting: 'in a backyard, dew on the grass', timeOfDay: 'noon', vantage: 'eye level', van: false };
  const prompt = (cast, extra = {}, args = {}) => gen.buildPrompt({ title: 'Roof rats', keyword: 'Roof rats', mode: 'blog-hero', plan: { ...PLAN, cast, ...extra }, ...args });

  test('cast none: no people at all and no uniform clause', () => {
    const p = prompt('none');
    expect(p).toContain('People: none.');
    expect(p).toContain(gen.NO_PEOPLE_CAST_LINE);
    expect(p).not.toContain('TECHNICIAN:');
    expect(p).not.toContain('If a Waves technician appears');
    expect(p).not.toContain("a technician's red shirt or red cap is part of the palette");
    expect(p).not.toContain(gen.IDENTIFICATION_NO_PEST_CLOSEUP_LINE);
    // The logo reference clause set never leaks the technician in either.
    expect(prompt('none', {}, { uniformLogo: false })).not.toMatch(/Waves logo/);
  });

  test('cast homeowner: ordinary clothes, no technician clause', () => {
    const p = prompt('homeowner');
    expect(p).toContain(gen.HOMEOWNER_CAST_LINE);
    expect(p).toContain('People: one adult homeowner in ordinary casual clothes');
    expect(p).not.toContain('TECHNICIAN:');
    expect(p).not.toContain('If a Waves technician appears');
  });

  test('cast technician: one technician line, then the existing uniform clause as before', () => {
    const plain = prompt('technician');
    expect(plain).toContain(`${gen.TECHNICIAN_CAST_LINE} ${gen.WAVES_UNIFORM_LINE}`);
    expect(plain).toContain('People: exactly one Waves technician in the scene, and no other uniformed worker.');
    const logo = prompt('technician', {}, { uniformLogo: true });
    expect(logo).toContain(`${gen.TECHNICIAN_CAST_LINE} ${gen.WAVES_UNIFORM_LOGO_LINE}`);
  });

  test('an identification post adds the no-pest-close-up sentence whatever the cast; other posts never carry it', () => {
    for (const cast of ['technician', 'homeowner', 'none']) {
      expect(prompt(cast, { identification: true })).toContain(gen.IDENTIFICATION_NO_PEST_CLOSEUP_LINE);
      expect(prompt(cast)).not.toContain(gen.IDENTIFICATION_NO_PEST_CLOSEUP_LINE);
    }
    // The technician picture keeps its uniform clause in front of the restriction.
    expect(prompt('technician', { identification: true })).toContain(`${gen.TECHNICIAN_CAST_LINE} `);
  });

  test('a people-free picture never gets the over-the-shoulder vantage, first try or retry; other casts keep the full list', () => {
    const seen = new Set();
    for (const slug of slugsOf(400)) {
      for (const index of [0, 1, 2, 101, 1000, 1002]) {
        const plan = gen.planFor({ slug, mode: index % 1000 === 0 ? 'blog-hero' : 'blog-body', index, subject: YARD_SUBJECT });
        if (plan.cast === 'none') expect(plan.vantage).not.toBe('over the shoulder');
        else seen.add(plan.vantage);
      }
    }
    expect(seen.has('over the shoulder')).toBe(true);
  });

  test('body action framing agrees with the cast', () => {
    const framing = (cast) => gen.buildPrompt({ keyword: 'Sealing the vents', topic: 'lead', mode: 'blog-body', shot: 'action', plan: { ...PLAN, cast } });
    expect(framing('technician')).toContain('Framing: the Waves technician actively doing what this section describes');
    // A homeowner only observes: "doing what this section describes" would show a
    // homeowner in casual clothes applying a treatment on a treatment section.
    expect(framing('homeowner')).toContain('Framing: a homeowner looking closely at what this section describes');
    expect(framing('homeowner')).not.toMatch(/homeowner actively doing/);
    for (const mode of ['blog-hero', 'blog-body']) {
      expect(gen.buildPrompt({ keyword: 'Applying the treatment', mode, shot: 'action', plan: { ...PLAN, cast: 'homeowner' } }))
        .toContain('they never apply a pesticide or any other product, hold a sprayer, or do a treatment');
    }
    expect(framing('none')).toContain('Framing: the task this section describes caught mid-way — the tools and materials in place where the work happens, no person in frame.');
    expect(framing('none')).not.toMatch(/Framing: a person/);
    // Other shots are unchanged by the cast.
    const close = gen.buildPrompt({ keyword: 'k', mode: 'blog-body', shot: 'close-up', plan: { ...PLAN, cast: 'none' } });
    expect(close).toContain(gen.BODY_IMAGE_FRAMING['close-up']);
  });

  test('the no-drawn-marks sentence rides on blog-hero and blog-body, not social-square', () => {
    for (const mode of ['blog-hero', 'blog-body']) {
      expect(gen.buildPrompt({ title: 'T', keyword: 'K', mode, plan: { ...PLAN, cast: 'none' } })).toContain(gen.NO_DRAWN_MARKS_LINE);
      expect(gen.buildPrompt({ title: 'T', keyword: 'K', mode })).toContain(gen.NO_DRAWN_MARKS_LINE);
    }
    expect(gen.NO_DRAWN_MARKS_LINE).toBe('Show one real scene with nothing drawn over it: no check marks, crosses, prohibition signs, arrows, callout bubbles, magnified insets, split panels or before-and-after comparisons — the picture states no verdict.');
    expect(gen.buildPrompt({ title: 'T', keyword: 'K', mode: 'social-square' })).not.toContain('nothing drawn over it');
    expect(gen.buildPrompt({ title: 'T', keyword: 'K', mode: 'social-square', plan: { ...PLAN, cast: 'none' } })).not.toContain('nothing drawn over it');
  });

  // Prompts captured from origin/main (before the cast change) for callers
  // that pass no plan. Social tiles and the newsletter must not change; the
  // blog modes differ only by the appended no-drawn-marks sentence.
  const LEGACY_SOCIAL = "A high-quality, photorealistic social media tile for a Southwest Florida pest control & lawn care business named \"Waves Pest Control.\" Subject: Fire ants. Setting: a Bradenton-area home or yard with characteristic SWFL landscaping (palm trees, sandy soil, bright sun). If a Waves technician appears, they wear the real Waves uniform: a solid red long-sleeve polo (a small blank badge on the left chest is fine), a baseball cap that is either light blue or red, and plain black or dark navy work pants — never a blue shirt, never khaki or tan pants; shirt and cap carry no readable logo or lettering. Composition: square 1:1 aspect ratio, 1024x1024. Style: bright, clean, professional. Sunny coastal light with a deep-blue sky and warm golden accents (brand palette: blue #009CDE, gold #FFD700 — no teal color cast). No text, words, letters, numbers, watermarks, or logos anywhere in the image. Must not depict: no company logos, brand names, or brand marks of any kind — equipment and vehicles are generic and unbranded, and uniforms carry no logo or lettering (only the uniform COLORS follow the Waves uniform line); no invented control-panel labels, dials with fake words, or gibberish lettering.";
  const LEGACY_BODY = "A high-quality, photorealistic in-article illustration for a Southwest Florida pest control & lawn care business named \"Waves Pest Control.\" Subject: k. Context from the article: lead Setting: SWFL residential — palm trees, tropical landscaping, sunny afternoon. Framing: a person (a technician or homeowner) actively doing what this section describes — hands visible, mid-task, candid documentary feel. If a Waves technician appears, they wear the real Waves uniform: a solid red long-sleeve polo (a small blank badge on the left chest is fine), a baseball cap that is either light blue or red, and plain black or dark navy work pants — never a blue shirt, never khaki or tan pants; shirt and cap carry no readable logo or lettering. Composition: landscape 3:2 aspect ratio, 1536x1024. Style: bright, clean, professional. Sunny coastal light with a deep-blue sky and warm golden accents (brand palette: blue #009CDE, gold #FFD700 — no teal color cast). No text, words, letters, numbers, watermarks, or logos anywhere in the image. Must not depict: no company logos, brand names, or brand marks of any kind — equipment and vehicles are generic and unbranded, and uniforms carry no logo or lettering (only the uniform COLORS follow the Waves uniform line); no invented control-panel labels, dials with fake words, or gibberish lettering. This image must look clearly different from the article's hero image (a wide establishing shot of: a timer) — a different scene, distance and angle, not a variation of it. Editorial image content: depict the specific observation or step in the supplied article context. Do not invent measured results, charts, percentages, before-and-after outcomes, or diagnostic features. Source organizations mentioned in the context are attribution, not image subjects: never reproduce their logos, seals, badges, or imply endorsement. Keep anatomy and relative scale plausible; do not exaggerate pests or damage for drama. Prefer an explanatory view of the relevant condition or task over a generic technician pose.";
  const LEGACY_HERO = "A high-quality, photorealistic blog hero image for a Southwest Florida pest control & lawn care business named \"Waves Pest Control.\" Subject: Post. Setting: SWFL residential — palm trees, tropical landscaping, sunny afternoon. If a Waves technician appears, they wear the real Waves uniform: a solid red long-sleeve polo (a small blank badge on the left chest is fine), a baseball cap that is either light blue or red, and plain black or dark navy work pants — never a blue shirt, never khaki or tan pants; shirt and cap carry no readable logo or lettering. Composition: landscape 3:2 aspect ratio, 1536x1024. Style: bright, clean, professional. Sunny coastal light with a deep-blue sky and warm golden accents (brand palette: blue #009CDE, gold #FFD700 — no teal color cast). No text, words, letters, numbers, watermarks, or logos anywhere in the image. Must not depict: no company logos, brand names, or brand marks of any kind — equipment and vehicles are generic and unbranded, and uniforms carry no logo or lettering (only the uniform COLORS follow the Waves uniform line); no invented control-panel labels, dials with fake words, or gibberish lettering. Editorial image content: depict the specific observation or step in the supplied article context. Do not invent measured results, charts, percentages, before-and-after outcomes, or diagnostic features. Source organizations mentioned in the context are attribution, not image subjects: never reproduce their logos, seals, badges, or imply endorsement. Keep anatomy and relative scale plausible; do not exaggerate pests or damage for drama. Prefer an explanatory view of the relevant condition or task over a generic technician pose.";
  test('a call with no plan builds the same prompt as before (social tiles and legacy callers)', () => {
    expect(gen.buildPrompt({ title: 'Pest Control Bradenton', city: 'Bradenton', mode: 'social-square', keyword: 'Fire ants' })).toBe(LEGACY_SOCIAL);
    expect(gen.buildPrompt({ title: 'Post', keyword: 'k', topic: 'lead', mode: 'blog-body', shot: 'action', avoid: 'a timer' })).toBe(`${LEGACY_BODY} ${gen.NO_DRAWN_MARKS_LINE}`);
    expect(gen.buildPrompt({ title: 'Post', mode: 'blog-hero' })).toBe(`${LEGACY_HERO} ${gen.NO_DRAWN_MARKS_LINE}`);
  });
});

describe('screenGeneratedImage', () => {
  const buffer = Buffer.from('fake-image');
  beforeEach(() => jest.clearAllMocks());

  test('clean image passes', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": [], "notes": "a hand on a dial"}' });
    const r = await screenGeneratedImage({ buffer });
    expect(r).toMatchObject({ ok: true, checked: true, reasons: [] });
    expect(dispatchWithFallback.mock.calls[0][0]).toBe('imageScreen');
    expect(dispatchWithFallback.mock.calls[0][1].images[0].data).toBe(buffer.toString('base64'));
    // The caller's remaining slot time bounds the vision chain; a spent deadline skips the screen (Codex r7 P2 on #3964).
    expect(dispatchWithFallback.mock.calls[0][1].timeoutMs).toBeUndefined();
    await screenGeneratedImage({ buffer, timeoutMs: 42_000 });
    expect(dispatchWithFallback.mock.calls[1][1].timeoutMs).toBe(42_000);
    dispatchWithFallback.mockClear();
    expect(await screenGeneratedImage({ buffer, timeoutMs: 0 })).toMatchObject({ ok: true, checked: false });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a logo fails and every readable string fails: no caption can be allowed (the AI infographic is retired, owner 2026-11-19)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '```json\n{"readable_text": ["ORKIN"], "logos_or_brand_marks": ["Orkin logo on truck"], "notes": ""}\n```' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/logo or brand mark: Orkin/), expect.stringMatching(/readable text: ORKIN/)], violations: 2 });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["SET TIME", "ZONE 5 RUN"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/readable text: SET TIME, ZONE 5 RUN/)], violations: 2 });
    // A caption list a caller still passes changes nothing: the string is stray text and the prompt allows none.
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["How to Stop Ants"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['How to Stop Ants'] })).toMatchObject({ ok: false, reasons: ['readable text: How to Stop Ants'], violations: 1 });
    expect(buildScreenPrompt({ allowedText: ['1 OFF'] })).not.toMatch(/ALLOWED|1 OFF/);
  });

  test('a brief exclusion the provider ignored fails the screen; only exclusions the caller named count (Codex r8 P2 on #3964)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": [], "forbidden_scenes": ["irrigation repair scenes", "a made-up item"]}' });
    const r = await screenGeneratedImage({ buffer, avoidDepicting: ['irrigation repair scenes'] });
    expect(r).toMatchObject({ ok: false, forbidden: ['irrigation repair scenes'], reasons: [expect.stringMatching(/forbidden scene: irrigation repair scenes/)] });
    expect(dispatchWithFallback.mock.calls.at(-1)[1].text).toMatch(/FORBIDDEN .*1\. "irrigation repair scenes"/);
    // Without exclusions the field is ignored entirely.
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, forbidden: [] });
  });

  test('a detection counts as its exclusion by id, exact text, or paraphrase — never by invention (Codex r12 P2 on #3964)', async () => {
    const avoidDepicting = ['irrigation repair scenes', 'a competitor\'s branded vehicle'];
    const run = async (forbidden) => {
      dispatchWithFallback.mockResolvedValue({ ok: true, text: JSON.stringify({ readable_text: [], logos_or_brand_marks: [], forbidden_scenes: forbidden }) });
      return screenGeneratedImage({ buffer, avoidDepicting });
    };
    expect(await run([2])).toMatchObject({ ok: false, forbidden: ['a competitor\'s branded vehicle'], violations: 1 });
    expect(await run(['an irrigation repair scene'])).toMatchObject({ ok: false, forbidden: ['irrigation repair scenes'] });
    expect(await run(['Irrigation Repair Scenes', 1])).toMatchObject({ ok: false, forbidden: ['irrigation repair scenes'], violations: 1 });
    // A quoted id is the id (Codex r13 P2 on #3964).
    expect(await run(['2', ' 1 '])).toMatchObject({ ok: false, forbidden: ['a competitor\'s branded vehicle', 'irrigation repair scenes'], violations: 2 });
    expect(await run([3, 0, 'a lawn mower', 'repair'])).toMatchObject({ ok: true, forbidden: [] });
  });

  test('with exclusions active, a missing or scalar forbidden_scenes is an unusable answer, not a clean verdict (Codex r9 P2 on #3964)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, avoidDepicting: ['irrigation repair scenes'] })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": [], "forbidden_scenes": "irrigation repair scenes"}' });
    expect(await screenGeneratedImage({ buffer, avoidDepicting: ['irrigation repair scenes'] })).toMatchObject({ ok: true, checked: false });
    expect(parseScreen('{"readable_text": [], "logos_or_brand_marks": []}', { requireForbidden: true })).toBeNull();
    // The same answer without exclusions is a checked, clean screen.
    expect(await screenGeneratedImage({ buffer, avoidDepicting: [] })).toMatchObject({ ok: true, checked: true });
  });

  test('fails open on a vision miss, unusable output, or a throw', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: 'not json' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockRejectedValue(new Error('boom'));
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    expect(await screenGeneratedImage({ buffer: null })).toMatchObject({ ok: true, checked: false });
    // A scalar or missing list is an unusable answer, not a clean verdict (Codex r1 P2 on #3964).
    expect(parseScreen('{"readable_text": "x"}')).toBeNull();
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": "ORKIN", "logos_or_brand_marks": "Orkin logo"}' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
  });
});
