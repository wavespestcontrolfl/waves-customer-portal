const { escapeBareXmlEntities } = require('../services/event-ingestion');

describe('escapeBareXmlEntities', () => {
  test('escapes a bare ampersand (the Gabber "Invalid character in entity name" failure)', () => {
    expect(escapeBareXmlEntities('<title>Rock & Roll Night</title>'))
      .toBe('<title>Rock &amp; Roll Night</title>');
  });

  test('escapes bare & in query-string URLs', () => {
    expect(escapeBareXmlEntities('<link>https://x.com/?a=1&b=2</link>'))
      .toBe('<link>https://x.com/?a=1&amp;b=2</link>');
  });

  test('leaves valid named, decimal, and hex entities untouched', () => {
    const xml = '<t>Fish &amp; Chips &#8217; caf&eacute; &#x2019;</t>';
    expect(escapeBareXmlEntities(xml)).toBe(xml);
  });

  test('escapes & with no terminating semicolon; leaves entity-shaped refs alone', () => {
    // "&T;" is entity-shaped so the conservative lookahead skips it (sax
    // accepts unknown-but-well-formed refs); "&euro" without a semicolon is
    // the malformed case that kills the parse and must be escaped.
    expect(escapeBareXmlEntities('<t>AT&T; costs 5 &euro</t>'))
      .toBe('<t>AT&T; costs 5 &amp;euro</t>');
  });
});
