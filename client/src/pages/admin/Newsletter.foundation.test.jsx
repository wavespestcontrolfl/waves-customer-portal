// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import NewsletterPage from './NewsletterPage';
import { ComposeView } from './NewsletterTabs';
vi.mock('./EmailAutomationsPanelV2', () => ({default:()=> <div>Automation companion</div>}));
const response = body => ({ok:true,json:async()=>body});
function fixture(url, options={}) {
 const route = String(url).split('?')[0];
 if(route.endsWith('/auth/me'))return {email:'operator@example.invalid'};
 if(route.endsWith('/subscribers'))return {subscribers:[],counts:{active:3},total:3};
 if(route.endsWith('/tags'))return {tags:[]};
 if(route.endsWith('/quizzes'))return {quizzes:[]};
 if(route.endsWith('/latest-autopilot'))return {send:null};
 if(route.endsWith('/segment-preview'))return {count:3};
 if(route.endsWith('/calendar'))return {currentWeek:'2035-01-01',calendar:[{id:'plan-1',weekOf:'2035-01-01',topic:'Synthetic topic',homeownerMinuteTopic:'Synthetic tip',status:'planned',eventIds:[]}]};
 if(route.endsWith('/sends'))return options.method==='POST'?{send:{id:'draft-1'}}:{sends:[],counts:{sent:0}};
 if(route.endsWith('/validate'))return {errors:[],warnings:[]};
 return {};
}
beforeEach(()=>{localStorage.setItem('waves_admin_token','synthetic-token');vi.stubGlobal('fetch',vi.fn(async(url,options)=>response(fixture(url,options))));Element.prototype.scrollIntoView=vi.fn();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
function Location(){return <output data-testid="location">{useLocation().search}</output>;}
it('preserves unrelated URL filters and clears a draft deep link when changing workspace',async()=>{
 render(<MemoryRouter initialEntries={['/admin/newsletter?tab=calendar&draftId=draft-1&keep=yes']}><NewsletterPage/><Location/></MemoryRouter>);
 await screen.findByDisplayValue('Synthetic topic');
 fireEvent.click(within(screen.getByRole('navigation',{name:'Newsletter section'})).getByRole('button',{name:'Compose',exact:true}));
 expect(screen.getByTestId('location')).toHaveTextContent('keep=yes');expect(screen.getByTestId('location')).toHaveTextContent('tab=compose');expect(screen.getByTestId('location')).not.toHaveTextContent('draftId');
});
it('saves calendar edits to the existing row with both editor values',async()=>{
 render(<MemoryRouter initialEntries={['/admin/newsletter?tab=calendar']}><NewsletterPage/></MemoryRouter>);
 const input=await screen.findByDisplayValue('Synthetic topic');fireEvent.change(input,{target:{value:'Edited topic'}});fireEvent.blur(input);
 await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/api/admin/newsletter/calendar/plan-1',expect.objectContaining({method:'PATCH',body:JSON.stringify({topic:'Edited topic',homeownerMinuteTopic:'Synthetic tip'})})));
});
it('requires validation and typed SEND before the campaign send request',async()=>{
 render(<MemoryRouter><ComposeView/></MemoryRouter>);
 const subject=await screen.findByPlaceholderText('e.g. Florida spring pest alert — what to watch for');
 fireEvent.change(subject,{target:{value:'Synthetic subject'}});
 const body=screen.getByPlaceholderText('<h1>Subject line</h1><p>Your newsletter content here. The unsubscribe footer is appended automatically.</p>');fireEvent.change(body,{target:{value:'<p>Synthetic body</p>'}});
 fireEvent.click(screen.getByRole('button',{name:"Send To Audience"}));
 const dialog=await screen.findByRole('dialog');const send=within(dialog).getByRole('button',{name:'Send to all'});expect(send).toBeDisabled();
 expect(fetch.mock.calls.some(([url])=>String(url).endsWith('/send'))).toBe(false);
 fireEvent.change(within(dialog).getByPlaceholderText('SEND'),{target:{value:'SEND'}});expect(send).toBeEnabled();fireEvent.click(send);
 await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/api/admin/newsletter/sends/draft-1/send',expect.objectContaining({method:'POST'})));
});
it('clears stale summary badges when an automatic summary refresh fails',async()=>{
 render(<MemoryRouter><NewsletterPage/></MemoryRouter>);
 expect(await screen.findByRole('button',{name:'Audience (3)'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Schedule (0)'})).toBeInTheDocument();
 const priorImplementation=fetch.getMockImplementation();
 fetch.mockImplementation((url,options)=>{
  const route=String(url).split('?')[0];
  if(route.endsWith('/sends')||route.endsWith('/subscribers'))return Promise.reject(new Error('summary unavailable'));
  return priorImplementation(url,options);
 });
 fireEvent(window,new Event('online'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Audience'})).toBeInTheDocument());
 expect(screen.getByRole('button',{name:'Schedule'})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Audience (3)'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Schedule (0)'})).not.toBeInTheDocument();
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
