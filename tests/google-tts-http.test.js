const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {fixture,json}=require('../test-support/server-fixture');
const {payload}=require('../test-support/tts-wav');
const env={T2A_PROVIDER:'google-gemini',T2A_GOOGLE_PROJECT:'test-project',NODE_OPTIONS:'--require='+path.join(__dirname,'../test-support/gemini-transport.cjs')};
test('Gemini TTS aliases, formats, output modes, auth and validation',async t=>{
 const f=await fixture(t,{env,handle(req,res,body){if(req.url!=='/gemini')return false;assert.equal(body.generationConfig.responseModalities[0],'AUDIO');json(res,200,payload());return true;}});
 for(const route of ['/t2a','/api/t2a']){
  assert.equal((await f.request(route,{headers:{}})).status,401);
  for(const body of [{text:''},{text:'test',voice_id:'Kore'},{text:'test',voice_choice:'cantonese_male_1',speed:1},{text:'test',sample_rate:12345}])assert.equal((await f.request(route,{body})).status,400);
  assert.equal((await f.request(route,{body:{text:'x',stream:true}})).status,501);
  assert.equal((await f.request(route,{body:{text:'字'.repeat(201)}})).status,413);
  for(const format of ['mp3','wav','pcm'])for(const mode of ['binary','base64_json']){
   const r=await f.request(route,{body:{text:'測試',format,response_mode:mode}});assert.equal(r.status,200);
   if(mode==='binary'){assert.match(r.headers.get('content-disposition'),new RegExp('speech\\.'+format));assert.ok((await r.arrayBuffer()).byteLength>0);}
   else{const b=await r.json();assert.deepEqual(Object.keys(b).sort(),['ok','audio','format','mime','contentType','size','provider'].sort());assert.equal(b.format,format);assert.equal(Buffer.from(b.audio,'base64').length,b.size);}
  }
 }
});
test('Gemini TTS timeout, quota and subsequent admission recovery',async t=>{
 const f=await fixture(t,{env:{...env,T2A_INVOKE_TIMEOUT_MS:'1000',GOOGLE_GEMINI_MAX_CONCURRENCY:'1'},handle(req,res,body){
  if(req.url!=='/gemini')return false;
  const text=body.contents[0].parts[0].text;
  if(text==='slow')return true;
  if(text==='quota'){json(res,429,{error:'private'});return true;}
  json(res,200,payload());return true;
 }});
 assert.equal((await f.request('/t2a',{body:{text:'slow'}})).status,504);
 assert.equal((await f.request('/t2a',{body:{text:'quota'}})).status,429);
 const results=await Promise.all(['one','two'].map(text=>f.request('/t2a',{body:{text}})));
 for(const r of results){assert.equal(r.status,200);await r.arrayBuffer();}
});
test('Gemini rewrite and TTS coexist, share admission, and accept the configured text boundary',async t=>{
 const f=await fixture(t,{env:{...env,REWRITE_PROVIDER:'google-gemini',REWRITE_GOOGLE_PROJECT:'test-project',T2A_MAX_TEXT_LENGTH:'1000',GOOGLE_GEMINI_MAX_CONCURRENCY:'1'},handle(req,res,body){
  if(req.url!=='/gemini')return false;
  if(body.generationConfig.responseModalities)json(res,200,payload());
  else json(res,200,{candidates:[{finishReason:'STOP',content:{parts:[{text:'正式文字'}]}}]});
  return true;
 }});
 const responses=await Promise.all([f.request('/rewrite'),f.request('/t2a',{body:{text:'字'.repeat(1000),voice_choice:'english_narrator_female'}})]);
 assert.equal((await responses[0].json()).result,'正式文字');assert.equal(responses[1].status,200);await responses[1].arrayBuffer();
 const count=f.calls.length;
 assert.equal((await f.request('/t2a',{body:{text:'字'.repeat(1001)}})).status,413);assert.equal(f.calls.length,count);
});
