const adminDispatchRouter = require('../routes/admin-dispatch');

const {
  lawnAssessmentCompletionBlockPayload,
  preflightLawnAssessmentCompletion,
} = adminDispatchRouter._test;

function fakeAssessmentKnex(firstResult) {
  const builder = {
    where: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    first: jest.fn(() => (
      firstResult instanceof Error
        ? Promise.reject(firstResult)
        : Promise.resolve(firstResult)
    )),
  };
  return jest.fn(() => builder);
}

describe('admin dispatch lawn assessment completion guard', () => {
  test('does not block non-lawn or incomplete visits', () => {
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'pest',
      unconfirmedAssessment: { id: 'assessment-1' },
    })).toBeNull();
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      isIncompleteVisit: true,
      unconfirmedAssessment: { id: 'assessment-1' },
    })).toBeNull();
  });

  test('blocks submitted assessment ids that are missing or unconfirmed', () => {
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      lawnAssessmentId: 'missing-assessment',
      submittedAssessment: null,
    })).toMatchObject({
      status: 400,
      payload: {
        code: 'lawn_assessment_not_found',
        lawnAssessmentId: 'missing-assessment',
      },
    });

    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      lawnAssessmentId: 'assessment-1',
      submittedAssessment: { id: 'assessment-1', confirmed_by_tech: false },
    })).toMatchObject({
      status: 400,
      payload: {
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: 'assessment-1',
      },
    });
  });

  test('blocks latest unconfirmed drafts when no assessment id is submitted', () => {
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      latestAssessment: { id: 'draft-assessment', confirmed_by_tech: false },
    })).toMatchObject({
      status: 400,
      payload: {
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: 'draft-assessment',
      },
    });
  });

  test('blocks an unconfirmed retake even when an older confirmed assessment exists', () => {
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      latestAssessment: { id: 'retake-assessment', confirmed_by_tech: false },
    })).toMatchObject({
      status: 400,
      payload: {
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: 'retake-assessment',
      },
    });
  });

  test('blocks a submitted older confirmed assessment when the latest retake is unconfirmed', () => {
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      lawnAssessmentId: 'confirmed-assessment',
      submittedAssessment: { id: 'confirmed-assessment', confirmed_by_tech: true },
      latestAssessment: { id: 'retake-assessment', confirmed_by_tech: false },
    })).toMatchObject({
      status: 400,
      payload: {
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: 'retake-assessment',
      },
    });
  });

  test('blocks a submitted older confirmed assessment when a newer confirmed retake exists', () => {
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      lawnAssessmentId: 'confirmed-assessment',
      submittedAssessment: { id: 'confirmed-assessment', confirmed_by_tech: true },
      latestAssessment: { id: 'retake-assessment', confirmed_by_tech: true },
    })).toMatchObject({
      status: 409,
      payload: {
        code: 'lawn_assessment_stale',
        lawnAssessmentId: 'retake-assessment',
      },
    });
  });

  test('allows completion when a confirmed assessment is present', () => {
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      latestAssessment: { id: 'confirmed-assessment', confirmed_by_tech: true },
    })).toBeNull();
    expect(lawnAssessmentCompletionBlockPayload({
      reportServiceLine: 'lawn',
      lawnAssessmentId: 'confirmed-assessment',
      submittedAssessment: { id: 'confirmed-assessment', confirmed_by_tech: true },
    })).toBeNull();
  });

  test('fails closed when the latest assessment lookup fails', async () => {
    await expect(preflightLawnAssessmentCompletion({
      knex: fakeAssessmentKnex(new Error('assessment lookup failed')),
      serviceId: 'service-1',
      customerId: 'customer-1',
      reportServiceLine: 'lawn',
    })).rejects.toThrow('assessment lookup failed');
  });
});
