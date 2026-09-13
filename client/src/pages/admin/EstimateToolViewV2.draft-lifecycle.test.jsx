// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';
import { IntelligenceBarPageDataProvider, useIntelligenceBarActions, useIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';
function AssistantOutcome() { const { notifyMutation } = useIntelligenceBarActions(); const pageData = useIntelligenceBarPageData(); return <><button onClick={() => notifyMutation({ id: 'operation-a', domain: 'estimate', estimate_id: source.id })}>Assistant saved estimate</button><button onClick={() => notifyMutation({ id: 'unrelated', domain: 'inventory' })}>Assistant saved inventory</button><output aria-label="Current assistant targets">{JSON.stringify(pageData)}</output></>; }
const { openSend }=vi.hoisted(()=>({openSend:vi.fn()}));
vi.mock('../../components/admin/EstimateSendDialog',()=>({useEstimateSend:()=>openSend}));
const result={recurring:{tier:'Bronze',grandTotal:50,annualAfterDiscount:600,services:[{service:'pest_control',name:'Pest Control',mo:50,annual:600}]},oneTime:{total:99,items:[]},results:{},totals:{year2mo:50,year1:699}};
const request={profile:{homeSqFt:2000,lotSqFt:6000},selectedServices:['PEST'],options:{pestTier:'quarterly'}};
const source={id:'qa-draft',status:'draft',editable:true,editVersion:'first-version',customerName:'QA Contact',customerPhone:'+19415550100',customerEmail:'qa@example.invalid',address:'100 Example Court',propertyId:'qa-property',inputs:{svcPest:true,homeSqFt:'2000',lotSqFt:'6000'},engineRequest:request,result,token:'synthetic-preview-token'};
const response=(data,status=200)=>Promise.resolve({ok:status<400,status,json:async()=>data,clone(){return this;},text:async()=>JSON.stringify(data)});
let currentSource;let writes;let fetcher;
beforeEach(()=>{
 localStorage.setItem('waves_admin_token','fixture');writes=[];currentSource=structuredClone(source);openSend.mockReset();
 vi.spyOn(window,'confirm').mockReturnValue(true);vi.spyOn(window,'alert').mockImplementation(()=>{});
 fetcher=vi.fn((url,opts={})=>{
  if(String(url).endsWith('/edit-source')) return response(currentSource);
  if(opts.method==='PUT') {const body=JSON.parse(opts.body);writes.push(body);return response({id:source.id,status:'draft',editVersion:'saved-version',token:source.token});}
  if(String(url).endsWith('/calculate-estimate'))return response(structuredClone(result));
  if(String(url).includes('/discounts'))return response([]);
  return response({});
 });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});
const renderEditor=(props={})=>render(<MemoryRouter><EstimateToolViewV2 {...props}/></MemoryRouter>);
const committed=()=>writes.filter(b=>!b.dryRun);
describe('draft identity and reviewed version',()=>{
 it('reopens the saved request and keeps server replay inputs on a contact-only revision',async()=>{
  renderEditor({editEstimateId:source.id});
  const name=await screen.findByDisplayValue('QA Contact');
  fireEvent.change(name,{target:{value:'QA Updated'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft',exact:true}));
  await waitFor(()=>expect(committed()).toHaveLength(1));
  expect(committed()[0]).toMatchObject({expectedEditVersion:'first-version',customerName:'QA Updated',propertyId:'qa-property',estimateData:{engineRequest:request,inputs:{svcPest:true,homeSqFt:'2000'}}});
  expect(fetcher.mock.calls.filter(([url,o])=>String(url).endsWith('/api/admin/estimates')&&o?.method==='POST')).toHaveLength(0);
 });
 it('hydrates the fields belonging to a new version after the send outcome, so a concurrent edit is not overwritten',async()=>{
  renderEditor({editEstimateId:source.id});await screen.findByDisplayValue('QA Contact');
  openSend.mockImplementation(async()=>{
   currentSource={...structuredClone(source),status:'sent',editVersion:'concurrent-version',customerName:'QA Newer Editor',inputs:{...source.inputs,homeSqFt:'3100'},engineRequest:{...request,profile:{...request.profile,homeSqFt:3100}}};
   return {sent:true};
  });
  fireEvent.click(screen.getByRole('button',{name:'Review and send',exact:true}));
  const newer=await screen.findByDisplayValue('QA Newer Editor');
  expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(3100);
  fireEvent.change(newer,{target:{value:'QA Final Contact'}});
  fireEvent.click(screen.getByRole('button',{name:'Save changes',exact:true}));
  await waitFor(()=>expect(committed()).toHaveLength(1));
  expect(committed()[0]).toMatchObject({expectedEditVersion:'concurrent-version',estimateData:{inputs:{homeSqFt:'3100'},engineRequest:{profile:{homeSqFt:3100}}}});
 });
 it('retries a lost create response with the same draft UUID and then revises that saved identity',async()=>{
  let creates=0;const createBodies=[];
  const original=fetcher.getMockImplementation();
  fetcher.mockImplementation((url,opts={})=>{
   if(String(url)==='/api/admin/estimates'&&opts.method==='POST'){
    creates++;createBodies.push(JSON.parse(opts.body));
    return creates===1?Promise.reject(new Error('Lost response')):response({id:'persisted-qa-draft',status:'draft',editVersion:'created-version',token:source.token});
   }
   return original(url,opts);
  });
  renderEditor();
  fireEvent.change(screen.getByLabelText('Customer name'),{target:{value:'QA New'}});
  fireEvent.change(screen.getByLabelText('Service address'),{target:{value:'200 Example Court'}});
  fireEvent.change(screen.getByLabelText('Home Sq Ft'),{target:{value:'2000'}});
  fireEvent.click(screen.getByRole('checkbox',{name:'Pest Control',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Generate Estimate',exact:true}));
  const save=await screen.findByRole('button',{name:'Save draft',exact:true});fireEvent.click(save);
  expect(await screen.findByText('Lost response')).toBeInTheDocument();
  fireEvent.click(save);
  await waitFor(()=>expect(createBodies).toHaveLength(2));
  expect(createBodies[0].clientDraftId).toMatch(/^[a-f0-9-]{36}$/);
  expect(createBodies[1].clientDraftId).toBe(createBodies[0].clientDraftId);
  await screen.findByText(/Draft saved/);
  fireEvent.change(screen.getByLabelText('Customer name'),{target:{value:'QA New Updated'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft',exact:true}));
  await waitFor(()=>expect(committed()).toHaveLength(1));
  expect(creates).toBe(2);
  expect(fetcher.mock.calls.some(([url,o])=>url==='/api/admin/estimates/persisted-qa-draft'&&o?.method==='PUT')).toBe(true);
 });
});

describe('assistant estimate refresh', () => {
 const mount = () => render(<MemoryRouter><IntelligenceBarPageDataProvider><AssistantOutcome /><EstimateToolViewV2 editEstimateId={source.id} /></IntelligenceBarPageDataProvider></MemoryRouter>);
 it('refreshes the matching saved editor and publishes only its current record identifiers', async () => {
  mount();await screen.findByDisplayValue('QA Contact');
  await waitFor(() => {
   expect(screen.getByRole('status', { name: 'Current assistant targets' })).toHaveTextContent('qa-property');
   expect(screen.getByRole('status', { name: 'Current assistant targets' })).toHaveTextContent('qa-draft');
   expect(screen.getByRole('status', { name: 'Current assistant targets' })).not.toHaveTextContent('QA Contact');
  });
  currentSource={...structuredClone(source),editVersion:'assistant-version',customerName:'QA Assistant Saved'};
  fireEvent.click(screen.getByRole('button',{name:'Assistant saved estimate'}));
  await screen.findByDisplayValue('QA Assistant Saved');
  fireEvent.change(screen.getByLabelText('Customer name'),{target:{value:'QA Operator Edit'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft',exact:true}));
  await waitFor(()=>expect(committed()).toHaveLength(1));
  expect(committed()[0].expectedEditVersion).toBe('assistant-version');
 });
 it('keeps the editor usable after a failed refresh and retries the saved version', async () => {
  mount();await screen.findByDisplayValue('QA Contact');
  const original=fetcher.getMockImplementation();
  let refreshCalls=0;
  fetcher.mockImplementation((url,opts)=>{
   if(!String(url).endsWith('/edit-source')) return original(url,opts);
   refreshCalls++;
   return refreshCalls===1 ? response({error:'Temporary refresh failure'},503)
    : response({...source,customerName:'QA Recovered',editVersion:'recovered-version'});
  });
  fireEvent.click(screen.getByRole('button',{name:'Assistant saved estimate'}));
  await screen.findByText('Temporary refresh failure',{exact:false});
  expect(screen.getByLabelText('Customer name')).toHaveValue('QA Contact');
  expect(screen.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
  expect(refreshCalls).toBe(1);
  fireEvent.click(screen.getByRole('button',{name:'Retry',exact:true}));
  await screen.findByDisplayValue('QA Recovered');
  expect(refreshCalls).toBe(2);
  expect(screen.queryByText('Temporary refresh failure',{exact:false})).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Customer name'),{target:{value:'QA After Retry'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft',exact:true}));
  await waitFor(()=>expect(committed()).toHaveLength(1));
  expect(committed()[0].expectedEditVersion).toBe('recovered-version');
 });
 it('preserves edits made after a failed refresh when Retry is clicked', async () => {
  mount();await screen.findByDisplayValue('QA Contact');
  const original=fetcher.getMockImplementation();
  fetcher.mockImplementation((url,opts)=>String(url).endsWith('/edit-source')
   ? response({error:'Temporary refresh failure'},503) : original(url,opts));
  fireEvent.click(screen.getByRole('button',{name:'Assistant saved estimate'}));
  await screen.findByText('Temporary refresh failure',{exact:false});
  fireEvent.change(screen.getByLabelText('Customer name'),{target:{value:'QA Unsaved After Failure'}});
  fireEvent.click(screen.getByRole('button',{name:'Retry',exact:true}));
  await screen.findByText(/Your unsaved edits are still here/);
  expect(screen.getByLabelText('Customer name')).toHaveValue('QA Unsaved After Failure');
  expect(committed()).toHaveLength(0);
 });
 it.each(['before','during'])('preserves unsaved fields entered %s the assistant refresh', async timing => {
  mount();await screen.findByDisplayValue('QA Contact');
  let finish;
  if(timing==='during'){
   const original=fetcher.getMockImplementation();
   fetcher.mockImplementation((url,opts)=>String(url).endsWith('/edit-source')?new Promise(resolve=>{finish=resolve;}):original(url,opts));
   fireEvent.click(screen.getByRole('button',{name:'Assistant saved estimate'}));
   await waitFor(()=>expect(finish).toBeTypeOf('function'));
  }
  fireEvent.change(screen.getByLabelText('Customer name'),{target:{value:'QA Unsaved'}});
  if(timing==='before')fireEvent.click(screen.getByRole('button',{name:'Assistant saved estimate'}));
  else await act(async()=>finish(await response({...source,customerName:'QA Server Newer',editVersion:'newer'})));
  expect(await screen.findByText(/Your unsaved edits are still here/)).toBeInTheDocument();
  expect(screen.getByLabelText('Customer name')).toHaveValue('QA Unsaved');
  expect(committed()).toHaveLength(0);
 });
 it('keeps a matching refresh in flight when an unrelated receipt arrives', async () => {
  mount();await screen.findByDisplayValue('QA Contact');
  let finish;
  const original=fetcher.getMockImplementation();
  fetcher.mockImplementation((url,opts)=>String(url).endsWith('/edit-source')?new Promise(resolve=>{finish=resolve;}):original(url,opts));
  fireEvent.click(screen.getByRole('button',{name:'Assistant saved estimate'}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button',{name:'Assistant saved inventory'}));
  await act(async()=>finish(await response({...source,customerName:'QA Refreshed',editVersion:'refreshed'})));
  await screen.findByDisplayValue('QA Refreshed');
 });
 it('removes the prior estimate context while another saved estimate is loading', async () => {
  currentSource={...currentSource,customerId:'qa-customer-a'};
  const tree=id=><MemoryRouter><IntelligenceBarPageDataProvider><AssistantOutcome /><EstimateToolViewV2 editEstimateId={id} /></IntelligenceBarPageDataProvider></MemoryRouter>;
  const view=render(tree(source.id));await screen.findByDisplayValue('QA Contact');
  await waitFor(()=>expect(screen.getByRole('status',{name:'Current assistant targets'})).toHaveTextContent('qa-draft'));
  let finish;
  const original=fetcher.getMockImplementation();
  fetcher.mockImplementation((url,opts)=>String(url).endsWith('/edit-source')?new Promise(resolve=>{finish=resolve;}):original(url,opts));
  view.rerender(tree('qa-next-draft'));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  const targets=screen.getByRole('status',{name:'Current assistant targets'});
  expect(targets).not.toHaveTextContent('qa-draft');
  expect(targets).not.toHaveTextContent('qa-property');
  expect(targets).not.toHaveTextContent('qa-customer-a');
  await act(async()=>finish(await response({...source,id:'qa-next-draft',customerId:'qa-customer-b',propertyId:'qa-property-b',customerName:'QA Next'})));
  await screen.findByDisplayValue('QA Next');
  await waitFor(()=>{
   expect(targets).toHaveTextContent('qa-next-draft');
   expect(targets).toHaveTextContent('qa-property-b');
   expect(targets).toHaveTextContent('qa-customer-b');
  });
 });
});
