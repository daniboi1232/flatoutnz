/* =====================================================================
   FlatOut Employees Panel — storage
   =====================================================================
   The only thing that touches stored data. The browser never reaches
   Netlify Blobs directly; it calls this function, and this function
   checks the signed session cookie on every single request.

   Why the session is checked here as well as at the edge: this
   function is routed at /panel/api/data, which the edge function
   covers today — but if that config is ever changed, this check still
   stands between the data and the internet. Protecting it in one place
   only is how an "internal" tool quietly becomes public.

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
import { readSession, readCookie, SESSION_COOKIE } from '../shared/session.js';
import { addToIndex, removeFromIndex, allKeys } from '../shared/store.js';

const STORE = 'flatout-panel';
const KINDS = ['job', 'contractor', 'customer', 'document', 'acceptance', 'portal', 'template', 'alert', 'expense', 'trip', 'asset', 'hours', 'user'];

export default async (req) => {
  const denied = await checkAuth(req);
  if (denied) return denied;

  /* Strong consistency on every read. Blobs defaults to eventual, which
     means a read can be served an older copy of a key that was just
     written: a contractor saved and read straight back still showed the
     old categories a second later, and a deleted record came back once
     before staying gone. Strong reads cost a little latency and remove
     a whole class of "it did not save" that is really "it did not read".
     Listing has no such option, which is why the index exists. */
  const store = getStore({ name: STORE, consistency: 'strong' });
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
        case 'putMany': return json(await putMany(store, body));
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
/* The signed session cookie, checked here as well as at the edge.
   This function is routed at /panel/api/data, which the edge function
   already covers — but protecting data in one place only is how an
   internal tool quietly becomes public the day a path config changes.

   It used to check a shared username and password. It no longer can:
   those variables were deleted when the six-digit codes replaced them,
   and a function that 503s because a retired variable is gone is a
   panel that cannot save a single job. Same cookie as the edge, same
   secret, same failure mode when the secret is missing. */
async function checkAuth(req) {
  const secret = Deno_env('PANEL_SECRET');
  if (!secret || secret.length < 24) {
    return json({ error: 'The panel is not configured. Set PANEL_SECRET in Netlify and redeploy.' }, 503);
  }
  const token = readCookie(req.headers.get('cookie') || '', SESSION_COOKIE);
  const session = token && await readSession(token, secret);
  if (!session) {
    /* No WWW-Authenticate: it would make the browser pop up a password
       box that nothing can answer any more. The panel's own code sees
       this and sends the person to /staff/ to enter their code. */
    return json({ error: 'signed-out' }, 401);
  }
  return null;
}
function Deno_env(k) {
  // Works in both the Node and Deno function runtimes.
  return (typeof process !== 'undefined' && process.env && process.env[k]) ||
         (typeof Deno !== 'undefined' && Deno.env.get(k)) || '';
}

/* ---------- reads ------------------------------------------------- */
async function loadAll(store) {
  const out = { jobs: [], contractors: [], customers: [], documents: [], acceptances: [], portals: [],
    templates: [], alerts: [], expenses: [], trips: [], assets: [], hours: [], users: [],
    settings: null, business: null };
  const PLURAL = { job: 'jobs', contractor: 'contractors', customer: 'customers',
    document: 'documents', acceptance: 'acceptances', portal: 'portals',
    template: 'templates', alert: 'alerts', expense: 'expenses',
    trip: 'trips', asset: 'assets', hours: 'hours', user: 'users' };

  for (const kind of KINDS) {
    /* Both sources, unioned. The index carries what was written in the
       last minute, which list() cannot see yet; list carries anything
       the index missed. A record present in neither does not exist. */
    const keys = await allKeys(store, kind);
    const records = await Promise.all(
      keys.map(k => store.get(k, { type: 'json' }).catch(() => null))
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
/* ---------- the index, and why it exists ---------------------------
   Netlify Blobs reads a key you just wrote straight back, but LISTING
   is only eventually consistent — a new key can take the better part
   of a minute to show up under store.list(). loadAll enumerated every
   record with list(), so anything newly created was missing from the
   next load: save a job and reload, and it was not there; wait, reload
   again, and it was. Measured on the live site, a new record was still
   invisible to list 21 seconds after the write returned ok.

   Worse than the confusion, it corrupted data. Issuing a document
   reads the highest number already used; a reload in that window
   loaded a document set with the newest one missing, so the next
   document reused its number. That is how three different estimates
   ended up numbered EST-0010.

   So each kind keeps its own index of ids at index/<kind>, written
   with the record. Reads take the union of the index and list(): the
   index makes a new record visible at once, and list still heals the
   index if a write of it is ever lost. Neither source alone is
   trusted, which is what makes it safe. */
async function put(store, { kind, id, value }) {
  if (kind === 'settings' || kind === 'business') {
    await store.setJSON(kind, value);
    return { ok: true };
  }
  if (!KINDS.includes(kind)) return { error: 'Unknown kind' };
  if (!id || /[^A-Za-z0-9._-]/.test(id)) return { error: 'Bad id' };
  await store.setJSON(`${kind}/${id}`, value);
  /* After the record, never before: an id in the index whose record is
     missing would read as a record that vanished. This way round the
     worst case is a record that takes the old path to becoming
     visible, which is what used to happen to all of them. */
  await addToIndex(store, kind, [id]);
  return { ok: true };
}

/* One action in the panel — issuing a document, recording a payment —
   touches several records at once. Sent one at a time, each is its own
   round trip to this function, and the panel sat there for seconds.
   They go together now and are written in parallel. If any one of them
   fails the whole batch is reported as failed, so the panel keeps all
   of them queued and retries: writing the same record twice is
   harmless, losing one is not. */
async function putMany(store, { items }) {
  if (!Array.isArray(items) || !items.length) return { error: 'Nothing to save' };
  if (items.length > 50) return { error: 'Too many records in one save' };
  /* The records in parallel, then one index write per kind. Letting
     each put update the index would have them read-modify-write the
     same key at the same time and lose each other's ids. */
  const results = await Promise.all(items.map(it => putRecordOnly(store, it)
    .catch(e => ({ error: String(e) }))));
  const bad = results.find(r => r && r.error);
  if (bad) return { error: bad.error };

  const byKind = {};
  items.forEach(it => {
    if (it.kind === 'settings' || it.kind === 'business') return;
    (byKind[it.kind] = byKind[it.kind] || []).push(it.id);
  });
  for (const [kind, ids] of Object.entries(byKind)) await addToIndex(store, kind, ids);

  return { ok: true, saved: items.length };
}

/* The record without touching the index — putMany does the index once
   per kind afterwards. */
async function putRecordOnly(store, { kind, id, value }) {
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
  /* Out of the index too, or the next load keeps asking for a record
     that is gone. A miss is harmless — loadAll drops the nulls — but
     it is a read per load, forever. */
  await removeFromIndex(store, kind, id);
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
  /* The index as well as the list. A stale list on a store that was
     seeded a moment ago would read as empty and seed it again, writing
     the starting contractors over the real ones — the one place where
     a stale list could destroy data rather than just hide it. */
  const keys = await allKeys(store, 'contractor');
  if (keys.length) return { ok: true, seeded: false };

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
