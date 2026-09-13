// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
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
