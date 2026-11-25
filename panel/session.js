/* =====================================================================
   Session helpers — the browser half.
   =====================================================================
   The panel ISSUES codes; the server VERIFIES them. This file is the
   issuing half, and netlify/shared/session.js is the verifying half.

   They are two files because there is no build step: that one is an ES
   module running in Deno and Node, and the panel is classic scripts in
   a browser. The alternative is a bundler, which is a lot of machinery
   to avoid thirty duplicated lines.

   WHAT MATTERS: the hash these produce must be byte-identical, or a
   code issued here will never verify there. Everything below —
   iteration count, salt length, base64url alphabet, the SHA-256
   choice — has a twin in that file. Change one and you must change the
   other, and `codes.test.mjs` fails loudly if you don't.
   ===================================================================== */

const Session = (() => {
  'use strict';
  const enc = new TextEncoder();

  /* Must match CODE_ITERATIONS in netlify/shared/session.js. */
  const CODE_ITERATIONS = 210000;

  function b64url(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unb64url(str) {
    const pad = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  return {
    CODE_ITERATIONS,
    b64url, unb64url,

    /* Six digits, drawn from crypto rather than Math.random. The modulo
       bias across a million buckets is negligible; the source is not. */
    newCode() {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return String(buf[0] % 1000000).padStart(6, '0');
    },

    newSalt() {
      return b64url(crypto.getRandomValues(new Uint8Array(16)));
    },

    async hashCode(code, salt, iterations) {
      const key = await crypto.subtle.importKey('raw', enc.encode(String(code)),
        'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: unb64url(salt),
          iterations: iterations || CODE_ITERATIONS, hash: 'SHA-256' }, key, 256);
      return b64url(bits);
    }
  };
})();
