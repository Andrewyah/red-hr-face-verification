/** Private Edge Function helper only. Never import into browser code.
 * This performs evaluation; it does not authorize an employee or mint a session.
 */
type Input = { subject: string; frames: string[]; template?: string };
export type Evaluation = {
  mode: "evaluation";
  authenticated: false;
  model_version: string;
  candidate_match?: boolean;
  quality_passed: boolean;
  template?: string;
};

const hex = (value: ArrayBuffer) => [...new Uint8Array(value)]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");

export async function evaluateFace(
  operation: "enroll" | "verify", input: Input,
): Promise<Evaluation> {
  // Caller must validate employee identity, consent, active enrollment and challenge.
  const url = new URL(Deno.env.get("FACE_SERVICE_URL") ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid face service configuration");
  }
  const secret = Deno.env.get("FACE_SERVICE_HMAC_KEY") ?? "";
  const keyBytes = Uint8Array.from(atob(secret), char => char.charCodeAt(0));
  if (keyBytes.length !== 32) throw new Error("Invalid face service key");
  const encoder = new TextEncoder();
  const path = `/v1/${operation}`;
  url.pathname = path;
  const body = JSON.stringify(input);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  const key = await crypto.subtle.importKey("raw", keyBytes,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key,
    encoder.encode(["POST", path, timestamp, nonce, digest].join("\n"))));
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", "X-Face-Timestamp": timestamp,
      "X-Face-Nonce": nonce, "X-Face-Signature": signature }, body,
  });
  if (!response.ok) throw new Error(`Face evaluation unavailable (${response.status})`);
  const result: Evaluation = await response.json();
  if (result.mode !== "evaluation" || result.authenticated !== false) {
    throw new Error("Unexpected face service response");
  }
  return result;
}
