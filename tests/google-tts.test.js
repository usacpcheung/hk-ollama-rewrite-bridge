const test = require('node:test'), assert = require('node:assert/strict');
const { createGoogleTTSProvider } = require('../providers/google-tts');
const presets = require('../providers/google-tts-voices');
const { googleT2APolicy: policy } = require('../providers/google-t2a-policy');
const { convertAudio, validateWav } = require('../lib/tts-audio');
const { wav, payload } = require('../test-support/tts-wav');
const request = { text:'測試', voiceSelection:{kind:'default'}, audio:{format:'mp3',sampleRate:32000,bitrate:128000,channel:1},timeoutMs:1000 };
const make = extra => createGoogleTTSProvider({project:'test-project',getAccessToken:async()=> 'test-token',fetchImpl:async()=>new Response(JSON.stringify(payload())),...extra});
for (const [id,preset] of Object.entries(presets)) test('preset exact schema: '+id, async()=>{
  let calls=0;
  const p=make({fetchImpl:async(url,options)=>{calls++;assert.match(url,/locations\/global.*gemini-3.8-flash-tts:generateContent$/);assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{contents:[{role:'user',parts:[{text:request.text,speechMetadata:{style:preset.style}}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{voice:preset.voice}}}});
    return new Response(JSON.stringify(payload()));},convert:async input=>{validateWav(input);return Buffer.from('audio');}});
  const r=await p.services.t2a.sync({...request,voiceSelection:{kind:'preset',id}});assert.equal(r.ok,true);assert.equal(calls,1);
});
for(const format of ['mp3','wav','pcm'])test('real FFmpeg '+format,async()=>{
  const r=await make().services.t2a.sync({...request,audio:{...request.audio,format}});
  assert.equal(r.ok,true,JSON.stringify(r));const a=r.data.output.artifacts[0];assert.equal(a.format,format);assert.ok(a.data.length>0);
  if(format==='wav'){assert.equal(a.data.toString('ascii',0,4),'RIFF');assert.equal(a.data.readUInt32LE(24),32000);assert.equal(a.data.readUInt32LE(4)+8,a.data.length);}
  if(format==='pcm')assert.equal(a.data.length,6400);
});
for(const status of [400,401,403,429,500])test('HTTP '+status+' no retry',async()=>{
 let calls=0;const r=await make({fetchImpl:async()=>{calls++;return new Response('secret',{status});}}).services.t2a.sync(request);
 assert.equal(r.ok,false);assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('secret'));
 assert.equal(r.error.status,status===429?429:[401,403].includes(status)?503:502);
});
for(const mutate of [p=>p.candidates[0].finishReason='MAX_TOKENS',p=>p.candidates[0].content.parts[0].inlineData.data='??',p=>p.candidates[0].content.parts[0].inlineData.data=Buffer.from('bad').toString('base64')])test('malformed audio rejected',async()=>{
 const body=payload();mutate(body);assert.equal((await make({fetchImpl:async()=>new Response(JSON.stringify(body))}).services.t2a.sync(request)).ok,false);
});
test('credential timeout does not launch inference; shared waiter can recover',async()=>{
 let resolve,calls=0;const credentials=new Promise(r=>resolve=r);
 const p=make({getAccessToken:()=>credentials,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(payload()));},convert:async()=>Buffer.from('ok')});
 const a=p.services.t2a.sync({...request,timeoutMs:10});const b=p.services.t2a.sync(request);
 assert.equal((await a).error.code,'MODEL_TIMEOUT');resolve('token');assert.equal((await b).ok,true);assert.equal(calls,1);
});
test('stalled body aborted at deadline',async()=>{
 const p=make({fetchImpl:async(_,o)=>new Response(new ReadableStream({start(c){o.signal.addEventListener('abort',()=>c.error(o.signal.reason),{once:true});}}))});
 assert.equal((await p.services.t2a.sync({...request,timeoutMs:20})).error.code,'MODEL_TIMEOUT');
});
test('conversion cancellation and missing executable',async()=>{
 const c=new AbortController();c.abort();await assert.rejects(convertAudio(wav(),request.audio,{signal:c.signal,ffmpeg:'/usr/bin/ffmpeg'}));
 const r=await make({ffmpeg:'/does/not/exist'}).services.t2a.sync(request);assert.equal(r.error.code,'AUDIO_PROCESSOR_UNAVAILABLE');
});
test('legacy controls rejected even alongside a preset',()=>{
 for(const key of policy.legacyFields)assert.equal(policy.validateControls({voice_choice:'cantonese_male_1',[key]:null}).ok,false);
 assert.equal(policy.validateControls({}).ok,true);
 assert.equal(policy.validateAudio({...request.audio,sampleRate:12345}).ok,false);
 assert.equal(policy.validateAudio(request.audio).ok,true);
});
test('configuration forbids untested locations and invalid models',()=>{
 for(const options of [{location:'us'},{location:'asia-east1'},{model:'x'},{project:''}])assert.throws(()=>make(options));
});
test('late rejected conversion is timeout even before timer callback',async()=>{
 const r=await make({convert:async()=>{const until=performance.now()+30;while(performance.now()<until){}throw Error('late');}}).services.t2a.sync({...request,timeoutMs:20});
 assert.equal(r.error.code,'MODEL_TIMEOUT');
});
test('active conversion child is stopped on caller cancellation',async()=>{
 const {runConversion}=require('../lib/tts-audio');const c=new AbortController();
 const work=runConversion(process.execPath,['-e','process.stdin.resume(); setInterval(()=>{},1000)'],Buffer.from('test'),c.signal);
 const timer=setTimeout(()=>c.abort(),30);
 try{await assert.rejects(work,{name:'AbortError'});}finally{clearTimeout(timer);}
});
test('WAV cannot contain truncated chunks or inconsistent PCM headers',()=>{
 for(const mutate of [b=>b.writeUInt32LE(999999,40),b=>b.writeUInt16LE(2,22),b=>b.writeUInt32LE(48000,24)]){const b=wav();mutate(b);assert.throws(()=>validateWav(b));}
});
