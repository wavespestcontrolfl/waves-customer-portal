import { describe, expect, test } from 'vitest';
import {
  ASKS_HOLD, answerIsComplete, answerTextProblem, asksEyebrow, asksHold, asksItemsFrom, itemLabel, itemWords, orderedChoices,
  productChoicesFrom, prunedAnswer, reasonProblem, reserviceAnswersField,
} from './fast-complete-reservice-asks';

const ids = (...list) => new Set(list);

describe('asksItemsFrom', () => {
  test('keeps the items the block can draw, drops ones with no id or no words, and repeats', () => {
    const items = asksItemsFrom({
      items: [
        { id: 'a', source: 'text', at: '2026-10-06T14:00:00.000Z', text: ' Ants ', quoted: true, kind: 'question', pests: ['Ants', ''] },
        { id: 'a', text: 'again' },
        { id: '', text: 'no id' },
        { id: 'b', text: '   ' },
        { id: 'c', text: 'Roaches', kind: 'other' },
      ],
    });
    expect(items.map((item) => item.id)).toEqual(['a', 'c']);
    expect(items[0]).toMatchObject({ text: 'Ants', quoted: true, kind: 'question', pests: ['Ants'], lead: null });
    expect(items[1].kind).toBe('problem');
    expect(asksItemsFrom(null)).toEqual([]);
  });
});

describe('words on the card', () => {
  test('the eyebrow counts items and says nothing for none', () => {
    expect(asksEyebrow(4)).toBe('They told us · 4 items');
    expect(asksEyebrow(1)).toBe('They told us · 1 item');
    expect(asksEyebrow(0)).toBe('');
  });

  test('the label is the source and the Eastern day; a question reads Question', () => {
    expect(itemLabel({ source: 'request_form', at: '2026-10-06T14:00:00.000Z', kind: 'problem' })).toBe('Request form · Oct 6');
    expect(itemLabel({ source: 'email', at: '2026-10-06T14:00:00.000Z', kind: 'problem' })).toBe('Email · Oct 6');
    expect(itemLabel({ source: 'office', at: '2026-10-06T14:00:00.000Z', kind: 'problem' })).toBe('Office · Oct 6');
    expect(itemLabel({ source: 'text', at: '2026-10-06T14:00:00.000Z', kind: 'question' })).toBe('Question · Oct 6');
    // 01:30 UTC on Oct 7 is the evening of Oct 6 in Eastern time.
    expect(itemLabel({ source: 'call', at: '2026-10-07T01:30:00.000Z', kind: 'problem' })).toBe('Call · Oct 6');
    // Clocks fell back at 06:00 UTC on Nov 1: the zone, not a fixed -4, decides the day.
    expect(itemLabel({ source: 'text', at: '2026-11-02T04:30:00.000Z', kind: 'problem' })).toBe('Text · Nov 1');
    expect(itemLabel({ source: 'text', at: '2026-11-02T05:30:00.000Z', kind: 'problem' })).toBe('Text · Nov 2');
    expect(itemLabel({ source: 'text', at: 'not a date', kind: 'problem' })).toBe('Text');
  });

  test('a quoted item is in quotation marks and a lead comes first', () => {
    expect(itemWords({ text: 'spiders by the garage', quoted: true })).toBe('“spiders by the garage”');
    expect(itemWords({ text: 'spiders by the garage', quoted: false, lead: 'On your call on Oct 6, you mentioned' })).toBe('On your call on Oct 6, you mentioned spiders by the garage');
    expect(itemWords({ text: 'ants', quoted: false })).toBe('ants');
  });
});

describe('typed answers mirror the server', () => {
  test('length, web links and phone numbers', () => {
    expect(answerTextProblem('')).toBe('');
    expect(answerTextProblem('Yes, mow in a day.')).toBe('');
    expect(answerTextProblem('x'.repeat(200))).toBe('');
    expect(answerTextProblem('x'.repeat(201))).toMatch(/200 characters/);
    expect(answerTextProblem('See https://example.com')).toBe('Leave web links out of the answer.');
    expect(answerTextProblem('see www.example.com')).toBe('Leave web links out of the answer.');
    expect(answerTextProblem('Call 941-555-0100')).toBe('Leave phone numbers out of the answer.');
    expect(answerTextProblem('Call (941) 555 0100')).toBe('Leave phone numbers out of the answer.');
    // Short numbers are fine.
    expect(answerTextProblem('Back in 3 to 5 days.')).toBe('');
  });

  test('the reason is held to 160 characters', () => {
    expect(reasonProblem('x'.repeat(160))).toBe('');
    expect(reasonProblem('x'.repeat(161))).toMatch(/160 characters/);
  });
});

describe('product choices', () => {
  const rows = [
    { productId: 'a', name: 'Taurus SC', product: { category: 'Insecticide' }, active: true },
    { productId: 'b', name: 'Spider and Wasp Freeze', product: {}, active: true },
    { productId: 'c', name: 'Gel bait for roaches', product: {}, active: false },
    { productId: 'd', name: 'Celsius WG', product: { category: 'herbicide' }, targets: ['Chinch bug damage'] },
    { productId: 'a', name: 'Taurus SC again', active: true },
    { productId: null, name: 'No id' },
  ];

  test('only rows on the completion, once each', () => {
    expect(productChoicesFrom(rows).map((choice) => choice.id)).toEqual(['a', 'b', 'd']);
    expect(productChoicesFrom(null)).toEqual([]);
  });

  test('a row naming the pest (plural or singular) leads; every other row still follows in sheet order', () => {
    const choices = productChoicesFrom(rows);
    expect(orderedChoices(choices, ['Spiders']).map((c) => c.id)).toEqual(['b', 'a', 'd']);
    expect(orderedChoices(choices, ['Chinch bugs']).map((c) => c.id)).toEqual(['d', 'a', 'b']);
    expect(orderedChoices(choices, ['Wasps', 'Chinch bugs']).map((c) => c.id)).toEqual(['b', 'd', 'a']);
  });

  test('nothing matches: all rows, in sheet order', () => {
    const choices = productChoicesFrom(rows);
    expect(orderedChoices(choices, ['Ants']).map((c) => c.id)).toEqual(['a', 'b', 'd']);
    expect(orderedChoices(choices, []).map((c) => c.id)).toEqual(['a', 'b', 'd']);
  });
});

describe('answers', () => {
  const items = [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }];

  test('which answers are complete', () => {
    const have = ids('p1');
    expect(answerIsComplete({ answer: 'noted' }, have)).toBe(true);
    expect(answerIsComplete({ answer: 'checked_none' }, have)).toBe(true);
    expect(answerIsComplete({ answer: 'hidden' }, have)).toBe(true);
    expect(answerIsComplete({ answer: null }, have)).toBe(false);
    expect(answerIsComplete(undefined, have)).toBe(false);
    expect(answerIsComplete({ answer: 'treated', productIds: [] }, have)).toBe(false);
    expect(answerIsComplete({ answer: 'treated', productIds: ['p1'] }, have)).toBe(true);
    expect(answerIsComplete({ answer: 'treated', productIds: ['gone'] }, have)).toBe(false);
    expect(answerIsComplete({ answer: 'not_today', reason: '  ' }, have)).toBe(false);
    expect(answerIsComplete({ answer: 'not_today', reason: 'Rain' }, have)).toBe(true);
    expect(answerIsComplete({ answer: 'not_today', reason: 'x'.repeat(161) }, have)).toBe(false);
    expect(answerIsComplete({ answer: 'answered', text: '' }, have)).toBe(false);
    expect(answerIsComplete({ answer: 'answered', text: 'See www.example.com' }, have)).toBe(false);
    expect(answerIsComplete({ answer: 'answered', text: 'Yes.' }, have)).toBe(true);
  });

  test('a removed product leaves the pick; the hold returns when none is left', () => {
    const answer = { answer: 'treated', productIds: ['p1', 'p2'] };
    expect(prunedAnswer(answer, ids('p1', 'p2'))).toBe(answer);
    expect(prunedAnswer(answer, ids('p2')).productIds).toEqual(['p2']);
    const answers = { i1: { answer: 'noted' }, i2: { answer: 'hidden' }, i3: answer };
    expect(asksHold({ items, answers, availableIds: ids('p1') })).toBe('');
    expect(asksHold({ items, answers, availableIds: ids() })).toBe(ASKS_HOLD);
    expect(asksHold({ items: [], answers: {}, availableIds: ids() })).toBe('');
  });

  test('the body field carries one entry per item with only the keys its kind uses', () => {
    const answers = {
      i1: { answer: 'treated', productIds: ['p1', 'gone'], reason: 'stale', text: 'stale' },
      i2: { answer: 'not_today', reason: '  Rain  ', productIds: ['p1'] },
      i3: { answer: 'answered', text: '  Yes.  ' },
    };
    expect(reserviceAnswersField({ items, answers, availableIds: ids('p1') })).toEqual({
      reserviceAnswers: {
        items: [
          { itemId: 'i1', answer: 'treated', productIds: ['p1'] },
          { itemId: 'i2', answer: 'not_today', reason: 'Rain' },
          { itemId: 'i3', answer: 'answered', text: 'Yes.' },
        ],
      },
    });
    expect(reserviceAnswersField({ items: [], answers, availableIds: ids('p1') })).toEqual({});
    expect(reserviceAnswersField({ items, answers: {}, availableIds: ids() })).toEqual({});
  });
});
