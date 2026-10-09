/* =====================================================================
   FlatOut Employees Panel — DATA ADAPTER (Phase 2, Netlify Blobs)
   =====================================================================
   The only file that holds data or changes it. The UI calls the
   functions on `Data` and never touches a record directly.

   HOW THIS WORKS
   On boot, Data.init() loads everything once from /panel/api/data into
   memory. Reads then stay synchronous, exactly as they were in Phase 1,
   so index.html did not have to change. Every write updates memory
   immediately (so the screen responds at once) and queues a save to the
   server.

   WHAT THAT MEANS IN PRACTICE
   - If Rocky changes something, you won't see it until you reload.
     At two people and a few jobs a week that is fine; if it starts
     biting, the fix is a periodic refetch.
   - A save can fail. When it does the UI says so and keeps retrying —
     see onSaveState below. A change that silently failed to save is the
     worst outcome, so it is made loud.
   ===================================================================== */

const Data = (() => {
  'use strict';

  const API = '/panel/api/data';

  /* ---------- fixed vocabulary ------------------------------------- */
  const SERVICES = { cleaning: 'Cleaning', rubbish: 'Rubbish removal', moving: 'Moving', storage: 'Storage' };
  const SERVICE_KEYS = Object.keys(SERVICES);
  const OWNERS = ['Daniel Bell', 'Rocky Lin'];
  const TITLES = { 'Daniel Bell': 'Executive Officer' };
  const MARGIN = 0.15;
  const ACCESS_ITEMS = ['Off-street parking', 'Stairs to unit', 'Keys with tenant', 'Power on',
    'Water on', 'Pets on property', 'Narrow access', 'Lockbox on site'];
  /* Eight stages. "New" exists because a job is now entered from the
     quote request before anyone has been to the property, and "Paid" is
     its own stage rather than being skipped: payment and issuing the
     job orders are two separate things you do. */
  const STAGES = ['New', 'Scoped', 'Estimate sent', 'Accepted', 'Quote sent',
    'Paid', 'Job orders out', 'Done'];
  const SCHEMA = 2;  // bump when the shape of a stored job changes
  /* Standby: the flat is doing it themselves but wants us on file in case
   they need a last-minute clean. No urgency, no pipeline, no deadline —
   it just sits there until their move-out date comes round, when the
   panel asks you to deal with it. Nothing expires on its own: there is
   no server ticking away, and a record quietly deleting itself is not
   something you could notice had gone wrong. */
  const JOB_STATUS = { active: 'Active', standby: 'On standby', lost: 'Lost', cancelled: 'Cancelled' };
  const SIGNOFF_CHECKS = ['Contractor photos reviewed', 'Customer confirmed they are happy',
    'No damage or issues reported', 'Keys and access returned'];
  const PAYMENT_TERMS = ['14 days', '1 month', 'On completion (on site)'];
  const ALERT_TYPES = {
    accept: 'Customer accepts an estimate',
    pay: 'Customer pays or puts the deposit in',
    decline: 'Contractor declines a job order',
    silent: 'Contractor misses the 2-day reply window',
    done: 'Contractor marks a job done',
    caccept: 'Contractor accepts a job order'
  };

  /* ---------- dates ------------------------------------------------ */
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /* NZ public holidays plus Canterbury Anniversary Day. Used by the
     2-business-day contractor reply window and the 3-business-day
     deposit, so nobody collects a strike over a long weekend.
     Add future years here as they are gazetted. */
  const HOLIDAYS = new Set([
    '2026-01-01', '2026-01-02', '2026-02-06', '2026-04-03', '2026-04-06',
    '2026-04-27', '2026-06-01', '2026-07-10', '2026-10-26', '2026-11-13',
    '2026-12-25', '2026-12-28',
    '2027-01-01', '2027-01-04', '2027-02-08', '2027-04-16', '2027-04-19',
    '2027-04-26', '2027-06-07', '2027-06-25', '2027-10-25', '2027-11-12',
    '2027-12-27', '2027-12-28'
  ]);
  const isBusinessDay = d => {
    const w = d.getDay();
    return w !== 0 && w !== 6 && !HOLIDAYS.has(isoDate(d));
  };
  function addBusinessDays(date, n) {
    const x = new Date(date), step = Math.sign(n);
    let left = Math.abs(n);
    while (left > 0) { x.setDate(x.getDate() + step); if (isBusinessDay(x)) left--; }
    return x;
  }
  function addDays(date, n) { const x = new Date(date); x.setDate(x.getDate() + n); return x; }

  /* Jobs saved before the stage list changed used seven stages with no
     "New": old 0 was the walk-through, and "Paid" was never reachable.
     Shifting every old stage up by one lands each job in the right
     place on the new list. Marked with a schema number so it only
     happens once. */
  function migrateJob(j) {
    if (!j) return j;
    if ((j.schema || 1) < 2) {
      j.stage = Math.min(STAGES.length - 1, (j.stage ?? 0) + 1);
      j.schema = 2;
    }
    if (!j.status) j.status = 'active';
    if (!Array.isArray(j.notes)) j.notes = [];
    if (!Array.isArray(j.log)) j.log = [];
    if (!Array.isArray(j.pos)) j.pos = [];
    if (!j.sections) j.sections = {};
    return j;
  }

  /* ---------- in-memory model, filled by init() -------------------- */
  let contractors = [], jobs = [], templates = [], alerts = [], customers = [], documents = [];
  let acceptances = [], portalGates = [];
  let alertSettings = {};
  let ready = false;

  /* Everything that appears on a customer document and is not part of
     a particular job. Stored with the settings blob so the two owners
     share one set. GST is off until the partnership registers — it has
     to be a switch rather than a rewrite, because crossing the $60k
     threshold happens mid-season and not on a quiet afternoon. */
  const BUSINESS_DEFAULTS = {
    name: 'FlatOut NZ',
    entity: 'A partnership',
    nzbn: '9429053975751',
    place: 'Christchurch, New Zealand',
    phone: '027 408 6895',
    web: 'flatoutnz.co.nz',
    logo: '/images/logo-icon.png',
    signature: '',
    termsVersion: '1.0',
    quoteValidDays: 14,
    bank: { accountName: '', accountNumber: '', bank: '' },
    gstRegistered: false,
    gstNumber: '',
    gstRate: 0.15
  };
  let business = Object.assign({}, BUSINESS_DEFAULTS);

  const getContractor = id => contractors.find(c => c.id === id) || null;
  const getCustomer = id => customers.find(c => c.id === id) || null;
  const contractorsCovering = key => contractors.filter(c => c.services.includes(key));
  const getRateItem = (cid, iid) => getContractor(cid)?.items.find(i => i.id === iid) || null;
  const getJob = id => jobs.find(j => j.id === id) || null;
  const getTemplate = id => templates.find(t => t.id === id) || null;
  const livePos = job => job.pos.filter(p => p.status !== 'replaced');
  const findPo = (job, no) => job.pos.find(p => p.no === no) || null;

  /* ids. Jobs and POs are numbered from what already exists rather than
     from a stored counter, so two people creating records at once can't
     both be handed the same number by a stale counter. Items and new
     contractors get random ids, which can't collide at all. */
  const rid = () => Math.random().toString(36).slice(2, 10);
  function nextJobId() {
    const max = jobs.reduce((m, j) => Math.max(m, Number(String(j.id).replace(/\D/g, '')) || 0), 1000);
    return 'J-' + (max + 1);
  }
  function nextPoNo() {
    const max = jobs.flatMap(j => j.pos).reduce((m, p) => Math.max(m, Number(String(p.no).replace(/\D/g, '')) || 0), 0);
    return 'PO-' + String(max + 1).padStart(4, '0');
  }
  function slug(name) {
    let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'contractor';
    let id = base, n = 2;
    while (getContractor(id)) id = `${base}-${n++}`;
    return id;
  }

  /* ---------- saving ----------------------------------------------- */
  /* Saves are queued per record and retried. The UI is told about the
     state so an unsaved change is visible rather than silent. */
  const pending = new Map();      // key -> {kind, id, value}
  let saving = false, failures = 0, saveListener = null;

  function reportSave() {
    if (!saveListener) return;
    saveListener(pending.size === 0 && !saving ? 'saved' : failures ? 'failing' : 'saving');
  }

  function queueSave(kind, id, value) {
    pending.set(`${kind}/${id || ''}`, { kind, id, value });
    reportSave();
    flush();
  }

  let flushTimer = null;
  function flush() {
    if (saving || !pending.size) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(runFlush, failures ? Math.min(30000, 1000 * 2 ** failures) : 150);
  }

  async function runFlush() {
    if (saving || !pending.size) return;
    saving = true;
    reportSave();
    const [key, item] = pending.entries().next().value;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'put', kind: item.kind, id: item.id, value: item.value })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      pending.delete(key);
      failures = 0;
    } catch (err) {
      failures++;
      console.error('Save failed, will retry:', err);
    } finally {
      saving = false;
      reportSave();
      if (pending.size) flush();
    }
  }

  const saveJobRecord = j => queueSave('job', j.id, j);
  const saveContractor = c => queueSave('contractor', c.id, c);
  const saveSettings = () => queueSave('settings', '', alertSettings);
  const saveBusiness = () => queueSave('business', '', business);
  const saveDocument = d => queueSave('document', d.id, d);
  const saveAcceptance = a => queueSave('acceptance', a.jobId, a);

  /* Acceptance is kept in its own record rather than on the job. The
     customer's page writes it without a password, and the panel holds
     jobs in memory and saves them whole — so a field on the job could
     be wiped by the next save from here. Keeping it apart means
     neither side can clobber the other. */
  const getAcceptance = jobId => acceptances.find(a => a.jobId === jobId) || null;
  const portalGate = jobId => portalGates.find(g => g.jobId === jobId)
    || { jobId, tries: 0, openedAt: null };

  async function removeRecord(kind, id) {
    try {
      await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'del', kind, id })
      });
    } catch (err) { console.error('Delete failed:', err); }
  }

  /* ---------- alerts ----------------------------------------------- */
  let alertListener = null;
  function raiseAlert(job, type, text) {
    const to = OWNERS.filter(o => alertSettings[o]?.types[type] && (!alertSettings[o].mineOnly || job.owner === o));
    if (!to.length) return;
    const a = { id: String(Date.now()) + '-' + rid(), type, jobId: job.id, text,
      at: new Date().toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
      to, readBy: [] };
    alerts.unshift(a);
    queueSave('alert', a.id, a);
    if (alertListener) alertListener(a);
  }

  /* ---------- money ------------------------------------------------
     A job is priced off the contractor's rate card, and rate cards
     change. Once an estimate has gone to a customer those numbers have
     to stop moving: putting GECS's hourly rate up must not quietly
     rewrite what a job you finished in March says it cost, or what a
     customer was quoted and has already paid.

     So sending the estimate takes a copy of every rate the job uses,
     and from then on the job is priced from its own copy. Jobs that
     have not been quoted yet still follow the live rate card, which is
     what you want while you are still pricing. */
  function lineItem(section, iid) {
    return (section.frozen && section.frozen[iid]) || getRateItem(section.contractorId, iid);
  }
  /* Copy the rates this section currently uses onto the section itself.
     `only` fills gaps without touching rates already frozen, which is
     what happens when an item is added to a job that is already out. */
  function freezeSection(s, onlyGaps) {
    const frozen = onlyGaps ? Object.assign({}, s.frozen) : {};
    Object.keys(s.lines).forEach(iid => {
      if (onlyGaps && frozen[iid]) return;
      const i = getRateItem(s.contractorId, iid);
      if (i) frozen[iid] = { id: i.id, name: i.name, unit: i.unit, type: i.type, rate: i.rate, section: i.section };
    });
    s.frozen = frozen;
  }
  function freezeJob(j, onlyGaps) {
    Object.values(j.sections).forEach(s => freezeSection(s, onlyGaps));
    if (!onlyGaps) j.pricedAt = isoDate(new Date());
  }

  function sectionCost(section) {
    return Object.entries(section.lines).reduce((t, [iid, q]) => {
      const i = lineItem(section, iid);
      return t + (i ? q * i.rate : 0);
    }, 0);
  }
  function jobCost(job) {
    return Object.values(job.sections).reduce((t, s) => t + sectionCost(s), 0);
  }
  const customerPrice = cost => Math.round(cost * (1 + MARGIN));

  function paymentTerms(job) {
    const total = customerPrice(jobCost(job));

    /* A job can be priced before it has a date. The shape stays the
       same so nothing downstream has to special-case it; the dates are
       simply null, and whatever displays them says so. */
    if (!job.cust.moveDate) {
      if (total <= 500) {
        return { kind: 'Full payment', amount: total, due: null,
          note: 'Paid in full 2 days before the job' };
      }
      const half = Math.round(total / 2);
      return { kind: '50% deposit', amount: half, due: null, balance: total - half,
        balanceDue: null,
        note: '50% deposit 3 business days before the job, balance 14 days after the deposit' };
    }

    const move = parseDate(job.cust.moveDate);
    if (total <= 500) {
      return { kind: 'Full payment', amount: total, due: addDays(move, -2),
        note: 'Paid in full 2 days before the job' };
    }
    const depositDue = addBusinessDays(move, -3);
    const half = Math.round(total / 2);
    return { kind: '50% deposit', amount: half, due: depositDue, balance: total - half,
      balanceDue: addDays(depositDue, 14),
      note: '50% deposit 3 business days before the job, balance 14 days after the deposit' };
  }

  /* ---------- scorecard -------------------------------------------- */
  function getScorecard(cid) {
    const c = getContractor(cid);
    if (!c) return { sent: 0, rate: null, rating: ['p-grey', 'No orders yet'], acc: 0, dec: 0, sil: 0, hrs: 0, strikes: 0 };
    const pos = jobs.flatMap(j => j.pos).filter(p => p.contractorId === cid && p.status !== 'awaiting');
    const acc = c.hist.acc + pos.filter(p => p.status === 'accepted' || p.status === 'done').length;
    const dec = c.hist.dec + pos.filter(p => p.status === 'declined' || (p.status === 'replaced' && p.reason)).length;
    const sil = c.hist.sil + pos.filter(p => p.status === 'silent' || (p.status === 'replaced' && p.wasSilent)).length;
    const sent = acc + dec + sil;
    const rate = sent ? acc / sent : null;
    const rating = !sent ? ['p-grey', 'No orders yet']
      : (c.strikes >= 2 || rate < 0.6) ? ['p-bad', 'At risk']
      : (c.strikes || rate < 0.85) ? ['p-warn', 'Watch']
      : ['p-ok', 'Reliable'];
    return { sent, acc, dec, sil, rate, hrs: c.hist.hrs, strikes: c.strikes, rating };
  }

  /* ---------- customers --------------------------------------------
     A customer is their own record, and a job points at one. That is
     what makes changing a phone number change it everywhere rather
     than only on the job you happened to be looking at.

     Matching is on phone and email only — never the address. Students
     move house every year, and two flatmates share one address while
     being two different customers. Names are far too weak to match on:
     there is more than one Sarah Wilson in Ilam. */

  /* The last 8 digits, so 021 123 4567, +64 21 123 4567 and
     0064211234567 are recognised as the same number. */
  function phoneKey(v) {
    const d = String(v || '').replace(/\D/g, '');
    return d.length >= 8 ? d.slice(-8) : '';
  }
  function emailKey(v) {
    const e = String(v || '').trim().toLowerCase();
    return /\S+@\S+/.test(e) ? e : '';
  }
  /* The quote form has a single "best contact" answer, so whichever
     field it landed in, work out which is which by looking at it. */
  function pickEmail(...vals) { return vals.map(emailKey).find(Boolean) || ''; }
  function pickPhone(...vals) {
    return vals.find(v => !emailKey(v) && String(v || '').replace(/\D/g, '').length >= 7) || '';
  }

  function findCustomerByContact(phone, email, exceptId) {
    const p = phoneKey(phone), e = emailKey(email);
    if (!p && !e) return null;
    return customers.find(c => c.id !== exceptId &&
      ((p && phoneKey(c.phone) === p) || (e && emailKey(c.email) === e))) || null;
  }

  function customerSlug(name) {
    const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'customer';
    let id = base, n = 2;
    while (getCustomer(id)) id = `${base}-${n++}`;
    return id;
  }

  function newCustomerRecord(f) {
    return {
      id: customerSlug(f.name), name: String(f.name || '').trim(),
      phone: String(f.phone || '').trim(), email: String(f.email || '').trim(),
      contact: f.contact === 'Email' ? 'Email' : 'Text',
      notes: String(f.notes || '').trim(),
      created: isoDate(new Date())
    };
  }
  const saveCustomer = c => queueSave('customer', c.id, c);

  const customerJobs = id => jobs.filter(j => j.custId === id);

  /* The job keeps its own copy of the contact details so that search,
     export and every existing screen keep working untouched. The
     customer record is the source of truth: an edit there is written
     through to each of their jobs, and logged on each one. */
  function syncJobsToCustomer(c, byOwner) {
    const touched = [];
    customerJobs(c.id).forEach(j => {
      const before = `${j.cust.name}|${j.cust.phone}|${j.cust.email || ''}|${j.cust.contact}`;
      j.cust.name = c.name; j.cust.phone = c.phone;
      j.cust.email = c.email; j.cust.contact = c.contact;
      if (`${c.name}|${c.phone}|${c.email}|${c.contact}` !== before) {
        if (byOwner) j.log.push(`Customer details updated by ${byOwner}`);
        saveJobRecord(j);
        touched.push(j.id);
      }
    });
    return touched;
  }

  /* ---------- building customer records out of existing jobs -------
     Jobs saved before customers existed carry the details inline. This
     works out what the customer list would be, grouping on phone and
     email, and is shown for checking before anything is written. */
  function planCustomerMigration() {
    const groups = [];
    jobs.filter(j => !j.custId).forEach(j => {
      const phone = pickPhone(j.cust.phone, j.cust.email);
      const email = pickEmail(j.cust.email, j.cust.phone);
      const p = phoneKey(phone), e = emailKey(email);
      let g = groups.find(x => (p && x.phones.has(p)) || (e && x.emails.has(e)));
      if (!g) {
        g = { name: j.cust.name || 'Unnamed', phone, email,
          contact: j.cust.contact === 'Email' ? 'Email' : 'Text',
          phones: new Set(), emails: new Set(), jobs: [] };
        groups.push(g);
      }
      if (p) g.phones.add(p);
      if (e) g.emails.add(e);
      // Prefer the most recent job's spelling of the name and any
      // detail an earlier job was missing.
      if (!g.phone && phone) g.phone = phone;
      if (!g.email && email) g.email = email;
      g.jobs.push(j.id);
    });
    return groups.map(g => ({ name: g.name, phone: g.phone, email: g.email,
      contact: g.contact, jobs: g.jobs }));
  }

  /* Point a new job at a customer. If you picked an existing one, their
     record wins over what was typed, so one person cannot end up with
     two spellings of their own phone number. Otherwise a new record is
     made from the job's details — there is no such thing as a job
     without a customer. */
  function attachCustomer(job, custId, byOwner) {
    let c = custId ? getCustomer(custId) : null;
    if (!c) {
      const phone = pickPhone(job.cust.phone, job.cust.email);
      const email = pickEmail(job.cust.email, job.cust.phone);
      c = findCustomerByContact(phone, email);
      if (!c) {
        c = newCustomerRecord({ name: job.cust.name, phone, email, contact: job.cust.contact });
        customers.push(c);
        saveCustomer(c);
        job.log.push(`Customer record created by ${byOwner}`);
      } else {
        job.log.push(`Matched to existing customer ${c.name}`);
      }
    } else {
      job.log.push(`Added to ${c.name}'s existing customer record`);
    }
    job.custId = c.id;
    job.cust.name = c.name;
    job.cust.phone = c.phone;
    job.cust.email = c.email;
    job.cust.contact = c.contact;
    return c;
  }

  function runCustomerMigration(plan, byOwner) {
    let made = 0, linked = 0;
    plan.forEach(g => {
      const c = newCustomerRecord(g);
      customers.push(c);
      saveCustomer(c);
      made++;
      g.jobs.forEach(id => {
        const j = getJob(id);
        if (!j) return;
        j.custId = c.id;
        j.cust.email = c.email;
        j.cust.phone = c.phone;
        j.log.push(`Linked to customer record by ${byOwner}`);
        saveJobRecord(j);
        linked++;
      });
    });
    return { made, linked };
  }

  /* ---------- documents --------------------------------------------
     An issued document is FROZEN: the HTML it rendered to is stored
     with it. What the customer opens in six months is exactly what was
     sent, whatever has changed since — the rate card, the terms, the
     logo, this code. A document that can quietly re-render is worth
     nothing if a price is ever disputed.

     A wrong document is never edited. It is voided and replaced by a
     new number that says what it replaces, the same way a contractor
     job order is. */

  /* Each type counts up on its own and never resets. Worked out from
     what exists rather than a stored counter, so two people issuing at
     once can't be handed the same number. */
  function nextDocNo(type, extra = []) {
    const prefix = Docs.TYPES[type].prefix;
    const all = documents.concat(extra).filter(d => d.type === type);
    const max = all.reduce((m, d) => Math.max(m, Number(String(d.no).replace(/\D/g, '')) || 0), 0);
    return prefix + '-' + String(max + 1).padStart(4, '0');
  }

  const docsFor = jobId => documents
    .filter(d => d.jobId === jobId)
    .sort((a, b) => String(a.issuedAt).localeCompare(String(b.issuedAt)));
  const liveDocs = jobId => docsFor(jobId).filter(d => d.status !== 'voided');
  const latestDoc = (jobId, type) => liveDocs(jobId).filter(d => d.type === type).pop() || null;
  const getDocument = id => documents.find(d => d.id === id) || null;

  /* A random token long enough that guessing one is not a strategy, and
     a 4-digit code sent by a different channel. The token is the real
     secret; the code is there so a forwarded link alone is not enough.
     Attempts are counted and the page locks — a 4-digit code with
     unlimited guesses is not a second factor. */
  function randomToken() {
    const bytes = new Uint8Array(16);
    (globalThis.crypto || {}).getRandomValues
      ? crypto.getRandomValues(bytes)
      : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
    return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 22);
  }
  function randomCode() {
    const n = (globalThis.crypto || {}).getRandomValues
      ? crypto.getRandomValues(new Uint32Array(1))[0]
      : Math.floor(Math.random() * 4294967296);
    return String(n % 10000).padStart(4, '0');
  }
  function ensurePortal(j) {
    if (!j.portal || !j.portal.token) {
      j.portal = { token: randomToken(), code: randomCode(), codeSetAt: new Date().toISOString() };
    }
    if (j.portal.tries == null) j.portal.tries = 0;
    return j.portal;
  }

  /* What the customer owes and when, as a schedule rather than prose,
     so the quote, the invoices and the portal all agree. */
  function paymentPlan(job) {
    const total = customerPrice(jobCost(job));

    /* No date yet, so there are no due dates — only the rule. Said as
       the rule rather than with invented dates, which would be worse
       than saying nothing. */
    if (!job.cust.moveDate) {
      if (total <= 500) {
        return { total, dated: false,
          schedule: [{ key: 'full', what: 'Full payment', amount: total, due: null }],
          sentence: 'Jobs of $500 or less are paid in full two days before the job.',
          warning: 'Payment is due two days before the job, once we have a date.' };
      }
      const half = Math.round(total / 2);
      return { total, dated: false,
        schedule: [
          { key: 'deposit', what: '50% deposit', amount: half, due: null },
          { key: 'balance', what: 'Balance', amount: total - half, due: null }
        ],
        sentence: 'Jobs over $500 are a 50% deposit three business days before the job, with the balance 14 days after.',
        warning: 'The deposit is due three business days before the job, once we have a date.' };
    }

    const t = paymentTerms(job);
    if (t.kind === 'Full payment') {
      return {
        total, dated: true,
        schedule: [{ key: 'full', what: 'Full payment', amount: t.amount, due: isoDate(t.due) }],
        sentence: `Jobs of $500 or less are paid in full two days before the job. On this job that is $${fmtMoney(t.amount).replace('$', '')} on ${fmtDate(isoDate(t.due))}.`,
        warning: 'Payment is due two days before the job. If it has not arrived by then the job cannot go ahead.'
      };
    }
    return {
      total, dated: true,
      schedule: [
        { key: 'deposit', what: '50% deposit', amount: t.amount, due: isoDate(t.due) },
        { key: 'balance', what: 'Balance', amount: t.balance, due: isoDate(t.balanceDue) }
      ],
      sentence: `Jobs over $500 are a 50% deposit three business days before the job, with the balance 14 days after. On this job that is $${fmtMoney(t.amount).replace('$', '')} on ${fmtDate(isoDate(t.due))} and $${fmtMoney(t.balance).replace('$', '')} on ${fmtDate(isoDate(t.balanceDue))}.`,
      warning: 'The deposit is due three business days before the job. If it has not arrived by then the job cannot go ahead — we would rather tell you early than send contractors to a job we cannot pay for.'
    };
  }

  const paidTotal = jobId => (getJob(jobId)?.payments || [])
    .reduce((t, p) => t + Number(p.amount || 0), 0);

  /* The snapshot a document renders from. Everything the template needs
     is read here, once, and never again. */
  function buildCtx(job, type, opts, byOwner) {
    const cust = job.custId ? getCustomer(job.custId) : null;
    const plan = paymentPlan(job);
    const nameParts = String(job.cust.name || '').trim().split(/\s+/);
    return Object.assign({
      type,
      no: opts.no,
      issued: isoDate(new Date()),
      issuedBy: byOwner,
      issuedByTitle: TITLES[byOwner] || '',
      issuedVerb: type === 'invoice' || type === 'receipt' ? 'Issued by' : 'Prepared by',
      termsVersion: business.termsVersion,
      business: JSON.parse(JSON.stringify(business)),
      customer: {
        name: job.cust.name,
        surname: nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameParts[0],
        email: (cust && cust.email) || job.cust.email || '',
        phone: (cust && cust.phone) || job.cust.phone || ''
      },
      job: { id: job.id, address: job.cust.address, date: job.cust.moveDate },
      seen: !!(job.cust.address && job.cust.moveDate),
      services: itemiseJob(job),
      total: plan.total,
      payment: plan,
      voided: false
    }, opts.ctx || {});
  }

  /* Every line the customer is paying for, with its own price.
     The customer's price for a line is its cost plus the margin. Those
     round individually, and rounded parts do not have to add up to a
     rounded whole — so the leftover cent or two is pushed onto the
     largest line. The lines then always sum to the figure at the
     bottom, which is the first thing anyone checks. */
  function itemiseJob(job) {
    const rows = [];
    Object.entries(job.sections).forEach(([k, sec]) => {
      Object.entries(sec.lines).forEach(([iid, q]) => {
        const i = lineItem(sec, iid);
        if (!i || !q) return;
        rows.push({ key: k, name: i.name, qty: q, hourly: i.type === 'hourly',
          cost: q * i.rate, amount: 0 });
      });
    });

    const total = customerPrice(rows.reduce((t, r) => t + r.cost, 0));
    rows.forEach(r => { r.amount = Math.round(r.cost * (1 + MARGIN)); });
    const drift = total - rows.reduce((t, r) => t + r.amount, 0);
    if (drift && rows.length) {
      const biggest = rows.reduce((a, b) => (b.amount > a.amount ? b : a), rows[0]);
      biggest.amount += drift;
    }

    return Object.entries(job.sections).map(([k, sec]) => {
      const items = rows.filter(r => r.key === k);
      return {
        name: SERVICES[k],
        when: job.cust.moveDate ? fmtDate(job.cust.moveDate) : '',
        items,
        // sec.notes is written for the contractor ("keys with the
        // tenant", "dog on site") and has no business on a customer
        // document, so it is deliberately not carried through.
        detail: items.map(i => i.name).join('. ') || 'As discussed at the walk-through.'
      };
    });
  }

  /* Issue: build the snapshot, render it, freeze it, store it. */
  function issueDocument(jobId, type, byOwner, extra = {}) {
    const job = getJob(jobId);
    if (!job) return { error: 'That job no longer exists.' };
    if (!Docs.TYPES[type]) return { error: 'Unknown document type.' };
    /* An estimate goes out before you have been to the property, so it
       asks for nothing but a name and a price. A quote is the firm
       document and an invoice asks for money, so those do need to say
       which property and which day. */
    if (type !== 'estimate') {
      if (!job.cust.address) return { error: 'A ' + type + ' needs the address. Add it with Edit details.' };
      if (!job.cust.moveDate) return { error: 'A ' + type + ' needs the move-out date. Add it with Edit details.' };
    }
    if (!String(job.cust.name || '').trim()) return { error: 'The job needs a customer name.' };
    if (type !== 'receipt' && !jobCost(job)) {
      return { error: 'Nothing is priced yet, so there is nothing to put on a document.' };
    }
    if ((type === 'invoice' || type === 'receipt') && !(business.bank.accountName && business.bank.accountNumber)) {
      return { error: 'Add the bank account under Settings first — an invoice without it cannot be paid.' };
    }

    ensurePortal(job);
    const no = nextDocNo(type);
    const plan = paymentPlan(job);
    const ctx = buildCtx(job, type, { no, ctx: documentExtras(job, type, plan, extra) }, byOwner);
    // Frozen means frozen: the stylesheet travels with the document,
    // so it still renders exactly like this when docs.js has moved on.
    const html = '<style>' + Docs.CSS + '</style>' + Docs.render(type, ctx);

    const doc = {
      id: 'D-' + Date.now().toString(36) + '-' + rid(),
      no, type, jobId, custId: job.custId || null,
      status: 'issued',
      issuedAt: new Date().toISOString(),
      issuedOn: ctx.issued,
      issuedBy: byOwner,
      total: ctx.total,
      amountDue: ctx.amountDue != null ? ctx.amountDue : ctx.total,
      dueDate: ctx.dueDate || null,
      validUntil: ctx.validUntil || null,
      instalment: extra.instalment || null,
      replaces: extra.replaces || null,
      html
    };
    documents.unshift(doc);
    saveDocument(doc);
    job.log.push(`${no} issued by ${byOwner}` + (extra.replaces ? `, replacing ${extra.replaces}` : ''));
    saveJobRecord(job);
    return { document: doc };
  }

  /* The per-type fields the shared snapshot doesn't cover. */
  function documentExtras(job, type, plan, extra) {
    const q = latestDoc(job.id, 'quote');
    const paid = paidTotal(job.id);
    if (type === 'estimate' || type === 'quote') {
      return { validUntil: isoDate(addDays(new Date(), business.quoteValidDays)), portalUrl: portalUrl(job) };
    }
    if (type === 'invoice') {
      const inst = plan.schedule.find(s => s.key === (extra.instalment || 'deposit')) || plan.schedule[0];
      const others = plan.schedule.filter(s => s.key !== inst.key);
      const notYetDue = others.filter(s => !isInstalmentPaid(job, s.key)).reduce((t, s) => t + s.amount, 0);
      return {
        quoteNo: q ? q.no : null,
        acceptedOn: (getAcceptance(job.id) || {}).at ? getAcceptance(job.id).at.slice(0, 10) : null,
        instalmentLabel: plan.schedule.length > 1
          ? (inst.key === 'deposit' ? 'DEPOSIT · 1 OF 2' : 'BALANCE · 2 OF 2') : 'DUE IN FULL',
        amountDue: inst.amount,
        dueDate: inst.due,
        alreadyPaid: paid || 0,
        notYetDue,
        balanceDue: (plan.schedule.find(s => s.key === 'balance') || {}).due || null
      };
    }
    // receipt
    const inv = extra.invoiceNo ? documents.find(d => d.no === extra.invoiceNo) : latestDoc(job.id, 'invoice');
    return {
      invoiceNo: inv ? inv.no : null,
      received: Number(extra.received || 0),
      receivedOn: extra.receivedOn || isoDate(new Date()),
      method: extra.method || 'Bank transfer',
      forWhat: extra.forWhat || 'Payment',
      paidToDate: paid,
      outstanding: Math.max(0, plan.total - paid),
      balanceDue: (plan.schedule.find(s => s.key === 'balance') || {}).due || null
    };
  }

  const isInstalmentPaid = (job, key) =>
    (job.payments || []).some(p => p.instalment === key);

  function portalUrl(job) {
    const p = ensurePortal(job);
    const origin = (typeof location !== 'undefined' && location.origin) || 'https://flatoutnz.co.nz';
    return `${origin}/j/#${p.token}`;
  }

  /* =================================================================
     PUBLIC API
     ================================================================= */
  return {
    SERVICES, SERVICE_KEYS, OWNERS, TITLES, MARGIN, ACCESS_ITEMS, STAGES,
    SIGNOFF_CHECKS, PAYMENT_TERMS, ALERT_TYPES,
    today: () => new Date(),
    addBusinessDays, addDays, parseDate, isoDate,

    /* ---- startup ------------------------------------------------- */
    isReady: () => ready,
    onSaveState(fn) { saveListener = fn; },
    onAlert(fn) { alertListener = fn; },

    async init() {
      // Seed on first ever run (no-op afterwards), then load everything.
      await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'seed' })
      }).catch(() => {});

      const res = await fetch(API + '?action=load');
      if (!res.ok) throw new Error('Could not load the panel data (HTTP ' + res.status + ')');
      const d = await res.json();
      if (d.error) throw new Error(d.error);

      contractors = d.contractors || [];
      customers = (d.customers || []).sort((a, b) => a.name.localeCompare(b.name));
      documents = (d.documents || []).sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
      acceptances = d.acceptances || [];
      portalGates = d.portals || [];
      jobs = (d.jobs || []).map(migrateJob)
        .sort((a, b) => String(b.id).localeCompare(String(a.id)));
      templates = d.templates || [];
      alerts = (d.alerts || []).sort((a, b) => String(b.id).localeCompare(String(a.id)));
      alertSettings = d.settings || {};
      business = Object.assign({}, BUSINESS_DEFAULTS, d.business || {},
        { bank: Object.assign({}, BUSINESS_DEFAULTS.bank, (d.business || {}).bank) });
      OWNERS.forEach(o => {
        if (!alertSettings[o]) {
          alertSettings[o] = { types: { accept: true, pay: true, decline: true, silent: true, done: true, caccept: false }, mineOnly: false };
        }
      });
      ready = true;
      reportSave();
      return true;
    },

    /* ---- enquiries ------------------------------------------------
       Typed in by hand for now. The Google Sheet feed is Stage 3; when
       it arrives, only this function changes. */
    listEnquiries: () => [],
    getEnquiry: () => null,
    bookVisit() { return null; },

    /* ---- customers ----------------------------------------------- */
    listCustomers: () => customers.slice().sort((a, b) => a.name.localeCompare(b.name)),
    getCustomer, customerJobs, findCustomerByContact, phoneKey, emailKey,
    pickPhone, pickEmail,

    /* How many jobs they have had with us, and which. Shown on the job
       page so a returning customer is obvious while you are pricing. */
    customerHistory(custId, exceptJobId) {
      const all = customerJobs(custId)
        .filter(j => j.status !== 'cancelled')
        .sort((a, b) => String(b.id).localeCompare(String(a.id)));
      return { count: all.length, previous: all.filter(j => j.id !== exceptJobId) };
    },

    /* Another job at the same address. Flagged, never linked: it is
       usually two flatmates booking separately, and occasionally a
       whole-flat job that got entered twice. */
    jobsAtAddress(address, exceptJobId) {
      const a = String(address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (a.length < 8) return [];
      return jobs.filter(j => j.id !== exceptJobId &&
        String(j.cust.address || '').toLowerCase().replace(/[^a-z0-9]/g, '') === a);
    },

    createCustomer(fields, byOwner) {
      const c = newCustomerRecord(fields);
      if (!c.name) return { error: 'A customer needs a name.' };
      customers.push(c);
      saveCustomer(c);
      return { customer: c, by: byOwner };
    },

    /* Writes through to every job of theirs, and says which. */
    updateCustomer(id, fields, byOwner) {
      const c = getCustomer(id);
      if (!c) return { error: 'That customer no longer exists.' };
      if (!String(fields.name || '').trim()) return { error: 'A customer needs a name.' };
      const clash = findCustomerByContact(fields.phone, fields.email, id);
      c.name = String(fields.name).trim();
      c.phone = String(fields.phone || '').trim();
      c.email = String(fields.email || '').trim();
      c.contact = fields.contact === 'Email' ? 'Email' : 'Text';
      c.notes = String(fields.notes || '').trim();
      saveCustomer(c);
      const touched = syncJobsToCustomer(c, byOwner);
      return { customer: c, jobs: touched, clash };
    },

    /* Two records, one person. Jobs follow, and the notes are kept
       rather than thrown away. Deleting a customer is deliberately not
       possible — a job pointing at a record that has gone is exactly
       the kind of thing that breaks a page. */
    mergeCustomers(fromId, intoId, byOwner) {
      const from = getCustomer(fromId), into = getCustomer(intoId);
      if (!from || !into) return { error: 'One of those customers no longer exists.' };
      if (fromId === intoId) return { error: 'That is the same customer.' };
      const moved = customerJobs(fromId).map(j => j.id);
      if (!into.phone && from.phone) into.phone = from.phone;
      if (!into.email && from.email) into.email = from.email;
      if (from.notes) into.notes = [into.notes, `(merged from ${from.name}) ${from.notes}`].filter(Boolean).join('\n');
      customerJobs(fromId).forEach(j => {
        j.custId = intoId;
        j.log.push(`Moved to customer ${into.name} by ${byOwner}`);
      });
      customers = customers.filter(c => c.id !== fromId);
      saveCustomer(into);
      syncJobsToCustomer(into, byOwner);
      customerJobs(intoId).forEach(saveJobRecord);
      removeRecord('customer', fromId);
      return { customer: into, moved };
    },

    /* ---- one-off: build customers from jobs entered before this --- */
    customerMigrationPlan: planCustomerMigration,
    needsCustomerMigration: () => jobs.some(j => !j.custId),
    runCustomerMigration,

    /* ---- jobs ---------------------------------------------------- */
    listJobs: () => jobs.slice(),
    getJob, livePos, findPo,

    saveJob(draft, byOwner) {
      const sections = {};
      Object.entries(draft.sections).forEach(([k, s]) => {
        if (Object.keys(s.lines).length) sections[k] = s;
      });
      const id = nextJobId();
      const job = { id, schema: SCHEMA, owner: byOwner, stage: 1, status: 'active',
        preparedBy: byOwner, cust: draft.cust, sections, pos: [], notes: [],
        log: [`Walk-through saved by ${byOwner}`] };
      attachCustomer(job, draft.custId, byOwner);
      jobs.unshift(job);
      saveJobRecord(job);
      return id;
    },

    /* A job entered from a quote request, before anyone has been to the
       property. Stage 0, nothing owed, nothing to do until you visit. */
    createJob(cust, byOwner, services = [], custId) {
      const id = nextJobId();
      const sections = {};
      services.forEach(k => { sections[k] = this.newSection(k); });
      const job = { id, schema: SCHEMA, owner: byOwner, stage: 0, status: 'active',
        preparedBy: byOwner, cust, sections, pos: [], notes: [],
        log: [`Job created by ${byOwner}`] };
      attachCustomer(job, custId, byOwner);
      jobs.unshift(job);
      saveJobRecord(job);
      return job;
    },

    /* Save whatever has been priced so far on an existing job, without
       moving it along. Lets a walk-through be done in pieces. */
    saveScope(jobId, sections, byOwner) {
      const j = getJob(jobId);
      if (!j) return null;
      const kept = {};
      Object.entries(sections).forEach(([k, sec]) => { kept[k] = sec; });
      j.sections = kept;
      if (j.pricedAt) freezeJob(j, true);
      const priced = Object.values(kept).some(sec => Object.keys(sec.lines).length);
      if (priced && j.stage === 0) {
        j.stage = 1;
        j.log.push(`Scoped and priced by ${byOwner}`);
      } else {
        j.log.push(`Scope updated by ${byOwner}`);
      }
      saveJobRecord(j);
      return j;
    },

    /* ---- lost or cancelled --------------------------------------
       Kept, not deleted: you still want the record and the reason.
       Dropped out of the pipeline counts and the attention list. */
    setJobStatus(id, status, reason, byOwner) {
      const j = getJob(id);
      if (!j) return null;
      j.status = status;
      j.statusReason = reason || '';
      j.log.push(status === 'active'
        ? `Reopened by ${byOwner}`
        : `Marked ${JOB_STATUS[status].toLowerCase()} by ${byOwner}${reason ? ': ' + reason : ''}`);
      saveJobRecord(j);
      return j;
    },
    JOB_STATUS,
    parseSheetRow,

    /* ---- picking up the other owner's changes ---------------------
       Everything is loaded once at boot, so you and Rocky each work
       from your own copy and neither sees the other until a reload.
       This re-reads quietly and reports what moved, so the UI can say
       so rather than you finding out by overwriting something.

       It deliberately does not touch a record you have unsaved changes
       queued for: your own work in progress always wins, and the next
       poll picks the change up once your save has gone through. */
    async refresh() {
      if (pending.size) return { skipped: 'saving' };
      let d;
      try {
        const res = await fetch(API + '?action=load');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        d = await res.json();
        if (d.error) throw new Error(d.error);
      } catch (err) {
        return { error: err.message };
      }
      if (pending.size) return { skipped: 'saving' };   // a save started while we waited

      const before = new Map(jobs.map(j => [j.id, JSON.stringify(j)]));
      const fresh = (d.jobs || []).map(migrateJob)
        .sort((a, b) => String(b.id).localeCompare(String(a.id)));
      const changed = fresh.filter(j => before.has(j.id) && before.get(j.id) !== JSON.stringify(j)).map(j => j.id);
      const added = fresh.filter(j => !before.has(j.id)).map(j => j.id);

      const accBefore = acceptances.length;
      jobs = fresh;
      acceptances = d.acceptances || [];
      portalGates = d.portals || [];
      const newlyAccepted = acceptances.length > accBefore;
      contractors = d.contractors || contractors;
      customers = (d.customers || []).sort((a, b) => a.name.localeCompare(b.name));
      templates = d.templates || templates;
      alerts = (d.alerts || []).sort((a, b) => String(b.id).localeCompare(String(a.id)));
      if (d.settings) alertSettings = d.settings;

      // An acceptance arriving is itself worth a redraw, even if the
      // job record did not change.
      return { changed, added, newlyAccepted,
        any: changed.length + added.length > 0 || newlyAccepted };
    },

    /* ---- what's on today -----------------------------------------
       One screen for the morning: the jobs happening, who is meant to
       be there, and what needs chasing before they are.
       Named daySheet, not today: Data.today() is the clock. */
    daySheet(forOwner, mineOnly = false) {
      const t = startOfDay(new Date());
      const todayIso = isoDate(t);
      const tomorrowIso = isoDate(addDays(t, 1));
      const mine = j => !mineOnly || j.owner === forOwner;
      const pick = iso => jobs
        .filter(j => j.status === 'active' && j.cust.moveDate === iso && mine(j))
        .sort((a, b) => String(a.cust.address).localeCompare(String(b.cust.address)))
        .map(j => ({
          job: j,
          crews: livePos(j)
            .filter(p => p.status !== 'replaced')
            .map(p => ({ no: p.no, status: p.status, section: SERVICES[p.key],
              name: getContractor(p.contractorId)?.name || 'Contractor removed',
              phone: getContractor(p.contractorId)?.phone || '' })),
          unconfirmed: livePos(j).filter(p => p.status === 'awaiting' || p.status === 'silent').length,
          notReady: j.stage < 6
        }));
      return { date: todayIso, today: pick(todayIso), tomorrow: pick(tomorrowIso) };
    },

    /* ---- going back a stage ---------------------------------------
       Stages only ever went forward, so one mis-click on "Paid" left
       you with no way back short of deleting the job and entering it
       again. Every step back is logged: this is a correction, and the
       record should show that it happened. */
    stepBack(id, byOwner) {
      const j = getJob(id);
      if (!j || j.stage <= 0) return { error: 'It is already at the start.' };
      const from = STAGES[j.stage], to = STAGES[j.stage - 1];
      j.stage -= 1;
      j.log.push(`Stage put back from ${from} to ${to} by ${byOwner}`);
      saveJobRecord(j);
      return { job: j, from, to };
    },

    /* What stepping back from here would undo, so it can be said out
       loud before it happens rather than discovered afterwards. */
    stepBackWarning(j) {
      if (j.stage === 6 && j.pos.length) {
        return 'The job orders you have already issued stay as they are — going back here does not unsend them.';
      }
      if (j.stage === 2 && j.pricedAt) {
        return 'Prices stay locked at the rates from when the estimate went out. Re-price it if they need to move.';
      }
      if (j.stage === 6 || j.stage === 7) {
        return 'Contractor replies and sign-off tickings are kept.';
      }
      return '';
    },

    /* ---- editing a job after it exists ----------------------------
       Everything here was write-once until now, which meant a typo in
       an address or a customer moving their date could only be fixed by
       deleting the job and entering it again. */
    updateJobDetails(id, fields, byOwner) {
      const j = getJob(id);
      if (!j) return { error: 'That job no longer exists.' };
      // Both can legitimately be blank early on; the documents and the
      // job page say when they are missing rather than refusing.

      const changed = [];
      const set = (key, label, value) => {
        const was = j.cust[key] == null ? '' : String(j.cust[key]);
        const now = value == null ? '' : String(value);
        if (was === now) return;
        changed.push(`${label} ${was || 'blank'} → ${now || 'blank'}`);
        j.cust[key] = key === 'people' ? Number(value) || 0 : value;
      };
      set('address', 'address', String(fields.address).trim());
      set('ref', 'reference', String(fields.ref || '').trim() || '—');
      set('people', 'people', Number(fields.people) || 0);
      set('special', 'what they told us', String(fields.special || '').trim());

      const dateMoved = j.cust.moveDate !== fields.moveDate;
      const oldDate = j.cust.moveDate;
      if (dateMoved) {
        changed.push(`job date ${oldDate || 'unset'} → ${fields.moveDate}`);
        j.cust.moveDate = fields.moveDate;
      }

      if (!changed.length) return { job: j, changed: [], toldContractors: [] };
      j.log.push(`Details changed by ${byOwner}: ${changed.join('; ')}`);

      /* A date change is not just a label: it moves the payment dates,
         and any contractor already holding an order is holding the old
         one. The panel can't tell them, so it says who needs telling. */
      const toldContractors = dateMoved
        ? livePos(j).filter(p => p.status === 'awaiting' || p.status === 'accepted')
            .map(p => ({ no: p.no, name: getContractor(p.contractorId)?.name || 'Contractor removed' }))
        : [];
      if (toldContractors.length) {
        j.log.push(`Job orders ${toldContractors.map(c => c.no).join(', ')} still show ${oldDate} — contractors need telling`);
      }
      saveJobRecord(j);
      return { job: j, changed, dateMoved, oldDate, toldContractors };
    },

    /* ---- documents ------------------------------------------------ */
    DOC_TYPES: Docs.TYPES,
    listDocuments: jobId => (jobId ? docsFor(jobId) : documents.slice()),
    liveDocuments: liveDocs,
    latestDocument: latestDoc,
    getDocument,
    issueDocument,
    paymentPlan,
    paidTotal,
    outstanding: jobId => Math.max(0, paymentPlan(getJob(jobId)).total - paidTotal(jobId)),
    isInstalmentPaid: (jobId, key) => isInstalmentPaid(getJob(jobId), key),
    portalUrl,
    getPortal: jobId => { const j = getJob(jobId); if (!j) return null; const p = ensurePortal(j); saveJobRecord(j); return p; },

    /* Reset the code when a customer says they never got it, or when
       the page has locked itself after too many wrong guesses. */
    resetPortalCode(jobId, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      const p = ensurePortal(j);
      p.code = randomCode();
      p.codeSetAt = new Date().toISOString();
      p.tries = 0;
      j.log.push(`Portal code reset by ${byOwner}`);
      saveJobRecord(j);
      return { portal: p };
    },

    /* Voiding never deletes. The document keeps its number, gets a
       VOIDED stamp drawn into its own frozen HTML, and says who did it
       and why — a document that vanishes is worse than a wrong one. */
    voidDocument(id, reason, byOwner) {
      const d = getDocument(id);
      if (!d) return { error: 'That document no longer exists.' };
      if (d.status === 'voided') return { error: 'That one is already voided.' };
      d.status = 'voided';
      d.voidedAt = new Date().toISOString();
      d.voidedBy = byOwner;
      d.voidReason = String(reason || '').trim();
      d.html = d.html.replace('class="fo-doc"', 'class="fo-doc fo-void"');
      saveDocument(d);
      const j = getJob(d.jobId);
      if (j) {
        j.log.push(`${d.no} voided by ${byOwner}${d.voidReason ? ': ' + d.voidReason : ''}`);
        saveJobRecord(j);
      }
      return { document: d };
    },

    /* Void and issue a fresh one in a single move, which is what you
       actually want when you spot a mistake. */
    reissueDocument(id, reason, byOwner) {
      const old = getDocument(id);
      if (!old) return { error: 'That document no longer exists.' };
      const v = this.voidDocument(id, reason, byOwner);
      if (v.error) return v;
      return issueDocument(old.jobId, old.type, byOwner,
        { replaces: old.no, instalment: old.instalment });
    },

    /* ---- money in --------------------------------------------------
       Recorded by hand: you read your bank and tick it here. Issuing
       the receipt is part of the same action, because a payment with
       no receipt is the thing you get asked about later. */
    recordPayment(jobId, { amount, on, method, instalment }, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      const amt = Number(amount);
      if (!(amt > 0)) return { error: 'Enter the amount that landed.' };
      if (!(business.bank.accountName && business.bank.accountNumber)) {
        return { error: 'Add the bank account under Settings first, so the receipt can show it.' };
      }
      if (!Array.isArray(j.payments)) j.payments = [];
      const plan = paymentPlan(j);
      const key = instalment || (plan.schedule.find(s => !isInstalmentPaid(j, s.key)) || {}).key || 'full';
      const label = (plan.schedule.find(s => s.key === key) || {}).what || 'Payment';
      const pay = { id: rid(), amount: amt, on: on || isoDate(new Date()),
        method: method || 'Bank transfer', instalment: key, by: byOwner };
      j.payments.push(pay);
      j.log.push(`${fmtMoney(amt)} received (${label.toLowerCase()}) recorded by ${byOwner}`);

      // Money in moves the job on, but only from the stage before it.
      if (j.stage === 4) j.stage = 5;
      saveJobRecord(j);

      const res = issueDocument(jobId, 'receipt', byOwner, {
        received: amt, receivedOn: pay.on, method: pay.method, forWhat: label
      });
      raiseAlert(j, 'pay', `${fmtMoney(amt)} received from ${j.cust.name} for ${j.id}`);
      return { payment: pay, receipt: res.document || null, error: res.error };
    },

    deletePayment(jobId, payId, byOwner) {
      const j = getJob(jobId);
      if (!j || !Array.isArray(j.payments)) return null;
      const p = j.payments.find(x => x.id === payId);
      j.payments = j.payments.filter(x => x.id !== payId);
      if (p) j.log.push(`Payment of ${fmtMoney(p.amount)} removed by ${byOwner} — the receipt stays and should be voided`);
      saveJobRecord(j);
      return j;
    },

    /* ---- the business details that go on every document ---------- */
    getBusiness: () => JSON.parse(JSON.stringify(business)),
    saveBusinessDetails(fields, byOwner) {
      business = Object.assign({}, business, fields,
        { bank: Object.assign({}, business.bank, fields.bank || {}) });
      business.gstRate = Number(business.gstRate) || 0.15;
      saveBusiness();
      return { business: JSON.parse(JSON.stringify(business)), by: byOwner };
    },
    bankReady: () => !!(business.bank.accountName && business.bank.accountNumber),

    /* ---- the customer accepting a quote ---------------------------
       Called from the panel when they ring, and by the public function
       when they tap the button. Either way it is recorded against the
       quote number and the terms version they were shown. */
    getAcceptance,
    portalGate,
    recordAcceptance(jobId, how, at) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      if (getAcceptance(jobId)) return { job: j, already: true };
      const q = latestDoc(jobId, 'quote');
      const a = { jobId, at: at || new Date().toISOString(), how: how || 'online',
        quoteNo: q ? q.no : null, termsVersion: business.termsVersion };
      acceptances.push(a);
      saveAcceptance(a);
      if (j.stage < 3) j.stage = 3;
      j.log.push(`Quote ${q ? q.no + ' ' : ''}accepted by the customer (${a.how}), terms v${a.termsVersion}`);
      saveJobRecord(j);
      raiseAlert(j, 'accept', `${j.cust.name} accepted ${q ? q.no : 'the quote'} for ${j.id}`);
      return { job: j, acceptance: a };
    },

    /* The customer accepted on their own page; the panel notices on its
       next refresh and moves the job along. The acceptance itself is
       already recorded — this only catches the job up. */
    applyPendingAcceptances(byOwner) {
      const moved = [];
      acceptances.forEach(a => {
        const j = getJob(a.jobId);
        if (!j || j.stage >= 3 || j.status !== 'active') return;
        j.stage = 3;
        j.log.push(`Quote ${a.quoteNo || ''} accepted by the customer online, terms v${a.termsVersion}`);
        saveJobRecord(j);
        raiseAlert(j, 'accept', `${j.cust.name} accepted ${a.quoteNo || 'the quote'} for ${j.id}`);
        moved.push(j.id);
      });
      return moved;
    },

    /* ---- prices ---------------------------------------------------
       lineItem is how the UI should look up a priced line: it returns
       the job's own frozen copy once one exists, and the live rate card
       before that. Reading the rate card directly would make a finished
       job's figures change whenever a contractor puts their prices up. */
    lineItem,

    /* Deliberate re-pricing: the contractor's price genuinely changed
       before the customer accepted, so take a fresh copy. */
    repriceJob(id, byOwner) {
      const j = getJob(id);
      if (!j) return null;
      const before = jobCost(j);
      freezeJob(j);
      const after = jobCost(j);
      j.log.push(`Re-priced at today's rates by ${byOwner}: ${fmtMoney(customerPrice(before))} → ${fmtMoney(customerPrice(after))}`);
      saveJobRecord(j);
      return { job: j, before: customerPrice(before), after: customerPrice(after) };
    },

    /* ---- standby ------------------------------------------------- */
    listStandby: () => jobs.filter(j => j.status === 'standby'),

    /* Standby jobs that have reached their move-out date. These are the
       only ones that need you: either they rang and it is live, or the
       flat is gone and it is cancelled. */
    standbyDue() {
      const today = isoDate(startOfDay(new Date()));
      return jobs.filter(j => j.status === 'standby' && j.cust.moveDate && j.cust.moveDate <= today)
        .sort((a, b) => String(a.cust.moveDate).localeCompare(String(b.cust.moveDate)));
    },

    /* They rang after all. Back to the stage it was at, with a new date,
       because by now the old one is almost certainly past. */
    retrieveJob(id, newDate, byOwner) {
      const j = getJob(id);
      if (!j) return { error: 'That job no longer exists.' };
      if (!newDate) return { error: 'Set the new date first.' };
      const was = j.cust.moveDate;
      j.status = 'active';
      j.statusReason = '';
      j.cust.moveDate = newDate;
      j.log.push(`Taken off standby by ${byOwner}, job date ${was || 'unset'} → ${newDate}`);
      saveJobRecord(j);
      return { job: j };
    },

    /* ---- notes you type yourself, alongside the automatic log ---- */
    addNote(id, text, byOwner) {
      const j = getJob(id);
      if (!j || !text.trim()) return null;
      const note = { at: new Date().toISOString(), by: byOwner, text: text.trim() };
      j.notes.unshift(note);
      saveJobRecord(j);
      return note;
    },
    deleteNote(id, at) {
      const j = getJob(id);
      if (!j) return;
      j.notes = j.notes.filter(n => n.at !== at);
      saveJobRecord(j);
    },

    /* ---- has this come in before? -------------------------------
       Pasting the same row twice is easy to do. Matches on the quote
       reference first, then the phone or email, then the address. */
    findPossibleDuplicate({ ref, phone, email, address, moveDate }) {
      const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9@.]/g, '');
      const r = norm(ref), p = phoneKey(phone), e = emailKey(email), a = norm(address);
      return jobs.find(j => {
        if (r && r !== '—' && norm(j.cust.ref) === r) return true;
        if (p && phoneKey(j.cust.phone) === p && j.cust.moveDate === moveDate) return true;
        if (e && emailKey(j.cust.email) === e && j.cust.moveDate === moveDate) return true;
        if (a && a.length > 8 && norm(j.cust.address) === a && j.cust.moveDate === moveDate) return true;
        return false;
      }) || null;
    },

    deleteJob(id) {
      jobs = jobs.filter(j => j.id !== id);
      removeRecord('job', id);
    },

    setJobOwner(id, newOwner, byOwner) {
      const j = getJob(id);
      if (!j || j.owner === newOwner) return j;
      j.owner = newOwner;
      j.log.push(`Owner changed to ${newOwner} by ${byOwner}`);
      saveJobRecord(j);
      return j;
    },

    logActivity(id, text) {
      const j = getJob(id);
      if (!j) return;
      j.log.push(text);
      saveJobRecord(j);
    },

    /* Saves edits made to a job's sections (items, access, notes,
       photos) from anywhere in the UI. */
    touchJob(id) {
      const j = getJob(id);
      if (j) saveJobRecord(j);
      return j;
    },

    sendEstimate(id, byOwner) {
      const j = getJob(id);
      freezeJob(j);
      j.stage = 2;
      j.log.push(`Estimate sent to the customer by ${byOwner} — prices locked at today's rates`);
      saveJobRecord(j);
      return j;
    },

    markEstimateAccepted(id) {
      const j = getJob(id);
      j.stage = 3;
      j.log.push('Customer accepted the estimate');
      raiseAlert(j, 'accept', `${j.cust.name} accepted the estimate for ${j.id}`);
      saveJobRecord(j);
      return j;
    },

    markFormalQuoteSent(id, byOwner) {
      const j = getJob(id);
      j.stage = 4;
      j.log.push(`Formal quote sent by ${byOwner}`);
      saveJobRecord(j);
      return j;
    },

    /* Payment and issuing the job orders are separate now: the money
       landing doesn't mean you're ready to send contractors out. */
    markPaymentReceived(id) {
      const j = getJob(id);
      j.stage = 5;
      j.log.push(`${paymentTerms(j).kind} recorded as received`);
      raiseAlert(j, 'pay', `${paymentTerms(j).kind} received from ${j.cust.name}.`);
      saveJobRecord(j);
      return j;
    },

    createPurchaseOrders(jobId) {
      const j = getJob(jobId);
      const made = [];
      for (const [k, s] of Object.entries(j.sections)) {
        made.push({
          no: nextPoNoFor(j, made), key: k, contractorId: s.contractorId,
          status: 'awaiting', issued: isoDate(new Date()),
          due: isoDate(addBusinessDays(new Date(), 2)), photos: 0
        });
      }
      j.pos = made;
      j.stage = 6;
      j.log.push(`Job orders issued: ${made.map(p => p.no + ' to ' + (getContractor(p.contractorId)?.name || '?')).join(', ')}`);
      saveJobRecord(j);
      return j.pos;
    },

    setPoStatus(jobId, poNo, status, extra = {}) {
      const j = getJob(jobId), p = findPo(j, poNo);
      if (!p) return null;
      const c = getContractor(p.contractorId);
      Object.assign(p, { status }, extra);
      const name = c?.name || 'Contractor';
      if (status === 'accepted') {
        j.log.push(`${name} accepted ${p.no}`);
        raiseAlert(j, 'caccept', `${name} accepted ${p.no} for ${j.cust.name}`);
      } else if (status === 'declined') {
        j.log.push(`${name} declined ${p.no}: ${p.reason}`);
        raiseAlert(j, 'decline', `${name} declined ${p.no} for ${j.cust.name}: ${p.reason}`);
      } else if (status === 'silent') {
        if (c) { c.strikes++; saveContractor(c); }
        j.log.push(`${name} did not reply to ${p.no} within 2 business days (strike ${c?.strikes} of 3)`);
        raiseAlert(j, 'silent', `${name} hasn't replied to ${p.no} for ${j.cust.name}. Strike ${c?.strikes} of 3.`);
        if (c && c.strikes >= 3) j.log.push(`${name} now has 3 strikes. Decide whether to keep sending them work.`);
      } else if (status === 'done') {
        j.log.push(`${name} marked ${p.no} done with ${p.photos} photo${p.photos === 1 ? '' : 's'}`);
        raiseAlert(j, 'done', `${name} marked ${p.no} done for ${j.cust.name}`);
      }
      saveJobRecord(j);
      return p;
    },

    replacePurchaseOrder(jobId, poNo, newContractorId) {
      const j = getJob(jobId), old = findPo(j, poNo);
      const s = j.sections[old.key];
      const from = getContractor(s.contractorId), to = getContractor(newContractorId);
      const lines = {};
      Object.entries(s.lines).forEach(([iid, q]) => {
        const name = getRateItem(s.contractorId, iid)?.name;
        const match = to.items.find(i => i.section === old.key && i.name === name);
        if (match) lines[match.id] = q;
      });
      s.contractorId = newContractorId;
      s.lines = lines;
      // The new contractor's items are new ids, so they need their own
      // frozen rates; the old ones are no longer referenced.
      if (j.pricedAt) freezeJob(j, true);
      if (old.status === 'silent') old.wasSilent = true;
      old.status = 'replaced';
      const fresh = { no: nextPoNoFor(j), key: old.key, contractorId: newContractorId,
        status: 'awaiting', issued: isoDate(new Date()),
        due: isoDate(addBusinessDays(new Date(), 2)), photos: 0 };
      j.pos.push(fresh);
      const matched = Object.keys(lines).length;
      j.log.push(`${fresh.no} issued to ${to.name} to replace ${old.no} (${from?.name || '?'}). ` +
        (matched ? 'Items were matched by name, so check the price.' : 'None of the items matched, so re-price this section.'));
      saveJobRecord(j);
      return { po: fresh, matched };
    },

    /* Same contractor, corrected order. You could only replace an order
       with a different contractor before, so a wrong quantity or a
       changed date left the contractor holding a sheet you couldn't
       correct. The old number is superseded rather than edited, so
       there is never a question about which sheet is the live one. */
    reissuePurchaseOrder(jobId, poNo, what, byOwner) {
      const j = getJob(jobId), old = findPo(j, poNo);
      if (!old) return { error: 'That job order no longer exists.' };
      if (old.status === 'replaced') return { error: 'That order has already been superseded.' };
      if (old.status === 'done') return { error: 'That one is already marked done.' };
      const c = getContractor(old.contractorId);
      if (old.status === 'silent') old.wasSilent = true;
      old.status = 'replaced';
      old.reason = '';          // not their fault, so no strike and no decline
      const fresh = { no: nextPoNoFor(j), key: old.key, contractorId: old.contractorId,
        status: 'awaiting', issued: isoDate(new Date()),
        due: isoDate(addBusinessDays(new Date(), 2)), photos: 0,
        corrects: old.no };
      j.pos.push(fresh);
      j.log.push(`${fresh.no} re-issued to ${c?.name || 'contractor'}, correcting ${old.no}` +
        (what ? `: ${what}` : '') + `, by ${byOwner}`);
      saveJobRecord(j);
      return { po: fresh, replaced: old.no, contractor: c?.name || 'the contractor' };
    },

    signOffJob(id, byOwner) {
      const j = getJob(id);
      j.stage = 7;
      j.log.push(`Completion check signed off by ${byOwner}`);
      saveJobRecord(j);
      return j;
    },

    newSection(key) {
      return { contractorId: contractorsCovering(key)[0]?.id || null, lines: {}, access: [], notes: '', photos: [] };
    },

    /* ---- photos --------------------------------------------------
       Downscaled in the browser before upload, then stored as a blob
       and referenced by key. A raw phone photo is several megabytes and
       would be refused; this keeps uploads quick on a patchy site
       connection too. */
    async uploadPhoto(file) {
      const dataUrl = await shrink(file);
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'photo', dataUrl })
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || 'Upload failed');
      return body.key;
    },
    photoUrl: key => `${API}?action=photo&key=${encodeURIComponent(key)}`,

    /* ---- money --------------------------------------------------- */
    sectionCost, jobCost, customerPrice, paymentTerms,

    /* ---- contractors --------------------------------------------- */
    listContractors: () => contractors.slice(),
    getContractor, contractorsCovering, getRateItem, getScorecard,

    addContractor(fields) {
      const c = { id: slug(fields.name), ...fields, strikes: 0,
        hist: { sent: 0, acc: 0, dec: 0, sil: 0, hrs: 0 }, items: [] };
      contractors.push(c);
      saveContractor(c);
      return c;
    },
    updateContractor(id, fields) {
      const c = getContractor(id);
      const dropped = c.services.filter(k => !fields.services.includes(k) && c.items.some(i => i.section === k));
      if (dropped.length) {
        return { error: `Remove the ${dropped.map(k => SERVICES[k]).join(' and ')} items first` };
      }
      Object.assign(c, fields);
      saveContractor(c);
      return { ok: true, contractor: c };
    },
    deleteContractor(id) {
      contractors = contractors.filter(c => c.id !== id);
      removeRecord('contractor', id);
    },
    addRateItem(cid, { section, name, unit, type, rate }) {
      const c = getContractor(cid);
      const i = { id: 'i' + rid(), section, name, unit, type, rate: Math.max(0, Number(rate) || 0) };
      c.items.push(i);
      saveContractor(c);
      return i;
    },
    removeRateItem(cid, iid) {
      const c = getContractor(cid);
      c.items = c.items.filter(i => i.id !== iid);
      saveContractor(c);
    },
    setRate(cid, iid, rate) {
      const i = getRateItem(cid, iid);
      if (!i) return null;
      i.rate = Math.max(0, Number(rate) || 0);
      saveContractor(getContractor(cid));
      return i;
    },

    /* ---- templates ----------------------------------------------- */
    listTemplates: () => templates.slice(),
    getTemplate,
    saveTemplate(id, { subject, body }) {
      const t = getTemplate(id);
      if (!t) return null;
      t.subject = subject;
      t.body = body;
      queueSave('template', id, t);
      return t;
    },

    /* ---- alerts -------------------------------------------------- */
    getAlerts: forOwner => alerts.filter(a => a.to.includes(forOwner)),
    alertIndex: a => alerts.indexOf(a),
    alertAt: ix => alerts[ix] || null,
    unreadCount: forOwner => alerts.filter(a => a.to.includes(forOwner) && !a.readBy.includes(forOwner)).length,
    markAlertRead(ix, forOwner) {
      const a = alerts[ix];
      if (a && !a.readBy.includes(forOwner)) {
        a.readBy.push(forOwner);
        queueSave('alert', a.id, a);
      }
      return a;
    },
    markAllAlertsRead(forOwner) {
      alerts.filter(a => a.to.includes(forOwner)).forEach(a => {
        if (!a.readBy.includes(forOwner)) {
          a.readBy.push(forOwner);
          queueSave('alert', a.id, a);
        }
      });
    },
    getAlertSettings: forOwner => alertSettings[forOwner],
    setAlertType(forOwner, type, on) { alertSettings[forOwner].types[type] = on; saveSettings(); },
    setAlertScope(forOwner, mineOnly) { alertSettings[forOwner].mineOnly = mineOnly; saveSettings(); },

    /* ---- what needs you today -----------------------------------
       The one screen that matters in a busy week. Everything here is
       something going wrong or about to, in the order it will bite. */
    getAttention(forOwner, mineOnly = false) {
      const today = startOfDay(new Date());
      const out = [];
      const mine = j => !mineOnly || j.owner === forOwner;

      jobs.filter(j => j.status === 'active' && mine(j)).forEach(j => {
        const movesOn = parseDate(j.cust.moveDate);
        const daysToJob = Math.round((movesOn - today) / 864e5);

        // contractors who have gone quiet past their reply date
        livePos(j).filter(p => p.status === 'awaiting').forEach(p => {
          const due = startOfDay(parseDate(p.due));
          if (due <= today) {
            const over = Math.round((today - due) / 864e5);
            out.push({ urgency: over > 0 ? 0 : 1, jobId: j.id,
              what: `${getContractor(p.contractorId)?.name || 'Contractor'} hasn't replied to ${p.no}`,
              detail: over > 0 ? `Reply was due ${over} day${over === 1 ? '' : 's'} ago. Chase them or send it elsewhere.`
                               : 'Reply is due today.',
              action: 'Chase' });
          }
        });

        // a job happening tomorrow where someone hasn't confirmed
        if (j.stage === 6 && daysToJob >= 0 && daysToJob <= 1) {
          const unconfirmed = livePos(j).filter(p => p.status !== 'accepted' && p.status !== 'done');
          if (unconfirmed.length) {
            out.push({ urgency: 0, jobId: j.id,
              what: `${j.cust.name}'s job is ${daysToJob === 0 ? 'today' : 'tomorrow'} and ${unconfirmed.length} contractor${unconfirmed.length === 1 ? " hasn't" : "s haven't"} confirmed`,
              detail: unconfirmed.map(p => `${getContractor(p.contractorId)?.name || '?'} (${p.no})`).join(', '),
              action: 'Open' });
          }
        }

        // money due, or already late
        if (j.stage >= 2 && j.stage <= 4) {
          const t = paymentTerms(j);
          const due = startOfDay(t.due);
          const days = Math.round((due - today) / 864e5);
          if (days <= 2) {
            out.push({ urgency: days < 0 ? 0 : 1, jobId: j.id,
              what: `${t.kind} of ${fmtMoney(t.amount)} from ${j.cust.name} ${days < 0 ? 'is overdue' : days === 0 ? 'is due today' : `is due in ${days} day${days === 1 ? '' : 's'}`}`,
              detail: days < 0 ? "The job doesn't go ahead until this is paid." : 'Chase it if it hasn\u2019t come through.',
              action: 'Open' });
          }
        }

        // everything done, waiting on you to sign it off
        if (j.stage === 6 && livePos(j).length && livePos(j).every(p => p.status === 'done')) {
          out.push({ urgency: 1, jobId: j.id,
            what: `${j.cust.name} is finished and needs signing off`,
            detail: 'Check the photos, confirm with the customer, then sign it off.',
            action: 'Sign off' });
        }

        // entered but never scoped, and the move is close
        if (j.stage === 0 && daysToJob >= 0 && daysToJob <= 10) {
          out.push({ urgency: daysToJob <= 4 ? 0 : 2, jobId: j.id,
            what: `${j.cust.name} hasn't been scoped and moves in ${daysToJob} day${daysToJob === 1 ? '' : 's'}`,
            detail: 'Book a time to walk through the property.',
            action: 'Open' });
        }

        // paid, but the contractors still haven't been told
        if (j.stage === 5) {
          out.push({ urgency: daysToJob <= 3 ? 0 : 1, jobId: j.id,
            what: `${j.cust.name} has paid but the job orders haven't gone out`,
            detail: `Job is ${fmtDate(j.cust.moveDate)}. Send the orders to your contractors.`,
            action: 'Open' });
        }
      });

      /* Priced but still missing the details a quote needs. */
      jobs.filter(j => j.status === 'active' && mine(j) && jobCost(j) && (!j.cust.address || !j.cust.moveDate))
        .forEach(j => {
          const missing = [!j.cust.address && 'an address', !j.cust.moveDate && 'a date'].filter(Boolean).join(' and ');
          out.push({ urgency: 2, jobId: j.id,
            what: `${j.cust.name} is priced but has no ${missing}`,
            detail: 'An estimate can go out without it. A quote, an invoice and a place on the calendar cannot.',
            action: 'Open' });
        });

      /* Documents waiting on you. These are the hand-offs the panel
         deliberately does not do by itself: nothing reaches a customer
         without someone pressing the button. */
      jobs.filter(j => j.status === 'active' && mine(j)).forEach(j => {
        if (!jobCost(j)) return;
        const plan = paymentPlan(j);

        // accepted, but the deposit invoice hasn't gone
        if (getAcceptance(j.id) && !latestDoc(j.id, 'invoice')) {
          const first = plan.schedule[0];
          out.push({ urgency: 1, jobId: j.id,
            what: `${j.cust.name} accepted — the first invoice hasn't gone out`,
            detail: !this.bankReady()
              ? 'Add the bank account under Settings first — an invoice without it cannot be paid.'
              : first.due
                ? `${fmtMoney(first.amount)} due ${fmtDate(first.due)}. Issue it from the job.`
                : `${fmtMoney(first.amount)}. Set the job date first, then issue it.`,
            action: 'Open' });
        }

        // an issued invoice that hasn't been paid by its date
        liveDocs(j.id).filter(d => d.type === 'invoice' && !isInstalmentPaid(j, d.instalment || 'deposit'))
          .forEach(d => {
            if (!d.dueDate) return;
            const days = Math.round((startOfDay(parseDate(d.dueDate)) - today) / 864e5);
            if (days <= 2) {
              out.push({ urgency: days < 0 ? 0 : 1, jobId: j.id,
                what: `${d.no} for ${j.cust.name} ${days < 0 ? 'is overdue' : days === 0 ? 'is due today' : `is due in ${days} day${days === 1 ? '' : 's'}`}`,
                detail: `${fmtMoney(d.amountDue)}. Check your bank, then record it on the job.`,
                action: 'Open' });
            }
          });

        // the balance invoice's turn has come round
        // An undated job has a schedule with no due dates on it.
        const bal = plan.schedule.find(x => x.key === 'balance' && x.due);
        if (bal && !isInstalmentPaid(j, 'balance')
            && !liveDocs(j.id).some(d => d.type === 'invoice' && d.instalment === 'balance')
            && startOfDay(parseDate(bal.due)) - today <= 3 * 864e5) {
          out.push({ urgency: 2, jobId: j.id,
            what: `${j.cust.name}'s balance invoice is due to go out`,
            detail: `${fmtMoney(bal.amount)}, payable ${fmtDate(bal.due)}. Issue it from the job.`,
            action: 'Open' });
        }
      });

      /* Standby jobs that have reached their move-out date. Low
         urgency on purpose — it is tidying, not work — but it has to
         appear somewhere or standby becomes a drawer things are never
         taken out of. */
      this.standbyDue().filter(mine).forEach(j => {
        const daysPast = Math.round((today - startOfDay(parseDate(j.cust.moveDate))) / 864e5);
        out.push({ urgency: 3, jobId: j.id,
          what: `${j.cust.name} was on standby and their move-out date has passed`,
          detail: daysPast > 0
            ? `Moved out ${daysPast} day${daysPast === 1 ? '' : 's'} ago. If you never heard from them, mark it cancelled.`
            : 'They move out today. If you never heard from them, mark it cancelled.',
          action: 'Open' });
      });

      return out.sort((a, b) => a.urgency - b.urgency);
    },

    /* ---- export --------------------------------------------------
       A spreadsheet is for reading and for your records. It flattens,
       so a job's individual line items become one summary column: good
       for an accountant, not a file you could restore from. */
    exportJobsCsv() {
      const head = ['Job', 'Status', 'Stage', 'Customer', 'Customer ID', 'Contact by',
        'Phone', 'Email',
        'Address', 'Move-out date', 'People', 'Owner', 'Prepared by', 'Services',
        'Contractors', 'Contractor cost', 'Customer price', 'Payment', 'Amount', 'Due',
        'Job orders', 'Reference', 'Notes'];
      const rows = jobs.map(j => {
        const cost = jobCost(j), price = customerPrice(cost), t = paymentTerms(j);
        return [
          j.id, JOB_STATUS[j.status] || 'Active', STAGES[j.stage] || '',
          j.cust.name, j.custId || '', j.cust.contact, j.cust.phone, j.cust.email || '',
          j.cust.address, j.cust.moveDate,
          j.cust.people, j.owner, j.preparedBy,
          Object.keys(j.sections).map(k => SERVICES[k]).join('; '),
          Object.values(j.sections).map(sec => getContractor(sec.contractorId)?.name || '').filter(Boolean).join('; '),
          cost.toFixed(2), price.toFixed(2), t.kind, t.amount.toFixed(2), isoDate(t.due),
          j.pos.map(p => `${p.no} ${getContractor(p.contractorId)?.name || ''} (${p.status})`).join('; '),
          j.cust.ref || '', j.notes.map(n => n.text).join(' | ')
        ];
      });
      return toCsv([head, ...rows]);
    },

    exportCustomersCsv() {
      const head = ['Customer', 'ID', 'Contact by', 'Phone', 'Email', 'Jobs',
        'First job', 'Last job', 'Total billed', 'Notes'];
      const rows = this.listCustomers().map(c => {
        const mine = customerJobs(c.id).filter(j => j.status !== 'cancelled');
        const dates = mine.map(j => j.cust.moveDate).filter(Boolean).sort();
        const billed = mine.reduce((t, j) => t + customerPrice(jobCost(j)), 0);
        return [c.name, c.id, c.contact, c.phone, c.email, mine.length,
          dates[0] || '', dates[dates.length - 1] || '', billed.toFixed(2), c.notes];
      });
      return toCsv([head, ...rows]);
    },

    exportContractorsCsv() {
      const head = ['Contractor', 'Contact', 'Phone', 'Job order email', 'Payment terms',
        'Insurance expiry', 'Services', 'Strikes', 'Item', 'Service', 'Per', 'Pricing', 'Rate'];
      const rows = [];
      contractors.forEach(c => {
        const base = [c.name, c.contact, c.phone, c.email, c.terms, c.insurance,
          c.services.map(k => SERVICES[k]).join('; '), `${c.strikes} of 3`];
        if (!c.items.length) { rows.push([...base, '(no rate card yet)', '', '', '', '']); return; }
        c.items.forEach(i => rows.push([...base, i.name, SERVICES[i.section], i.unit,
          i.type === 'hourly' ? 'Hourly' : 'Fixed', Number(i.rate).toFixed(2)]));
      });
      return toCsv([head, ...rows]);
    },

    /* ---- payments ------------------------------------------------
       Display only. Zoho does the invoicing; you tick the stage over
       here when you see the money land. */
    getPayments() {
      const now = startOfDay(new Date());
      // From the estimate going out until the job is signed off. Paid
      // is stage 5 and everything after it; before that the money is
      // still owed, and overdue once the due date has gone by.
      return jobs.filter(j => j.stage >= 2 && j.stage < 7 && j.status === 'active' && j.cust.moveDate).map(j => {
        const t = paymentTerms(j);
        const paid = j.stage >= 5;
        return { job: j, terms: t, paid, overdue: !paid && startOfDay(t.due) < now };
      });
    }
  };

  /* The next PO number, counting every order that already exists
     ANYWHERE, including ones built moments ago in the same loop.
     The earlier version read job.pos while that array was still being
     replaced, so every order in a job came out with the same number and
     accepting one would act on another. `extra` is how freshly-made
     orders get counted before they have been stored. */
  /* =================================================================
     Parsing a row pasted from Google Sheets
     =================================================================
     Copying a row out of Sheets gives tab-separated text. The two tabs
     have different columns, so which one it is comes from the toggle
     rather than from guessing. Whatever this works out is shown in the
     form for checking before anything is saved — a misread column
     should never quietly become a wrong job.

     Tenant tab:
       A Timestamp  B Email  C Full name  D Phone  E Student?
       F Move-out date  G Current location  H Moving to  I Move is for
       J Services  K Bedrooms  L Amount of stuff  M Special requirements
       N How heard  O Best contact  P Consent  Q Reference
       R Terms version  S Consented at

     Landlord tab:
       A Timestamp  B Email  C Name/company  D Email  E Phone  F Role
       G Property address  H Tenancy end  I Required completion
       J Access method  K Services  L Property size  M Condition
       N Special requirements  O Preferred contact  P Consent
       Q Reference  R Terms version  S Consented at
     ================================================================= */
  function parseSheetRow(text, kind) {
    const raw = String(text || '').replace(/\r/g, '').trim();
    if (!raw) return { error: 'Nothing pasted.' };
    // One row. If several were copied, take the first non-empty one.
    const line = raw.split('\n').find(l => l.trim()) || '';
    const cols = line.split('\t').map(c => c.trim());
    if (cols.length < 6) {
      return { error: 'That does not look like a row from the sheet. Select the whole row in Sheets and copy it.' };
    }
    const at = i => cols[i] || '';
    const warnings = [];

    const out = { services: [], warnings };
    if (kind === 'landlord') {
      out.name = at(2);
      out.phone = pickPhone(at(4), at(3), at(1));
      out.email = pickEmail(at(3), at(1), at(4));
      out.contact = /phone/i.test(at(14)) ? 'Text' : 'Email';
      out.address = at(6);
      out.moveDate = parseAnyDate(at(8) || at(7), warnings);
      out.people = 0;
      out.services = mapServices(at(10));
      out.special = [at(5) && `Role: ${at(5)}`, at(11) && `Size: ${at(11)}`,
        at(12) && `Condition: ${at(12)}`, at(9) && `Access: ${at(9)}`, at(13)]
        .filter(Boolean).join('. ');
      out.ref = at(16);
    } else {
      out.name = at(2);
      out.phone = pickPhone(at(3), at(1));
      out.email = pickEmail(at(1), at(3));
      out.contact = /email/i.test(at(14)) ? 'Email' : 'Text';
      out.address = at(6);
      out.moveDate = parseAnyDate(at(5), warnings);
      out.people = bedroomsToPeople(at(10));
      out.services = mapServices(at(9));
      out.special = [at(10) && `${at(10)}`, at(11) && `${at(11)}`, at(12)]
        .filter(Boolean).join('. ');
      out.ref = at(16);
    }

    if (!out.name) warnings.push('No customer name found in the row.');
    if (!out.phone && !out.email) warnings.push('No phone number or email found — add one below, or the job can\'t be matched to a customer.');
    if (out.contact === 'Email' && !out.email) warnings.push('They asked to be contacted by email but the row has no email address.');
    if (out.contact === 'Text' && !out.phone) warnings.push('They asked to be contacted by text but the row has no phone number.');
    if (!out.address) warnings.push('No address found in the row.');
    if (!out.services.length) warnings.push('No services recognised — tick them yourself below.');
    if (!out.moveDate) warnings.push('Could not read the move-out date — set it yourself below.');
    return out;
  }

  /* Services arrive as the form's own wording, e.g.
     "Cleaning (end-of-lease deep clean), Rubbish (junk removal & disposal)".
     Matching on the plain word is enough and survives the wording
     being reworded later. */
  function mapServices(text) {
    const t = String(text || '').toLowerCase();
    const found = [];
    if (/clean/.test(t)) found.push('cleaning');
    if (/rubbish|junk|disposal/.test(t)) found.push('rubbish');
    if (/moving|move|transport|furniture/.test(t)) found.push('moving');
    if (/storage|store/.test(t)) found.push('storage');
    return found;
  }

  function bedroomsToPeople(text) {
    const m = /(\d+)/.exec(String(text || ''));
    return m ? Number(m[1]) : 0;
  }

  /* Sheets can hand over a date in several shapes depending on the
     locale and whether the cell was formatted: 13/11/2026, 2026-11-13,
     "13 November 2026", or a bare serial number if the cell was never
     formatted as a date. NZ reads d/m/y, so 3/4/2026 is 3 April. */
  function parseAnyDate(value, warnings = []) {
    const v = String(value || '').trim();
    if (!v) return '';

    // Excel / Sheets serial number (days since 30 Dec 1899)
    if (/^\d{5}(\.\d+)?$/.test(v)) {
      const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 864e5);
      return isNaN(d) ? '' : isoDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    // already ISO
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (m) return isoDate(new Date(+m[1], +m[2] - 1, +m[3]));
    // d/m/y or d-m-y, read the NZ way
    m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(v);
    if (m) {
      let [, d, mo, y] = m.map(Number);
      if (y < 100) y += 2000;
      if (d > 12 && mo > 12) return '';
      if (mo > 12) { warnings.push(`Read "${v}" as day/month. Check the date below.`); [d, mo] = [mo, d]; }
      return isoDate(new Date(y, mo - 1, d));
    }
    // "13 November 2026" and similar
    const parsed = new Date(v);
    if (!isNaN(parsed)) return isoDate(new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
    return '';
  }

  /* Function declarations, not consts: everything below sits after the
     `return` that exports the API, and only function declarations are
     hoisted far enough to be callable from it. */
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function fmtMoney(n) { return n.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' }); }
  function fmtDate(d) {
    return (typeof d === 'string' ? parseDate(d) : new Date(d))
      .toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /* Quote every field. A customer's note containing a comma, a quote
     mark or a line break would otherwise split the row and shift every
     column after it. */
  function toCsv(rows) {
    return rows.map(r => r.map(v => {
      const str = String(v ?? '');
      return '"' + str.replace(/"/g, '""') + '"';
    }).join(',')).join('\r\n');
  }

  function nextPoNoFor(job, extra = []) {
    const all = jobs.flatMap(j => j.pos || []).concat(job.pos || [], extra);
    const max = all.reduce((m, p) => Math.max(m, Number(String(p.no).replace(/\D/g, '')) || 0), 0);
    return 'PO-' + String(max + 1).padStart(4, '0');
  }

  /* Downscale to at most 1600px on the long edge and re-encode as JPEG.
     A 4MB phone photo comes out around 200-400KB. */
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1600;
        let { width: w, height: h } = img;
        if (w > max || h > max) {
          const r = Math.min(max / w, max / h);
          w = Math.round(w * r); h = Math.round(h * r);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image')); };
      img.src = url;
    });
  }
})();
