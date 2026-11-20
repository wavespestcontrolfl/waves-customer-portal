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

  test('a tag of an element that is not plain text in the flow of the page gives null, even when the list allows it', () => {
    const names = ['textarea', 'template', 'svg', 'math', 'select', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes',
      'plaintext', 'frameset', 'details', 'dialog', 'datalist', 'rp', 'audio', 'canvas', 'object', 'video', 'meter',
      'progress', 'input', 'button', 'ol', 'q', 'bdi', 'bdo', 'link', 'meta', 'ruby', 'marquee', 'image'];
    // A browser reads the <td> in each as text, by other rules, not at all, or with text that is not in the page.
    const all = new Set([...TAGS, ...names]);
    for (const name of names) expect(plainPage(`<table><tr><${name}><td>35A-02-8</${name}></table>`, all)).toBeNull();
    expect(plainPage('<td><input type=submit value=Callback>', all)).toBeNull();
    // An option outside a select shows its content (the state's pages hold an empty one), unless it has a label.
    const withOption = new Set([...TAGS, 'option']);
    expect(plainPage('<td><option>&nbsp;</option>Met', withOption)).toBe('<td><option>\u00a0</option>Met');
    expect(plainPage('<td><option label=Callback>x</option>', withOption)).toBeNull();
  });

  test('a start tag that can hide its element or reorder its text gives null: hidden, popover, a dir other than ltr, or such a style', () => {
    const hiding = ['<td hidden>Callback</td>', '<td HIDDEN="">x', '<td popover>x', '<td style="display:none">x',
      '<td style="color:red; DISPLAY : none">x', '<td style="display:/**/none">x', '<td style="display&#58;none">x',
      "<td style='visibility: hidden'>x", '<td style=visibility:collapse>x', '<td style="content-visibility: hidden">x',
      // A CSS escape can spell any style ("\6e one" is "none"), and a function can stand for any value.
      '<td style="display:\\6e one">x', '<td style="--state:none; display:var(--state)">x', '<td style="content-visibility: var(--v)">x',
      // A quoted url() is a string, which holds no declaration. An unquoted one whose address holds a "/*" or a quote
      // counts, whatever follows it, as CSS can read it in two ways: after a "#", an "@" or a name character (a NUL,
      // a U+00D7 too) a "url(" is part of a longer name and its "/*" opens a comment; where a token starts (after a
      // "<!--" too) it opens a url(), whose "/*" or quote is part of its address.
      "<td style='background: url(\"a)b\"); display: none'>x", '<td style="background:url(/icons/*/dot.png)">x',
      "<td style=\"background: url(a'b.png)\">x", '<td style="--x: #url(/* ) \' */); display:none">x',
      '<td style="--x: @url(/* ) \' */); display:none">x', '<td style="--x: a\u0000url(/* ) \' */); display:none">x',
      '<td style="--x: <!--url(/*); display:none">x', '<td style="--x: \u00d7url(/* ) \' */); display:none">x',
      // CSS white space is a space, a tab or a line break: after a no-break space, "url(" opens a url() that runs to
      // the first ")". A browser does not draw what a table column holds.
      '<td style="background: url(&nbsp;\'a); display:none; \')">x', '<td style="display: table-column">x',
      // Of two attributes with one name, a browser keeps the first.
      '<td style="display:none" style="color:red">x',
      // In an attribute, a reference without its ";" before a letter, a digit or "=" stays as written: no quote opens.
      '<td style="font-family: &quotA; display: none">x', '<td style="font-family: &quot=x; display: none">x',
      // A browser can show a cell's text in another order than it is written.
      '<td dir=rtl>x', '<td DIR="Auto">x', '<td style="direction: rtl">x', '<td style="unicode-bidi: bidi-override">x',
      '<td style="direction: var(--d)">x'];
    for (const cell of hiding) expect(plain(`<table><tr><td>Routine</td>${cell}</table>`)).toBeNull();
    // Other styles read as before; a string or a comment is not a declaration, and a comment parts two words; an end
    // tag's attributes do nothing.
    expect(plain('<td style="font-size: 13px; overflow: hidden; list-style-type: none; content: \'display: none\'">A</td hidden>'
      + '<td style="dis/**/play: none /* display: none */">B'
      // A url() whose address holds no "/*" and no quote reads alike either way. A line break ends no declaration.
      + '<td style="background: URL( /i/dot.png ) no-repeat, url(\'a.png\'); x: -url(a b)">C'
      + '<td style="color: red\n display: none">D'
      // A whole legacy reference before a space is decoded in an attribute too: these quotes hold the declaration.
      + '<td style="font-family: &quot x; display: none &quot;">G'
      // Left to right is the order a browser shows by default, and a custom property sets nothing by itself.
      + '<td dir=LTR style="direction: ltr; unicode-bidi: normal; --display: none; --visibility: hidden">H'
      // A browser drops an attribute whose name an earlier one of the tag has.
      + '<td style="color:red" STYLE="display:none" dir=ltr dir=rtl>K'))
      .toBe('<td>A</td><td>B<td>C<td>D<td>G<td>H<td>K');
    // Each declaration is read once, and each rule's selector is judged once: a long style reads quickly.
    const started = Date.now();
    expect(plain(`<td style="${'display:'.repeat(40000)}">E`)).toBe('<td>E');
    expect(plain(`<style>td { ${'display:'.repeat(40000)} }</style><td>F`)).toBe('<td>F');
    expect(plain(`<style>${'.a, '.repeat(20000)}.z { ${'display: none; '.repeat(20000)}}</style><td>G`)).toBe('<td>G');
    // A selector of 60,000 attribute tests left open counts (it may match anything), and is judged quickly.
    expect(plain(`<style>${'a[ '.repeat(60000)}{ display: block }</style><td>H`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a style sheet gives null when a rule in it can hide an element of the page or reorder its text, and so does a style that can show a script, a style or the title', () => {
    const hiding = ['<style>td.c { display: none }</style><td class="a c">x', '<style>.Banner{visibility:hidden}</style><td class=BANNER>x',
      '<style>#Main { display: none }</style><td id=main>x', '<style>.banner { display: none }</style><td class="b&#97;nner">x',
      // A selector of a type name only, a list part, a pseudo-class or "*" may match any element.
      '<style>td { display: none }</style><td>x', '<style>.absent, td { display: none }</style><td>x',
      '<style>.x:not(.y) { display: none }</style><td>x', '<style>* { visibility: hidden }</style><td>x',
      // A declaration with no rule, or one after a nested rule, has no selector to read.
      '<style>display: none</style><td>x', '<style>.a { .b { color: red } display: none }</style><td>x',
      // A function can stand for any value, and a sheet with an unquoted url() whose address holds a "/*" or a quote
      // counts whatever its rules.
      '<style>td { --d: none; display: var(--d) }</style><td>x', '<style>.absent { background: url(/i/*/d.png) }</style><td>x',
      // After a no-break space, "url(" opens a url(); a browser does not draw a column group.
      '<style>td { background: url(\u00a0\'a); display: none; \') }</style><td>x', '<style>td { display: TABLE-COLUMN-GROUP }</style><td>x',
      '<style>td { --x: <!--url(/*); display: none }</style><td>x',
      // A "-->" right after a name is part of it: ".nav-->" is the class "nav--" and a ">".
      '<style>.nav--> b { display: none }</style><td class="nav--"><b>x</b>',
      // A CSS escape can spell any style, and an import loads a sheet this cannot read.
      '<style>td { display: \\6e one }</style><td>x', '<style>@import "a.css";</style><td>x',
      // Read left to right, as CSS reads it: a "/*" in a string opens no comment, and a quote in a comment opens no string.
      '<style>td::after { content: "/*" } td.c { display: none } /* " */</style><td class=c>x',
      '<style>/* " */ td.c { display: none } /* " */</style><td class=c>x',
      // A script's, a style's and the title's class and id names count too.
      '<style>.marker + table { display: none }</style><script class=marker></script><table><tr><td>x</table>',
      '<style>td { direction: rtl }</style><td>x',
      // A style element is a sheet with no type, or with a type that is empty or text/css (its first part, in any
      // case), whatever its media; of two types, the first counts.
      '<style type="TEXT/CSS">td { display: none }</style><td>x', '<style type="">td { display: none }</style><td>x',
      '<style type="text/css; charset=utf-8">td { display: none }</style><td>x',
      '<style media=print>td { display: none }</style><td>x', '<style type=text/css type=text/plain>td { display: none }</style><td>x',
      // A display other than none, or an all, can show what a script, a style or the title holds: a rule counts unless
      // its selector's last compound is led by another element's name (a no-break space parts nothing), and so does a
      // declaration with no rule, after a nested rule, or in an at-rule.
      '<style>* { display: block }</style><td>x', '<style>head, Title { display: block }</style><td>x',
      '<style>script { all: unset }</style><td>x', '<style>.x { display: inline }</style><script class=x>y</script><td>x',
      '<style>.x:not(a b, c) { display: block }</style><td>x', '<style>head > :first-child { display: block }</style><td>x',
      '<style>.x\u00a0b { display: block }</style><td>x', '<style>script { @media screen { display: block } }</style><td>x',
      '<style>display: block</style><td>x', '<style>a { b { color: red } display: block }</style><td>x',
      // A step of a @keyframes ("from" or "to", in any case) applies to whatever element the animation runs on.
      '<style>@keyframes show { from { display: block } }</style><td>x', '<style>@keyframes s { 50% { color: red } TO { display: inline } }</style><td>x',
      // The title's class counts for a showing rule too.
      '<style>.banner { display: block }</style><title class=banner>T</title><td>x',
      '<title style="display: block">Callback</title><td>x', '<script style="display:inline">y</script><td>x',
      '<title style="d\\69splay: block">Callback</title><td>x'];
    for (const cell of hiding) expect(plain(`<table><tr><td>Routine</td>${cell}</table>`)).toBeNull();
    // A hiding rule whose selector names a class or an id no element has hides nothing (the state's pages hold two);
    // a sheet's "<!--" and "-->" are no part of a selector, and a string, a url() or a comment is not a declaration.
    expect(plain('<style type="text/css"><!-- .leftNav {display:none;} @media print { .banner {display:none;} -->\r\n'
      + 'td { font-size: 13px; content: "display: none"; --display: none; unicode-bidi: normal;'
      + ' background: url("../i/bg2.png"), url(/i/dot.png) } /* td { display: none } */'
      + '</style><td class="list" id=x>A')).toBe('<td>A');
    // A style element of another type is inert, and of two class attributes a browser keeps the first.
    expect(plain('<style type="text/plain">td { display: none }</style><style>.b { display: none }</style><td class=a class=b>A'))
      .toBe('<td>A');
    // A showing rule shows nothing when its selector names a class no element has, or when its only part that can
    // match an element is led by another element's name.
    expect(plain('<style>.banner { display: block } .absent, a { display: block }</style><td class=x>A')).toBe('<td>A');
    // ".nav-->" is the class "nav--" and a ">", which no element has here; an animation with no display or visibility
    // step hides and shows nothing.
    expect(plain('<style>.nav--> b { display: none } @keyframes fade { from { opacity: 0 } to { opacity: 1 } }</style>'
      + '<td class=nav><b>A</b>')).toBe('<td><b>A</b>');
    // A display in a rule led by another element's name (as on the state's pages), or none on a script, a style or the
    // title, shows nothing this drops.
    expect(plain('<style>li a:top { display: block } a.top:link { display: block } input[type=text] { display: inline-block }'
      + ' .x { display: none }</style><title style="color: red; display: none; content: \'a;display:block\'">T</title><td>A'))
      .toBe('<td>A');
  });

  test('a run of text that holds a right-to-left letter or a direction control gives null: a browser can show it in another order', () => {
    // "\u202e8-20-A53" shows as "35A-02-8".
    const texts = ['\u202e8-20-A53', '&#x202E;8-20-A53', '35A-02-8&rlm;', '\u2067x\u2069', '\u202ax\u202c', '\u061cx',
      '\u05d0 35A-02-8', '&#1488;', '\u0627', '\u0663', '\ufb1d', '\ufefc', '\u{10900}', '\u{1e900}'];
    for (const text of texts) expect(plain(`<table><tr><td>A</td><td>${text}</table>`)).toBeNull();
    expect(plain('<td>A</td>\u05d0')).toBeNull();
    // The left-to-right mark changes no order on a page without right-to-left text.
    expect(plain('<td>35A-02-8&lrm;')).toBe('<td>35A-02-8\u200e');
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
    // An insertion, a deletion and a label are inline too.
    const inline = new Set([...TAGS, 'ins', 'del', 'label']);
    expect(htmlText(plainPage('<td>Call<ins>ba</ins><del>c</del>k <label>Fol</label>low-up', inline))).toBe('Callback Follow-up');
  });

  test('decodes references, takes out invisible characters and NUL characters, and makes white space one space', () => {
    expect(text(' Live&nbsp;ro&shy;aches &amp; flies,\n &lt;5 seen a < b ')).toBe('Live roaches & flies, <5 seen a < b');
    // A browser drops a NUL in text: "Call\0back" shows as "Callback".
    expect(text('a\0b\u200bc &amp;lt; d&lrm;e&#8288;f&#xFEFF; Call\0back')).toBe('abc &lt; def Callback');
    // A joiner shapes what a browser shows: the chef emoji stays one emoji.
    expect(text('Chef: \u{1F469}&zwj;\u{1F373}')).toBe('Chef: \u{1F469}\u200d\u{1F373}');
  });
});
