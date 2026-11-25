/* =====================================================================
   The gate on /panel/
   =====================================================================
   Runs at Netlify's edge, BEFORE any file is served. Anything under
   /panel/ — the page, data.js, the API, the photos — is unreachable
   without a valid session.

   This replaces the shared Basic auth password. The difference that
   matters: a password says "somebody who knows the password", and a
   session says WHO. Job history, the money screens and the staff
   restrictions all depend on knowing which of them it is, and a
   shared password cannot answer that.

   What happens here is only verification. Issuing a session is the
   login Function's job, because that needs the blob store and this
   wants to stay fast — it runs on every request for every asset.

   SETUP (once, in the Netlify dashboard):
     Site configuration > Environment variables > Add a variable
       PANEL_SECRET   a long random string, 32+ characters
     Then redeploy. Changing it signs everybody out, which is also how
     you sign everybody out.
   ===================================================================== */

import { readSession, readCookie, SESSION_COOKIE } from '../shared/session.js';

export default async (request, context) => {
  const secret = Deno.env.get('PANEL_SECRET');

  // A misconfigured deploy must fail closed, never open.
  if (!secret || secret.length < 24) {
    return new Response(
      'The panel is not configured yet. Set PANEL_SECRET in Netlify (32+ random characters), then redeploy.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }
    );
  }

  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const session = await readSession(token, secret);

  if (!session) {
    const url = new URL(request.url);

    /* An API call gets a status, not a redirect. The panel can then
       say "you have been signed out" instead of quietly parsing a
       login page as if it were data. */
    if (url.pathname.startsWith('/panel/api/')) {
      return new Response(JSON.stringify({ error: 'signed-out' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }

    /* Everything else goes to the code screen, remembering where they
       were headed so a link into a job still lands on that job. */
    const next = url.pathname + url.search;
    return Response.redirect(
      new URL('/staff/?next=' + encodeURIComponent(next), url.origin), 302);
  }

  const response = await context.next();

  /* Hand the page its own identity rather than making it ask. The
     cookie is HttpOnly and deliberately unreadable from JavaScript, so
     this is how the panel knows who is signed in — injected into the
     HTML at the edge, one round trip saved and no flash of the wrong
     name while a /me call is in flight.

     Injected, not trusted: the panel reads it for display and for
     which tabs to draw, while every restriction that matters is
     enforced here and in the API, where the client cannot reach. */
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/html')) {
    const html = await response.text();
    const payload = JSON.stringify({
      uid: session.uid, name: session.name, role: session.role, exp: session.exp
    }).replace(/</g, '\\u003c');       // never let it close the script tag
    const patched = html.replace('<!--SESSION-->',
      `<script>window.__SESSION=${payload};</script>`);
    return new Response(patched, {
      status: response.status,
      headers: withGuards(response.headers)
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: withGuards(response.headers)
  });
};

function withGuards(headers) {
  const h = new Headers(headers);
  h.set('cache-control', 'no-store');      // never cache a protected response
  h.set('x-robots-tag', 'noindex, nofollow');
  h.delete('content-length');              // the body may have changed length
  return h;
}

/* Covers /panel and everything under it, INCLUDING the data API at
   /panel/api/data. That is why the API was put under /panel/ rather
   than at /api/ — one rule protects the page, its script and its data,
   with nothing to remember to add later. The API path is also listed
   explicitly, so the protection does not rest on how a glob is
   interpreted.

   /api/panel-login is deliberately NOT here: it is how you get in. */
export const config = {
  path: ['/panel', '/panel/', '/panel/*', '/panel/api/*']
};
