const { plainPage, htmlText } = require('../services/prospects/plain-html');

const TAGS = new Set(['b', 'html', 'table', 'td', 'tr']);
const plain = (html) => plainPage(html, TAGS);

describe('plainPage', () => {
  test('rebuilds each tag without its attributes, keeps the text, and drops comments, doctypes, scripts, styles and the title', () => {
    expect(plain('<!DOCTYPE html><HTML><title>A <td>t</td></title><style>td { x: "</td>" }</style>'
      + '<TABLE border=1><tr class="r"><td>35A-02-8<td>Live roaches.</table><!-- <td>c</td> --></html>'))
      .toBe(' <html>  <table><tr><td>35A-02-8<td>Live roaches.</table> </html>');
  });

  test('a ">" inside a quoted attribute value stays in the value; an unquoted value runs to white space or ">"', () => {
    expect(plain('<td title="count > 1">A</td><td title=\'<tr>\'>B</td>')).toBe('<td>A</td><td>B</td>');
    expect(plain('<td x=a"b>C</td>')).toBe('<td>C</td>');
  });

  test('an "=" where an attribute name or value starts is part of it, so a quote after it opens no value', () => {
    // A browser ends each of these tags at its first ">", and the rest is text.
    expect(plain('<td x=="y>">A</td>')).toBe('<td>">A</td>');
    expect(plain('<td ="y>">A</td>')).toBe('<td>">A</td>');
    expect(plain('<td x="1"="y>">A</td>')).toBe('<td>">A</td>');
  });

  test('a script ends at "</script" then white space, "/" or ">", in any case, and hides what it holds', () => {
    expect(plain('<table><script>"<tr><td>35A-02-8<td>Live roaches."</script ><tr><td>25-06-4</table>'))
      .toBe('<table> <tr><td>25-06-4</table>');
    expect(plain('<script>a</SCRIPT\n><b>x</b>')).toBe(' <b>x</b>');
    expect(plain('<script>a</script/><b>x</b>')).toBe(' <b>x</b>');
    // "</scripts>" ends nothing: the script runs on to its own end tag.
    expect(plain('<script>a</scripts><b>x</b></script><b>y</b>')).toBe(' <b>y</b>');
  });

  test('a script that holds "<script" gives null: after "<!--" it runs past its first end tag', () => {
    // A browser reads all of this as one script, to the page end: the table is script text.
    expect(plain('<script><!-- <script></script><table><tr><td>35A-02-8</table> -->')).toBeNull();
  });

  test('a comment ends as a browser ends it: "<!-->" and "<!--->" at once, any other at its first "-->" or "--!>"', () => {
    expect(plain('<!--><b>a</b>-->')).toBe(' <b>a</b>-->');
    expect(plain('<!---><b>a</b>-->')).toBe(' <b>a</b>-->');
    expect(plain('<!-- x --!><b>a</b>-->')).toBe(' <b>a</b>-->');
    expect(plain('<!-- <b>x</b> --><b>a</b>')).toBe(' <b>a</b>');
  });

  test('"<?…>", "<![CDATA[…]]>", "</ …>" and "</>" each end at their first ">"; a "<" before anything else is text', () => {
    expect(plain('<?xml a="<b>"?><b>a</b>')).toBe(' "?><b>a</b>');
    expect(plain('<![CDATA[<b>x]]><b>a</b>')).toBe(' x]]><b>a</b>');
    expect(plain('</ b><b>a</b></>')).toBe(' <b>a</b> ');
    expect(plain('a < b, 3<5 <b>c</b>')).toBe('a < b, 3<5 <b>c</b>');
  });

  test('a tag not on the list gives null (a template, a textarea, an svg, a select), as does a name with other characters', () => {
    const refused = ['<template><td>35A-02-8</template>', '<textarea><td>x</textarea>', '<svg><td>x</svg>',
      '<noscript>x</noscript>', '<select>x</select>', '<span>x</span>', '<td="x">', '<tdÁ>x', '</title>'];
    for (const html of refused) expect(plain(html)).toBeNull();
  });

  test('only HTML white space ends a name: a no-break space is part of it', () => {
    expect(plain('<td title="x">A')).toBeNull();
    expect(plain('<td\ftitle="a>b">A')).toBe('<td>A');
  });

  test('a page that ends inside a tag, a quoted value, a comment, a doctype, a script, a style or the title gives null', () => {
    const cut = ['<b>a</b><td', '<td title="a>b', '<!-- a', '<!DOCTYPE', '<?x', '<script', '<script>a',
      '<style>a</styl', '<title>a'];
    for (const html of cut) expect(plain(html)).toBeNull();
  });
});

describe('htmlText', () => {
  test('is the text a browser shows: tags out, references decoded, format characters out, white space one space', () => {
    expect(htmlText('<td><u>35A-02-8</u></td>')).toBe('35A-02-8');
    expect(htmlText(' Live&nbsp;ro&shy;aches &amp; flies,\n &lt;5 seen<br>a < b ')).toBe('Live roaches & flies, <5 seen a < b');
    expect(htmlText('a\0b​c')).toBe('a bc');
  });
});
