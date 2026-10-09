/* =====================================================================
   FlatOut — the customer's page, server side
   =====================================================================
   This is the ONLY part of the panel that answers without a password,
   because the customer is not logging in. Everything about it is
   written to be narrow.

   WHAT IT WILL DO
     1. Given a token and the 4-digit code, return ONE job, cut down to
        what that customer is entitled to see.
     2. Record that they accepted their quote.

   That is the whole list. It cannot list jobs, search, read a
   contractor, read another job, or write anything else. If it is ever
   asked to, it says no.

   WHAT IT WILL NOT RETURN, EVER
     contractor cost, margin, rate cards, contractor phone numbers,
     internal notes, the activity log, other jobs, other customers.
   The panel's own API returns whole records; this one hands back a
   hand-built object, so a field added to a job later cannot leak here
   by accident. That is why `view()` lists fields one by one instead of
   copying the record and deleting things.

   IT NEVER WRITES A JOB
   The two things it does record — that someone got in, and that they
   accepted — go in blobs of their own, keyed by job id. Nothing the
   customer does touches the job record itself. That matters for two
   reasons: the panel holds jobs in memory and saves them whole, so a
   write here could be silently wiped by Dan saving the job a minute
   later; and an unauthenticated writer should not be able to reach a
   record that holds everything about a job.

   THE CODE IS NOT A PASSWORD
   Four digits is 10,000 guesses. The token is the real secret; the
   code only means a forwarded link is not enough on its own. So wrong
   codes are counted and the job locks after MAX_TRIES until Dan resets
   it from the panel.
   ===================================================================== */

import { getStore } from '@netlify/blobs';

const STORE = 'flatout-panel';
const MAX_TRIES = 8;

export default async (req) => {
  try {
    const store = getStore(STORE);
    const url = new URL(req.url);

    if (req.method === 'GET') {
      if (url.searchParams.get('action') === 'photo') {
        return servePhoto(store, url.searchParams.get('key'), url.searchParams.get('token'), url.searchParams.get('code'));
      }
      return json({ error: 'Unknown action' }, 400);
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const body = await req.json().catch(() => ({}));
    const token = clean(body.token, 64);
    const code = clean(body.code, 8);
    if (!token) return json({ error: 'That link is not complete.' }, 400);

    const found = await findByToken(store, token);
    if (!found) {
      // Same answer whether the token is wrong or the job is gone, so
      // this cannot be used to find out which tokens exist.
      return json({ error: 'We could not find that. Check the link, or text Dan on 027 408 6895.' }, 404);
    }
    const { job, business } = found;
    const gate = (await store.get(`portal/${job.id}`, { type: 'json' }).catch(() => null)) || { tries: 0, openedAt: null };

    // A code reset from the panel clears the count.
    if (job.portal.codeSetAt && gate.codeSetAt !== job.portal.codeSetAt) {
      gate.tries = 0;
      gate.codeSetAt = job.portal.codeSetAt;
    }

    if ((gate.tries || 0) >= MAX_TRIES) {
      return json({ locked: true, error: 'Too many wrong codes. Text Dan on 027 408 6895 and he will send you a new one.' }, 429);
    }
    if (!code) return json({ needCode: true });
    if (String(code) !== String(job.portal.code)) {
      gate.tries = (gate.tries || 0) + 1;
      await store.setJSON(`portal/${job.id}`, gate);
      const left = MAX_TRIES - gate.tries;
      return json({
        needCode: true,
        error: left > 0
          ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'Too many wrong codes. Text Dan on 027 408 6895.',
        locked: left <= 0
      }, 401);
    }

    // Right code. Clear the counter and note that they have been in.
    if (gate.tries || !gate.openedAt) {
      gate.tries = 0;
      gate.openedAt = gate.openedAt || new Date().toISOString();
      gate.codeSetAt = job.portal.codeSetAt || gate.codeSetAt || null;
      await store.setJSON(`portal/${job.id}`, gate);
    }

    if (body.action === 'accept') {
      return json(await accept(store, job, business));
    }
    if (body.action === 'open' || !body.action) {
      return json(await view(store, job, business));
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    console.error('panel-public failed:', err);
    return json({ error: 'Something went wrong at our end. Text Dan on 027 408 6895.' }, 500);
  }
};

/* ---------- finding the one job --------------------------------- */
async function findByToken(store, token) {
  const { blobs } = await store.list({ prefix: 'job/' });
  for (const b of blobs) {
    const job = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (job && job.portal && job.portal.token && timingSafeEqual(String(job.portal.token), token)) {
      const business = await store.get('business', { type: 'json' }).catch(() => null);
      return { job, business: business || {} };
    }
  }
  return null;
}

/* ---------- what the customer is allowed to see ------------------ */
async function view(store, job, business) {
  const { blobs } = await store.list({ prefix: 'document/' });
  const docs = [];
  for (const b of blobs) {
    const d = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (d && d.jobId === job.id) docs.push(d);
  }
  docs.sort((a, b) => String(a.issuedAt).localeCompare(String(b.issuedAt)));

  const paid = (job.payments || []).reduce((t, p) => t + Number(p.amount || 0), 0);
  const acc = await store.get(`acceptance/${job.id}`, { type: 'json' }).catch(() => null);
  const live = docs.filter(d => d.type === 'quote' && d.status !== 'voided');
  /* Once they have accepted, the quote they accepted is the one that
     counts — not whatever was issued afterwards. A later quote is a
     variation to be agreed, and must not quietly change what the
     customer believes they owe. */
  const quote = (acc && live.find(d => d.no === acc.quoteNo)) || live[live.length - 1] || null;
  const expired = quote && quote.validUntil && quote.validUntil < isoToday();

  return {
    ok: true,
    customer: { firstName: String(job.cust.name || '').trim().split(/\s+/)[0] },
    job: {
      id: job.id,
      address: job.cust.address,
      date: job.cust.moveDate,
      status: job.status,
      stageLabel: stageLabel(job),
      done: job.stage >= 7
    },
    money: {
      total: quote ? quote.total : null,
      paid,
      outstanding: quote ? Math.max(0, quote.total - paid) : null
    },
    /* The frozen HTML, exactly as it was issued. */
    documents: docs.map(d => ({
      no: d.no, type: d.type, issuedOn: d.issuedOn, status: d.status,
      amountDue: d.amountDue, dueDate: d.dueDate, validUntil: d.validUntil,
      html: d.html
    })),
    /* Trade and arrival window only. The contractor's NAME appears on
       the morning of the job and not before: the supplier list is the
       thing a competitor would most like, and a customer does not need
       it to know someone is coming. */
    crew: await crewView(store, job),
    photos: job.stage >= 7 ? collectPhotos(job) : [],
    accept: {
      possible: !!quote && !acc && !expired && job.status === 'active',
      already: !!acc,
      acceptedOn: acc ? acc.at : null,
      expired: !!expired,
      quoteNo: quote ? quote.no : null,
      validUntil: quote ? quote.validUntil : null
    },
    business: {
      name: business.name || 'FlatOut NZ',
      phone: business.phone || '027 408 6895',
      web: business.web || 'flatoutnz.co.nz',
      entity: business.entity || 'A partnership',
      nzbn: business.nzbn || '',
      gstRegistered: !!business.gstRegistered,
      termsVersion: business.termsVersion || '1.0'
    }
  };
}

async function accept(store, job, business) {
  const { blobs } = await store.list({ prefix: 'document/' });
  let quote = null;
  for (const b of blobs) {
    const d = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (d && d.jobId === job.id && d.type === 'quote' && d.status !== 'voided') {
      if (!quote || String(d.issuedAt) > String(quote.issuedAt)) quote = d;
    }
  }
  if (!quote) return { error: 'There is no quote to accept yet.' };
  if (job.status !== 'active') return { error: 'This job is not open. Text Dan on 027 408 6895.' };
  if (quote.validUntil && quote.validUntil < isoToday()) {
    return { error: 'This quote has expired. Text Dan on 027 408 6895 for a fresh one.' };
  }
  const existing = await store.get(`acceptance/${job.id}`, { type: 'json' }).catch(() => null);
  if (existing) return view(store, job, business);

  /* A blob of its own, not a field on the job — see the note at the
     top. The panel picks it up on its next refresh and moves the job
     along itself. */
  await store.setJSON(`acceptance/${job.id}`, {
    jobId: job.id,
    at: new Date().toISOString(),
    how: 'online',
    quoteNo: quote.no,
    termsVersion: business.termsVersion || '1.0'
  });

  return view(store, job, business);
}

/* ---------- photos ------------------------------------------------ */
async function servePhoto(store, key, token, code) {
  if (!key || !key.startsWith('photo/')) return json({ error: 'Bad key' }, 400);
  const found = await findByToken(store, clean(token, 64));
  if (!found) return json({ error: 'Not found' }, 404);
  const { job } = found;
  if (String(clean(code, 8)) !== String(job.portal.code)) return json({ error: 'Not authorised' }, 401);
  if (job.stage < 7) return json({ error: 'Not found' }, 404);
  if (!collectPhotos(job).includes(key)) return json({ error: 'Not found' }, 404);

  const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!blob) return json({ error: 'Not found' }, 404);
  return new Response(blob.data, {
    headers: { 'content-type': blob.metadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=3600' }
  });
}

/* Trade and whether they are confirmed, always. The contractor's NAME
   is looked up only from the morning of the job onwards — before that
   the lookup does not even happen, so there is nothing to leak. */
async function crewView(store, job) {
  const orders = liveOrders(job);
  const reveal = revealNames(job);
  const out = [];
  for (const p of orders) {
    let name = null;
    if (reveal && p.contractorId) {
      const c = await store.get(`contractor/${p.contractorId}`, { type: 'json' }).catch(() => null);
      name = c ? c.name : null;
    }
    out.push({
      service: SERVICES[p.key] || p.key,
      confirmed: p.status === 'accepted' || p.status === 'done',
      done: p.status === 'done',
      name
    });
  }
  return out;
}

const collectPhotos = job =>
  Object.values(job.sections || {}).flatMap(s => s.photos || []);

/* ---------- small helpers ---------------------------------------- */
const SERVICES = { cleaning: 'Cleaning', rubbish: 'Rubbish removal', moving: 'Moving', storage: 'Storage' };

const liveOrders = job => (job.pos || []).filter(p => p.status !== 'replaced');

/* The crew's name shows from the morning of the job onwards. */
function revealNames(job) {
  return !!job.cust.moveDate && job.cust.moveDate <= isoToday();
}

function stageLabel(job) {
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'lost') return 'Not going ahead';
  if (job.status === 'standby') return 'On hold at your request';
  const n = job.stage || 0;
  if (n >= 7) return 'All done';
  if (n >= 6) return 'Booked in — your crews have their orders';
  if (n >= 5) return 'Paid — we are briefing your crews';
  if (n >= 4) return 'Waiting on payment';
  if (n >= 3) return 'Accepted — your quote is confirmed';
  if (n >= 2) return 'With you to accept';
  if (n >= 1) return 'Priced — your quote is on its way';
  return 'We have your details';
}

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const clean = (v, max) => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, max);

/* Constant-time-ish compare, so a wrong token can't be narrowed down
   by how long the answer takes. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow'
    }
  });
}

/* Deliberately NOT under /panel/, which the password gate covers —
   the customer has no password. Everything that protects this one is
   in this file. */
export const config = { path: '/j/api' };
