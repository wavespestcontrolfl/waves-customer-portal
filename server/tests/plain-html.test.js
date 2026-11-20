const { plainPage, htmlText } = require('../services/prospects/plain-html');

const TAGS = new Set(['b', 'br', 'html', 'table', 'td', 'tr', 'u', 'wbr']);
const plain = (html) => plainPage(html, TAGS);

describe('plainPage', () => {
  test('rebuilds each tag without its attributes, keeps the text, and drops comments, doctypes, scripts, styles and the title', () => {
    expect(plain('<!DOCTYPE html><HTML><title>A <td>t</td></title><style>td { x: "</td>" }</style>'
      + '<TABLE border=1><tr class="r"><td>35A-02-8<td>Live roaches.</table><!-- <td>c</td> --></html>'))
      .toBe('<html><table><tr><td>35A-02-8<td>Live roaches.</table></html>');
  });

  test('a ">" inside a quoted attribute value stays in the value; an unquoted value runs to white space or ">"', () => {
    expect(plain('<td title="count > 1">A</td><td title=\'<tr>\'>B</td>')).toBe('<td>A</td><td>B</td>');
    expect(plain('<td x=a"b>C</td>')).toBe('<td>C</td>');
  });

  test('an "=" where an attribute name or value starts is part of it, so a quote after it opens no value', () => {
    // A browser ends each of these tags at its first ">", and the rest is text.
    expect(plain('<td x=="y>">A</td>')).toBe('<td>"&gt;A</td>');
    expect(plain('<td ="y>">A</td>')).toBe('<td>"&gt;A</td>');
    expect(plain('<td x="1"="y>">A</td>')).toBe('<td>"&gt;A</td>');
  });

  test('a script ends at "</script" then white space, "/" or ">", in any case, and hides what it holds', () => {
    expect(plain('<table><script>"<tr><td>35A-02-8<td>Live roaches."</script ><tr><td>25-06-4</table>'))
      .toBe('<table><tr><td>25-06-4</table>');
    expect(plain('<script>a</SCRIPT\n><b>x</b>')).toBe('<b>x</b>');
    expect(plain('<script>a</script/><b>x</b>')).toBe('<b>x</b>');
    // "</scripts>" ends nothing: the script runs on to its own end tag.
    expect(plain('<script>a</scripts><b>x</b></script><b>y</b>')).toBe('<b>y</b>');
  });

  test('a script that holds "<script" gives null: after "<!--" it runs past its first end tag', () => {
    // A browser reads all of this as one script, to the page end: the table is script text.
    expect(plain('<script><!-- <script></script><table><tr><td>35A-02-8</table> -->')).toBeNull();
  });

  test('a comment ends as a browser ends it: "<!-->" and "<!--->" at once, any other at its first "-->" or "--!>"', () => {
    expect(plain('<!--><b>a</b>-->')).toBe('<b>a</b>--&gt;');
    expect(plain('<!---><b>a</b>-->')).toBe('<b>a</b>--&gt;');
    expect(plain('<!-- x --!><b>a</b>-->')).toBe('<b>a</b>--&gt;');
    expect(plain('<!-- <b>x</b> --><b>a</b>')).toBe('<b>a</b>');
  });

  test('"<?…>", "<![CDATA[…]]>", "</ …>" and "</>" each end at their first ">"; a "<" before anything else is text', () => {
    expect(plain('<?xml a="<b>"?><b>a</b>')).toBe('"?&gt;<b>a</b>');
    expect(plain('<![CDATA[<b>x]]><b>a</b>')).toBe('x]]&gt;<b>a</b>');
    expect(plain('</ b><b>a</b></>')).toBe('<b>a</b>');
    expect(plain('a < b, 3<5 <b>c</b>')).toBe('a &lt; b, 3&lt;5 <b>c</b>');
  });

  test('each run of text is decoded once, as a browser decodes it, then "&", "<" and ">" written back: no tag or reference is made', () => {
    expect(plain('a &lt;td&gt; &amp;lt; &#60;b> x&lt')).toBe('a &lt;td&gt; &amp;lt; &lt;b&gt; x&lt;');
    // A reference never runs past a tag or a comment: a browser shows these as "&lt; &lt; <td>".
    expect(plain('&l<b></b>t; &<!-- -->lt; <<!-- -->td>')).toBe('&amp;l<b></b>t; &amp;lt; &lt;td&gt;');
  });

  test('a tag not on the list gives null, as does a name with other characters', () => {
    for (const html of ['<span>x</span>', '<p>x</p>', '<td="x">', '<td\u00c1>x', '</title>']) expect(plain(html)).toBeNull();
  });

  test('an element that changes how a browser reads what follows it, or whose content it does not show, gives null', () => {
    const names = ['textarea', 'template', 'svg', 'math', 'select', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes',
      'plaintext', 'frameset', 'details', 'dialog', 'datalist', 'rp', 'audio', 'canvas', 'object', 'video'];
    // Even when the list allows it: a browser reads the <td> in each as text, by other rules, or not at all.
    const all = new Set([...TAGS, ...names]);
    for (const name of names) expect(plainPage(`<table><tr><${name}><td>35A-02-8</${name}></table>`, all)).toBeNull();
  });

  test('a start tag that can hide its element gives null: the hidden or popover attribute, or a style attribute that can hide', () => {
    const hiding = ['<td hidden>Callback</td>', '<td HIDDEN="">x', '<td popover>x', '<td style="display:none">x',
      '<td style="color:red; DISPLAY : none">x', '<td style="display:/**/none">x', '<td style="display&#58;none">x',
      "<td style='visibility: hidden'>x", '<td style=visibility:collapse>x', '<td style="content-visibility: hidden">x',
      // A CSS escape can spell any style ("\6e one" is "none"), and a function can stand for any value.
      '<td style="display:\\6e one">x', '<td style="--state:none; display:var(--state)">x', '<td style="content-visibility: var(--v)">x',
      // An unquoted url() keeps a "/*" as part of its address, and a quoted one is a string: neither opens a comment.
      '<td style="background:url(/icons/*/dot.png); display:none">x', "<td style='background: url(\"a)b\"); display: none'>x",
      // In an attribute, a reference without its ";" before a letter, a digit or "=" stays as written: no quote opens.
      '<td style="font-family: &quotA; display: none">x', '<td style="font-family: &quot=x; display: none">x'];
    for (const cell of hiding) expect(plain(`<table><tr><td>Routine</td>${cell}</table>`)).toBeNull();
    // Other styles read as before; a string or a comment is not a declaration, and a comment parts two words; an end
    // tag's attributes do nothing.
    expect(plain('<td style="font-size: 13px; overflow: hidden; list-style-type: none; content: \'display: none\'">A</td hidden>'
      + '<td style="dis/**/play: none /* display: none */">B'
      // "-url(" is a function, not a url(): its "/*" opens a comment. A line break does not end a declaration.
      + '<td style="x: -url(/*); display: none; y: */; display: block">C<td style="color: red\n display: none">D'
      // A whole legacy reference before a space is decoded in an attribute too: these quotes hold the declaration.
      + '<td style="font-family: &quot x; display: none &quot;">G')).toBe('<td>A</td><td>B<td>C<td>D<td>G');
    // Each declaration is read once: a long style with no ";" reads quickly.
    const started = Date.now();
    expect(plain(`<td style="${'display:'.repeat(40000)}">E`)).toBe('<td>E');
    expect(plain(`<style>td { ${'display:'.repeat(40000)} }</style><td>F`)).toBe('<td>F');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a style sheet gives null when a rule in it can hide an element of the page', () => {
    const hiding = ['<style>td.c { display: none }</style><td class="a c">x', '<style>.Banner{visibility:hidden}</style><td class=BANNER>x',
      '<style>#Main { display: none }</style><td id=main>x', '<style>.banner { display: none }</style><td class="b&#97;nner">x',
      // A selector of a type name only, a list part, a pseudo-class or "*" may match any element.
      '<style>td { display: none }</style><td>x', '<style>.absent, td { display: none }</style><td>x',
      '<style>.x:not(.y) { display: none }</style><td>x', '<style>* { visibility: hidden }</style><td>x',
      // A declaration with no rule, or one after a nested rule, has no selector to read.
      '<style>display: none</style><td>x', '<style>.a { .b { color: red } display: none }</style><td>x',
      // A function can stand for any value, and an unquoted url() keeps its "/*" as part of the address.
      '<style>td { --d: none; display: var(--d) }</style><td>x', '<style>td { background: url(/i/*/d.png); display: none }</style><td>x',
      // A CSS escape can spell any style, and an import loads a sheet this cannot read.
      '<style>td { display: \\6e one }</style><td>x', '<style>@import "a.css";</style><td>x',
      // Read left to right, as CSS reads it: a "/*" in a string opens no comment, and a quote in a comment opens no string.
      '<style>td::after { content: "/*" } td.c { display: none } /* " */</style><td class=c>x',
      '<style>/* " */ td.c { display: none } /* " */</style><td class=c>x',
      // A script's, a style's and the title's class and id names count too.
      '<style>.marker + table { display: none }</style><script class=marker></script><table><tr><td>x</table>'];
    for (const cell of hiding) expect(plain(`<table><tr><td>Routine</td>${cell}</table>`)).toBeNull();
    // A hiding rule whose selector names a class or an id no element has hides nothing (the state's pages hold two);
    // a sheet's "<!--" and "-->" are no part of a selector, and a string or a comment is not a declaration.
    expect(plain('<style type="text/css"><!-- .leftNav {display:none;} @media print { .banner {display:none;} -->\r\n'
      + 'td { font-size: 13px; content: "display: none" } /* td { display: none } */</style><td class="list" id=x>A'))
      .toBe('<td>A');
  });

  test('a name of a letter, then letters or digits, is kept when the list allows it (h1 to h6)', () => {
    expect(plainPage('<H1 class=t>Inspection</H1><table><tr><td>x</table>', new Set([...TAGS, 'h1'])))
      .toBe('<h1>Inspection</h1><table><tr><td>x</table>');
    expect(htmlText(plainPage('<h2>Inspection</h2>Information', new Set(['h2'])))).toBe('Inspection Information');
    expect(plain('<h1>x</h1>')).toBeNull();
  });

  test('only HTML white space ends a name: a no-break space is part of it', () => {
    expect(plain('<td\u00a0title="x">A')).toBeNull();
    expect(plain('<td\ftitle="a>b">A')).toBe('<td>A');
  });

  test('a page that ends inside a tag, a quoted value, a comment, a doctype, a script, a style or the title gives null', () => {
    const cut = ['<b>a</b><td', '<td title="a>b', '<!-- a', '<!DOCTYPE', '<?x', '<script', '<script>a',
      '<style>a</styl', '<title>a'];
    for (const html of cut) expect(plain(html)).toBeNull();
  });
});

describe('htmlText', () => {
  const text = (html) => htmlText(plain(html));

  test('joins the text around an inline tag, as a browser shows it, and parts it at any other tag', () => {
    expect(text('<td>35A-<B class=x>02</B>-8<br>Live ro<wbr>aches<td>Callba<u>ck</u></td>')).toBe('35A-02-8 Live roaches Callback');
    expect(text('&l<b></b>t; &<!-- -->lt; <<!-- -->td>')).toBe('&lt; &lt; <td>');
  });

  test('decodes references, takes out invisible characters, and makes NUL characters and white space one space', () => {
    expect(text(' Live&nbsp;ro&shy;aches &amp; flies,\n &lt;5 seen a < b ')).toBe('Live roaches & flies, <5 seen a < b');
    expect(text('a\0b\u200bc &amp;lt; d&lrm;e&#8288;f&#xFEFF;')).toBe('a bc &lt; def');
    // A joiner shapes what a browser shows: the chef emoji stays one emoji.
    expect(text('Chef: \u{1F469}&zwj;\u{1F373}')).toBe('Chef: \u{1F469}\u200d\u{1F373}');
  });
});
