/* =====================================================================
   POST /api/panel-logout
   =====================================================================
   Clears the session cookie. A separate endpoint because the cookie is
   HttpOnly — the page cannot delete what it cannot read, which is the
   whole point of HttpOnly.

   Nothing is checked here. Signing out when you were not signed in is
   not an error, and refusing it would only ever strand someone holding
   a session this server no longer recognises.
   ===================================================================== */

import { SESSION_COOKIE } from '../shared/session.js';

export default async () => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    /* Max-Age=0 with the same Path and flags is what actually removes
       it; a cookie that differs in Path would be set alongside the
       real one rather than replacing it. */
    'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  }
});

export const config = { path: '/api/panel-logout' };
