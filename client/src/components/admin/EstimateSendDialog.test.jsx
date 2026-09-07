// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateSendDialog from './EstimateSendDialog';
const preview = {
 id:'qa-estimate', status:'draft', editVersion:'a'.repeat(64), updatedAt:'2026-01-01T12:00:00Z',
 customerName:'QA Recipient', customerPhone:'+19415550100', customerEmail:'qa@example.invalid', address:'100 Example Court',
 previewPath:'/estimate/synthetic?adminPreview=1', messageVersion:'message-v1', groupVersions:null,
 messages:{sms:'QA, your estimate is ready: secure link',email:{subject:'Your estimate',text:'Review the saved offer.'}},
};
const json=(value,status=200)=>Promise.resolve({ok:status<400,status,json:async()=>value});
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
beforeEach(()=>{localStorage.setItem('waves_admin_token','fixture');});
describe('saved estimate send confirmation',()=>{
 it('opening, reading and choosing a channel do not send; one explicit confirmation hands off once',async()=>{
  let finish; const transport=new Promise(resolve=>{finish=resolve;});
  const fetcher=vi.fn((url,opts)=>opts?.method==='POST'?transport:json(preview));vi.stubGlobal('fetch',fetcher);
  render(<EstimateSendDialog request={{id:preview.id}} onClose={vi.fn()}/>);
  expect(await screen.findByText('QA Recipient')).toBeInTheDocument();
  const confirm=screen.getByRole('button',{name:'Confirm send'});expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('radio',{name:'Text message',exact:true}));
  expect(screen.getByText(preview.messages.sms)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(0);
  fireEvent.click(confirm);fireEvent.click(confirm);
  await waitFor(()=>expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1));
  const body=JSON.parse(fetcher.mock.calls.find(([,o])=>o?.method==='POST')[1].body);
  expect(body).toMatchObject({sendMethod:'sms',expectedEditVersion:preview.editVersion,messageVersion:preview.messageVersion});
  finish({ok:true,status:200,json:async()=>({sent:true,channels:{sms:{ok:true,real:true}}})});
  expect(await screen.findByText(/provider accepted; delivery not confirmed/)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Confirm send'})).not.toBeInTheDocument();
 });
 it('retries a lost response with exactly the same body and attempt key',async()=>{
  let posts=0;
  const fetcher=vi.fn((url,opts)=>{
   if(opts?.method!=='POST') return json(preview);
   posts++;return posts===1?Promise.reject(new Error('Connection lost')):json({sent:true,replayed:true,channels:{sms:{ok:true,real:true}}});
  });vi.stubGlobal('fetch',fetcher);
  render(<EstimateSendDialog request={{id:preview.id}} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Text message',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('saved estimate is retained');
  fireEvent.click(screen.getByRole('button',{name:'Check / retry attempt'}));
  expect(await screen.findByText(/No new message was sent/)).toBeInTheDocument();
  const bodies=fetcher.mock.calls.filter(([,o])=>o?.method==='POST').map(([,o])=>o.body);
  expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);
 });
 it('blocks an editor that opened an older saved revision and reports suppression without a success claim',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>json(preview)));
  const mounted=render(<EstimateSendDialog request={{id:preview.id,expectedEditVersion:'older'}} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Text message',exact:true}));
  expect(screen.getByRole('button',{name:'Confirm send'})).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('changed since the editor loaded');
  mounted.unmount();
  vi.stubGlobal('fetch',vi.fn((url,opts)=>opts?.method==='POST'?json({sent:false,channels:{sms:{ok:false,real:false,error:'SMS suppressed'}}},422):json(preview)));
  render(<EstimateSendDialog request={{id:preview.id}} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Text message',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByText(/Text message to .*SMS suppressed/)).toBeInTheDocument();
  expect(screen.queryByText(/provider accepted/)).not.toBeInTheDocument();
 });
});
