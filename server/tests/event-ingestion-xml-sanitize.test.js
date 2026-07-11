const { escapeBareXmlEntities, decodeXmlBody } = require('../services/event-ingestion');

describe('escapeBareXmlEntities', () => {
  test('escapes a bare ampersand (the Gabber "Invalid character in entity name" failure)', () => {
    expect(escapeBareXmlEntities('<title>Rock & Roll Night</title>'))
      .toBe('<title>Rock &amp; Roll Night</title>');
  });

  test('escapes bare & in query-string URLs', () => {
    expect(escapeBareXmlEntities('<link>https://x.com/?a=1&b=2</link>'))
      .toBe('<link>https://x.com/?a=1&amp;b=2</link>');
  });

  test('leaves the five predefined entities and numeric references untouched', () => {
    const xml = '<t>Fish &amp; Chips &lt;now&gt; &quot;hot&quot; &apos;yes&apos; &#8217; &#x2019;</t>';
    expect(escapeBareXmlEntities(xml)).toBe(xml);
  });

  test('escapes entity-SHAPED refs sax cannot resolve ("AT&T;", "&nbsp;") — they killed the parse too', () => {
    expect(escapeBareXmlEntities('<t>AT&T; costs 5 &euro and&nbsp;more</t>'))
      .toBe('<t>AT&amp;T; costs 5 &amp;euro and&amp;nbsp;more</t>');
  });

  test('never rewrites CDATA contents (parsers do not expand entities there)', () => {
    const xml = '<title><![CDATA[Rock & Roll ?a=1&b=2]]></title><desc>Tea & Co</desc>';
    expect(escapeBareXmlEntities(xml))
      .toBe('<title><![CDATA[Rock & Roll ?a=1&b=2]]></title><desc>Tea &amp; Co</desc>');
  });

  test('handles multiple CDATA sections with bare & between them', () => {
    const xml = '<a><![CDATA[x & y]]></a> & <b><![CDATA[p&q]]></b>';
    expect(escapeBareXmlEntities(xml))
      .toBe('<a><![CDATA[x & y]]></a> &amp; <b><![CDATA[p&q]]></b>');
  });
});

describe('decodeXmlBody', () => {
  test('decodes with the Content-Type charset (ISO-8859-1 café)', () => {
    const buf = Buffer.from('<t>caf\xe9</t>', 'latin1');
    expect(decodeXmlBody(buf, 'application/rss+xml; charset=ISO-8859-1')).toBe('<t>café</t>');
  });

  test('falls back to the XML prolog encoding when the header has no charset', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><t>caf\xe9</t>', 'latin1');
    expect(decodeXmlBody(buf, 'application/rss+xml')).toBe('<?xml version="1.0" encoding="ISO-8859-1"?><t>café</t>');
  });

  test('defaults to UTF-8 with no declaration anywhere', () => {
    const buf = Buffer.from('<t>café</t>', 'utf8');
    expect(decodeXmlBody(buf, null)).toBe('<t>café</t>');
  });

  test('unknown charset label falls back to UTF-8 instead of throwing', () => {
    const buf = Buffer.from('<t>ok</t>', 'utf8');
    expect(decodeXmlBody(buf, 'text/xml; charset=bogus-charset')).toBe('<t>ok</t>');
  });
});
