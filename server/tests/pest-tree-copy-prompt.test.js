const { TREE_SHRUB_MAIN_REPORT_PROMPT, RECURRING_PEST_MAIN_REPORT_PROMPT } = require('../services/service-report/pest-tree-copy-prompt');

describe('pest/tree main report prompt modules', () => {
  test('tree/shrub preserves plant, method, scope, and provenance boundaries', () => {
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Foliar spray, root injection, soil drench, and trunk injection are distinct');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('same product recorded with different methods represents separate work');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Reviewed photo signals remain separate unconfirmed context');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Missing data is unknown');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Return exactly the existing WHAT WE DID / WHAT WE FOUND');
  });

  test('recurring pest keeps observations distinct from labeled capability', () => {
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('Missing pressure is not zero');
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).not.toContain('without repeating its numeric score');
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('also helps control other labeled crawling pests in the treated areas');
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('Never total overlapping lists or state a numeric coverage count');
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('Never imply termite protection or a bond, rodent service, mosquito service');
  });

});
