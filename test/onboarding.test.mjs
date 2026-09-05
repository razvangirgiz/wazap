import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseSetupChoice } from "../dist/setup.js";
import { checkChatgptEndpoint, effectiveChatgptConfig } from "../dist/chatgpt.js";
import { whereInstalled } from "../dist/connect.js";
import { applyTranscribe, applyWrites } from "../dist/settings.js";
import { offlineConfig } from "./helpers.mjs";
const run = promisify(execFile);
const binary = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const make = () => mkdtempSync(join(tmpdir(), 'wazap-onboarding-'));
function linked() {
  const root = make();
  mkdirSync(join(root, 'auth'));
  writeFileSync(join(root, 'auth/creds.json'), JSON.stringify({registered:true,me:{id:'15550100:1@s.whatsapp.net',name:'Demo'}}));
  writeFileSync(join(root, 'server.lock'), String(process.pid));
  return root;
}
function environment() {
  return {...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('WAZAP_'))), WAZAP_NO_UPDATE_CHECK:'1', WAZAP_TYPEWRITER:'1', TERM:'xterm-256color'};
}
async function ptyRun(root, args, steps, columns=100) {
  const job={argv:[process.execPath,binary,'setup','--no-global','--data-dir',root,...args],steps,columns};
  const result=await run('python3',[fileURLToPath(new URL('./setup-pty.py',import.meta.url)),JSON.stringify(job)],{env:environment(),maxBuffer:4_000_000,timeout:30_000});
  return JSON.parse(result.stdout);
}
const ptyOnly={skip:process.platform==='win32'?'POSIX PTY test; Windows CLI contract is covered separately':false};

test('terminal setup stays alive through animated screens and preserves transcription when deferred', ptyOnly, async()=>{
  const root=linked();
  const original='WAZAP_TRANSCRIBE=local\n# preserve this\n';
  writeFileSync(join(root,'.env'),original);
  const r=await ptyRun(root,['--client','chatgpt'],[
    {wait:'Choose [3]:',send:'3\n'},
    {wait:'Choose: [3]',send:'\n'},
  ]);
  assert.equal(r.code,0,r.output);
  assert.equal(r.steps_completed,2,r.output);
  assert.match(r.output,/connection still needs attention/);
  assert.match(r.output,/first read|first.*succeeds|complete only when/);
  assert.doesNotMatch(r.output,/✓ Setup complete/);
  assert.doesNotMatch(r.output,/5 \/ 4/);
  assert.match(r.output,/4 \/ 4/);
  assert.equal(readFileSync(join(root,'.env'),'utf8'),original);
});

test('new user can choose ChatGPT by name in a terminal simulation without pairing or writing', ptyOnly, async()=>{
  const root=make();
  const r=await ptyRun(root,['--dry-run','--service','--transcribe','openai'],[{wait:'Choose a name or number (Enter to decide later):',send:'chatgpt\n'}],60);
  assert.equal(r.code,0,r.output);
  assert.equal(r.steps_completed,1);
  assert.match(r.output,/Simulation finished/);
  assert.doesNotMatch(r.output,/Paste the API key|Pairing code:/);
  assert.deepEqual(readdirSync(root),[]);
});

test('invalid terminal choices never fall back to configuring detected clients',ptyOnly,async()=>{
 const root=make();
 const steps=Array.from({length:3},()=>({wait:'Choose a name or number (Enter to decide later):',send:'invalid\n'}));
 const r=await ptyRun(root,[],steps);
 assert.equal(r.code,1,r.output);
 assert.equal(r.steps_completed,3);
 assert.match(r.output,/No valid client selected/);
 assert.deepEqual(readdirSync(root),[]);
});

test('Enter at destination pauses setup instead of claiming success',ptyOnly,async()=>{
 const root=make();const r=await ptyRun(root,[],[{wait:'Choose a name or number (Enter to decide later):',send:'\n'}]);
 assert.equal(r.code,0,r.output);assert.match(r.output,/Setup paused/);assert.doesNotMatch(r.output,/Setup complete/);assert.deepEqual(readdirSync(root),[]);
});

test('simulation with all mutation flags preserves files byte for byte and needs no API key',async()=>{
 const root=linked();writeFileSync(join(root,'.env'),'WAZAP_TRANSCRIBE=local\n');
 const before=readFileSync(join(root,'.env'),'utf8');
 const result=await run(process.execPath,[binary,'setup','--client','chatgpt','--dry-run','--yes','--expose','--transcribe','openai','--data-dir',root],{env:environment()});
 assert.match(result.stderr,/Simulation only/);assert.equal(readFileSync(join(root,'.env'),'utf8'),before);
 assert.deepEqual(readdirSync(root).sort(),['.env','auth','server.lock']);
});

test('settings helpers also respect dry-run when called outside the wizard',async()=>{
 const root=make();const config=offlineConfig('wazap-setting-preview-',{dataDir:root,dryRun:true});
 await applyTranscribe(config,'openai');applyWrites(config,true);assert.deepEqual(readdirSync(root),[]);
});

test('ChatGPT is a first-class setup choice; multiple clients require explicit selection',()=>{
 assert.deepEqual(parseSetupChoice('1'),['chatgpt']);assert.deepEqual(parseSetupChoice('chatgpt'),['chatgpt']);
 assert.deepEqual(parseSetupChoice(''),[]);assert.deepEqual(parseSetupChoice('2,codex'),['claude-code','codex']);assert.equal(parseSetupChoice('all'),null);
});

test('checkout is never replaced by a different executable merely present on PATH',()=>{
 const root=make();mkdirSync(join(root,'bin'));writeFileSync(join(root,'bin/wazap'),'old executable');
 assert.equal(whereInstalled(binary,join(root,'bin')).kind,'checkout');
});

const config={transport:'http',publicUrl:'https://wazap.example.com',oauthPassword:'test-secret'};
function response(status, data, headers={}) {return new Response(JSON.stringify(data),{status,headers});}
const goodResource={resource:'https://wazap.example.com/mcp',authorization_servers:['https://wazap.example.com']};
const goodAuth={issuer:'https://wazap.example.com',authorization_endpoint:'https://wazap.example.com/authorize',token_endpoint:'https://wazap.example.com/token'};
test('endpoint verification checks discovery and authentication, never treats health alone as connection',async()=>{
 const seen=[];
 const result=await checkChatgptEndpoint(config,async(url,init)=>{
  seen.push(url);assert.equal(init.redirect,'error');assert.ok(init.signal);assert.ok(!JSON.stringify(init).includes('test-secret'));
  return seen.length===1?response(200,goodResource):seen.length===2?response(200,goodAuth):response(401,{}, {'www-authenticate':'Bearer resource_metadata="https://wazap.example.com/.well-known/oauth-protected-resource/mcp"'});
 });
 assert.equal(result.ready,true);assert.match(result.detail,/first read in ChatGPT is still pending/);assert.equal(seen.length,3);
});
for(const [label,responses] of [
 ['wrong URL',[response(200,{...goodResource,resource:'https://other.example/mcp'})]],
 ['missing OAuth',[response(404,{})]],
 ['wrong issuer',[response(200,goodResource),response(200,{...goodAuth,issuer:'https://other.example'})]],
 ['unprotected MCP',[response(200,goodResource),response(200,goodAuth),response(200,{})]],
])test(`endpoint verification refuses ${label}`,async()=>{
 const result=await checkChatgptEndpoint(config,async()=>responses.shift());assert.equal(result.ready,false);
});
test('unreachable endpoint gives a recovery step without leaking configuration',async()=>{
 const result=await checkChatgptEndpoint(config,async()=>{throw new Error('secret-token')});assert.equal(result.ready,false);assert.match(result.detail,/run setup again/);assert.doesNotMatch(result.detail,/secret-token/);
});

test('connection checker accepts the real SDK discovery document, including normalized issuer slash',async(t)=>{
 const {startHttpEndpoint}=await import('../dist/server.js');
 const {WazapOAuthProvider}=await import('../dist/oauth.js');
 const root=make(), stop=new AbortController();
 const oauth=new WazapOAuthProvider({publicUrl:new URL(config.publicUrl),password:'test-secret',stateFile:join(root,'oauth.json')});
 const port=await startHttpEndpoint({getStatus:()=>({status:'connected'})},offlineConfig('wazap-onboarding-http-',{dataDir:root}),{host:'127.0.0.1',port:0,credentials:[],openRead:false,oauth,signal:stop.signal});
 t.after(()=>stop.abort());
 const result=await checkChatgptEndpoint(config,(url,init)=>fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`,init));
 assert.equal(result.ready,true,result.detail);
});

test('guided setup detects an older running service instead of claiming new tools are ready',async(t)=>{
 const {createServer}=await import('node:http');
 const root=linked();
 const server=createServer(async(req,res)=>{
  if(req.method==='DELETE'){res.writeHead(204).end();return;}
  let body='';for await(const c of req)body+=c;
  const rpc=body?JSON.parse(body):{};
  if(rpc.method==='notifications/initialized'){res.writeHead(202).end();return;}
  const result=rpc.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'wazap',version:'0.13.0'}}:{content:[{type:'text',text:'connected'}],structuredContent:{status:'connected'}};
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 writeFileSync(join(root,'daemon.json'),JSON.stringify({pid:process.pid,port:server.address().port,version:'0.13.0',token:'synthetic-token'}));
 const r=await run(process.execPath,[binary,'setup','--client','chatgpt','--yes','--no-global','--data-dir',root],{env:environment(),timeout:15_000});
 assert.match(r.stderr,/running service uses a different version/);
 assert.match(r.stderr,/Running service: 0.13.0/);
 assert.match(r.stderr,/same setup with --service/);
 assert.doesNotMatch(r.stderr,/Setup complete/);
});

test('multi-account setup selects the named profile interactively without changing the registry',ptyOnly,async()=>{
 const root=make();
 const registry=JSON.stringify({version:1,accounts:[{id:'a_00000000000000000000000000000001',name:'Personal',enabled:true},{id:'a_00000000000000000000000000000002',name:'Business',enabled:true}]});
 writeFileSync(join(root,'accounts.json'),registry);
 const r=await ptyRun(root,['--client','chatgpt','--dry-run'],[{wait:'Account name or number:',send:'Business\n'}]);
 assert.equal(r.code,0,r.output);assert.equal(r.steps_completed,1);assert.match(r.output,/Simulation finished/);
 assert.equal(readFileSync(join(root,'accounts.json'),'utf8'),registry);assert.deepEqual(readdirSync(root),['accounts.json']);
 const refused=await run(process.execPath,[binary,'setup','--client','chatgpt','--dry-run','--yes','--data-dir',root],{env:environment()}).catch(e=>e);
 assert.equal(refused.code,1);assert.match(refused.stderr,/Choose an account for setup/);
});

test('effective ChatGPT config respects parsed overrides and only reloads saved settings explicitly',()=>{
 const root=make();writeFileSync(join(root,'.env'),'WAZAP_PUBLIC_URL=https://saved.example\nWAZAP_OAUTH_PASSWORD=saved\n');
 const configured=offlineConfig('wazap-onboarding-env-',{dataDir:root,publicUrl:'https://override.example',oauthPassword:'override'});
 assert.equal(effectiveChatgptConfig(configured).publicUrl,'https://override.example');
 assert.equal(effectiveChatgptConfig(configured).oauthPassword,'override');
 assert.equal(effectiveChatgptConfig(configured,true).publicUrl,'https://saved.example');
});
