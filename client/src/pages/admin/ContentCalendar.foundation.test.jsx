// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import ContentCalendar from './ContentCalendar';
const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
const day = `${month}-12`;
beforeEach(() => {
  localStorage.setItem('waves_admin_token','synthetic-token');
  vi.stubGlobal('fetch',vi.fn(async url => ({ok:true,json:async()=>String(url).includes('/calendar?') ? {calendar:[{title:'ET overnight',type:'social',scheduledDate:`${month}-13T02:00:00Z`,status:'scheduled'},{title:'Date only',type:'blog',scheduledDate:day,status:'scheduled'}]} : String(url).includes('/blog?') ? {posts:[{id:'draft-1',title:'Synthetic draft'}]} : {}})));
});
afterEach(() => {cleanup();vi.unstubAllGlobals();localStorage.clear();});
it('groups timestamps in Eastern time and preserves date-only entries and month navigation',async()=>{
  render(<ContentCalendar/>);
  const dateButton = await screen.findByRole('button',{name:/12, .*2 scheduled items/});
  fireEvent.click(dateButton);
  // Each item shows twice: once in the month cell, once in the selected-day
  // list. The cell prefixes the content type so it is readable without colour.
  expect(screen.getByText('ET overnight')).toBeInTheDocument();
  expect(screen.getByTitle('Social: ET overnight')).toHaveTextContent('Social · ET overnight');
  expect(screen.getByText('Date only')).toBeInTheDocument();
  expect(screen.getByTitle('Blog: Date only')).toHaveTextContent('Blog · Date only');
  fireEvent.click(screen.getByRole('button',{name:'Next month'}));
  const next = new Date(now.getFullYear(),now.getMonth()+1,1);
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`start=${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-01`),expect.anything()));
});
it('validates a draft and preserves the blog schedule payload and selected date',async()=>{
  render(<ContentCalendar/>);
  fireEvent.click(await screen.findByRole('button',{name:/12, .*2 scheduled items/}));
  fireEvent.click(screen.getByRole('button',{name:'Schedule Blog'}));
  const dialog=screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button',{name:'Schedule',exact:true}));
  expect(screen.getByRole('status')).toHaveTextContent('Pick a blog draft');
  expect(fetch.mock.calls.some(([,o])=>o.method==='POST')).toBe(false);
  await screen.findByRole('option',{name:'Synthetic draft'});
  fireEvent.change(screen.getByLabelText('Draft'),{target:{value:'draft-1'}});
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(within(dialog).getByRole('button',{name:'Schedule',exact:true}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/api/admin/content/schedule-blog/draft-1',expect.objectContaining({method:'POST',body:JSON.stringify({publishAt:`${day}T09:00:00`,autoShareSocial:false})})));
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('preserves social scheduling payload and keeps errors in the dialog',async()=>{
  render(<ContentCalendar/>);
  fireEvent.click(await screen.findByRole('button',{name:/12, .*2 scheduled items/}));
  fireEvent.click(screen.getByRole('button',{name:'Schedule Social'}));
  fireEvent.change(screen.getByLabelText('Title'),{target:{value:' Synthetic post '}});
  fetch.mockImplementationOnce(async()=>({ok:false,status:503}));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Schedule',exact:true}));
  await screen.findByText('Failed: HTTP 503');
  expect(screen.getByLabelText('Title')).toHaveValue(' Synthetic post ');
  expect(fetch).toHaveBeenLastCalledWith('/api/admin/content/schedule-social',expect.objectContaining({method:'POST',body:JSON.stringify({title:'Synthetic post',description:'',link:'',scheduledFor:`${day}T09:00:00`,platforms:[]})}));
});

function calendarFetch(onCalendar) {
  return vi.fn(async url => {
    const body = String(url).includes('/calendar?') ? await onCalendar(String(url)) : {};
    if (body instanceof Error) return {ok:false,status:503};
    return {ok:true,json:async()=>body};
  });
}

it('clears the selected day on month change so Schedule Social never prefills a rolled-over date',async()=>{
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(new Date(2026,9,15,12));
  try {
    vi.stubGlobal('fetch',calendarFetch(()=>({calendar:[]})));
    render(<ContentCalendar/>);
    fireEvent.click(await screen.findByRole('button',{name:/October 31, 2026/}));
    expect(screen.getByRole('button',{name:'Schedule Social'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Next month'}));
    expect(await screen.findByRole('heading',{name:'November 2026'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Schedule Social'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Schedule',exact:true}));
    expect(within(screen.getByRole('dialog')).getByLabelText('Date')).not.toHaveValue('2026-12-01');
  } finally {
    vi.useRealTimers();
  }
});

it('ignores a slow earlier month response that resolves after the current month loaded',async()=>{
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(new Date(2026,9,15,12));
  try {
    let releaseOctober;
    vi.stubGlobal('fetch',calendarFetch(url=>url.includes('start=2026-10-01')
      ? new Promise(resolve=>{releaseOctober=resolve;})
      : {calendar:[{title:'November item',type:'social',scheduledDate:'2026-11-12',status:'scheduled'}]}));
    render(<ContentCalendar/>);
    await waitFor(()=>expect(releaseOctober).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button',{name:'Next month'}));
    await screen.findByTitle('Social: November item');
    await act(async()=>{releaseOctober({calendar:[{title:'Old October item',type:'blog',scheduledDate:'2026-11-12',status:'scheduled'},{title:'Another',type:'blog',scheduledDate:'2026-11-13',status:'scheduled'}]});});
    expect(screen.getByTitle('Social: November item')).toBeInTheDocument();
    expect(screen.queryByTitle('Blog: Old October item')).not.toBeInTheDocument();
    expect(screen.getByText('1 posts this month')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('shows an unavailable state with retry on a failed read, and the plain empty state on an empty one',async()=>{
  let fail=true;
  vi.stubGlobal('fetch',calendarFetch(()=>fail?new Error('down'):{calendar:[]}));
  render(<ContentCalendar/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Calendar unavailable: HTTP 503');
  expect(screen.queryByText(/posts this month/)).not.toBeInTheDocument();
  fail=false;
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  expect(await screen.findByText('0 posts this month')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
