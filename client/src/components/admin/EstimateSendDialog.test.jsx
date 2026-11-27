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
  expect(screen.getByRole('button',{name:'Confirm send'})).toHaveAttribute('aria-busy','true');
  expect(confirm).toBeDisabled();
  const body=JSON.parse(fetcher.mock.calls.find(([,o])=>o?.method==='POST')[1].body);
  expect(body).toMatchObject({sendMethod:'sms',expectedEditVersion:preview.editVersion,messageVersion:preview.messageVersion});
  expect(body).not.toHaveProperty('confirmedPalmCount');
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
 it('a satellite palm count asks for the typed count: none or another number is refused before any send, the priced one rides the attempt',async()=>{
  const fetcher=vi.fn((url,opts)=>opts?.method==='POST'?json({sent:true,channels:{sms:{ok:true,real:true}}}):json({...preview,satellitePalmCount:14}));vi.stubGlobal('fetch',fetcher);
  render(<EstimateSendDialog request={{id:preview.id}} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Text message',exact:true}));
  const count=screen.getByLabelText(/Palms you counted on the aerial photo/);
  expect(count).toHaveAccessibleDescription(/Count a clump or a multi-trunk palm as one palm/);
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Type the number of palms you counted on the aerial photo.');
  fireEvent.change(count,{target:{value:'6'}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('You counted 6 palms, but this quote priced 14. Rebuild the quote with 6 palms in the estimate builder, then send it.');
  expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(0);
  fireEvent.change(count,{target:{value:'14'}});
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  await waitFor(()=>expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1));
  expect(JSON.parse(fetcher.mock.calls.find(([,o])=>o?.method==='POST')[1].body)).toMatchObject({confirmedPalmCount:14});
 });
 it('an impossible saved US phone shows the reason and leaves only the email channel selectable',async()=>{
  const reason='+11035550123 is not a valid US phone number. Fix the phone on the contact or the estimate, then send again. Nothing was sent.';
  vi.stubGlobal('fetch',vi.fn(()=>json({...preview,customerPhone:'+11035550123',smsBlockReason:reason})));
  render(<EstimateSendDialog request={{id:preview.id}} onClose={vi.fn()}/>);
  expect(await screen.findByText(reason)).toBeInTheDocument();
  expect(screen.getByRole('radio',{name:'Text message',exact:true})).toBeDisabled();
  expect(screen.getByRole('radio',{name:'Text message and email',exact:true})).toBeDisabled();
  expect(screen.getByRole('radio',{name:'Email',exact:true})).not.toBeDisabled();
 });
 it('unlocks channel/schedule controls and uses a fresh attempt key after a pre-dispatch 400 rejection',async()=>{
  let posts=0;
  const fetcher=vi.fn((url,opts)=>{
   if(opts?.method!=='POST') return json(preview);
   posts++;
   if(posts===1) return json({error:'SMS channel unavailable'},400);
   return json({sent:true,channels:{email:{ok:true,real:true}}});
  });vi.stubGlobal('fetch',fetcher);
  render(<EstimateSendDialog request={{id:preview.id}} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Text message',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('SMS channel unavailable');
  expect(screen.getByRole('alert')).not.toHaveTextContent('Retrying checks the same attempt');
  const emailRadio=screen.getByRole('radio',{name:'Email',exact:true});
  expect(emailRadio).not.toBeDisabled();
  fireEvent.click(emailRadio);
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByText(/provider accepted; delivery not confirmed/)).toBeInTheDocument();
  const bodies=fetcher.mock.calls.filter(([,o])=>o?.method==='POST').map(([,o])=>JSON.parse(o.body));
  expect(bodies).toHaveLength(2);
  expect(bodies[0].sendMethod).toBe('sms');
  expect(bodies[1].sendMethod).toBe('email');
  expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
 });
 it('handles non-JSON 502 error bodies without throwing a JSON parse crash',async()=>{
  const fetcher=vi.fn((url,opts)=>opts?.method==='POST'
   ? Promise.resolve({ok:false,status:502,json:async()=>{throw new SyntaxError('Unexpected token <');}})
   : json(preview));
  vi.stubGlobal('fetch',fetcher);
  render(<EstimateSendDialog request={{id:preview.id}} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Email',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('The saved estimate is retained. Retrying checks the same attempt.');
 });
 it('treats an unreadable JSON body on 200 OK as uncertain, preserves the attempt key, and notifies onClose',async()=>{
  let posts=0;
  const onClose=vi.fn();
  const fetcher=vi.fn((url,opts)=>{
   if(opts?.method!=='POST') return json(preview);
   posts++;
   return posts===1
    ? Promise.resolve({ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected end of JSON');}})
    : json({sent:true,replayed:true,channels:{email:{ok:true,real:true}}});
  });
  vi.stubGlobal('fetch',fetcher);
  render(<EstimateSendDialog request={{id:preview.id}} onClose={onClose}/>);
  fireEvent.click(await screen.findByRole('radio',{name:'Email',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('unreadable send receipt');
  expect(screen.getByRole('button',{name:'Check / retry attempt'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(onClose).toHaveBeenCalledWith({uncertain:true});
  fireEvent.click(screen.getByRole('button',{name:'Check / retry attempt'}));
  expect(await screen.findByText(/No new message was sent/)).toBeInTheDocument();
  const bodies=fetcher.mock.calls.filter(([,o])=>o?.method==='POST').map(([,o])=>o.body);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
 });
 it('restricts selectable channels when allowedChannels is passed for a failed-channel retry',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>json(preview)));
  render(<EstimateSendDialog request={{id:preview.id,allowedChannels:['email']}} onClose={vi.fn()}/>);
  expect(await screen.findByText('QA Recipient')).toBeInTheDocument();
  expect(screen.getByRole('radio',{name:'Text message',exact:true})).toBeDisabled();
  expect(screen.getByRole('radio',{name:'Text message and email',exact:true})).toBeDisabled();
  expect(screen.getByRole('radio',{name:'Email',exact:true})).not.toBeDisabled();
 });
});
