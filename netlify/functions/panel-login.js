/* =====================================================================
   POST /api/panel-login   { code: "481920" }
   =====================================================================
   The only place a six-digit code is checked. Deliberately a Function
   rather than an edge function, because it needs the blob store: the
   user records, their code hashes, and the attempt counters all live
   there.

   Six digits is a million possibilities. What makes that safe is not
   the hash — it is that this endpoint will not let anyone take more
   than five guesses, and slows the ones it does allow. The hash only
   means a leaked blob cannot be read straight off.

   Attempts are counted per code attempt AND per caller, so one person
   locking themselves out does not lock out the business, and a script
   working through the keyspace is stopped on its sixth try regardless
   of which code it is aiming at.
   ===================================================================== */

import { getStore } from '@netlify/blobs';
import {
  checkCode, signSession, cookieHeader, MAX_ATTEMPTS, backoffMs
} from '../shared/session.js';
import { allKeys } from '../shared/store.js';

const STORE = 'flatout-panel';      // must match panel-data.js
const SESSION_HOURS = 12;           // a working day, then sign in again
const LOCK_MINUTES = 15;            // how long a lock lasts
const sleep = ms => new Promise(r => setTimeout(r, ms));

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra)
});

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Use POST.' });

  const secret = Netlify.env.get('PANEL_SECRET');
  if (!secret || secret.length < 24) {
    /* Fail closed and say so plainly — a panel that lets everyone in
       because a variable is missing is worse than one that is down. */
    return json(503, { error: 'The panel is not configured. Set PANEL_SECRET in Netlify and redeploy.' });
  }

  let code = '';
  try { code = String((await request.json()).code || '').trim(); } catch { /* handled below */ }
  if (!/^\d{6}$/.test(code)) return json(400, { error: 'Enter your six-digit code.' });

  /* 'flatout-panel' is the same store panel-data.js writes to. It has
     to be, byte for byte: the user records this walks are the ones the
     panel saves when a code is issued. Reading a differently named
     store finds nothing, every real code is refused, and — worse —
     the bootstrap stays open because the user list looks empty. */
  const store = getStore(STORE);
  const gate = getStore('panel-gate');

  /* Who is asking. Behind Netlify this is the real client address. */
  const who = request.headers.get('x-nf-client-connection-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || 'unknown';
  const gateKey = 'ip/' + who;

  const now = Date.now();
  let state = (await gate.get(gateKey, { type: 'json' })) || { attempts: 0, lockedUntil: 0 };

  if (state.lockedUntil > now) {
    const mins = Math.ceil((state.lockedUntil - now) / 60000);
    return json(429, {
      error: `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask a partner to reset your code.`,
      locked: true
    });
  }

  /* Slow the guess down BEFORE checking it. Doing it after would leak,
     through timing, whether the code happened to be right. */
  const wait = backoffMs(state.attempts + 1);
  if (wait) await sleep(wait);

  /* Every active user with a code set. The list is small; a linear
     walk is fine and avoids leaking which codes exist.

     Not store.list() on its own: listing in Blobs is eventually
     consistent, so a login created a minute ago can be missing from
     it, and the code you had just handed somebody would be refused —
     with the attempt counted against them. allKeys unions the list
     with the index written alongside the record. */
  const keys = await allKeys(store, 'user');
  const withCodes = [];
  for (const k of keys) {
    const u = await store.get(k, { type: 'json' }).catch(() => null);
    if (u && u.active && u.codeHash && u.codeSalt) withCodes.push(u);
  }

  let matched = null;
  for (const u of withCodes) {
    if (await checkCode(code, u.codeSalt, u.codeHash)) { matched = u; break; }
  }

  /* ---- first sign-in ------------------------------------------------
     Nobody has a code yet, which is true exactly once: the moment this
     gate replaces the old shared password. Without a way in, the first
     deploy locks everyone out of the panel they need in order to issue
     the codes — the classic chicken and egg.

     PANEL_BOOTSTRAP is that way in, and it closes itself: the instant
     any user has a code, this branch stops being reachable, whether or
     not the variable is still set. Delete it afterwards anyway. */
  if (!matched && withCodes.length === 0) {
    const boot = Netlify.env.get('PANEL_BOOTSTRAP');
    if (boot && /^\d{6}$/.test(boot) && code === boot) {
      matched = { id: 'u-bootstrap', name: 'Daniel Bell', role: 'partner', active: true, bootstrap: true };
    }
  }

  if (!matched) {
    state = { attempts: state.attempts + 1, lockedUntil: 0 };
    if (state.attempts >= MAX_ATTEMPTS) {
      state.lockedUntil = now + LOCK_MINUTES * 60000;
      state.attempts = 0;
    }
    await gate.setJSON(gateKey, state, { metadata: { at: now } });

    const left = MAX_ATTEMPTS - state.attempts;
    return json(401, state.lockedUntil
      ? { error: `Too many wrong codes. Locked for ${LOCK_MINUTES} minutes.`, locked: true }
      : { error: `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` });
  }

  /* Right code: clear the counter so a bad day does not carry over. */
  await gate.delete(gateKey).catch(() => {});

  const exp = now + SESSION_HOURS * 3600 * 1000;
  const token = await signSession(
    { uid: matched.id, name: matched.name, role: matched.role, exp }, secret);

  /* Record the sign-in on the user, which is what makes "last seen"
     real rather than a guess. The bootstrap identity is not a stored
     user and must not become one — writing it would give it a record
     with no code, and it would linger in Settings forever. */
  if (!matched.bootstrap) {
    matched.lastSeen = new Date(now).toISOString();
    await store.setJSON('user/' + matched.id, matched).catch(() => {});
  }

  return json(200,
    { ok: true, name: matched.name, role: matched.role },
    { 'set-cookie': cookieHeader(token, SESSION_HOURS * 3600) });
};

export const config = { path: '/api/panel-login' };
