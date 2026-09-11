/** Signed server-to-server diagnostic. No employee data or login session API. */
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(n => n.toString(16).padStart(2, "0")).join("");
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

async function rpc(name: string, body: unknown = {}) {
  const origin = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!origin || !key) throw new Error("configuration_unavailable");
  const response = await fetch(`${origin}/rest/v1/rpc/${name}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", "apikey": key, "Authorization": `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("backend_unavailable");
  return await response.json();
}

async function message(path: string, raw: string, ts: string, nonce: string) {
  return enc.encode(["POST", path, ts, nonce, hex(await crypto.subtle.digest("SHA-256", enc.encode(raw)))].join("\n"));
}

async function signature(key: CryptoKey, path: string, raw: string, ts: string, nonce: string) {
  return hex(await crypto.subtle.sign("HMAC", key, await message(path, raw, ts, nonce)));
}

Deno.serve(async (req: Request) => {
  // Externally callable only with a purpose-bound, short-lived HMAC proof.
  // verify_jwt=false is intentional for this non-user service-to-service route.
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if ((req.headers.get("content-type") || "").split(";")[0] !== "application/json") return reply({error:"json_required"},415);
  const ts = req.headers.get("x-face-timestamp") || "";
  const nonce = req.headers.get("x-face-nonce") || "";
  const supplied = req.headers.get("x-face-signature") || "";
  if (!/^\d{10}$/.test(ts) || Math.abs(Date.now()/1000-Number(ts)) > 60 ||
      !/^[A-Za-z0-9_-]{24,80}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) return reply({error:"unauthorized"},401);
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = req.body?.getReader();
    if (!reader) return reply({error:"invalid_request"},400);
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); void reader.cancel(); }, 5000);
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256) { await reader.cancel(); return reply({error:"request_too_large"},413); }
        chunks.push(value);
      }
    } finally { clearTimeout(timer); }
    if (controller.signal.aborted) return reply({error:"request_timeout"},408);
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    const raw = new TextDecoder("utf-8", {fatal:true}).decode(bytes);
    // This route has no arbitrary relay, employee identifier, image or template input.
    if (raw !== '{"operation":"probe"}') return reply({error:"invalid_request"},400);
    const config = await rpc("hr_face_service_config");
    const target = new URL(config.url);
    if (target.origin !== "https://face-verifier-api-production.up.railway.app" || target.pathname !== "/" || target.username || target.password || target.search || target.hash)
      throw new Error("configuration_unavailable");
    const keyBytes = Uint8Array.from(atob(config.key), c => c.charCodeAt(0));
    if (keyBytes.length !== 32) throw new Error("configuration_unavailable");
    const key = await crypto.subtle.importKey("raw",keyBytes,{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
    const proof = Uint8Array.from(supplied.match(/../g)!, pair => parseInt(pair,16));
    if (!await crypto.subtle.verify("HMAC",key,proof,await message("/hr-face-service-check",raw,ts,nonce))) return reply({error:"unauthorized"},401);
    if (!await rpc("hr_face_claim_probe",{p_nonce:nonce})) return reply({error:"replayed_or_rate_limited"},429);
    const health = await fetch(new URL("/readyz",target), {redirect:"error",signal:AbortSignal.timeout(15000)});
    if (!health.ok) return reply({error:"model_service_not_ready"},503);
    const state = await health.json();
    if (state.ready !== true || state.mode !== "evaluation" || state.login_enabled !== false) return reply({error:"unexpected_service_mode"},503);
    const body = '{"subject":"connectivity-probe","frames":[]}';
    const upstreamTs = String(Math.floor(Date.now()/1000));
    const upstreamNonce = hex(crypto.getRandomValues(new Uint8Array(24)).buffer);
    const headers = {"Content-Type":"application/json", "X-Face-Timestamp":upstreamTs,
      "X-Face-Nonce":upstreamNonce, "X-Face-Signature":await signature(key,"/v1/enroll",body,upstreamTs,upstreamNonce)};
    const upstream = await fetch(new URL("/v1/enroll",target), {
      method:"POST",headers,body,redirect:"error",signal:AbortSignal.timeout(15000),
    });
    const result = await upstream.json();
    // A signed deliberately empty capture must reach validation and be rejected.
    // There is no enrollment and no biometric material in this diagnostic.
    if (upstream.status !== 400 || result.error !== "three_to_six_frames_required") return reply({error:"signed_connection_failed"},503);
    return reply({connected:true,signing_verified:true,model_ready:true,
      model_version:state.model_version,mode:"evaluation",login_enabled:false});
  } catch {
    return reply({error:"service_check_failed"},503);
  }
});
