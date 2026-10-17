const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require(process.env.JSDOM_MODULE || 'jsdom');
const root = path.join(__dirname, '../customer_identity/static');
const html = fs.readFileSync(path.join(root, 'capture.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'capture.js'), 'utf8');
const token = 'a'.repeat(43);
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function fixture({hash = token, deny = false} = {}) {
  const dom = new JSDOM(html, {url:'https://face.example.test/customer-identity/verify#'+hash, runScripts:'outside-only'});
  const w = dom.window, calls = [];
  let stopped = 0, cameraRequests = 0, step = 0;
  const pending = {state:'pending', mode:'evaluation', activationAllowed:false, documentNeeded:true, step:0};
  let state = pending;
  Object.defineProperty(w.document, 'hidden', {value:false, configurable:true});
  Object.defineProperty(w.navigator, 'mediaDevices', {value:{getUserMedia:async options => {
    cameraRequests++; assert.equal(options.audio, false);
    if (deny) throw new Error('NotAllowedError');
    return {getTracks:()=>[{stop:()=>stopped++}]};
  }}});
  w.HTMLMediaElement.prototype.play = async () => {};
  Object.defineProperties(w.document.getElementById('video'), {videoWidth:{value:640},videoHeight:{value:480}});
  w.HTMLCanvasElement.prototype.getContext = () => ({drawImage(){}});
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,framebytes';
  w.createImageBitmap = async () => ({width:640,height:480,close(){}});
  w.AbortSignal = global.AbortSignal;
  w.fetch = async (url, options) => {
    calls.push({url,options});
    assert.equal(options.headers.Authorization, 'Bearer '+token);
    assert.equal(options.credentials, 'omit');
    assert.ok(!url.includes(token));
    if (url.endsWith('/document')) {
      const data = JSON.parse(options.body);
      assert.equal(data.consent, true);
      assert.deepEqual(Object.keys(data).sort(), ['consent','image','kind']);
      state = {...pending, documentNeeded:false, challenge:{id:'nonce-0',action:'center'}};
    }
    if (url.endsWith('/frame')) {
      assert.equal(JSON.parse(options.body).challengeId, state.challenge.id);
      step++;
      state = step === 5 ? {state:'evaluated',activationAllowed:false} : {...state,step,challenge:{id:'nonce-'+step,action:step%2 ? 'left':'center'}};
    }
    if (url.endsWith('/cancel')) state = {state:'failed',reason:'cancelled'};
    return {ok:true,json:async()=>structuredClone(state)};
  };
  w.eval(script); await tick();
  const $ = id => w.document.getElementById(id);
  function choose() {
    Object.defineProperty($('file'), 'files', {value:[{type:'image/jpeg',size:10000}],configurable:true});
    $('consent').checked = true;
  }
  return {dom,w,$,calls,choose,stopped:()=>stopped,cameraRequests:()=>cameraRequests};
}

test('capture token is removed from URL and no camera starts without consent', async () => {
  const f = await fixture();
  assert.equal(f.w.location.hash, '');
  assert.equal(f.cameraRequests(), 0);
  f.$('document-next').click(); await tick();
  assert.equal(f.cameraRequests(), 0);
  assert.equal(f.calls.length, 1);
  assert.match(f.$('status').textContent, /agree/);
  f.dom.window.close();
});

test('denied camera leaves document unsubmitted and no active stream', async () => {
  const f = await fixture({deny:true}); f.choose();
  f.$('document-next').click(); await tick();
  assert.equal(f.cameraRequests(), 1);
  assert.equal(f.calls.length, 1);
  assert.match(f.$('status').textContent, /Camera access/);
  f.dom.window.close();
});

test('complete candidate flow stops camera and never says account activated', async () => {
  const f = await fixture(); f.choose();
  f.$('document-next').click(); await tick();
  assert.equal(f.$('live').hidden, false);
  for(let i=0;i<5;i++) {
    await new Promise(resolve=>setTimeout(resolve,920));
    f.$('capture').click(); await tick();
  }
  assert.match(f.$('status').textContent, /has not been activated/);
  assert.equal(f.$('return').hidden, false);
  assert.ok(f.stopped()>0);
  assert.equal(f.$('video').srcObject, null);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/frame')).length, 5);
  f.dom.window.close();
});

test('backgrounding and cancellation stop capture', async () => {
  const f = await fixture(); f.choose(); f.$('document-next').click(); await tick();
  Object.defineProperty(f.w.document,'hidden',{value:true,configurable:true});
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
  assert.ok(f.stopped()>0); assert.equal(f.$('video').srcObject,null);
  f.$('cancel').click(); await tick();
  assert.match(f.$('status').textContent,/cancelled/);
  assert.equal(f.$('cancel').hidden,true);
  f.dom.window.close();
});

test('missing fragment cannot start a capture and offers return link', async () => {
  const f = await fixture({hash:''});
  assert.equal(f.calls.length,0); assert.equal(f.cameraRequests(),0);
  assert.equal(f.$('return').hidden,false);
  assert.match(f.$('status').textContent,/no active session/);
  f.dom.window.close();
});
