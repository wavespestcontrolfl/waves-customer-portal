// classifyPhotoDiagnosisIntent — the photo-text sibling of the lead-intake
// service-intent classifier: regex fast path first, Claude FAST only for a
// caption the regex cannot place.
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  classifyPhotoDiagnosisIntent,
  classifyServiceIntent,
  TREE_SHRUB_TRIAGE_TYPE,
} = require('../services/sms-service-intent');

beforeEach(() => mockDispatch.mockReset());

describe('regex fast path', () => {
  test.each([
    // An empty caption with a photo is a show-and-ask.
    ['', 'pest'],
    [null, 'pest'],
    ['   ', 'pest'],
    ['what is this in my lawn?', 'lawn'],
    ['Brown patches all over the grass', 'lawn'],
    ['weeds taking over the yard', 'lawn'],
    ['fungus spreading on the turf', 'lawn'],
    ['found these bugs in the kitchen', 'pest'],
    ['what are these, termites?', 'pest'],
    ['ants everywhere', 'pest'],
    // A tie between lawn and pest words runs the pest identifier.
    ['bugs in my lawn eating it', 'pest'],
    ['seeing bugs all over the lawn', 'pest'],
    ['whats this', 'pest'],
    ["what's wrong with it", 'pest'],
    ['can you tell what this is', 'pest'],
    ['mushrooms popping up', 'pest'],
  ])('%p → photo_diagnosis / %s with no model call', async (body, type) => {
    await expect(classifyPhotoDiagnosisIntent(body)).resolves.toEqual({
      intent: 'photo_diagnosis', assessmentType: type, method: 'regex',
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('tree/shrub words route to their own assessment type', async () => {
    expect(TREE_SHRUB_TRIAGE_TYPE).toBe('tree_shrub');
    const result = await classifyPhotoDiagnosisIntent('what is wrong with my palm tree leaves');
    expect(result).toEqual({ intent: 'photo_diagnosis', assessmentType: TREE_SHRUB_TRIAGE_TYPE, method: 'regex' });
    // Tree words outvote a single lawn word (lawn must strictly outnumber
    // the combined pest + tree/shrub words to win).
    await expect(classifyPhotoDiagnosisIntent('shrubs and bushes next to the lawn are dying'))
      .resolves.toMatchObject({ assessmentType: TREE_SHRUB_TRIAGE_TYPE });
    // Any pest word alongside plant words runs the pest identifier.
    await expect(classifyPhotoDiagnosisIntent('found a bug on my plant'))
      .resolves.toMatchObject({ assessmentType: 'pest' });
  });

  // codex #4810 r1: every pest class the classifier prompt names (spider,
  // rodent...) and the common sightings must count as pest words, or a
  // mixed caption fast-paths to a plant-health assessment.
  test.each([
    'what is this spider on my plant?',
    'found a beetle eating my shrub leaves',
    'what are these mealybugs on the hibiscus bush',
    'what kind of caterpillar is this on my tree',
    'rat droppings under the palm',
  ])('mixed plant-and-pest caption %p runs the pest identifier', async (body) => {
    await expect(classifyPhotoDiagnosisIntent(body)).resolves.toMatchObject({ assessmentType: 'pest', method: 'regex' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test.each([
    'Attached is my receipt for lawn service',
    'Here is the gate code for the yard',
    'Lawn guy can come Tuesday',
    'Photo of the pest control invoice',
    // Ordinary questions and paperwork/scheduling captions, even with a
    // subject word or an identification phrase, are the model's call.
    'Can you tell me when lawn service is scheduled?',
    'Is this the lawn invoice you need?',
    'What is this charge on my invoice?',
    'Brown spots in the lawn, can you come out tomorrow',
    'are these termites',
  ])('not fast-pathed: %p goes to the model', async (body) => {
    mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'none' } });
    await expect(classifyPhotoDiagnosisIntent(body)).resolves.toEqual({ intent: null, assessmentType: null, method: 'ai' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('subject words need a word boundary ("want", "giant", "plantation" do not match)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'none' } });
    await expect(classifyPhotoDiagnosisIntent('I want the giant plantation shutters quote'))
      .resolves.toEqual({ intent: null, assessmentType: null, method: 'ai' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('Claude FAST fallback', () => {
  test('an unplaced caption asks the sms_intent lane with the structured schema', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'lawn' } });
    await expect(classifyPhotoDiagnosisIntent('Look at this mess by the driveway'))
      .resolves.toEqual({ intent: 'photo_diagnosis', assessmentType: 'lawn', method: 'ai' });
    const [, request] = mockDispatch.mock.calls[0];
    expect(request).toMatchObject({ laneId: 'sms_intent', jsonMode: true });
    expect(request.jsonSchema.properties.subject.enum).toEqual(['lawn', 'pest', 'tree_shrub', 'none']);
  });

  test('tree_shrub from the model maps to its own assessment type', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'tree_shrub' } });
    await expect(classifyPhotoDiagnosisIntent('Look at this by the driveway'))
      .resolves.toMatchObject({ intent: 'photo_diagnosis', assessmentType: TREE_SHRUB_TRIAGE_TYPE });
  });

  test.each([
    ['none', { ok: true, json: { subject: 'none' } }],
    ['an unknown subject', { ok: true, json: { subject: 'gate_code' } }],
    ['a failed dispatch', { ok: false }],
  ])('%s is not a diagnosis', async (_label, response) => {
    mockDispatch.mockResolvedValue(response);
    await expect(classifyPhotoDiagnosisIntent('Here is my gate code sticker'))
      .resolves.toEqual({ intent: null, assessmentType: null, method: 'ai' });
  });

  test('allowModel is asked only when the regex misses; a "no" skips the model', async () => {
    const allowModel = jest.fn(async () => false);
    await expect(classifyPhotoDiagnosisIntent('Look at this by the driveway', { allowModel }))
      .resolves.toEqual({ intent: null, assessmentType: null, method: 'none' });
    expect(allowModel).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    await classifyPhotoDiagnosisIntent('what is this in my lawn?', { allowModel });
    expect(allowModel).toHaveBeenCalledTimes(1);
  });

  test('a thrown dispatch is not a diagnosis and never throws', async () => {
    mockDispatch.mockRejectedValue(new Error('provider down'));
    await expect(classifyPhotoDiagnosisIntent('Here is my receipt'))
      .resolves.toEqual({ intent: null, assessmentType: null, method: 'ai' });
  });
});

test('the lead-intake classifier is unchanged', async () => {
  await expect(classifyServiceIntent('need lawn care')).resolves.toEqual({ interest: 'lawn', confidence: 0.9, method: 'regex' });
  await expect(classifyServiceIntent('ants in the kitchen')).resolves.toEqual({ interest: 'pest', confidence: 0.9, method: 'regex' });
});
