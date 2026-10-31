// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import NewsletterPage from './NewsletterPage';
vi.mock('./EmailAutomationsPanelV2', () => ({default:()=> <div>Automation companion</div>}));
const response = body => ({ok:true,json:async()=>body});
function fixture(url, options={}) {
 const route = String(url).split('?')[0];
 if(route.endsWith('/auth/me'))return {email:'operator@example.invalid'};
 if(route.endsWith('/subscribers'))return {subscribers:[],counts:{active:3},total:3};
 if(route.endsWith('/sends'))return {sends:[],counts:{sent:0}};
 return {};
}
beforeEach(()=>{localStorage.setItem('waves_admin_token','synthetic-token');vi.stubGlobal('fetch',vi.fn(async(url,options)=>response(fixture(url,options))));Element.prototype.scrollIntoView=vi.fn();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
// Manual newsletter tools were removed (owner 2026-10-30): the weekly issue
// is drafted by the Monday autopilot and sent through the proof flow.
const REMOVED_ROUTES=[/\/calendar/,/\/tags$/,/\/quizzes$/,/\/latest-autopilot/,/\/segment-preview$/,/\/draft-ai$/,/\/digest-plan$/,/\/preview$/,/\/validate$/,/\/approved-ids$/,/\/test$/,/\/schedule$/,/\/send$/];
const requestedPaths=()=>fetch.mock.calls.map(([url,options])=>({path:String(url).split('?')[0],method:options?.method||'GET'}));
const removedRequests=()=>requestedPaths().filter(({path,method})=>REMOVED_ROUTES.some(re=>re.test(path))||(method==='POST'&&path.endsWith('/sends'))||(method==='PATCH'&&/\/sends\/[^/]+$/.test(path)));
const draftRow={id:'draft-1',subject:'Synthetic draft issue',status:'draft',recipient_count:0,delivered_count:0};
const correctableRow={id:'sent-1',subject:'Synthetic sent issue',status:'sent',correctable:true,recipient_count:10,delivered_count:8,sent_at:'2035-01-01T15:00:00.000Z'};
const withSends=sends=>{const original=fetch.getMockImplementation();fetch.mockImplementation(async(url,options)=>String(url).split('?')[0].endsWith('/sends')?response({sends,counts:{sent:1,draft:1}}):original(url,options));};
it.each([
 '?tab=compose',
 '?tab=compose&draftId=draft-1',
 '?tab=compose&autopilotType=reengagement&draftId=draft-1',
 '?tab=calendar',
])('opens History for the retired link %s and calls no removed route',async(query)=>{
 withSends([draftRow]);
 render(<MemoryRouter initialEntries={[`/admin/newsletter${query}`]}><NewsletterPage/></MemoryRouter>);
 expect(await screen.findByText('Synthetic draft issue')).toBeInTheDocument();
 expect(screen.getByText('Past sends')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:/^History/})).toBeInTheDocument();
 expect(removedRequests()).toEqual([]);
});
it('renders no Compose, Calendar, New Campaign, Draft, Edit or Correct copy control',async()=>{
 withSends([draftRow,correctableRow]);
 const original=fetch.getMockImplementation();
 fetch.mockImplementation(async(url,options)=>String(url).includes('/events')?response({events:[{id:'event-1',title:'Synthetic event',startAt:'2035-01-02T15:00:00.000Z',adminStatus:'pending'}],counts:{pending:1}}):original(url,options));
 const banned=/compose|calendar|new campaign|draft newsletter|^edit$|correct copy|open composer/i;
 const view=render(<MemoryRouter initialEntries={['/admin/newsletter']}><NewsletterPage/></MemoryRouter>);
 const bannedButtons=()=>screen.queryAllByRole('button').filter(b=>banned.test(`${b.textContent} ${b.getAttribute('aria-label')||''} ${b.getAttribute('title')||''}`.trim()));
 await screen.findByText('Synthetic event');
 expect(bannedButtons()).toEqual([]);
 const nav=within(screen.getByRole('navigation',{name:'Newsletter section'}));
 expect(nav.getAllByRole('button').map(b=>b.textContent.replace(/\s*\(\d+\)$/,''))).toEqual(['Dashboard','History','Automation','Audience']);
 fireEvent.click(nav.getByRole('button',{name:/^History/}));
 await screen.findByText('Synthetic draft issue');
 expect(bannedButtons()).toEqual([]);
 expect(screen.getByRole('button',{name:'Delete'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Resume'})).toBeInTheDocument();
 fireEvent.click(nav.getByRole('button',{name:'Automation'}));
 fireEvent.click(await screen.findByRole('button',{name:'Events'}));
 await screen.findByText('Synthetic event');
 expect(bannedButtons()).toEqual([]);
 expect(view.container).not.toHaveTextContent(/Open composer|Compose manually/i);
 expect(removedRequests()).toEqual([]);
});
it('tells the operator the weekly issue comes from the autopilot when no campaign exists',async()=>{
 render(<MemoryRouter initialEntries={['/admin/newsletter?tab=history']}><NewsletterPage/></MemoryRouter>);
 expect(await screen.findByText('No campaigns yet. The weekly issue appears here after the Monday autopilot drafts it.')).toBeInTheDocument();
});
it('clears stale summary badges when an automatic summary refresh fails',async()=>{
 render(<MemoryRouter><NewsletterPage/></MemoryRouter>);
 expect(await screen.findByRole('button',{name:'Audience (3)'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'History (0)'})).toBeInTheDocument();
 const priorImplementation=fetch.getMockImplementation();
 fetch.mockImplementation((url,options)=>{
  const route=String(url).split('?')[0];
  if(route.endsWith('/sends')||route.endsWith('/subscribers'))return Promise.reject(new Error('summary unavailable'));
  return priorImplementation(url,options);
 });
 fireEvent(window,new Event('online'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Audience'})).toBeInTheDocument());
 expect(screen.getByRole('button',{name:'History'})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Audience (3)'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'History (0)'})).not.toBeInTheDocument();
});
it('drops vanished inbox selections while keeping visible rows selected for bulk actions',async()=>{
 let events=[
  {id:'event-a',title:'Vanished event',adminStatus:'pending'},
  {id:'event-b',title:'Visible event',adminStatus:'pending'},
 ];
 const original=fetch.getMockImplementation();
 fetch.mockImplementation(async(url,options)=>String(url).includes('/events/inbox')
  ? response({events,counts:{pending:events.length}})
  : original(url,options));
 render(<MemoryRouter initialEntries={['/admin/newsletter?tab=events']}><NewsletterPage/></MemoryRouter>);
 const first=await screen.findByText('Vanished event');
 fireEvent.click(within(first.closest('tr')).getByRole('checkbox'));
 fireEvent.click(within(screen.getByText('Visible event').closest('tr')).getByRole('checkbox'));
 expect(screen.getByText('2 selected')).toBeInTheDocument();
 events=[events[1]];
 fireEvent(window,new Event('online'));
 await waitFor(()=>expect(screen.queryByText('Vanished event')).not.toBeInTheDocument());
 expect(screen.getByText('1 selected')).toBeInTheDocument();
 expect(within(screen.getByText('Visible event').closest('tr')).getByRole('checkbox')).toBeChecked();
 fireEvent.click(screen.getAllByRole('button',{name:'Approve',exact:true})[0]);
 await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/api/admin/newsletter/events/bulk-action',expect.objectContaining({
  method:'POST',body:JSON.stringify({action:'approve',ids:['event-b']})
 })));
});

it('ignores the first StrictMode events response after the second setup has loaded',async()=>{
 let finishFirst;
 let eventReads=0;
 const original=fetch.getMockImplementation();
 fetch.mockImplementation(async(url,options)=>{
  if(String(url).includes('/newsletter/events?')){
   eventReads+=1;
   if(eventReads===1)return new Promise(resolve=>{finishFirst=resolve;});
   return response({events:[{id:'new-event',title:'Current event'}]});
  }
  return original(url,options);
 });
 render(<StrictMode><MemoryRouter><NewsletterPage/></MemoryRouter></StrictMode>);
 await screen.findByText('Current event');
 expect(eventReads).toBe(2);
 await act(async()=>{finishFirst(response({events:[{id:'old-event',title:'Stale event'}]}));});
 expect(screen.getByText('Current event')).toBeInTheDocument();
 expect(screen.queryByText('Stale event')).not.toBeInTheDocument();
});


it.each(['bulk', 'merge'])('recovers inbox polling after a failed %s action cancels a foreground read', async (action) => {
 const events=[{id:'event-a',title:'First event',adminStatus:'pending'}, {id:'event-b',title:'Second event',adminStatus:'pending'}];
 let reads=0;
 let cancelledSignal;
 const original=fetch.getMockImplementation();
 vi.stubGlobal('confirm',vi.fn(()=>true));
 vi.stubGlobal('alert',vi.fn());
 fetch.mockImplementation((url,options)=>{
  if(String(url).includes('/events/inbox')){
   reads+=1;
   if(reads===2){
    cancelledSignal=options.signal;
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError'))));
   }
   return Promise.resolve(response({events:reads>2?[{...events[0],title:'Refreshed event'}]:events,counts:{pending:2}}));
  }
  if(String(url).endsWith('/events/bulk-action')||String(url).endsWith('/events/merge'))return Promise.reject(new Error('Synthetic action failure'));
  return original(url,options);
 });
 render(<MemoryRouter initialEntries={['/admin/newsletter?tab=events']}><NewsletterPage/></MemoryRouter>);
 fireEvent.click(within((await screen.findByText('First event')).closest('tr')).getByRole('checkbox'));
 fireEvent.click(within(screen.getByText('Second event').closest('tr')).getByRole('checkbox'));
 fireEvent.change(screen.getByRole('combobox',{name:'Freshness'}),{target:{value:'fresh'}});
 await screen.findByText('Loading events...');
 fireEvent.click(action==='merge'?screen.getByRole('button',{name:'Merge 2'}):screen.getByRole('button',{name:'Approve',exact:true}));
 if(action==='bulk')await screen.findByText('0 of 2 events updated. Bulk approve failed: Synthetic action failure. 2 still selected.');
 else await waitFor(()=>expect(alert).toHaveBeenCalledWith('Merge failed: Synthetic action failure'));
 expect(cancelledSignal.aborted).toBe(true);
 expect(screen.queryByText('Loading events...')).not.toBeInTheDocument();
 fireEvent(window,new Event('online'));
 expect(await screen.findByText('Refreshed event')).toBeInTheDocument();
});

// Audit 2026-10-30 NEWS-04: the route takes 50 ids per request; the inbox
// once reported a 100-event selection as updated after only 50 were.
it('sends a large selection in batches, reports the server count and keeps unprocessed events selected', async () => {
 const events=Array.from({length:60},(_,i)=>({id:`event-${i}`,title:`Batch event ${i}`,adminStatus:'pending'}));
 const batches=[];
 const original=fetch.getMockImplementation();
 fetch.mockImplementation((url,options)=>{
  if(String(url).includes('/events/inbox'))return Promise.resolve(response({events,counts:{pending:60}}));
  if(String(url).endsWith('/events/bulk-action')){
   const {ids}=JSON.parse(options.body);batches.push(ids);
   const updatedIds=ids.filter(id=>id!=='event-59');
   return Promise.resolve(response({success:true,updated:updatedIds.length,updatedIds}));
  }
  return original(url,options);
 });
 render(<MemoryRouter initialEntries={['/admin/newsletter?tab=events']}><NewsletterPage/></MemoryRouter>);
 await screen.findByText('Batch event 0');
 fireEvent.click(within(screen.getAllByRole('columnheader')[0]).getByRole('checkbox'));
 fireEvent.click(within(screen.getByText('60 selected').parentElement).getByRole('button',{name:'Approve',exact:true}));
 expect(await screen.findByText('59 of 60 events updated. 1 could not be updated and is still selected.')).toBeInTheDocument();
 expect(batches.map(ids=>ids.length)).toEqual([50,10]);
 expect(screen.getByText('1 selected')).toBeInTheDocument();
 expect(within(screen.getByText('Batch event 59').closest('tr')).getByRole('checkbox')).toBeChecked();
}, 20_000); // 60 rendered rows: generous under a loaded CI runner

it('refuses a merge larger than one request before the confirm', async () => {
 const events=Array.from({length:52},(_,i)=>({id:`dup-${i}`,title:`Duplicate ${i}`,adminStatus:'pending'}));
 const original=fetch.getMockImplementation();
 fetch.mockImplementation((url,options)=>{
  if(String(url).includes('/events/inbox'))return Promise.resolve(response({events,counts:{pending:52}}));
  return original(url,options);
 });
 const confirmSpy=vi.fn(()=>true);vi.stubGlobal('confirm',confirmSpy);
 render(<MemoryRouter initialEntries={['/admin/newsletter?tab=events']}><NewsletterPage/></MemoryRouter>);
 await screen.findByText('Duplicate 0');
 fireEvent.click(within(screen.getAllByRole('columnheader')[0]).getByRole('checkbox'));
 fireEvent.click(screen.getByRole('button',{name:'Merge 52'}));
 expect(await screen.findByText('Merge up to 51 events at a time. 52 are selected.')).toBeInTheDocument();
 expect(confirmSpy).not.toHaveBeenCalled();
 expect(fetch.mock.calls.some(([url])=>String(url).endsWith('/events/merge'))).toBe(false);
}, 20_000); // 52 rendered rows: generous under a loaded CI runner
