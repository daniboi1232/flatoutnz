/* =====================================================================
   Panel sessions — signing, verifying, and the code hash.
   =====================================================================
   Shared by the edge function (which only verifies) and the login
   function (which issues). Written against Web Crypto so the same file
   runs in Deno at the edge and in Node in a Netlify Function.

   A session is a signed statement of three things: who you are, what
   role you hold, and when it stops being true. Nothing else is in it,
   because anything else would be a copy of data that can change — a
   role revoked at 9am must not keep working until the cookie expires,
   so the edge re-checks the role against the stored user on every
   request rather than trusting what the cookie says.
   ===================================================================== */

const enc = new TextEncoder();

/* Base64url, because a cookie value cannot carry + / or =. */
export function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/* ---------- the session cookie -------------------------------------- */

export async function signSession(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64url(sig);
}

export async function readSession(token, secret) {
  if (!token || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret),
      unb64url(sig), enc.encode(body));
  } catch { return null; }
  if (!ok) return null;

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(unb64url(body))); }
  catch { return null; }

  /* An expired session is not a session. Checked here rather than left
     to the cookie's Max-Age, because a cookie's lifetime is a hint the
     client can ignore and this is not. */
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

/* ---------- the six-digit code --------------------------------------
   Six digits is a million possibilities, which a script exhausts in
   seconds given the chance. Two things stop that: the login function
   refuses to give it the chance (delay, then lockout), and the stored
   value is run through PBKDF2 so that a leaked blob cannot simply be
   read. The iteration count is what makes an offline sweep of a
   million candidates expensive rather than instant.
   -------------------------------------------------------------------- */

export const CODE_ITERATIONS = 210000;

export function newCode() {
  /* Rejection-free: take 32 random bits and reduce. The tiny modulo
     bias across a million buckets is irrelevant here, but drawing from
     crypto rather than Math.random is not. */
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

export function newSalt() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashCode(code, salt, iterations = CODE_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(code)),
    'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64url(salt), iterations, hash: 'SHA-256' }, key, 256);
  return b64url(bits);
}

export async function checkCode(code, salt, expected, iterations = CODE_ITERATIONS) {
  const got = await hashCode(code, salt, iterations);
  /* Constant time over equal-length base64url strings. */
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/* ---------- lockout ---------------------------------------------------
   Delay first, then lock. The delay handles the person who fat-fingered
   their own code; the lock handles everything that is not a person.
   -------------------------------------------------------------------- */

export const MAX_ATTEMPTS = 5;

export function backoffMs(attempts) {
  if (attempts <= 1) return 0;
  return Math.min(8000, 1000 * Math.pow(2, attempts - 2));  // 1s, 2s, 4s, 8s
}

export const SESSION_COOKIE = 'flatout_panel';

export function cookieHeader(value, maxAgeSeconds) {
  const bits = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',                 // the page never needs to read it
    'Secure',
    'SameSite=Lax',             // survives a normal link into the panel
    `Max-Age=${maxAgeSeconds}`
  ];
  return bits.join('; ');
}

export function readCookie(header, name) {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
