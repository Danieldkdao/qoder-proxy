'use strict';
// ── State
interface Model { id: string; label: string; }
interface ChatMessage { role: 'user' | 'assistant'; content: string; }
interface DashboardConfig { publicBaseUrl: string; authEnabled: boolean; version: string; }
let config: DashboardConfig;
let models: Model[] = [];
let conversation: ChatMessage[] = [];
let pending: AbortController | undefined;
const content = document.getElementById('content')!;
function escHtml(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
function mdToHtml(value: string): string { return escHtml(value); }
function syntaxJson(value: unknown): string { return escHtml(JSON.stringify(value,null,2)); }
function copyText(value: string): void { void navigator.clipboard.writeText(value).catch(()=>showError('Clipboard unavailable')); }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] { const el=document.createElement(tag);el.textContent=text;return el; }
function showError(message: string): void { const el=node('p',message);el.className='error';content.append(el); }
async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Dashboard-Request':'1',...options.headers}});
  if(response.status===401){window.location.assign('/dashboard/login');throw Error('Session expired');}
  if(!response.ok)throw Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
function button(label: string, action: ()=>void): HTMLButtonElement { const el=node('button',label);el.className='btn btn-ghost';el.addEventListener('click',action);return el; }
async function page(name: string): Promise<void> {
  pending?.abort();pending=undefined;content.replaceChildren();
  try {
    if(name==='playground'){renderChat();return;}
    if(name==='logs'||name==='system-logs'){
      const url=name==='logs'?'/dashboard/api/logs':'/dashboard/api/logs/system';
      content.append(node('h1',name==='logs'?'Request logs':'System logs'));
      const data=await api<{logs:unknown[]}>(url);const pre=node('pre',JSON.stringify(data.logs,null,2));content.append(pre);
      content.append(button('Refresh',()=>{void page(name);}),button('Clear',()=>{void api(url,{method:'DELETE'}).then(()=>page(name)).catch(e=>showError(String(e)));}));return;
    }
    content.append(node('h1','Qoder proxy'),node('p',`Version ${config.version}`));
    const url=(config.publicBaseUrl||window.location.origin)+'/v1';content.append(node('code',url),button('Copy base URL',()=>copyText(url)));
    content.append(node('p','Use your configured PROXY_API_KEY in Hermes. The dashboard never sends that secret to the browser.'));
    const status=await api<Record<string,unknown>>('/dashboard/api/status');content.append(node('pre',JSON.stringify(status,null,2)));
  }catch(error){showError(error instanceof Error?error.message:String(error));}
}
function renderChat():void {
  content.append(node('h1','Playground'));
  const select=node('select');for(const model of models){const option=node('option',model.label);option.value=model.id;select.append(option);}
  const mode=node('select');for(const [value,label] of [['true','Streaming'],['false','Non-streaming']] as const){const option=node('option',label);option.value=value;mode.append(option);}
  const transcript=node('pre',conversation.map(m=>`${m.role}: ${m.content}`).join('\n\n'));
  const input=node('textarea');input.placeholder='Message';const send=button('Send',()=>{void submit();});
  const stop=button('Stop',()=>pending?.abort());
  const clear=button('Clear',()=>{pending?.abort();conversation=[];void page('playground');});
  content.append(select,mode,transcript,input,send,stop,clear);
  const render=()=>{transcript.textContent=conversation.map(m=>`${m.role}: ${m.content}`).join('\n\n');};
  async function submit():Promise<void>{
    const text=input.value.trim();if(!text||pending)return;
    conversation.push({role:'user',content:text});input.value='';
    const outgoing=[...conversation];const assistant:ChatMessage={role:'assistant',content:''};conversation.push(assistant);render();
    const controller=new AbortController();pending=controller;send.disabled=true;
    try {
      const response=await fetch('/dashboard/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Dashboard-Request':'1'},body:JSON.stringify({model:select.value,stream:mode.value==='true',messages:outgoing}),signal:controller.signal});
      if(!response.ok){const data=await response.json() as {error?:{message?:string}};throw Error(data.error?.message||`HTTP ${response.status}`);}
      if(mode.value==='true'){
        const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
        const consume=(line:string)=>{
          if(!line.startsWith('data: ')||line==='data: [DONE]')return;
          const event=JSON.parse(line.slice(6)) as {error?:{message:string};choices?:Array<{delta?:{content?:string}}>};
          if(event.error)throw Error(event.error.message);assistant.content+=event.choices?.[0]?.delta?.content||'';render();
        };
        try {while(true){const result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true});let at:number;while((at=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,at).trimEnd());buffer=buffer.slice(at+1);}}buffer+=decoder.decode();if(buffer.trim())consume(buffer.trim());}
        finally{await reader.cancel().catch(()=>{});}
      }else{const data=await response.json() as {choices:Array<{message:{content:string}}>};assistant.content=data.choices[0]?.message.content||'';render();}
    }catch(error){assistant.content+='\n'+(controller.signal.aborted?'Stopped':error instanceof Error?error.message:String(error));render();}
    finally{if(pending===controller)pending=undefined;send.disabled=false;}
  }
}
async function init():Promise<void>{
  if(window.location.pathname==='/dashboard/login'){
    document.getElementById('app')!.hidden=true;document.getElementById('login-container')!.hidden=false;
    if(new URLSearchParams(location.search).has('error'))document.getElementById('login-err')!.hidden=false;return;
  }
  try{
    config=await api<DashboardConfig>('/dashboard/api/config');models=(await api<{models:Model[]}>('/dashboard/api/models')).models;
    for(const link of document.querySelectorAll<HTMLAnchorElement>('[data-page]'))link.addEventListener('click',()=>{void page(link.dataset.page||'endpoints');});
    await page('endpoints');
  }catch(error){showError(String(error));}
}
void init();
