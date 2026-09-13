// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
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
