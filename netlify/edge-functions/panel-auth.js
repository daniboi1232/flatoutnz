/* =====================================================================
   Password gate for /panel/
   =====================================================================
   Runs at Netlify's edge, BEFORE any file is served. Anything under
   /panel/ — the page, data.js, and later the photos and API calls —
   is unreachable without the password. A browser login box appears;
   there is no page to style and nothing to maintain.

   This is deliberately not a JavaScript "password screen" on the page
   itself. Those only hide the interface: anyone can open the page
   source or request /panel/data.js directly and read everything. This
   blocks the request.

   SETUP (once, in the Netlify dashboard):
     Site configuration > Environment variables > Add a variable
       PANEL_USER   e.g. flatout
       PANEL_PASS   a long random password
     Then redeploy, because edge functions read these at request time
     from the deployed environment.

   The password is never in the repo. If you ever need to change it,
   change the variable and redeploy — no code change.

   TO REMOVE THE PANEL ENTIRELY:
     delete /panel/, delete this file, and delete those two variables.
   ===================================================================== */

export default async (request, context) => {
  const user = Deno.env.get('PANEL_USER');
  const pass = Deno.env.get('PANEL_PASS');

  // If the variables aren't set, refuse rather than letting the panel
  // through unprotected. A misconfigured deploy must fail closed.
  if (!user || !pass) {
    return new Response(
      'The panel is not configured yet. Set PANEL_USER and PANEL_PASS in Netlify, then redeploy.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }

  const expected = 'Basic ' + btoa(`${user}:${pass}`);
  const supplied = request.headers.get('authorization') || '';

  // Constant-time-ish compare. Over HTTPS with a long random password a
  // plain === would be fine, but this costs nothing.
  const ok = supplied.length === expected.length && timingSafeEqual(supplied, expected);

  if (!ok) {
    return new Response('Authentication required.', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="FlatOut employees panel", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
        // Never let a proxy or browser cache a protected response.
        'cache-control': 'no-store'
      }
    });
  }

  // Password accepted — serve the real file, and keep it out of caches
  // and out of search engines.
  const response = await context.next();
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  return response;
};

function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Covers /panel and everything under it, INCLUDING the data API at
   /panel/api/data. That is why the API was put under /panel/ rather
   than at /api/ — one rule protects the page, its script and its data,
   with nothing to remember to add later. The API path is also listed
   explicitly, so the protection does not rest on how a glob is
   interpreted. */
export const config = {
  path: ['/panel', '/panel/', '/panel/*', '/panel/api/*']
};
