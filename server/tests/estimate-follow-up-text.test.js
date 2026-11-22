const {
  buildFollowUpText,
  followUpTextServiceName,
  swapLongLinkForShort,
} = require('../services/estimate-follow-up-text');

describe('estimate follow-up ready text', () => {
  const link = 'https://portal.wavespestcontrol.com/estimate/tok-1';

  test('names the service, with one space on each side of the link', () => {
    expect(buildFollowUpText({ firstName: 'Dana', serviceName: 'lawn care and pest control', link })).toBe(
      `Hi Dana, it's Waves. Your lawn care and pest control estimate is here: ${link} Any questions? Just reply to this text.`,
    );
  });

  test('without a proven name the sentence says Your Waves estimate', () => {
    expect(buildFollowUpText({ firstName: 'Dana', serviceName: null, link })).toBe(
      `Hi Dana, it's Waves. Your Waves estimate is here: ${link} Any questions? Just reply to this text.`,
    );
  });

  test('a name outside the allowed three is dropped', () => {
    expect(buildFollowUpText({ firstName: 'Dana', serviceName: 'home protection', link })).toContain('Your Waves estimate is here:');
  });

  test.each(['pest control', 'lawn care', 'lawn care and pest control'])('allows %s', (name) => {
    expect(followUpTextServiceName(name)).toBe(name);
  });

  test.each(['home protection', 'service quote', 'service', 'Pest Control', ' pest control', '', null, undefined, 4, {}])(
    'refuses %p',
    (label) => { expect(followUpTextServiceName(label)).toBeNull(); },
  );
});

describe('swapLongLinkForShort', () => {
  const longUrl = 'https://portal.wavespestcontrol.com/estimate/tok-1';
  const shortUrl = 'https://go.example.test/ab12';

  test('swaps every occurrence of this estimate\'s long link', () => {
    expect(swapLongLinkForShort(`a ${longUrl} b ${longUrl}.`, longUrl, shortUrl)).toBe(`a ${shortUrl} b ${shortUrl}.`);
  });

  test('a message without the long link is unchanged', () => {
    expect(swapLongLinkForShort('Hi Dana, any questions?', longUrl, shortUrl)).toBe('Hi Dana, any questions?');
  });

  test('another estimate\'s link is not swapped, even when it starts with this one', () => {
    const other = 'https://portal.wavespestcontrol.com/estimate/tok-2';
    const longer = `${longUrl}9`;
    expect(swapLongLinkForShort(`${other} ${longer}`, longUrl, shortUrl)).toBe(`${other} ${longer}`);
  });

  test('a link the office extended with a sub-path, a query or a fragment goes out as typed', () => {
    for (const tail of ['/assessment', '?intent=accept', '#terms', '&x=1', '=1', '%20']) {
      expect(swapLongLinkForShort(`See ${longUrl}${tail} today`, longUrl, shortUrl)).toBe(`See ${longUrl}${tail} today`);
    }
  });

  test('sentence punctuation right after the link still swaps', () => {
    for (const tail of ['.', ',', '!', ')', ';', ' ', '\n']) {
      expect(swapLongLinkForShort(`(${longUrl}${tail}`, longUrl, shortUrl)).toBe(`(${shortUrl}${tail}`);
    }
    expect(swapLongLinkForShort(longUrl, longUrl, shortUrl)).toBe(shortUrl);
  });

  test('a short link with a $ pattern is inserted as written', () => {
    expect(swapLongLinkForShort(longUrl, longUrl, 'https://x.test/$&$1')).toBe('https://x.test/$&$1');
  });

  test('a non-text message comes back as it was', () => {
    expect(swapLongLinkForShort(undefined, longUrl, shortUrl)).toBeUndefined();
  });
});
