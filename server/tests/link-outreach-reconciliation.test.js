jest.mock('../models/db', () => jest.fn());
const { outreachMatch } = require('../services/seo/link-prospect-verifier');
const link = (over={}) => ({id:'link',source_domain:'publisher.example',source_url:'https://publisher.example/Post',target_url:'https://wavespestcontrol.com/pest-control/',first_seen:'2026-08-12',...over});
const placement = (over={}) => ({id:'placement',target_domain:'publisher.example',target_page:'/pest-control/',outreach_sent_at:'2026-08-10T16:00:00Z',status:'contacted',outreach_status:'sent',...over});
test('one fresh backlink to the intended target matches its waiting outreach placement',()=>{
  const p=placement();expect(outreachMatch(link(),[p])).toEqual({placement:p,ambiguous:[]});
});
test.each(['2026-08-09','2026-08-10',null])('historical or same-day evidence (%s) is not attributed to a new pitch',first_seen=>{
  expect(outreachMatch(link({first_seen}),[placement()]).placement).toBeNull();
});
test('another target page, publisher or unsafe source URL never matches',()=>{
  for(const over of [{target_url:'https://wavespestcontrol.com/termites/'},{source_domain:'another.example'},{source_url:'javascript:alert(1)'},{source_url:'https://user:password@publisher.example/Post'}]) {
    expect(outreachMatch(link(over),[placement()])).toEqual({placement:null,ambiguous:[]});
  }
});
test('same-domain placements are ambiguous; a unique exact source URL disambiguates them',()=>{
  const first=placement({id:'first'}),second=placement({id:'second'});
  expect(outreachMatch(link(),[first,second])).toEqual({placement:null,ambiguous:[first,second]});
  second.live_url='https://www.publisher.example/Post/';
  expect(outreachMatch(link(),[first,second]).placement).toBe(second);
  second.live_url='https://publisher.example/post';
  expect(outreachMatch(link(),[second]).placement).toBeNull();
});
test('old evidence does not create ambiguous owner cards',()=>{
  expect(outreachMatch(link({first_seen:'2026-08-09'}),[placement(),placement({id:'other'})])).toEqual({placement:null,ambiguous:[]});
});
test('a unique expected publisher page disambiguates unsatisfied sibling placements', () => {
  const first = placement({ target_url: 'https://publisher.example/elsewhere' });
  const second = placement({ id: 'second', target_url: 'https://www.publisher.example/Post/' });
  expect(outreachMatch(link(), [first, second]).placement).toBe(second);
  expect(outreachMatch(link({ first_seen: '2020-01-01' }), [first, second]).placement).toBeNull();
});
test('historical exact evidence requires prior attribution or a recovery', () => {
  const p = placement({ live_url: link().source_url });
  const historic = link({ first_seen: '2020-01-01' });
  expect(outreachMatch(historic, [p]).placement).toBeNull();
  const attributed = { ...p, backlink_id: historic.id };
  expect(outreachMatch(historic, [attributed]).placement).toBe(attributed);
});
test.each([
  ['2026-03-08T04:30:00Z', '2026-03-08'],
  ['2026-11-01T04:30:00Z', '2026-11-02'],
])('freshness follows the next ET calendar day across DST (%s)', (outreach_sent_at, first_seen) => {
  const p = placement({ outreach_sent_at });
  expect(outreachMatch(link({ first_seen }), [p]).placement).toBe(p);
  const sentDay = require('../utils/datetime-et').etDateString(new Date(outreach_sent_at));
  expect(outreachMatch(link({ first_seen: sentDay }), [p]).placement).toBeNull();
});
test('a recovery can follow a fresh moved URL while ordinary known profiles stay pinned', () => {
  const p = placement({ live_url: 'https://publisher.example/old-profile', quality_signals: { lost_recovery: true } });
  expect(outreachMatch(link(), [p]).placement).toBe(p);
  expect(outreachMatch(link({ first_seen: '2026-08-09' }), [p]).placement).toBeNull();
  expect(outreachMatch(link(), [{ ...p, quality_signals: {} }]).placement).toBeNull();
});
