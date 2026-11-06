/* =====================================================================
   FlatOut Employees Panel — storage
   =====================================================================
   The only thing that touches stored data. The browser never reaches
   Netlify Blobs directly; it calls this function, and this function
   checks the password on every single request.

   Why the password is checked here as well as at the edge: Netlify
   Functions live at /.netlify/functions/..., which is a different path
   from /panel/. The edge function is configured to cover both, but if
   that config is ever changed this check still stands between the data
   and the internet. Protecting it in one place only is how an
   "internal" tool quietly becomes public.

   HOW THE DATA IS LAID OUT
   One blob per record, keyed by id:

     job/J-1001           one job
     customer/mere-harris one customer, and how to reach them
     document/D-xyz       one issued document, frozen as it was sent
     acceptance/J-1001    that the customer accepted their quote
     portal/J-1001        wrong-code count for the customer's page
     contractor/gecs      one contractor and their rate card
     template/estimate    one message template
     alert/<id>           one alert
     settings             alert preferences for both owners
     photo/<id>           an uploaded image

   One blob per record rather than one big blob of everything, so that
   two people editing two different jobs cannot overwrite each other.
   With a single "jobs" blob, whoever saved last would silently wipe the
   other's work — and that would happen exactly when you are both busy.
   ===================================================================== */

import { getStore } from '@netlify/blobs';

const STORE = 'flatout-panel';
const KINDS = ['job', 'contractor', 'customer', 'document', 'acceptance', 'portal', 'template', 'alert'];

export default async (req) => {
  const denied = checkAuth(req);
  if (denied) return denied;

  const store = getStore(STORE);
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const action = url.searchParams.get('action');
      if (action === 'photo') return servePhoto(store, url.searchParams.get('key'));
      if (action === 'load') return json(await loadAll(store));
      return json({ error: 'Unknown action' }, 400);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      switch (body.action) {
        case 'put':   return json(await put(store, body));
        case 'del':   return json(await del(store, body));
        case 'photo': return json(await savePhoto(store, body));
        case 'seed':  return json(await seed(store));
        default:      return json({ error: 'Unknown action' }, 400);
      }
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    // Never leak internals to the browser, but do log them for the
    // Netlify function log so a failure can actually be diagnosed.
    console.error('panel-data failed:', err);
    return json({ error: 'Storage error. Nothing was saved.' }, 500);
  }
};

/* ---------- auth -------------------------------------------------- */
function checkAuth(req) {
  const user = Deno_env('PANEL_USER'), pass = Deno_env('PANEL_PASS');
  if (!user || !pass) {
    return json({ error: 'Panel is not configured. Set PANEL_USER and PANEL_PASS.' }, 503);
  }
  const expected = 'Basic ' + btoa(`${user}:${pass}`);
  const supplied = req.headers.get('authorization') || '';
  const ok = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'Not authorised' }), {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="FlatOut employees panel", charset="UTF-8"',
        'content-type': 'application/json',
        'cache-control': 'no-store'
      }
    });
  }
  return null;
}
function Deno_env(k) {
  // Works in both the Node and Deno function runtimes.
  return (typeof process !== 'undefined' && process.env && process.env[k]) ||
         (typeof Deno !== 'undefined' && Deno.env.get(k)) || '';
}
function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- reads ------------------------------------------------- */
async function loadAll(store) {
  const out = { jobs: [], contractors: [], customers: [], documents: [], acceptances: [], portals: [],
    templates: [], alerts: [], settings: null, business: null };
  const PLURAL = { job: 'jobs', contractor: 'contractors', customer: 'customers',
    document: 'documents', acceptance: 'acceptances', portal: 'portals',
    template: 'templates', alert: 'alerts' };

  for (const kind of KINDS) {
    const { blobs } = await store.list({ prefix: kind + '/' });
    const records = await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    );
    out[PLURAL[kind]] = records.filter(Boolean);
  }

  out.settings = await store.get('settings', { type: 'json' }).catch(() => null);
  out.business = await store.get('business', { type: 'json' }).catch(() => null);
  return out;
}

async function servePhoto(store, key) {
  if (!key || !key.startsWith('photo/')) return json({ error: 'Bad key' }, 400);
  const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!blob) return json({ error: 'Not found' }, 404);
  return new Response(blob.data, {
    headers: {
      'content-type': blob.metadata?.contentType || 'image/jpeg',
      // Private, but safe to keep in the browser's own cache: the key is
      // unguessable and the request is still authenticated.
      'cache-control': 'private, max-age=86400'
    }
  });
}

/* ---------- writes ------------------------------------------------ */
async function put(store, { kind, id, value }) {
  if (kind === 'settings' || kind === 'business') {
    await store.setJSON(kind, value);
    return { ok: true };
  }
  if (!KINDS.includes(kind)) return { error: 'Unknown kind' };
  if (!id || /[^A-Za-z0-9._-]/.test(id)) return { error: 'Bad id' };
  await store.setJSON(`${kind}/${id}`, value);
  return { ok: true };
}

async function del(store, { kind, id }) {
  if (!KINDS.includes(kind)) return { error: 'Unknown kind' };
  if (!id || /[^A-Za-z0-9._-]/.test(id)) return { error: 'Bad id' };
  await store.delete(`${kind}/${id}`);
  return { ok: true };
}

async function savePhoto(store, { dataUrl }) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!m) return { error: 'Only jpeg, png or webp images' };
  const [, contentType, b64] = m;
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  // The panel downscales before upload, so anything large here is a bug
  // or an attempt to fill the store.
  if (bytes.length > 3_000_000) return { error: 'Image too large' };
  const key = 'photo/' + crypto.randomUUID();
  await store.set(key, bytes, { metadata: { contentType } });
  return { ok: true, key };
}

/* ---------- first run --------------------------------------------- */
/* Writes the starting contractors and message templates, once, if the
   store is empty. Rate cards are left EMPTY on purpose — Dan enters the
   real agreed prices. No sample jobs and no sample customers: from here
   on everything in the panel is real. */
async function seed(store) {
  const { blobs } = await store.list({ prefix: 'contractor/' });
  if (blobs.length) return { ok: true, seeded: false };

  const contractors = [
    ['gecs', 'GECS', 'Mike', ['cleaning'], '14 days'],
    ['junkman', 'Junkman', 'Glen', ['rubbish'], 'On completion (on site)'],
    ['general-junk', 'General Junk', '', ['rubbish'], 'On completion (on site)'],
    ['happy-helpers', 'Happy Helpers', '', ['moving', 'cleaning'], '14 days'],
    ['storage2u', 'Storage2U', 'Nick', ['storage'], '1 month'],
    ['complete-clean', 'Complete Clean', 'Joy', ['cleaning'], '14 days']
  ];
  for (const [id, name, contact, services, terms] of contractors) {
    await store.setJSON(`contractor/${id}`, {
      id, name, contact, phone: '', email: '', terms, insurance: '',
      services, strikes: 0, hist: { sent: 0, acc: 0, dec: 0, sil: 0, hrs: 0 },
      items: []
    });
  }

  const templates = [
    ['visit', 'Site visit confirmation', 'Your FlatOut walk-through',
      "Hi {first name}, it's {sender} from FlatOut. Confirming your walk-through at {address} on {visit}. It takes about 20 minutes. Reply here if that time doesn't suit."],
    ['estimate', 'Estimate ready', 'Your FlatOut estimate',
      "Hi {first name}, your FlatOut estimate for {address} is ready: {price} all-in. Accept it in your customer portal and we'll confirm the details with our contractors, then send your formal quote."],
    ['payment', 'Payment reminder', 'Payment due for your move-out',
      "Hi {first name}, a reminder that the {payment} of {amount} for your move-out at {address} is due {due date}. You can pay through your customer portal. If it hasn't come through by then, the job can't go ahead."],
    ['daybefore', 'Day-before reminder', 'Your FlatOut job is tomorrow',
      "Hi {first name}, your FlatOut job at {address} is tomorrow ({job date}). Booked: {services}. Please make sure power and water are on and someone can let the contractors in. Questions? Text 027 408 6895."],
    ['review', 'Job complete + review', 'All done, thanks from FlatOut',
      "Hi {first name}, your move-out at {address} is all done. Thanks for using FlatOut. If you've got a minute, an honest Google review helps other students find us: [review link]"]
  ];
  for (const [id, name, subject, body] of templates) {
    await store.setJSON(`template/${id}`, { id, name, subject, body });
  }

  await store.setJSON('settings', {
    'Daniel Bell': { types: { accept: true, pay: true, decline: true, silent: true, done: true, caccept: false }, mineOnly: false },
    'Rocky Lin': { types: { accept: true, pay: true, decline: true, silent: true, done: false, caccept: false }, mineOnly: false }
  });

  return { ok: true, seeded: true };
}

/* ---------- helpers ----------------------------------------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

/* Deliberately under /panel/ so the edge-function password gate that
   already covers /panel/* covers the data API too — one rule, nothing
   to forget. The check inside this file stays as a second lock. */
export const config = { path: '/panel/api/data' };
