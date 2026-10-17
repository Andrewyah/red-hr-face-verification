'use strict';
(() => {
  const $ = id => document.getElementById(id);
  // Fragment never goes to proxy logs or Referer. Keep it only in tab memory;
  // a reload must restart from the server-bound registration flow.
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  let state, stream, busy = false, delay;
  const messages = {
    document_name_not_confirmed: 'The document name could not be matched to your registration. Use a clear photo of your own document.',
    document_not_readable: 'The document text is not clear. Retake the whole document without glare.',
    document_one_portrait_required: 'One clear document portrait is required.',
    document_portrait_not_clear: 'Move closer to the document and make sure its portrait is clear.',
    service_busy: 'The service is busy. Please try again shortly.',
    session_expired: 'This check expired. Return to registration and start again.',
    document_reader_unavailable: 'The document reader is temporarily unavailable. Please try again later.',
    action_not_confirmed: 'The requested action was not confirmed. Return to registration to retry.',
    document_face_mismatch: 'The live face could not be matched to the document. Return to registration to retry.',
    challenge_expired: 'The camera action timed out. Return to registration to retry.',
    cancelled: 'This check was cancelled and its temporary measurements were cleared.'
  };
  const say = text => { $('status').textContent = text; };
  function stopCamera() { if (stream) stream.getTracks().forEach(track => track.stop()); stream = null; $('video').srcObject = null; }
  async function api(path, body) {
    const response = await fetch('/customer-identity/capture/' + path, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit',
      signal: AbortSignal.timeout(20000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(messages[data.error] || 'The check could not continue. Please retry or return to registration.');
    return data;
  }
  function render(next) {
    state = next; clearTimeout(delay);
    const pending = state.state === 'pending';
    $('document').hidden = !pending || !state.documentNeeded;
    $('live').hidden = !pending || !state.challenge;
    $('cancel').hidden = !pending;
    $('return').hidden = pending;
    if (!pending) {
      stopCamera();
      say(state.state === 'evaluated' ? 'Test complete. Candidate checks passed. Your account has not been activated; this service still needs real-device and replay acceptance.' : (messages[state.reason] || 'This check was not completed. Return to registration to retry.'));
      return;
    }
    if (state.documentNeeded) { stopCamera(); say(messages[state.reason] || 'Upload a clear photo and give consent to begin.'); }
    if (state.challenge) {
      const actions = { center: 'Look straight at the camera', left: 'Turn your head gently to your LEFT', right: 'Turn your head gently to your RIGHT' };
      $('action').textContent = `${state.step + 1} of 5: ${actions[state.challenge.action]}`;
      say('Hold the requested position, then capture. Each instruction expires after 45 seconds.');
      $('capture').disabled = true;
      delay = setTimeout(() => { $('capture').disabled = !stream; }, 900);
      $('restart-camera').hidden = !!stream;
    }
  }
  async function camera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } } });
      if (document.hidden) { stopCamera(); return; }
      $('video').srcObject = stream; await $('video').play();
      $('restart-camera').hidden = true;
      $('capture').disabled = false;
    } catch {
      stopCamera(); $('restart-camera').hidden = false; $('capture').disabled = true;
      say('Camera access is needed for the live check. Allow camera access in your browser and try again.');
    }
  }
  function encode(source, width, height) {
    if (!width || !height) throw new Error('Wait for the camera preview, then try again.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / Math.max(width, height));
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.88, 0.72, 0.55]) {
      const encoded = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (encoded.length <= 533332) return encoded;
    }
    throw new Error('The photo is too large. Please retake it.');
  }
  async function run(button, operation) {
    if (busy) return; busy = true; button.disabled = true;
    try { await operation(); } catch (error) { say(error.name === 'TimeoutError' ? 'The request timed out. Check the connection and try again.' : error.message); }
    finally { busy = false; button.disabled = false; }
  }
  $('document-next').onclick = () => run($('document-next'), async () => {
    const file = $('file').files[0];
    if (!$('consent').checked || !file) throw new Error('Choose your document photo and agree to the test first.');
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 12 * 1024 * 1024) throw new Error('Choose a JPEG or PNG photo smaller than 12 MB.');
    // Ask camera permission before the first timed challenge is issued.
    await camera(); if (!stream) return;
    let image;
    try {
      image = await createImageBitmap(file);
      const encoded = encode(image, image.width, image.height);
      render(await api('document', { image: encoded, kind: $('kind').value, consent: true }));
      $('file').value = '';
    } catch (error) { stopCamera(); throw error; }
    finally { image?.close(); }
  });
  $('capture').onclick = () => run($('capture'), async () => {
    if (!stream || !state?.challenge) throw new Error('Start the camera first.');
    const encoded = encode($('video'), $('video').videoWidth, $('video').videoHeight);
    try { render(await api('frame', { challengeId: state.challenge.id, frame: encoded })); }
    catch (error) { try { render(await api('session')); } catch {} throw error; }
  });
  $('restart-camera').onclick = () => run($('restart-camera'), camera);
  $('cancel').onclick = () => run($('cancel'), async () => { stopCamera(); render(await api('cancel', {})); });
  addEventListener('pagehide', stopCamera);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopCamera(); $('restart-camera').hidden = false; $('capture').disabled = true; } });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { say('Start a new identity check from your registration page. This link has no active session.'); $('return').hidden = false; return; }
  api('session').then(render).catch(error => { say(error.message); $('return').hidden = false; });
})();
