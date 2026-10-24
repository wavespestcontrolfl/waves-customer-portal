// @vitest-environment jsdom
// Tips with facts (owner 2026-10-24): picking a tip the picker payload pairs
// with a live Waves post fills the EMPTY blog slot; it never overwrites a
// post the tech chose, never fills when the blog section is not offered, and
// un-picking leaves the slot alone.
import { describe, it, expect } from 'vitest';
import { blogPostForTip, formAfterTipPick } from './FastCompleteParts';

const POST = { id: '11111111-2222-4333-8444-555555555555', title: 'How to get rid of mice', url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-mice/' };
const LIBRARY = { groups: [], more: [], blogPosts: { seal_door_sweeps: POST, broken: { id: 'x' } } };
const EMPTY = { tipId: '', customTip: '', blogPost: null };

describe('blogPostForTip', () => {
  it('answers the paired post, and nothing for an unpaired tip, a malformed post, or no payload', () => {
    expect(blogPostForTip(LIBRARY, 'seal_door_sweeps')).toEqual(POST);
    expect(blogPostForTip(LIBRARY, 'light_warm_bulbs')).toBeNull();
    expect(blogPostForTip(LIBRARY, 'broken')).toBeNull();
    expect(blogPostForTip(null, 'seal_door_sweeps')).toBeNull();
    expect(blogPostForTip({ groups: [] }, 'seal_door_sweeps')).toBeNull();
    expect(blogPostForTip(LIBRARY, '')).toBeNull();
  });
});

describe('formAfterTipPick', () => {
  it('a pick fills the empty blog slot when the blog section is offered', () => {
    expect(formAfterTipPick(EMPTY, 'seal_door_sweeps', { library: LIBRARY, blogOffered: true }))
      .toEqual({ tipId: 'seal_door_sweeps', customTip: '', blogPost: POST });
  });

  it('never overwrites a post the tech already chose', () => {
    const chosen = { id: 'other', title: 'Other', url: 'https://www.wavespestcontrol.com/x/y/' };
    expect(formAfterTipPick({ ...EMPTY, blogPost: chosen }, 'seal_door_sweeps', { library: LIBRARY, blogOffered: true }).blogPost).toBe(chosen);
  });

  it('fills nothing when the blog section is not offered, or the tip has no post', () => {
    expect(formAfterTipPick(EMPTY, 'seal_door_sweeps', { library: LIBRARY, blogOffered: false })).toEqual({ ...EMPTY, tipId: 'seal_door_sweeps' });
    expect(formAfterTipPick(EMPTY, 'light_warm_bulbs', { library: LIBRARY, blogOffered: true })).toEqual({ ...EMPTY, tipId: 'light_warm_bulbs' });
  });

  it('un-picking the same tip clears the tip and leaves the blog slot as it is', () => {
    const picked = { tipId: 'seal_door_sweeps', customTip: '', blogPost: POST };
    expect(formAfterTipPick(picked, 'seal_door_sweeps', { library: LIBRARY, blogOffered: true })).toEqual({ ...picked, tipId: '' });
  });

  it('a pick clears the tech\'s own line, as before', () => {
    expect(formAfterTipPick({ tipId: '', customTip: 'my own', blogPost: null }, 'light_warm_bulbs', { library: LIBRARY, blogOffered: true }).customTip).toBe('');
  });
});
