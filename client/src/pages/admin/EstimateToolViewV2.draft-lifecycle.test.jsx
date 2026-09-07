// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';
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
