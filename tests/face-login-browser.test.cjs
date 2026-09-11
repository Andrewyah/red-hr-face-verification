// Synthetic lifecycle checks. These do not measure recognition or spoof resistance.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../integration/web/face-login.js'),'utf8');
const settle=async()=>{for(let i=0;i<350;i++)await Promise.resolve();};
function fixture({delayedCamera=false,delayedCapture=false,error=null,identityError=false,sessionError=false}={}){
 const calls=[],events={},nodes=new Map(),states=[];let resolveCamera,resolveCapture,frames=0,entries=0,done=0;
 const track={stops:0,stop(){this.stops++;}},stream={getTracks:()=>[track]};
 const node=s=>{if(!nodes.has(s))nodes.set(s,{focus(){},textContent:''});return nodes.get(s);};
 Object.assign(node('video'),{readyState:2,videoWidth:640,videoHeight:480,play:async()=>{},srcObject:null});
 const dialog={setAttribute(){},querySelector:node,addEventListener(){},showModal(){},close(){},remove(){},dataset:new Proxy({},{set(o,k,v){states.push(v);o[k]=v;return true;}})};
 const document={hidden:false,body:{append(){}},addEventListener:(e,f)=>events[e]=f,removeEventListener:e=>delete events[e],createElement:tag=>tag==='dialog'?dialog:{width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(24*24*4)})}),toDataURL:()=>`data:image/jpeg;base64,${String.fromCharCode(65+frames++).repeat(104)}`}};
 const tokens={access_token:'test-access',refresh_token:'test-refresh'};
 const client={auth:{getUser:async()=>{calls.push('getUser');return {error:identityError,data:{user:{id:'user-a'}}};},setSession:async data=>{calls.push(['setSession',data]);return {error:sessionError,data:{user:{id:'user-a'}}};},signOut:async()=>{calls.push('signOut');}}};
 const fetch=async(url,opts)=>{
  if(url.includes('/logout')){calls.push('discard');return Response.json({});}
  const body=JSON.parse(opts.body);calls.push(body);
  if(body.action==='begin')return error==='face_login_not_enabled'?Response.json({error},{status:503}):Response.json({id:'challenge',proof:'test-proof'});
  if(delayedCapture)await new Promise(r=>resolveCapture=r);
  return error?Response.json({error,authenticated:false},{status:422}):Response.json({authenticated:true,session:tokens});
 };
 const ctx={document,AbortController,AbortSignal,DOMException,Response,fetch,Uint8ClampedArray,console,
  setTimeout:fn=>{queueMicrotask(fn);return 0;},clearTimeout(){},isSecureContext:true,
  navigator:{mediaDevices:{getUserMedia:options=>{calls.push(['camera',options]);return delayedCamera?new Promise(r=>resolveCamera=r):Promise.resolve(stream);}}},
  addEventListener:(e,f)=>events[e]=f,removeEventListener:e=>delete events[e]};ctx.window=ctx;vm.runInNewContext(source,ctx);
 return {calls,states,dialog,track,node,events,document,open:()=>ctx.HRFaceLogin.open({client,config:{SUPABASE_URL:'https://test.invalid',SUPABASE_PUBLISHABLE_KEY:'test-public'},onDone:()=>done++,onContinue:()=>entries++}),close:()=>ctx.HRFaceLogin.close(),releaseCamera:()=>resolveCamera(stream),releaseCapture:()=>resolveCapture(),entries:()=>entries,done:()=>done};
}
test('original tap starts front camera; no Email, password or capture button is rendered',async()=>{
 const f=fixture({delayedCamera:true});f.open();assert.equal(f.calls[0][0],'camera');assert.equal(f.calls[0][1].video.facingMode.ideal,'user');assert.equal(f.calls[0][1].audio,false);
 assert(!/Email|Password|Register face|Verify account|type="submit"/.test(f.dialog.innerHTML));assert.equal((f.dialog.innerHTML.match(/<button/g)||[]).length,1);
 f.close();f.releaseCamera();await settle();assert.equal(f.track.stops,1);assert.equal(f.entries(),0);
});
test('capture, session confirmation, green indicator and entry all complete without another click',async()=>{
 const f=fixture();f.open();await settle();assert.equal(f.calls.filter(x=>x.action==='capture').length,1);assert.equal(f.calls.find(x=>x.action==='capture').frames.length,3);
 assert.equal(f.calls.filter(x=>x[0]==='setSession').length,1);assert(f.states.includes('verified'));assert.equal(f.entries(),1);assert.equal(f.done(),1);assert.equal(f.track.stops,1);assert.equal(f.node('video').srcObject,null);assert(!f.calls.includes('signOut'));assert(!f.calls.includes('discard'));
});
test('disabled release never uploads frames, installs a session or shows green',async()=>{
 const f=fixture({error:'face_login_not_enabled'});f.open();await settle();assert(!f.calls.some(x=>x.action==='capture'||x[0]==='setSession'));assert(!f.states.includes('verified'));assert.equal(f.entries(),0);assert.equal(f.track.stops,1);f.close();
});
test('non-matching captures retry automatically at most three times, then stop the camera',async()=>{
 const f=fixture({error:'face_not_recognized'});f.open();await settle();assert.equal(f.calls.filter(x=>x.action==='capture').length,3);assert.equal(f.entries(),0);assert(!f.states.includes('verified'));assert.equal(f.track.stops,1);f.close();
});
test('failed identity or session installation revokes issued credentials and never shows green',async()=>{
 for(const option of [{identityError:true},{sessionError:true}]){const f=fixture(option);f.open();await settle();assert.equal(f.entries(),0);assert(!f.states.includes('verified'));assert(f.calls.includes('discard')||f.calls.includes('signOut'));f.close();}
});
test('closing during verification discards a late session and never enters HR',async()=>{
 const f=fixture({delayedCapture:true});f.open();await settle();f.close();f.releaseCapture();await settle();assert(f.calls.includes('discard'));assert(!f.calls.some(x=>x[0]==='setSession'));assert.equal(f.entries(),0);assert.equal(f.done(),1);assert.equal(f.track.stops,1);
});
test('backgrounding cancels the capture and stops the camera',async()=>{
 const f=fixture({delayedCapture:true});f.open();await settle();f.document.hidden=true;f.events.visibilitychange();f.releaseCapture();await settle();assert.equal(f.entries(),0);assert.equal(f.track.stops,1);assert.equal(f.node('video').srcObject,null);assert(f.calls.includes('discard'));
});
