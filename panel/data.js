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

  /* A session lasts 12 hours, so it will expire on someone mid-job.
     When it does, every request comes back 401 and the panel would
     otherwise look like it had simply stopped saving — the worst
     possible failure, because the person keeps working and trusts it.
     Send them to the code screen instead, with the way back included.
     Guarded so a burst of failed requests cannot redirect twice. */
  let leaving = false;
  function signedOut(res) {
    if (!res || res.status !== 401) return false;
    if (!leaving) {
      leaving = true;
      location.href = '/staff/?next=' + encodeURIComponent(location.pathname + location.hash);
    }
    return true;
  }

  /* ---------- fixed vocabulary ------------------------------------- */
  const SERVICES = { cleaning: 'Cleaning', rubbish: 'Rubbish removal', moving: 'Moving', storage: 'Storage' };
  const SERVICE_KEYS = Object.keys(SERVICES);
  /* Where a standalone one-off lands — a line with no contractor behind
     it, so no job order goes out for it. Deliberately NOT in SERVICES:
     that would make it a fifth service you could tick on a job and that
     contractors could cover, which it is not. It only ever exists on a
     job because you put a one-off line in it. */
  const EXTRAS_KEY = 'extras';
  const sectionLabel = k => SERVICES[k] || (k === EXTRAS_KEY ? 'Additional items' : k);
  /* ---------- who can do what ------------------------------------------
     OWNERS stays the two partners, because it is what profit splits
     across and what a job's "owner" means. Staff are users, not owners:
     they run jobs but have no share and no claim on the money screens.

     The split is deliberately coarse. Fine-grained permissions sound
     better and end up either unmaintained or worked around — two roles
     that everyone understands beat twelve nobody sets correctly. */
  const OWNERS = ['Daniel Bell', 'Rocky Lin'];

  const ROLES = {
    partner: {
      label: 'Partner',
      note: 'Everything, including money and settings.',
      can: { money: true, settings: true, costs: true, commission: true,
             contractors: true, rates: true, remove: true, audit: true }
    },
    staff: {
      label: 'Staff',
      note: 'Runs jobs and walk-throughs. No money screens, no settings, and contractor rates stay hidden.',
      /* Costs are off as well as the Money tab. A staff member who can
         see what a contractor charges can work out the margin, and that
         is the number you least want discussed on a job site. They
         still see the customer's price, because they have to quote. */
      can: { money: false, settings: false, costs: false, commission: false,
             contractors: true, rates: false, remove: false, audit: false }
    }
  };

  let users = [
    { id: 'u-dan',   name: 'Daniel Bell', role: 'partner', active: true },
    { id: 'u-rocky', name: 'Rocky Lin',   role: 'partner', active: true }
  ];

  const findUser = name => users.find(u => u.name === name) || null;
  /* An unknown name is treated as a partner, so an older record whose
     owner is not in the list never silently loses access. */
  const roleOf = name => (findUser(name) || {}).role || 'partner';
  const can = (name, what) => !!ROLES[roleOf(name)].can[what];
  const TITLES = { 'Daniel Bell': 'Executive Officer' };
  const MARGIN = 0.15;
  const ACCESS_ITEMS = ['Off-street parking', 'Stairs to unit', 'Keys with tenant', 'Power on',
    'Water on', 'Pets on property', 'Narrow access', 'Lockbox on site'];
  /* Eight stages. "New" exists because a job is now entered from the
     quote request before anyone has been to the property, and "Paid" is
     its own stage rather than being skipped: payment and issuing the
     job orders are two separate things you do. */
  /* The estimate is optional — most customers go straight to a quote —
     so it no longer has a stage of its own; it is a document you can
     issue at any point. Invoicing does have a stage, because "have we
     billed them yet" is a question worth being able to answer at a
     glance. Paid, Job orders out and Done keep their numbers so older
     jobs still land in the right place. */
  const STAGES = ['New', 'Scoped', 'Quoted', 'Accepted', 'Invoiced',
    'Paid', 'Job orders out', 'Done'];
  const SCHEMA = 2;  // bump when the shape of a stored job changes
  /* Standby: the flat is doing it themselves but wants us on file in case
   they need a last-minute clean. No urgency, no pipeline, no deadline —
   it just sits there until their move-out date comes round, when the
   panel asks you to deal with it. Nothing expires on its own: there is
   no server ticking away, and a record quietly deleting itself is not
   something you could notice had gone wrong. */
  const JOB_STATUS = { active: 'Active', standby: 'On standby', lost: 'Lost', cancelled: 'Cancelled' };

  /* Why money went back. `reduces` says whether the supply itself got
     smaller — which changes what they owe and, if you are registered,
     your output GST — or whether you are just returning money that was
     never yours to begin with. `cancels` marks the ones that end the
     job outright when refunded in full. */
  const REFUND_REASONS = {
    cancelled_customer: {
      label: 'Customer cancelled', reduces: true, cancels: true,
      blurb: 'You cancelled the job, so we have refunded what you paid.'
    },
    cancelled_us: {
      label: "We couldn't do it", reduces: true, cancels: true,
      blurb: 'We were unable to carry out the job, so we have refunded you in full.'
    },
    part_not_done: {
      label: "Part of the job didn't happen", reduces: true, cancels: false,
      blurb: 'Part of the work was not carried out, so we have credited you for it.'
    },
    goodwill: {
      label: 'Goodwill after a complaint', reduces: true, cancels: false,
      blurb: 'We have credited part of the price following your feedback.'
    },
    overpaid: {
      label: 'They paid too much', reduces: false, cancels: false,
      blurb: 'You paid more than the amount invoiced, so we have returned the difference.'
    },
    duplicate: {
      label: 'Paid twice', reduces: false, cancels: false,
      blurb: 'We received your payment twice, so we have returned the duplicate.'
    }
  };

  /* Refunds are stored as negative payments, so they net correctly
     everywhere money is summed without anything else having to know
     they exist. These two pull them back apart where the distinction
     matters. */
  const refundedTotal = j => (j.payments || [])
    .reduce((t, p) => t + (Number(p.amount) < 0 ? -Number(p.amount) : 0), 0);

  /* The part of the refunds that shrank the job rather than returning
     an overpayment — what comes off what they owed, and off supplies
     for GST. */
  const jobCredits = j => (j.payments || [])
    .reduce((t, p) => t + (p.refund && p.reduces ? Math.abs(Number(p.amount) || 0) : 0), 0);

  /* Credits dated inside a period, for the GST position and the P&L.
     Dated by when the refund happened, because a credit note belongs
     to the period it is issued in, not the period of the original job. */
  function creditsIn(fromISO, toISO) {
    return jobs.reduce((t, j) => t + (j.payments || [])
      .reduce((s, p) => s + (p.refund && p.reduces && p.on >= fromISO && p.on <= toISO
        ? Math.abs(Number(p.amount) || 0) : 0), 0), 0);
  }

  /* ---------- expense categories ------------------------------------
     Everything FlatOut spends that is not a contractor. Without these
     the panel's "you kept" is just revenue minus contractor cost, which
     overstates what you made by every dollar you actually spend.

     `rate` is how much of the business portion IRD lets you deduct —
     1 for almost everything, 0.5 for entertainment. `share` is the
     default business-use fraction, which you override per expense for
     anything part-personal. `gst` is whether the supplier normally
     charges GST you could claim back: an overseas subscription or a
     bank fee often does not.

     Treatments follow the notes already agreed with the accountant.
     They are defaults for data entry, not tax advice. */
  const EXPENSE_CATEGORIES = {
    advertising:  { label: 'Advertising and marketing', rate: 1, share: 1, gst: true },
    contractors:  { label: 'Contractor payments', rate: 1, share: 1, gst: true, auto: true,
                    note: 'Comes from job orders — not entered by hand' },
    insurance:    { label: 'Insurance', rate: 1, share: 1, gst: true },
    software:     { label: 'Software and subscriptions', rate: 1, share: 1, gst: false,
                    note: 'Many are billed overseas with no NZ GST — check the invoice' },
    web:          { label: 'Domain, hosting and email', rate: 1, share: 1, gst: false },
    printing:     { label: 'Printing and stationery', rate: 1, share: 1, gst: true },
    workwear:     { label: 'Branded workwear', rate: 1, share: 1, gst: true,
                    note: 'Branded only. Ordinary clothes are not deductible' },
    professional: { label: 'Accountant and legal', rate: 1, share: 1, gst: true },
    subs:         { label: 'Professional subscriptions', rate: 1, share: 1, gst: true },
    training:     { label: 'Training', rate: 1, share: 1, gst: true },
    repairs:      { label: 'Repairs and maintenance', rate: 1, share: 1, gst: true },
    equipment:    { label: 'Equipment under $1,000', rate: 1, share: 1, gst: true,
                    note: 'Written off this year. Over $1,000 is depreciated instead' },
    bank:         { label: 'Bank and card fees', rate: 1, share: 1, gst: false,
                    note: 'Bank fees are GST-exempt' },
    interest:     { label: 'Interest', rate: 1, share: 1, gst: false },
    phone:        { label: 'Phone and internet', rate: 1, share: 0.7, gst: true,
                    note: 'Business share only — set what is honest and keep a basis for it' },
    home:         { label: 'Use of home as office', rate: 1, share: 1, gst: false,
                    note: 'Square-metre rate, or apportion by time and space' },
    vehicle:      { label: 'Vehicle running costs', rate: 1, share: 0.3, gst: true,
                    note: 'Actual costs × business share. Use the vehicle log for km instead' },
    travel:       { label: 'Travel and accommodation', rate: 1, share: 1, gst: true },
    entertainment:{ label: 'Entertainment and client meals', rate: 0.5, share: 1, gst: true,
                    note: 'Only 50% is deductible' },
    other:        { label: 'Other', rate: 1, share: 1, gst: true }
  };
  /* Entered by hand — contractor spend is derived from jobs. */
  const EXPENSE_KEYS = Object.keys(EXPENSE_CATEGORIES).filter(k => !EXPENSE_CATEGORIES[k].auto);

  /* How a site visit actually went, as opposed to cust.visit, which is
     only when it was booked for. A visit that did not go to plan is the
     commonest way a job stalls: you drive out, you cannot get in, and
     there is nowhere to put that, so the job sits at New looking like
     nobody has been. These three outcomes give it somewhere to go, and
     the two unhappy ones raise it on the Home screen. */
  const VISIT_OUTCOMES = {
    done: 'Visit done',
    noaccess: "Couldn't get in",
    revisit: 'Needs another visit'
  };
  const KEY_HOLDERS = ['Tenant', 'Property manager', 'Landlord', 'Lockbox on site',
    'Neighbour', 'With us', 'Not sorted yet'];

  function newVisit() {
    return { arrivedAt: null, present: '', requesterOnSite: false,
      authoriser: { name: '', role: '', phone: '' },
      keys: { holder: '', code: '', notes: '' },
      outcome: '', reason: '', outstanding: [] };
  }
  /* Older jobs have no visit at all, and a half-written one can come
     back from storage, so everything that reads it goes through here. */
  function jobVisit(j) {
    const v = (j && j.visit) || {};
    return { arrivedAt: v.arrivedAt || null,
      present: v.present || '',
      requesterOnSite: !!v.requesterOnSite,
      authoriser: Object.assign({ name: '', role: '', phone: '' }, v.authoriser || {}),
      keys: Object.assign({ holder: '', code: '', notes: '' }, v.keys || {}),
      outcome: VISIT_OUTCOMES[v.outcome] ? v.outcome : '',
      reason: v.reason || '',
      outstanding: Array.isArray(v.outstanding) ? v.outstanding : [] };
  }

  /* Who was there and who is authorising, with the "it was the person
     who asked for the job" shortcut already worked out. Everything that
     displays these goes through here, so nothing downstream has to know
     whether the names were typed or came off the customer record.

     Reading live from the record rather than copying the name in means
     a manager who changes their number stays correct on visits already
     recorded — they are the same person either way. */
  function visitPeople(j) {
    const v = jobVisit(j);
    if (!v.requesterOnSite) return { present: v.present, authoriser: v.authoriser, from: null };
    const c = j && j.custId ? getCustomer(j.custId) : null;
    const name = (c && c.name) || (j && j.cust && j.cust.name) || '';
    const phone = (c && c.phone) || (j && j.cust && j.cust.phone) || '';
    return {
      present: name,
      /* A role typed during this visit wins; otherwise whatever the
         record already knows them as. */
      authoriser: { name, phone, role: v.authoriser.role || (c && c.role) || '' },
      from: c || null
    };
  }
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
  let expenses = [], trips = [], assets = [], hoursLog = [];
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
    gstRate: 0.15,
    /* The decision that costs money if it is made by accident.

       true  — the prices on the rate cards already include GST. Ticking
               "registered" changes nothing the customer sees and hands
               3/23 of every job to Inland Revenue out of what you keep.
       false — the rate cards are GST-exclusive, and 15% is added on top.
               The customer pays more; you keep what you kept before.

       Defaults to true because that is what unregistered prices are:
       a single all-in figure with no tax component. Registering without
       deciding this is the quiet 13% pay cut. */
    pricesIncludeGst: true,
    gstRegisteredFrom: '',
    gstFilingBasis: '2-monthly'
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
    /* Everything waiting goes in one request. One action in the panel
       touches several records — the job, a document, an acceptance —
       and sending them one at a time meant one round trip each, which
       is what made a single step take seconds. */
    const batch = [...pending.entries()].slice(0, 50);
    const items = batch.map(([, it]) => ({ kind: it.kind, id: it.id, value: it.value }));
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(items.length === 1
          ? { action: 'put', ...items[0] }
          : { action: 'putMany', items })
      });
      if (signedOut(res)) return;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      /* Only clear what was actually sent. Anything queued while the
         request was in flight stays, and the next flush picks it up. */
      for (const [key, it] of batch) {
        if (pending.get(key) === it) pending.delete(key);
      }
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
  /* A one-off line is not on anyone's rate card — it carries its own
     name, unit and price, written straight into the section's frozen
     map. lineItem then finds it by the normal frozen path, so costing,
     the documents and the price lock all work with no special cases.

     `oneoff: true` is what marks it, and it is the whole reason the
     re-freeze below has to be careful: rebuilding `frozen` from the
     rate card would wipe every one-off on the job, because there is
     nothing on a rate card to rebuild them from. */
  const isOneOff = i => !!(i && i.oneoff);
  const oneOffLines = s => Object.keys(s.lines || {})
    .filter(iid => isOneOff(s.frozen && s.frozen[iid]));

  /* A one-off can carry its own commission rate, set per line when you
     add it, independent of the job's rate.

       comm absent or null → the price you typed is what they pay.
       comm a number       → the price you typed is the COST, and that
                             rate goes on top, exactly like a rate-card
                             line but at this line's own percentage.

     Absent is the default because that is what a one-off usually is: a
     skip hire or a locksmith you are passing straight through. The rate
     is frozen onto the line when it is created, so changing the job's
     commission later never moves it. */
  const oneOffComm = i => {
    const r = i && i.comm;
    return (typeof r === 'number' && isFinite(r) && r >= 0 && r <= 1) ? r : null;
  };
  const isFixedLine = i => isOneOff(i) && oneOffComm(i) === null;
  /* Every one-off on the job, split by whether it carries a rate. */
  function oneOffTotals(job) {
    let fixed = 0, markedCost = 0, markedPrice = 0;
    if (!job || !job.sections) return { fixed, markedCost, markedPrice };
    Object.values(job.sections).forEach(s => {
      oneOffLines(s).forEach(iid => {
        const i = s.frozen[iid], cost = s.lines[iid] * i.rate, c = oneOffComm(i);
        if (c === null) fixed += cost;
        else { markedCost += cost; markedPrice += Math.round(cost * (1 + c)); }
      });
    });
    return { fixed, markedCost, markedPrice };
  }

  /* One place that decides what a valid one-off is, so a draft in the
     walk-through and a line added to a live job refuse the same bad
     input in the same words. */
  function validateOneOff({ name, amount, qty, unit, sectionKey, comm } = {}) {
    const label = String(name || '').trim();
    if (!label) return { error: 'Give the one-off a name — it goes on the customer’s quote.' };
    if (label.length > 80) return { error: 'That name is too long for a quote line. Keep it under 80 characters.' };

    const price = Number(amount);
    if (!isFinite(price) || price <= 0) return { error: 'Enter a price above $0.' };
    if (price > 100000) return { error: 'That price looks wrong. Enter it in dollars, not cents.' };

    const n = qty === undefined || qty === '' || qty === null ? 1 : Number(qty);
    if (!isFinite(n) || n <= 0 || n !== Math.round(n) || n > 999) {
      return { error: 'Quantity has to be a whole number between 1 and 999.' };
    }

    /* Empty, null or undefined all mean "no commission on this line",
       which is the default. Anything else has to be a real rate. */
    let rate = null;
    if (comm !== undefined && comm !== null && String(comm).trim() !== '') {
      rate = Number(comm);
      if (!isFinite(rate) || rate < 0 || rate > 1) {
        return { error: 'Pick a commission for this line, or leave it on no commission.' };
      }
    }

    return { label, price, n, comm: rate,
      unit: String(unit || '').trim().slice(0, 24) || 'each',
      key: sectionKey && SERVICE_KEYS.indexOf(sectionKey) !== -1 ? sectionKey : EXTRAS_KEY };
  }

  /* Copy the rates this section currently uses onto the section itself.
     `only` fills gaps without touching rates already frozen, which is
     what happens when an item is added to a job that is already out.

     One-off lines are carried over either way. They are not a cached
     copy of a live rate, so there is no newer version of them to pick
     up, and dropping them would silently delete a line the customer
     has already been quoted for. */
  function freezeSection(s, onlyGaps) {
    const frozen = onlyGaps ? Object.assign({}, s.frozen) : {};
    if (!onlyGaps) {
      oneOffLines(s).forEach(iid => { frozen[iid] = s.frozen[iid]; });
    }
    Object.keys(s.lines).forEach(iid => {
      if (frozen[iid] && (onlyGaps || isOneOff(frozen[iid]))) return;
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
  /* Commission is per job, not global. Student flats take the standard
     rate; some jobs are referrals at nothing, and a landlord or a
     retirement village is a different conversation. A job that has
     never been set keeps the standard rate, so every job that already
     exists prices exactly as it did before.

     It is frozen with the rates: once the quote is out, changing the
     commission must not quietly rewrite a number the customer has
     already been given. Re-pricing is the way to move it. */
  const COMMISSION_CHOICES = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
  function jobCommission(job) {
    const r = job && job.commission;
    return (typeof r === 'number' && isFinite(r) && r >= 0 && r <= 1) ? r : MARGIN;
  }

  /* What the no-commission one-offs add up to: the lines where the
     figure you typed is the figure they pay. */
  const jobFixedTotal = job => oneOffTotals(job).fixed;

  /* `cost` is the job's whole cost, one-off lines included, which is
     what jobCost returns. Three buckets come out of it:

       - fixed one-offs      pass through untouched
       - one-offs with a rate get their own rate
       - everything else      gets the job's rate

     Taking the full cost rather than the commissionable part keeps
     every existing caller correct without having to know that one-offs
     exist at all. */
  const customerPrice = (cost, job) => {
    const { fixed, markedCost, markedPrice } = oneOffTotals(job);
    /* Guard against a caller passing something other than jobCost: the
       base can never go negative. */
    const base = Math.max(0, cost - fixed - markedCost);
    const net = Math.round(base * (1 + jobCommission(job))) + fixed + markedPrice;
    /* Everything downstream — the documents, the payment schedule, the
       Money screen — treats this as the figure the customer actually
       pays. So GST is added here, once, and nothing else has to know
       about it. On GST-inclusive prices the figure is already gross and
       is returned untouched. */
    return business.gstRegistered && !business.pricesIncludeGst
      ? Math.round(net * (1 + business.gstRate))
      : net;
  };

  /* The GST sitting inside a gross figure: 3/23 at 15%. Returns 0 when
     you are not registered, so callers need no special case.

     Deliberately not rounded. The documents show this to the cent, and
     a period total that rounds every job first drifts away from the
     sum of the invoices — which is the one number a return must match.
     Formatting rounds at the point of display instead. */
  const gstWithin = gross => business.gstRegistered
    ? gross - (gross / (1 + business.gstRate)) : 0;
  const exGst = gross => gross - gstWithin(gross);

  /* Contractor cost in a period that carries reclaimable GST — only the
     sections run by contractors who are themselves registered. Declared
     here because both the GST position and the P&L need it. */
  function claimableCostIn(fromISO, toISO) {
    return jobs.filter(j => j.status === 'active'
        && j.cust.moveDate >= fromISO && j.cust.moveDate <= toISO)
      .reduce((t, j) => t + Object.values(j.sections).reduce((s, sec) => {
        const c = sec.contractorId ? getContractor(sec.contractorId) : null;
        return s + (c && c.gstRegistered ? sectionCost(sec) : 0);
      }, 0), 0);
  }

  function paymentTerms(job) {
    const total = customerPrice(jobCost(job), job);

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
      /* What they are to the property — "Property manager", "Tenant",
         "Landlord". Kept on the person rather than the job, because a
         property manager is the same thing on every job they send you,
         and typing it out each time is the thing this spares you. */
      role: String(f.role || '').trim(),
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
  function paymentPlan(jobOrId) {
    const job = typeof jobOrId === 'string' ? getJob(jobOrId) : jobOrId;
    if (!job) return { total: 0, dated: false, schedule: [], sentence: '', warning: '' };
    const total = customerPrice(jobCost(job), job);

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

  /* What a job is still owed — the one definition, used everywhere.
     It existed in three places and two of them were wrong: they took
     the price less what was paid, and refunds are stored as negative
     payments, so a refund pushed the "owing" figure straight back up
     by the amount you had just sent back. Refund $100 on a fully paid
     $350 job and the panel claimed $100 was still owing and refused
     to let you sign it off.

     Credits come off the price, because a credit note means the job
     was worth less, not that the customer underpaid. And a balance
     you have explicitly settled is zero regardless: sometimes you
     agree something that no formula will arrive at. */
  function owingOn(jobOrId) {
    const j = typeof jobOrId === 'string' ? getJob(jobOrId) : jobOrId;
    if (!j) return 0;
    if (j.settled) return 0;
    return rawOwing(j);
  }

  /* The same sum ignoring a settlement, so the panel can say what was
     written off rather than just showing zero. */
  function rawOwing(j) {
    return Math.max(0, paymentPlan(j).total - jobCredits(j) - paidTotal(j.id));
  }

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
          fixed: isFixedLine(i), own: isOneOff(i) ? oneOffComm(i) : null,
          cost: q * i.rate, amount: 0 });
      });
    });

    const total = customerPrice(rows.reduce((t, r) => t + r.cost, 0), job);
    rows.forEach(r => {
      r.amount = r.fixed ? r.cost
        : Math.round(r.cost * (1 + (r.own !== null ? r.own : jobCommission(job))));
    });
    /* The leftover cent or two goes onto the largest line, but never
       onto a one-off — a fixed one is the exact price you typed and may
       have been agreed out loud, and one with its own rate has already
       been rounded at that rate. */
    const movable = rows.filter(r => !r.fixed && r.own === null);
    const drift = total - rows.reduce((t, r) => t + r.amount, 0);
    if (drift && movable.length) {
      const biggest = movable.reduce((a, b) => (b.amount > a.amount ? b : a), movable[0]);
      biggest.amount += drift;
    }

    return Object.entries(job.sections).map(([k, sec]) => {
      const items = rows.filter(r => r.key === k);
      return {
        name: sectionLabel(k),
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

    /* Issuing the document IS the thing the stage was recording, so
       the stage follows it. Otherwise you do the same job twice: send
       the quote, then separately remember to tick "quote sent". Only
       ever forwards, and never past a stage that means something else
       has happened (accepted, paid). */
    const was = job.stage;
    // An estimate moves nothing. It is a courtesy document, issued
    // whenever the customer asks for the itemised version, and most
    // never do.
    if (type === 'quote' && job.stage < 2) job.stage = 2;
    // Invoicing only follows acceptance. Issuing one earlier must not
    // jump the job past Accepted, which has not happened yet.
    if (type === 'invoice' && job.stage === 3) job.stage = 4;
    if (job.stage !== was) job.log.push(`Moved to ${STAGES[job.stage]} by issuing ${no}`);

    saveJobRecord(job);
    return { document: doc, stageMoved: job.stage !== was };
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
    if (type === 'credit') {
      const invc = latestDoc(job.id, 'invoice');
      const paidGross = Number(extra.paidGross || 0);
      const netPaid = Number(extra.netPaid || 0);
      return {
        invoiceNo: invc ? invc.no : null,
        refunded: Number(extra.refunded || 0),
        refundedOn: extra.refundedOn || isoDate(new Date()),
        method: extra.method || 'Bank transfer',
        reasonLabel: extra.reasonLabel || 'Refund',
        why: extra.why || '',
        reducesSupply: !!extra.reducesSupply,
        paidGross, netPaid,
        /* What is left owing after the credit. Negative would mean we
           still hold money that is theirs, which the renderer shows as
           "net paid" instead. */
        stillOwing: Math.max(0, plan.total - jobCredits(job) - (paidGross - Number(extra.refunded || 0)))
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
      /* Credits off, same as everywhere else — a receipt issued after a
         credit note must not tell the customer they still owe what was
         credited back to them. */
      outstanding: Math.max(0, plan.total - jobCredits(job) - paid),
      balanceDue: (plan.schedule.find(s => s.key === 'balance') || {}).due || null
    };
  }

  /* Paid-ness is decided by money, not by matching labels. A $400 job has a
     single "full" instalment while the invoice may be stamped "deposit", and
     labels drift when a job is re-priced — the dollars never do. An instalment
     counts as paid once the payments cover it and everything before it. */
  function isInstalmentPaid(job, key) {
    const j = typeof job === 'string' ? getJob(job) : job;
    if (!j) return false;
    const plan = paymentPlan(j);
    /* Credits count towards the instalment, because the instalment is
       what they owe and a credit note says they owe less. Without this
       a refund made the payment they had already made look unpaid:
       $328 in, $164 credited back, and the panel asked for the $328
       again with "Was due" in red beside it. */
    const paid = (j.payments || []).reduce((t, p) => t + Number(p.amount || 0), 0)
      + jobCredits(j);
    const idx = plan.schedule.findIndex(s => s.key === key);
    if (idx < 0) return paid + 0.005 >= plan.total && plan.total > 0;
    const needed = plan.schedule.slice(0, idx + 1)
      .reduce((t, s) => t + Number(s.amount || 0), 0);
    return paid + 0.005 >= needed;
  }

  function portalUrl(job) {
    const p = ensurePortal(job);
    const origin = (typeof location !== 'undefined' && location.origin) || 'https://flatoutnz.co.nz';
    return `${origin}/j/#${p.token}`;
  }

  /* =================================================================
     PUBLIC API
     ================================================================= */
  return {
    SERVICES, SERVICE_KEYS, EXTRAS_KEY, sectionLabel,
    OWNERS, TITLES, MARGIN, ACCESS_ITEMS, STAGES,
    COMMISSION_CHOICES, jobCommission,
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
      if (signedOut(res)) return;
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
      expenses = (d.expenses || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      trips = (d.trips || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      assets = (d.assets || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      hoursLog = (d.hours || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (d.users && d.users.length) {
        const extra = d.users.filter(u => OWNERS.indexOf(u.name) === -1);
        users = users.filter(u => OWNERS.indexOf(u.name) !== -1).concat(extra);
      }
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
      /* Only touched when it is actually passed. The customer edit form
         does not carry a role field, and a save from there must not
         wipe what a walk-through recorded. */
      if (fields.role !== undefined) c.role = String(fields.role || '').trim().slice(0, 40);
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
        commission: jobCommission(draft),
        log: [`Walk-through saved by ${byOwner}`] };
      if (jobCommission(draft) !== MARGIN) {
        job.log.push(`Commission set to ${Math.round(jobCommission(draft) * 1000) / 10}% during the walk-through`);
      }
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
    saveScope(jobId, sections, byOwner, commission) {
      const j = getJob(jobId);
      if (!j) return null;
      /* The commission is set while pricing, so it is saved with the
         scope. Still refused once a quote is out — the customer has the
         number by then. */
      if (typeof commission === 'number' && isFinite(commission)
          && commission >= 0 && commission <= 1
          && !(j.pricedAt && j.stage >= 2)) {
        const was = jobCommission(j);
        if (Math.abs(was - commission) > 1e-9) {
          j.commission = commission;
          const pct = n => (Math.round(n * 1000) / 10) + '%';
          j.log.push(`Commission changed from ${pct(was)} to ${pct(commission)} by ${byOwner}`);
        }
      }
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
        if (signedOut(res)) return { skipped: 'signed-out' };
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
      if (d.expenses) expenses = d.expenses.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (d.trips) trips = d.trips.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (d.assets) assets = d.assets.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (d.hours) hoursLog = d.hours.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (d.users) {
        const extra = d.users.filter(u => OWNERS.indexOf(u.name) === -1);
        users = users.filter(u => OWNERS.indexOf(u.name) !== -1).concat(extra);
      }
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
    /* Setting the commission. Refused once the job is priced and a
       quote has gone out: the customer has a number, and this would
       change it silently. Re-price the job to move it deliberately. */
    setCommission(id, rate, byOwner) {
      const j = getJob(id);
      if (!j) return { error: 'No such job.' };
      const r = Number(rate);
      if (!isFinite(r) || r < 0 || r > 1) return { error: 'Enter a rate between 0% and 100%.' };
      if (j.pricedAt && j.stage >= 2) {
        return { error: 'This job is priced and quoted. Re-price it if the commission needs to move.' };
      }
      const was = jobCommission(j);
      if (Math.abs(was - r) < 1e-9) return { job: j };
      j.commission = r;
      const pct = n => (Math.round(n * 1000) / 10) + '%';
      j.log.push(`Commission changed from ${pct(was)} to ${pct(r)} by ${byOwner}`);
      saveJobRecord(j);
      return { job: j };
    },

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
        return 'Prices stay locked at the rates from when the quote went out. Re-price it if they need to move.';
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
    outstanding: owingOn,
    rawOutstanding: jobId => { const j = getJob(jobId); return j ? rawOwing(j) : 0; },
    settlement: jobId => (getJob(jobId) || {}).settled || null,

    /* Say that nothing more is owed on a job, whatever the arithmetic
       thinks. The honest cases: a refund you agreed in a conversation
       and the figures do not quite land on, a few dollars you are not
       going to chase, a balance written off. It is logged with who and
       when, because a balance disappearing with no name against it is
       the thing you cannot explain to each other later. */
    settleJob(jobId, byOwner, note) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      const amount = rawOwing(j);
      j.settled = { at: new Date().toISOString(), by: byOwner, amount,
        note: String(note || '').slice(0, 200) };
      j.log.push(`Marked settled by ${byOwner}` +
        (amount ? ` — ${fmtMoney(amount)} written off` : ' — nothing was outstanding') +
        (note ? `: ${String(note).slice(0, 200)}` : ''));
      saveJobRecord(j);
      return { job: j, amount };
    },

    /* Undo it, because the button is one tap and a mistake should not
       need me to fix it. */
    unsettleJob(jobId, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      if (!j.settled) return { error: 'This job is not marked settled.' };
      delete j.settled;
      j.log.push(`Settlement undone by ${byOwner} — the balance is back`);
      saveJobRecord(j);
      return { job: j, owing: rawOwing(j) };
    },

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

      // Money in moves the job on. Stage 5 means "paid for", so any job the
      // first instalment now covers belongs there, however it got to stage 3.
      const first = plan.schedule[0];
      if (j.stage >= 3 && j.stage < 5 && first && isInstalmentPaid(j, first.key)) j.stage = 5;
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
      j.log.push(`Re-priced at today's rates by ${byOwner}: ${fmtMoney(customerPrice(before, j))} → ${fmtMoney(customerPrice(after, j))}`);
      saveJobRecord(j);
      return { job: j, before: customerPrice(before, j), after: customerPrice(after, j) };
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

    /* Sending the estimate still locks the rates — that is the point of
       it — but it no longer moves the stage, because the job has not
       advanced just because someone asked for the itemised version. */
    sendEstimate(id, byOwner) {
      const j = getJob(id);
      freezeJob(j);
      j.log.push(`Estimate sent to the customer by ${byOwner} — prices locked at today's rates`);
      saveJobRecord(j);
      return j;
    },

    markQuoteSent(id, byOwner) {
      const j = getJob(id);
      freezeJob(j);
      if (j.stage < 2) j.stage = 2;
      j.log.push(`Quote sent by ${byOwner} — prices locked at today's rates`);
      saveJobRecord(j);
      return j;
    },

    markAccepted(id) {
      const j = getJob(id);
      j.stage = 3;
      j.log.push('Customer accepted the quote');
      raiseAlert(j, 'accept', `${j.cust.name} accepted the quote for ${j.id}`);
      saveJobRecord(j);
      return j;
    },

    markInvoiced(id, byOwner) {
      const j = getJob(id);
      if (j.stage < 4) j.stage = 4;
      j.log.push(`Invoice sent by ${byOwner}`);
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

    /* Signing a job off is where it leaves your pipeline, so it is the
       last moment anyone looks at it. Letting that happen with money
       still owing is how a balance quietly never gets chased.
       Overridable - sometimes you have agreed something - but it has
       to be a decision rather than an oversight, and it is logged. */
    signOffJob(id, byOwner, anyway) {
      const j = getJob(id);
      if (!j) return { error: 'That job no longer exists.' };
      const owing = owingOn(j);
      if (owing > 0 && !anyway) {
        return { blocked: true, owing, why: fmtMoney(owing) + ' is still owing on this job.' };
      }
      j.stage = 7;
      j.log.push(owing > 0
        ? 'Signed off by ' + byOwner + ' with ' + fmtMoney(owing) + ' still owing'
        : 'Completion check signed off by ' + byOwner);
      saveJobRecord(j);
      return { job: j, owing };
    },

    newSection(key) {
      return { contractorId: contractorsCovering(key)[0]?.id || null, lines: {}, access: [], notes: '', photos: [] };
    },

    /* ---------- one-off lines ---------------------------------------
       Something that is not on anybody's rate card: a skip hire, a
       locksmith, a carpet repair, a fixed price you agreed on the
       phone. The figure you type is what the customer pays.

       `sectionKey` decides who does it. Give it one of the four service
       keys and the line joins that section, so it appears on that
       contractor's job order and they are paid for it. Leave it out and
       it goes to the extras section, which has no contractor — nothing
       is ordered and nobody is paid; it is yours or a pass-through.

       Allowed on a job that is already quoted, same as any other added
       item: the line is frozen as it is created, so it cannot move the
       price of anything already sent. */
    /* Writes a one-off straight into a `sections` object. The
       walk-through needs this: it edits a draft that has no job id yet,
       so it cannot go through addOneOff below. Both call the same
       validation, so the walk-through and an existing job refuse the
       same bad input in the same words. */
    addOneOffTo(sections, spec) {
      const v = validateOneOff(spec);
      if (v.error) return v;
      const { key, label, price, n, unit, comm } = v;
      if (!sections[key]) sections[key] = this.newSection(key);
      const sec = sections[key];
      const iid = 'oo-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4);
      sec.frozen = sec.frozen || {};
      sec.frozen[iid] = { id: iid, name: label, unit, type: 'fixed',
        rate: price, section: key, oneoff: true, comm };
      sec.lines[iid] = n;
      return { id: iid, sectionKey: key, label, price, qty: n, comm,
        /* What the customer ends up seeing for this line. */
        shown: comm === null ? price * n : Math.round(price * n * (1 + comm)) };
    },

    addOneOff(jobId, spec, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      const r = this.addOneOffTo(j.sections, spec);
      if (r.error) return r;
      /* Frozen as it is created, so it can be added to a job that is
         already quoted without touching the price of anything already
         sent. */
      j.log.push(`One-off added by ${byOwner}: ${r.label}` +
        (r.qty > 1 ? ` ×${r.qty}` : '') + ` at ${fmtMoney(r.price * r.qty)}` +
        (r.sectionKey === EXTRAS_KEY ? ' (no contractor)' : ` on ${sectionLabel(r.sectionKey)}`));
      saveJobRecord(j);
      return Object.assign({ job: j }, r);
    },

    /* Remove from a draft's sections — the walk-through counterpart to
       removeOneOff. */
    removeOneOffFrom(sections, iid) {
      for (const [k, sec] of Object.entries(sections)) {
        const f = sec.frozen && sec.frozen[iid];
        if (!f || !isOneOff(f)) continue;
        delete sec.lines[iid];
        delete sec.frozen[iid];
        if (k === EXTRAS_KEY && !Object.keys(sec.lines).length) delete sections[k];
        return { name: f.name, amount: f.rate };
      }
      return { error: 'That one-off is no longer on this job.' };
    },

    /* Removing a one-off takes the frozen entry with it. Nothing else
       references it, so leaving it behind would just be litter. */
    removeOneOff(jobId, iid, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      /* Once a quote is out the customer is holding this number, so a
         line cannot just disappear from under it. Re-pricing is the
         deliberate way to change what was sent. */
      if (j.pricedAt && j.stage >= 2) {
        return { error: 'This job is quoted. Re-price it if a line needs to come off.' };
      }
      const qty = Object.values(j.sections)
        .reduce((n, s) => n || (isOneOff(s.frozen && s.frozen[iid]) ? s.lines[iid] : 0), 0);
      const r = this.removeOneOffFrom(j.sections, iid);
      if (r.error) return r;
      j.log.push(`One-off removed by ${byOwner}: ${r.name} (${fmtMoney(r.amount * (qty || 1))})`);
      saveJobRecord(j);
      return { job: j };
    },

    /* ---------- the site visit --------------------------------------
       cust.visit is the booking; this is what happened when you got
       there. Kept on the job rather than the walk-through draft so it
       survives whatever the walk-through turns into — including a visit
       where you never got through the door and there is no scope at
       all. */
    newVisit, jobVisit, visitPeople,

    /* Stamps when you arrived. Only the first one counts: pressing it
       again on a second walk round the flat must not quietly rewrite
       what time you turned up, which is the whole evidential point of
       it when a customer says nobody came. */
    arriveAtVisit(jobId, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      j.visit = Object.assign(newVisit(), j.visit || {});
      if (j.visit.arrivedAt) return { job: j, already: true, at: j.visit.arrivedAt };
      j.visit.arrivedAt = new Date().toISOString();
      j.log.push(`${byOwner} arrived on site at ` +
        new Date(j.visit.arrivedAt).toLocaleTimeString('en-NZ',
          { hour: 'numeric', minute: '2-digit' }));
      saveJobRecord(j);
      return { job: j, at: j.visit.arrivedAt };
    },

    /* Who showed you round, who is actually authorising the work, and
       where the keys are. Saved as one patch because they are filled in
       together, standing in the hallway. */
    saveVisitDetails(jobId, patch, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      const was = jobVisit(j);
      const v = Object.assign(newVisit(), j.visit || {});

      if (patch.requesterOnSite !== undefined) v.requesterOnSite = !!patch.requesterOnSite;
      if (patch.present !== undefined) v.present = String(patch.present).trim().slice(0, 200);
      if (patch.authoriser) {
        v.authoriser = {
          name: String(patch.authoriser.name || '').trim().slice(0, 80),
          role: String(patch.authoriser.role || '').trim().slice(0, 40),
          phone: String(patch.authoriser.phone || '').trim().slice(0, 40)
        };
      }
      if (patch.keys) {
        v.keys = {
          holder: String(patch.keys.holder || '').trim().slice(0, 40),
          code: String(patch.keys.code || '').trim().slice(0, 40),
          notes: String(patch.keys.notes || '').trim().slice(0, 200)
        };
      }
      j.visit = v;

      /* When it was the person who asked for the job, their role is
         worth keeping on their record — a property manager is the same
         thing on every job they send, so this is what stops you typing
         it out again next time. */
      let remembered = null;
      if (v.requesterOnSite && v.authoriser.role && j.custId) {
        const c = getCustomer(j.custId);
        if (c && c.role !== v.authoriser.role) {
          c.role = v.authoriser.role;
          saveCustomer(c);
          remembered = c.name;
        }
      }

      /* One line in the history, not four. The useful fact is that the
         authoriser changed, because that is the person a dispute turns
         on — not that a phone number was tidied up. */
      const people = visitPeople(j);
      if (!was.requesterOnSite && v.requesterOnSite) {
        j.log.push(`${byOwner} recorded that ${people.authoriser.name || 'the person who asked for the job'} was on site`);
      } else if (was.authoriser.name !== v.authoriser.name && v.authoriser.name) {
        j.log.push(`${byOwner} recorded ${v.authoriser.name}` +
          (v.authoriser.role ? ` (${v.authoriser.role})` : '') + ' as authorising the work');
      } else if (JSON.stringify(was) !== JSON.stringify(jobVisit(j))) {
        j.log.push(`Visit details updated by ${byOwner}`);
      }
      saveJobRecord(j);
      return { job: j, remembered };
    },

    /* How the visit ended. "Couldn't get in" and "needs another visit"
       both leave the job exactly where it was — nothing is priced, so
       nothing should move — and both surface on Home until they are
       cleared, which is the point: a wasted trip that nobody sees is a
       job that quietly dies. */
    setVisitOutcome(jobId, outcome, detail, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      if (!VISIT_OUTCOMES[outcome]) return { error: 'Pick what happened with the visit.' };

      const v = Object.assign(newVisit(), j.visit || {});
      if (outcome === 'noaccess') {
        const why = String(detail || '').trim();
        if (!why) return { error: 'Say why you couldn’t get in — future-you will want to know.' };
        v.reason = why.slice(0, 200);
        v.outstanding = [];
      } else if (outcome === 'revisit') {
        const list = (Array.isArray(detail) ? detail : String(detail || '').split('\n'))
          .map(s => String(s).trim()).filter(Boolean).slice(0, 12);
        if (!list.length) return { error: 'List what still needs doing on the next visit.' };
        v.outstanding = list;
        v.reason = '';
      } else {
        v.reason = ''; v.outstanding = [];
      }
      v.outcome = outcome;
      j.visit = v;

      j.log.push(`Visit marked "${VISIT_OUTCOMES[outcome]}" by ${byOwner}` +
        (outcome === 'noaccess' ? `: ${v.reason}` : '') +
        (outcome === 'revisit' ? `: ${v.outstanding.length} thing${v.outstanding.length === 1 ? '' : 's'} outstanding` : ''));
      saveJobRecord(j);
      return { job: j, outcome };
    },

    /* The move-out date moving while you are standing in the flat is
       routine — they got their dates wrong, or the tenancy shifted.
       Changing it does not touch the price, so it is allowed at any
       stage, but once job orders are out the contractors are holding
       the old date and have to be told. */
    setMoveDate(jobId, date, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };
      const d = String(date || '').trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'That date did not read properly.' };
      const was = j.cust.moveDate || '';
      if (was === d) return { job: j, unchanged: true };

      j.cust.moveDate = d;
      j.log.push(`Move-out date changed from ${was ? fmtDate(was) : 'not set'} to ` +
        `${d ? fmtDate(d) : 'not set'} by ${byOwner}`);

      /* Anyone already holding a job order has the old date in writing.
         Saying so here is cheaper than finding out on the day. */
      const told = livePos(j).filter(p => p.status === 'accepted' || p.status === 'awaiting');
      if (told.length) {
        j.log.push(`${told.length} contractor${told.length === 1 ? ' has' : 's have'} the old date on a job order — tell them`);
      }
      saveJobRecord(j);
      return { job: j, warnContractors: told.map(p => ({
        no: p.no, name: getContractor(p.contractorId)?.name || 'Contractor' })) };
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
    sectionCost, jobCost, customerPrice, paymentTerms, gstWithin, exGst,
    isOneOff, oneOffLines, jobFixedTotal, oneOffComm, isFixedLine, oneOffTotals,
    ROLES, roleOf, can,
    listUsers: () => users.filter(u => u.active).slice(),
    getUser: findUser,

    /* Adding someone is deliberately not the same as making them a
       partner: a new user can only be staff, and promoting them is a
       separate, explicit act. */
    /* A six-digit code, generated here, shown once, and stored only as
       a PBKDF2 hash. Nobody can read it back afterwards — not Rocky,
       not you. That is deliberate: a code you can look up is a code
       that can be looked up by whoever else gets in.

       Losing it is not a problem, because resetting is one tap. */
    async issueCode(id, byOwner) {
      if (!can(byOwner, 'settings')) return { error: 'Only a partner can set a code.' };
      const u = users.find(x => x.id === id);
      if (!u) return { error: 'No such login.' };

      const code = Session.newCode();
      const salt = Session.newSalt();
      u.codeSalt = salt;
      u.codeHash = await Session.hashCode(code, salt);
      u.codeSetAt = new Date().toISOString();
      u.codeSetBy = byOwner;
      queueSave('user', u.id, u);
      /* Returned once, to be shown once. Never stored in this shape. */
      return { user: u, code };
    },

    clearCode(id, byOwner) {
      if (!can(byOwner, 'settings')) return { error: 'Only a partner can clear a code.' };
      const u = users.find(x => x.id === id);
      if (!u) return { error: 'No such login.' };
      delete u.codeHash; delete u.codeSalt; delete u.codeSetAt; delete u.codeSetBy;
      queueSave('user', u.id, u);
      return { ok: true };
    },

    hasCode: id => {
      const u = users.find(x => x.id === id);
      return !!(u && u.codeHash && u.codeSalt);
    },

    addUser(name, role, byOwner) {
      const n = String(name || '').trim().slice(0, 60);
      if (!n) return { error: 'Give them a name.' };
      if (findUser(n)) return { error: 'Someone with that name already has a login.' };
      if (!ROLES[role]) return { error: 'Pick a role.' };
      if (role === 'partner' && !can(byOwner, 'settings')) {
        return { error: 'Only a partner can add another partner.' };
      }
      const u = { id: 'u-' + Date.now().toString(36), name: n, role, active: true };
      users.push(u);
      queueSave('user', u.id, u);
      return { user: u };
    },

    setUserRole(id, role, byOwner) {
      if (!can(byOwner, 'settings')) return { error: 'Only a partner can change roles.' };
      const u = users.find(x => x.id === id);
      if (!u) return { error: 'No such login.' };
      if (!ROLES[role]) return { error: 'Pick a role.' };
      if (OWNERS.indexOf(u.name) !== -1 && role !== 'partner') {
        return { error: u.name + ' is a partner in the business — that cannot be set from here.' };
      }
      u.role = role;
      queueSave('user', u.id, u);
      return { user: u };
    },

    removeUser(id, byOwner) {
      if (!can(byOwner, 'settings')) return { error: 'Only a partner can remove a login.' };
      const u = users.find(x => x.id === id);
      if (!u) return { error: 'No such login.' };
      if (OWNERS.indexOf(u.name) !== -1) {
        return { error: u.name + ' is a partner and cannot be removed.' };
      }
      /* Deactivated rather than deleted: their name is on job history
         and signed-off work, and that has to keep making sense. */
      u.active = false;
      queueSave('user', u.id, u);
      return { ok: true };
    },

    /* ---------- the audit trail -------------------------------------------
       Assembled from what the panel already records rather than kept as
       a second copy: job history, money entries and issued documents,
       merged and sorted. One place to answer "who changed that, and
       when" — which matters a great deal more once someone other than
       the two of you has a login. */
    auditTrail({ from, to, who, q } = {}) {
      const rows = [];
      const push = (at, user, what, where, kind) =>
        rows.push({ at, user: user || '—', what, where, kind });

      jobs.forEach(j => (j.log || []).forEach((text, i) => {
        /* Job history lines carry the person inside the sentence, which
           is how they were written to read on the job. Pull the name
           back out where one of the known users appears in it. */
        const u = users.find(x => text.indexOf(x.name) !== -1);
        push(j.updatedAt || j.cust.moveDate || '', u ? u.name : '', text, j.id, 'job');
      }));

      expenses.forEach(x => push(x.date, x.by,
        `Expense: ${x.what} — ${fmtMoney(x.amount)}`, 'Money', 'expense'));
      trips.forEach(t => push(t.date, t.by,
        `Trip: ${t.purpose} — ${t.km} km`, 'Money', 'trip'));
      assets.forEach(a => push(a.date, a.by,
        `Asset: ${a.what} — ${fmtMoney(a.cost)}`, 'Money', 'asset'));
      hoursLog.forEach(h => push(h.date, h.by,
        `Hours: ${h.hours}h — ${h.what}`, 'Money', 'hours'));
      documents.forEach(d => push(isoDate(new Date(d.issuedAt || Date.now())), d.issuedBy,
        `${(Docs.TYPES[d.type] || {}).label || d.type} ${d.no} issued` +
        (d.voided ? ' (later voided)' : ''), d.jobId, 'document'));

      const needle = String(q || '').trim().toLowerCase();
      return rows
        .filter(r => (!from || r.at >= from) && (!to || r.at <= to))
        .filter(r => !who || who === 'all' || r.user === who)
        .filter(r => !needle ||
          (r.what + ' ' + r.where + ' ' + r.user).toLowerCase().indexOf(needle) !== -1)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    },

    VISIT_OUTCOMES, KEY_HOLDERS, EXPENSE_CATEGORIES, EXPENSE_KEYS,

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

        /* A visit that did not come off. Urgent when the job date is
           close, because the window to get back out there is closing
           and nothing is priced yet. */
        const vis = jobVisit(j);
        if (vis.outcome === 'noaccess' || vis.outcome === 'revisit') {
          const soon = isFinite(daysToJob) && daysToJob <= 7;
          out.push({ urgency: soon ? 0 : 1, jobId: j.id,
            what: vis.outcome === 'noaccess'
              ? `Couldn't get in at ${j.cust.name}'s`
              : `${j.cust.name}'s walk-through isn't finished`,
            detail: (vis.outcome === 'noaccess'
              ? vis.reason
              : vis.outstanding.join('; ')) +
              (isFinite(daysToJob) && daysToJob >= 0
                ? ` · they move out in ${daysToJob} day${daysToJob === 1 ? '' : 's'}`
                : ''),
            action: 'Re-book' });
        }

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

    /* ---- what the business actually made --------------------------
       Two different questions that look like one. WORK DONE is by job
       date: what you sold that month and what it cost you. CASH IN is
       by payment date: what actually landed. They rarely match, because
       a deposit arrives before the job and a balance two weeks after,
       so they are reported separately rather than averaged into
       something that is true of neither. */
    /* ---------- expenses ----------------------------------------------
       What the business spends on itself. Contractor payments are not
       in here: those come off the jobs, so entering them again would
       double-count the largest cost you have. */
    listExpenses(fromISO, toISO) {
      return expenses
        .filter(x => (!fromISO || x.date >= fromISO) && (!toISO || x.date <= toISO))
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    },
    getExpense: id => expenses.find(x => x.id === id) || null,

    saveExpense(fields, byOwner) {
      const cat = EXPENSE_CATEGORIES[fields.category];
      if (!cat || cat.auto) return { error: 'Pick a category.' };

      const amount = Number(fields.amount);
      if (!isFinite(amount) || amount <= 0) return { error: 'Enter an amount above $0.' };
      if (amount > 1000000) return { error: 'That amount looks wrong. Enter it in dollars.' };

      const date = String(fields.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date.' };

      let share = fields.share === undefined || fields.share === '' ? cat.share : Number(fields.share);
      if (!isFinite(share) || share < 0 || share > 1) return { error: 'Business share has to be between 0% and 100%.' };

      const what = String(fields.what || '').trim().slice(0, 120);
      if (!what) return { error: 'Say what it was for — future-you reading a bank statement will not remember.' };

      const existing = fields.id ? expenses.find(x => x.id === fields.id) : null;
      const x = existing || { id: 'E-' + Date.now().toString(36), createdAt: new Date().toISOString() };
      Object.assign(x, {
        date, what, amount, share,
        category: fields.category,
        supplier: String(fields.supplier || '').trim().slice(0, 80),
        hasGst: fields.hasGst === undefined ? cat.gst : !!fields.hasGst,
        by: byOwner
      });
      if (!existing) expenses.push(x);
      expenses.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      queueSave('expense', x.id, x);
      return { expense: x, created: !existing };
    },

    deleteExpense(id) {
      expenses = expenses.filter(x => x.id !== id);
      removeRecord('expense', id);
      return { ok: true };
    },

    /* What an expense is actually worth: the business share, then the
       category's deductible rate (entertainment halves), and the GST
       stripped out if you are registered and the supplier charged it —
       you reclaim that separately, so it is not a cost. */
    expenseValue(x) {
      const cat = EXPENSE_CATEGORIES[x.category] || EXPENSE_CATEGORIES.other;
      const business = Number(x.amount) * Number(x.share);
      const gst = x.hasGst ? gstWithin(business) : 0;
      return {
        gross: Number(x.amount),
        business,
        gstClaim: gst,
        /* The figure that reduces taxable profit. */
        deductible: (business - gst) * cat.rate,
        personal: Number(x.amount) - business,
        halved: cat.rate < 1
      };
    },

    /* ---------- what each contractor was paid -----------------------------
       Their year in one line each. Useful to them, and the thing you
       want in front of you before renegotiating a rate card. */
    contractorYear(fromISO, toISO) {
      const totals = {};
      jobs.filter(j => j.status === 'active'
          && j.cust.moveDate >= fromISO && j.cust.moveDate <= toISO).forEach(j => {
        Object.entries(j.sections).forEach(([k, sec]) => {
          if (!sec.contractorId) return;
          const cost = sectionCost(sec);
          if (!cost) return;
          const c = getContractor(sec.contractorId);
          const row = totals[sec.contractorId] || (totals[sec.contractorId] = {
            id: sec.contractorId, name: c ? c.name : 'Contractor removed',
            gstNumber: (c && c.gstNumber) || '', gstRegistered: !!(c && c.gstRegistered),
            paid: 0, jobs: 0, services: new Set() });
          row.paid += cost; row.jobs++; row.services.add(sectionLabel(k));
        });
      });
      return Object.values(totals)
        .map(r => Object.assign(r, { services: [...r.services].join(', ') }))
        .sort((a, b) => b.paid - a.paid);
    },

    /* ---------- the year-end pack -----------------------------------------
       One file for the accountant instead of a shoebox. Several
       sections in one CSV, because a single download that opens in
       anything beats four they have to be talked through. */
    yearEndCsv(fromISO, toISO) {
      const q = v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const line = a => a.map(q).join(',');
      const out = [];
      const pl = this.profitAndLoss(fromISO, toISO);
      const b = business;

      out.push(line([b.name + ' — year-end pack']));
      out.push(line(['Period', fromISO + ' to ' + toISO]));
      out.push(line(['NZBN', b.nzbn || '']));
      out.push(line(['GST', b.gstRegistered ? 'Registered ' + (b.gstNumber || '') : 'Not registered']));
      out.push(line(['Prepared', isoDate(new Date())]));
      out.push('');

      out.push(line(['SUMMARY']));
      out.push(line(['Income (excl GST)', pl.income.toFixed(2)]));
      out.push(line(['Contractor payments', pl.contractors.toFixed(2)]));
      out.push(line(['Other deductions', pl.expenseTotal.toFixed(2)]));
      out.push(line(['Net profit', pl.net.toFixed(2)]));
      OWNERS.forEach(o => out.push(line([o + ' — 50% share', (pl.net / OWNERS.length).toFixed(2)])));
      out.push('');

      out.push(line(['INCOME BY JOB']));
      out.push(line(['Job', 'Customer', 'Date', 'Address', 'Gross', 'GST', 'Net', 'Contractor cost']));
      jobs.filter(j => j.status === 'active' && j.cust.moveDate >= fromISO && j.cust.moveDate <= toISO)
        .sort((a, c) => String(a.cust.moveDate).localeCompare(String(c.cust.moveDate)))
        .forEach(j => {
          const cost = jobCost(j); if (!cost) return;
          const gross = customerPrice(cost, j), gst = gstWithin(gross);
          out.push(line([j.id, j.cust.name, j.cust.moveDate, j.cust.address,
            gross.toFixed(2), gst.toFixed(2), (gross - gst).toFixed(2), cost.toFixed(2)]));
        });
      out.push('');

      out.push(line(['EXPENSES']));
      out.push(line(['Date', 'Category', 'What', 'Supplier', 'Paid', 'Business share', 'GST claimed', 'Deductible']));
      this.listExpenses(fromISO, toISO).forEach(x => {
        const v = this.expenseValue(x);
        out.push(line([x.date, (EXPENSE_CATEGORIES[x.category] || {}).label || x.category,
          x.what, x.supplier || '', v.gross.toFixed(2), Math.round(x.share * 100) + '%',
          v.gstClaim.toFixed(2), v.deductible.toFixed(2)]));
      });
      out.push('');

      out.push(line(['CONTRACTOR PAYMENTS']));
      out.push(line(['Contractor', 'GST number', 'GST registered', 'Jobs', 'Services', 'Paid']));
      this.contractorYear(fromISO, toISO).forEach(r =>
        out.push(line([r.name, r.gstNumber, r.gstRegistered ? 'Yes' : 'No',
          r.jobs, r.services, r.paid.toFixed(2)])));
      out.push('');

      const veh = this.vehicleClaim(fromISO, toISO);
      if (veh.rows.length) {
        out.push(line(['VEHICLE LOG']));
        out.push(line(['Date', 'Purpose', 'Fuel', 'km', 'Claim']));
        veh.rows.slice().reverse().forEach(t =>
          out.push(line([t.date, t.purpose, t.fuel, t.km, t.amount.toFixed(2)])));
        out.push(line(['', '', '', veh.km, veh.claim.toFixed(2)]));
        out.push('');
      }

      const dep = this.depreciation(fromISO, toISO);
      if (dep.rows.length) {
        out.push(line(['ASSETS AND DEPRECIATION']));
        out.push(line(['Asset', 'Bought', 'Cost', 'Rate', 'Opening', 'This year', 'Closing']));
        dep.rows.forEach(a => out.push(line([a.what, a.date, a.cost.toFixed(2),
          Math.round(a.rate * 100) + '%', a.opening.toFixed(2),
          a.thisYear.toFixed(2), a.closing.toFixed(2)])));
        out.push('');
      }

      const hrs = this.listHours(fromISO, toISO);
      if (hrs.length) {
        out.push(line(['OWN HOURS (not a deduction — for your information)']));
        out.push(line(['Date', 'Who', 'Hours', 'What']));
        hrs.slice().reverse().forEach(h => out.push(line([h.date, h.owner, h.hours, h.what])));
        out.push('');
      }

      if (b.gstRegistered) {
        out.push(line(['GST BY PERIOD']));
        out.push(line(['Period', 'Supplies', 'Output GST', 'Claimable purchases', 'Input GST', 'Net']));
        this.gstPeriods(6).filter(p => p.to >= fromISO && p.from <= toISO).reverse().forEach(p => {
          const g = this.gstPosition(p.from, p.to);
          out.push(line([p.label.replace(' (still open)', ''), g.supplies.toFixed(2),
            g.outputGst.toFixed(2), g.purchases.toFixed(2), g.inputGst.toFixed(2), g.net.toFixed(2)]));
        });
        out.push('');
      }

      out.push(line(['Figures are the panel\'s own working, on the job date. Confirm the basis with your accountant.']));
      return out.join('\n');
    },

    /* ---------- refunds ---------------------------------------------------
       Money going back out. Three different things wear the same word,
       and they are not the same in the books:

         - the job shrank or went away. What they owed drops, and if
           you are GST registered the output GST on it drops too. That
           needs a credit note, which is the supply correction
           information IRD requires.
         - they simply paid too much, or twice. Nothing about the job
           changed; you are returning money that was never yours.

       `reduces` is which of those it is, and it is on the reason
       rather than left to be chosen, because getting it wrong quietly
       misstates a GST return. */
    REFUND_REASONS,

    refundPayment(jobId, { amount, reason, on, method, note }, byOwner) {
      const j = getJob(jobId);
      if (!j) return { error: 'That job no longer exists.' };

      const r = REFUND_REASONS[reason];
      if (!r) return { error: 'Say why the money is going back.' };

      const amt = Number(amount);
      if (!(amt > 0)) return { error: 'Enter the amount you are refunding.' };

      const paidGross = (j.payments || []).reduce((t, p) => t + Math.max(0, Number(p.amount) || 0), 0);
      const refundedSoFar = refundedTotal(j);
      const left = paidGross - refundedSoFar;
      if (amt > left + 0.001) {
        return left <= 0
          ? { error: 'Nothing has been paid on this job, so there is nothing to refund.' }
          : { error: `You can only refund what was actually paid. ${fmtMoney(left)} is left.` };
      }

      const when = on || isoDate(new Date());
      const pay = { id: rid(), amount: -amt, on: when,
        method: method || 'Bank transfer', refund: true, reason,
        reduces: r.reduces, note: String(note || '').trim().slice(0, 200), by: byOwner };
      if (!Array.isArray(j.payments)) j.payments = [];
      j.payments.push(pay);

      j.log.push(`${fmtMoney(amt)} refunded to ${j.cust.name} by ${byOwner} — ${r.label.toLowerCase()}` +
        (pay.note ? `: ${pay.note}` : ''));

      /* A job refunded in full for a cancellation is cancelled, not
         active. Leaving it active keeps it in the pipeline, on the
         Home screen and in the debtor figures, which is where a
         cancelled job quietly rots. */
      const nowNet = paidGross - refundedTotal(j);
      if (r.cancels && nowNet <= 0.001 && j.status === 'active') {
        j.status = 'cancelled';
        j.log.push(`Job marked cancelled — refunded in full by ${byOwner}`);
      }
      saveJobRecord(j);

      const res = issueDocument(jobId, 'credit', byOwner, {
        refunded: amt, refundedOn: when, method: pay.method,
        reasonLabel: r.label, why: pay.note || r.blurb,
        reducesSupply: r.reduces, paidGross,
        netPaid: paidGross - refundedTotal(j)
      });
      raiseAlert(j, 'pay', `${fmtMoney(amt)} refunded to ${j.cust.name} for ${j.id}`);
      return { payment: pay, credit: res.document || null, error: res.error };
    },

    /* What has gone back out on a job, and how much of it reduced what
       was owed rather than simply returning an overpayment. */
    refundSummary(jobId) {
      const j = getJob(jobId);
      if (!j) return { total: 0, credited: 0, rows: [] };
      const rows = (j.payments || []).filter(p => p.refund)
        .sort((a, b) => String(b.on).localeCompare(String(a.on)));
      return {
        total: refundedTotal(j),
        credited: jobCredits(j),
        rows: rows.map(p => Object.assign({}, p, {
          amount: Math.abs(p.amount),
          label: (REFUND_REASONS[p.reason] || {}).label || 'Refund'
        }))
      };
    },

    /* What the 48-hour rule on the receipt works out to for this job.
       Not applied automatically — the figure is yours to decide — but
       shown, because the policy is already on every receipt you send
       and ought to be in front of you when you set the number. */
    cancellationGuide(jobId) {
      const j = getJob(jobId);
      if (!j) return null;
      const paidGross = (j.payments || []).reduce((t, p) => t + Math.max(0, Number(p.amount) || 0), 0);
      const net = paidGross - refundedTotal(j);
      if (!j.cust.moveDate) return { paid: net, hours: null, full: net, policy: 'no-date' };
      const hours = (parseDate(j.cust.moveDate) - new Date()) / 36e5;
      const inside = hours < 48;
      return {
        paid: net, hours: Math.round(hours),
        full: net,
        /* "Up to 50%" is a ceiling, not a rule — the wording on the
           receipt says may, and the contractors may not have been
           committed at all. */
        reduced: Math.round(net * 0.5 * 100) / 100,
        policy: inside ? 'inside-48' : 'outside-48'
      };
    },

    /* ---------- aged debtors ---------------------------------------------
       Who owes you and for how long. A flat list of names tells you
       nothing about which one is in trouble: 90 days overdue is a
       different conversation from last Tuesday, and the buckets are
       what make that visible at a glance. */
    agedDebtors() {
      const now = startOfDay(new Date()), buckets = { current: [], d30: [], d60: [], d90: [] };
      jobs.filter(j => j.status === 'active' && jobCost(j)).forEach(j => {
        const owing = owingOn(j);
        if (!owing) return;
        /* Only count it as a debt once an invoice has actually gone
           out — a priced job nobody has been billed for is pipeline. */
        if (!liveDocs(j.id).some(d => d.type === 'invoice')) return;

        const terms = paymentTerms(j);
        /* paymentTerms hands back a Date on some paths and an ISO
           string on others, so normalise before doing arithmetic. */
        const raw = terms.balanceDue || terms.due || j.cust.moveDate;
        const dueDate = raw instanceof Date ? raw : (raw ? parseDate(raw) : null);
        const due = dueDate ? isoDate(dueDate) : '';
        const days = dueDate ? Math.floor((now - dueDate) / 864e5) : 0;
        const row = { job: j, owing, due, days };
        if (days <= 0) buckets.current.push(row);
        else if (days <= 30) buckets.d30.push(row);
        else if (days <= 60) buckets.d60.push(row);
        else buckets.d90.push(row);
      });
      const sum = a => a.reduce((t, r) => t + r.owing, 0);
      Object.values(buckets).forEach(a => a.sort((x, y) => y.days - x.days));
      return { buckets,
        totals: { current: sum(buckets.current), d30: sum(buckets.d30),
                  d60: sum(buckets.d60), d90: sum(buckets.d90) },
        total: sum(buckets.current) + sum(buckets.d30) + sum(buckets.d60) + sum(buckets.d90),
        overdue: sum(buckets.d30) + sum(buckets.d60) + sum(buckets.d90) };
    },

    /* ---------- what you owe contractors ----------------------------------
       The panel has always known this and never added it up. A job
       order a contractor has accepted is a commitment: you pay them
       whether or not the customer pays you, which is the whole risk of
       the principal model. */
    payables() {
      const now = startOfDay(new Date()), rows = [];
      jobs.filter(j => j.status === 'active').forEach(j => {
        livePos(j).filter(p => p.status === 'accepted' || p.status === 'done').forEach(p => {
          const c = getContractor(p.contractorId);
          const sec = j.sections[p.key];
          const amount = sec ? sectionCost(sec) : 0;
          if (!amount) return;
          /* Their terms run from the job, since that is when they
             invoice. 1 month and 14 days are the two we offer. */
          const base = j.cust.moveDate ? parseDate(j.cust.moveDate) : now;
          const days = /month/i.test(c?.terms || '') ? 30 : 14;
          const due = new Date(base); due.setDate(due.getDate() + days);
          rows.push({ jobId: j.id, po: p.no, customer: j.cust.name,
            contractor: c ? c.name : 'Contractor removed', contractorId: p.contractorId,
            service: sectionLabel(p.key), amount, due: isoDate(due),
            overdue: due < now, done: p.status === 'done' });
        });
      });
      rows.sort((a, b) => String(a.due).localeCompare(String(b.due)));
      const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
      return { rows,
        total: rows.reduce((t, r) => t + r.amount, 0),
        thisWeek: rows.filter(r => parseDate(r.due) <= weekEnd).reduce((t, r) => t + r.amount, 0),
        overdue: rows.filter(r => r.overdue).reduce((t, r) => t + r.amount, 0) };
    },

    /* ---------- cash position ---------------------------------------------
       Money banked against money committed. The question it answers is
       the one that actually keeps you up: can I pay the contractors
       before the customers pay me? */
    cashPosition() {
      const banked = jobs.reduce((t, j) =>
        t + (j.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0), 0);
      const owedToYou = this.agedDebtors().total;
      const owedByYou = this.payables();
      return { banked, owedToYou,
        owedByYou: owedByYou.total, dueThisWeek: owedByYou.thisWeek,
        /* What is left if everyone you owe is paid and nobody who owes
           you has yet. The pessimistic number, deliberately. */
        worstCase: banked - owedByYou.total,
        expected: banked + owedToYou - owedByYou.total };
    },

    /* ---------- vehicle log ---------------------------------------------
       Site visits are the mileage nobody claims, because nothing
       records them at the time and a logbook written in April is not
       a logbook. One line per trip, costed at the IRD kilometre rates.

       The tiers: the first 14,000 km in a year are at Tier 1, the rest
       at Tier 2. Strictly that 14,000 counts the vehicle's TOTAL travel,
       business and private, so a car also driven privately crosses into
       Tier 2 sooner than this shows. The panel only ever sees business
       trips, so it says so rather than pretending otherwise. */
    KM_RATES: { petrol: { tier1: 1.20, tier2: 0.37 }, diesel: { tier1: 1.30, tier2: 0.38 } },
    KM_TIER1_LIMIT: 14000,

    listTrips(fromISO, toISO) {
      return trips
        .filter(t => (!fromISO || t.date >= fromISO) && (!toISO || t.date <= toISO))
        .slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    },

    saveTrip(fields, byOwner) {
      const km = Number(fields.km);
      if (!isFinite(km) || km <= 0) return { error: 'Enter the distance in kilometres.' };
      if (km > 2000) return { error: 'That looks like a typo — enter one trip at a time.' };
      const date = String(fields.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date.' };
      const purpose = String(fields.purpose || '').trim().slice(0, 120);
      if (!purpose) return { error: 'Say where you went and why — a logbook without that is not a logbook.' };
      const fuel = fields.fuel === 'diesel' ? 'diesel' : 'petrol';

      const existing = fields.id ? trips.find(t => t.id === fields.id) : null;
      const t = existing || { id: 'T-' + Date.now().toString(36) };
      Object.assign(t, { date, km, purpose, fuel, jobId: fields.jobId || '', by: byOwner });
      if (!existing) trips.push(t);
      trips.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      queueSave('trip', t.id, t);
      return { trip: t };
    },

    deleteTrip(id) { trips = trips.filter(t => t.id !== id); removeRecord('trip', id); return { ok: true }; },

    /* Costs a year's trips in date order, so the tier change lands on
       the trip that actually crossed it rather than being averaged. */
    vehicleClaim(fromISO, toISO) {
      const list = this.listTrips(fromISO, toISO)
        .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      let run = 0, claim = 0, tier2Km = 0;
      const rows = list.map(t => {
        const rates = this.KM_RATES[t.fuel] || this.KM_RATES.petrol;
        const atTier1 = Math.max(0, Math.min(t.km, this.KM_TIER1_LIMIT - run));
        const atTier2 = t.km - atTier1;
        const amount = atTier1 * rates.tier1 + atTier2 * rates.tier2;
        run += t.km; claim += amount; tier2Km += atTier2;
        return Object.assign({}, t, { amount, atTier1, atTier2 });
      });
      return { rows: rows.reverse(), km: run, claim, tier2Km,
        crossed: run > this.KM_TIER1_LIMIT };
    },

    /* ---------- your own hours -------------------------------------------
       The Money screen has always said profit is "before your own
       time". This is what turns that caveat into a number: hours in,
       and what the business actually paid you per hour for them. */
    listHours(fromISO, toISO) {
      return hoursLog
        .filter(h => (!fromISO || h.date >= fromISO) && (!toISO || h.date <= toISO))
        .slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    },

    saveHours(fields, byOwner) {
      const hours = Number(fields.hours);
      if (!isFinite(hours) || hours <= 0) return { error: 'Enter how many hours.' };
      if (hours > 24) return { error: 'More than 24 hours in a day — split it across dates.' };
      const date = String(fields.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date.' };
      const what = String(fields.what || '').trim().slice(0, 120);
      if (!what) return { error: 'Say what the time went on.' };

      const existing = fields.id ? hoursLog.find(h => h.id === fields.id) : null;
      const h = existing || { id: 'H-' + Date.now().toString(36) };
      Object.assign(h, { date, hours, what, jobId: fields.jobId || '',
        owner: fields.owner || byOwner, by: byOwner });
      if (!existing) hoursLog.push(h);
      hoursLog.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      queueSave('hours', h.id, h);
      return { entry: h };
    },

    deleteHours(id) { hoursLog = hoursLog.filter(h => h.id !== id); removeRecord('hours', id); return { ok: true }; },

    /* ---------- assets ----------------------------------------------------
       Under $1,000 is written off the year you buy it. Over $1,000 is
       depreciated, so only this year's slice reduces profit. Declining
       balance, which is the common default — the accountant sets the
       real rate per asset type. */
    listAssets() { return assets.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))); },

    saveAsset(fields, byOwner) {
      const cost = Number(fields.cost);
      if (!isFinite(cost) || cost <= 0) return { error: 'Enter what it cost.' };
      const date = String(fields.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick the date you bought it.' };
      const what = String(fields.what || '').trim().slice(0, 120);
      if (!what) return { error: 'Say what it is.' };
      let rate = fields.rate === undefined || fields.rate === '' ? 0.2 : Number(fields.rate);
      if (!isFinite(rate) || rate < 0 || rate > 1) return { error: 'Depreciation rate has to be between 0% and 100%.' };

      const existing = fields.id ? assets.find(a => a.id === fields.id) : null;
      const a = existing || { id: 'A-' + Date.now().toString(36) };
      Object.assign(a, { date, what, cost, rate,
        supplier: String(fields.supplier || '').trim().slice(0, 80),
        share: fields.share === undefined || fields.share === '' ? 1 : Number(fields.share),
        by: byOwner });
      if (!existing) assets.push(a);
      assets.sort((a2, b2) => String(b2.date).localeCompare(String(a2.date)));
      queueSave('asset', a.id, a);
      return { asset: a };
    },

    deleteAsset(id) { assets = assets.filter(a => a.id !== id); removeRecord('asset', id); return { ok: true }; },

    /* This year's depreciation on everything held, plus what is left to
       write off in later years. An asset under $1,000 is not here — it
       belongs in Expenses as "Equipment under $1,000". */
    depreciation(fromISO, toISO) {
      const yearEnd = new Date(toISO);
      const rows = assets.filter(a => a.cost >= 1000 && a.date <= toISO).map(a => {
        const bought = new Date(a.date);
        /* Whole years held before this one, so the opening book value
           is right for anything bought in an earlier year. */
        const yearsBefore = Math.max(0, Math.floor(
          (new Date(fromISO) - bought) / (365.25 * 864e5)));
        const opening = a.cost * Math.pow(1 - a.rate, yearsBefore);
        /* Part-year in the year of purchase, by month. */
        const monthsHeld = a.date >= fromISO
          ? Math.max(1, 12 - bought.getMonth() + (yearEnd.getMonth() < bought.getMonth() ? 0 : 0))
          : 12;
        const thisYear = opening * a.rate * (Math.min(12, monthsHeld) / 12) * (a.share || 1);
        return Object.assign({}, a, { opening, thisYear, closing: opening - thisYear });
      });
      return { rows, total: rows.reduce((t, r) => t + r.thisYear, 0) };
    },

    /* ---------- profit and loss ----------------------------------------
       Income is the job work done in the period, GST stripped out.
       Contractor cost comes off the jobs. Everything else comes from
       the expense records above. The result is what the partnership
       actually made, which is the number that splits 50/50. */
    profitAndLoss(fromISO, toISO) {
      const inPeriod = d => d && d >= fromISO && d <= toISO;
      let grossIncome = 0, contractorCost = 0, jobCount = 0;

      jobs.filter(j => j.status === 'active' && inPeriod(j.cust.moveDate)).forEach(j => {
        const cost = jobCost(j);
        if (!cost) return;
        grossIncome += customerPrice(cost, j);
        contractorCost += cost;
        jobCount++;
      });

      /* Money refunded for work that shrank or never happened is not
         income. Returning an overpayment is not deducted, because it
         was never counted as income in the first place. */
      const credited = creditsIn(fromISO, toISO);
      grossIncome -= credited;

      /* GST is never income and never a cost — it passes through. */
      const income = grossIncome - gstWithin(grossIncome);
      const contractors = contractorCost - gstWithin(claimableCostIn(fromISO, toISO));

      const byCategory = {};
      let expenseTotal = 0, gstOnExpenses = 0;
      this.listExpenses(fromISO, toISO).forEach(x => {
        const v = this.expenseValue(x);
        const row = byCategory[x.category] || (byCategory[x.category] =
          { key: x.category, label: EXPENSE_CATEGORIES[x.category].label, gross: 0, deductible: 0, count: 0 });
        row.gross += v.gross; row.deductible += v.deductible; row.count++;
        expenseTotal += v.deductible;
        gstOnExpenses += v.gstClaim;
      });

      /* The vehicle log and the depreciation schedule are deductions
         too, so they belong in the P&L rather than sitting in their own
         screens looking like trivia. Shown as their own lines because
         they are worked out differently from a receipt. */
      const veh = this.vehicleClaim(fromISO, toISO);
      const dep = this.depreciation(fromISO, toISO);
      const rows = Object.values(byCategory).sort((a, b) => b.deductible - a.deductible);
      if (veh.claim) rows.push({ key: 'km', label: 'Vehicle, kilometre rate',
        gross: veh.claim, deductible: veh.claim, count: veh.rows.length, derived: true });
      if (dep.total) rows.push({ key: 'depreciation', label: 'Depreciation',
        gross: dep.total, deductible: dep.total, count: dep.rows.length, derived: true });

      const deductions = expenseTotal + veh.claim + dep.total;
      const net = income - contractors - deductions;
      return {
        from: fromISO, to: toISO, jobCount, credited,
        grossIncome, income, contractorCost, contractors,
        expenses: rows, expenseTotal: deductions, receiptsTotal: expenseTotal,
        vehicle: veh, depreciation: dep,
        gstOnExpenses, net
      };
    },

    /* Each partner's half. A partnership is not taxed itself: it files
       a return, and each partner declares their share on their own
       personal return. So this, not the net profit, is the number Dan
       and Rocky each need. */
    partnerShares(net) {
      const share = net / OWNERS.length;
      return OWNERS.map(o => ({ owner: o, share }));
    },

    /* Tax on one partner's share, at the NZ individual rates. This is
       the partnership income alone — a partner with a job or other
       income pays at their top rate on top of that, so this is a floor,
       not a bill. ACC levies are extra again. */
    TAX_BANDS: [
      { upTo: 15600, rate: 0.105 },
      { upTo: 53500, rate: 0.175 },
      { upTo: 78100, rate: 0.30 },
      { upTo: 180000, rate: 0.33 },
      { upTo: Infinity, rate: 0.39 }
    ],
    taxOn(amount) {
      if (!(amount > 0)) return { tax: 0, bands: [], effective: 0, provisional: false };
      let left = amount, last = 0, tax = 0;
      const bands = [];
      for (const b of this.TAX_BANDS) {
        const slice = Math.min(left, b.upTo - last);
        if (slice > 0) {
          const t = slice * b.rate;
          bands.push({ from: last, to: b.upTo, rate: b.rate, amount: slice, tax: t });
          tax += t; left -= slice;
        }
        last = b.upTo;
        if (left <= 0) break;
      }
      return { tax, bands, effective: tax / amount,
        /* Residual income tax over $5,000 puts you into provisional
           tax for the following year — three instalments instead of
           one bill, which is a cash-flow change worth seeing coming. */
        provisional: tax > 5000 };
    },

    /* ---------- GST position -----------------------------------------
       A working figure for a return, not a return. It is built on the
       job date, which is when the service is supplied — the invoice
       basis would use payment dates instead, so the accountant has to
       say which one applies before this goes anywhere near myIR.

       Output GST is what you collected: 3/23 of every gross customer
       price in the period. Input GST is what you can claim back: 3/23
       of what GST-registered contractors charged you. A contractor who
       is not registered charges no GST, so none of their fee is
       claimable — which is why their status is a field and not an
       assumption. */
    gstPosition(fromISO, toISO) {
      if (!business.gstRegistered) return { registered: false };
      const inPeriod = d => d && d >= fromISO && d <= toISO;

      let supplies = 0, outputGst = 0, purchases = 0, inputGst = 0;
      let noGstCost = 0, unknown = 0;
      const rows = [];

      jobs.filter(j => j.status === 'active' && inPeriod(j.cust.moveDate)).forEach(j => {
        const cost = jobCost(j);
        if (!cost) return;
        const gross = customerPrice(cost, j);
        supplies += gross;
        outputGst += gstWithin(gross);

        /* Split this job's cost by whether the contractor behind each
           section can actually issue a GST invoice. */
        let claimable = 0, notClaimable = 0, unsure = 0;
        Object.values(j.sections).forEach(s => {
          const c = s.contractorId ? getContractor(s.contractorId) : null;
          const secCost = sectionCost(s);
          if (!secCost) return;
          if (!c) unsure += secCost;                 // a standalone one-off
          else if (c.gstRegistered) claimable += secCost;
          else notClaimable += secCost;
        });
        purchases += claimable;
        inputGst += gstWithin(claimable);
        noGstCost += notClaimable;
        unknown += unsure;

        rows.push({ id: j.id, name: j.cust.name, date: j.cust.moveDate,
          gross, outputGst: gstWithin(gross), claimable, inputGst: gstWithin(claimable) });
      });

      /* Credit notes issued in this period reduce what was supplied,
         and with it the GST collected on it. */
      const credited = creditsIn(fromISO, toISO);
      supplies -= credited;
      outputGst -= gstWithin(credited);

      return { registered: true, from: fromISO, to: toISO,
        supplies, outputGst, purchases, inputGst, credited,
        net: outputGst - inputGst,
        noGstCost, unknown,
        rows: rows.sort((a, b) => String(a.date).localeCompare(String(b.date))) };
    },

    /* The two-monthly periods most small NZ businesses file on, newest
       first, back as far as there are jobs. */
    gstPeriods(count = 6) {
      const out = [], now = new Date(), nowIso = isoDate(now);
      /* Two-monthly periods ending on the last day of an even month
         (Feb, Apr, … Dec). The list opens on the period TODAY sits in,
         not the last one that closed: most of the time you are looking
         at what is building up, and a card that opens empty because
         the current period was skipped just looks broken. */
      let endMonth = now.getMonth();
      if (endMonth % 2 === 0) endMonth += 1;
      let y = now.getFullYear();
      if (endMonth > 11) { endMonth -= 12; y += 1; }
      for (let i = 0; i < count; i++) {
        const end = new Date(y, endMonth + 1, 0);
        const start = new Date(y, endMonth - 1, 1);
        const open = isoDate(end) >= nowIso;
        out.push({ from: isoDate(start), to: isoDate(end), open,
          label: start.toLocaleDateString('en-NZ', { month: 'short' }) + '–' +
                 end.toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' }) +
                 (open ? ' (still open)' : '') });
        endMonth -= 2;
        if (endMonth < 0) { endMonth += 12; y -= 1; }
      }
      return out;
    },

    earnings(forOwner, mineOnly = false) {
      const mine = j => !mineOnly || j.owner === forOwner;
      const months = {};
      const row = k => (months[k] = months[k] || {
        key: k, sold: 0, cost: 0, margin: 0, jobs: 0, received: 0, lost: 0, lostJobs: 0
      });
      const monthOf = iso => String(iso || '').slice(0, 7);

      jobs.filter(mine).forEach(j => {
        const cost = jobCost(j);
        if (!cost) return;
        if (j.status === 'active' && j.cust.moveDate) {
          const r = row(monthOf(j.cust.moveDate));
          const price = customerPrice(cost, j);
          r.sold += price; r.cost += cost; r.margin += price - cost; r.jobs++;
        }
        if (j.status === 'lost' && j.cust.moveDate) {
          const r = row(monthOf(j.cust.moveDate));
          r.lost += customerPrice(cost, j); r.lostJobs++;
        }
        (j.payments || []).forEach(pm => { row(monthOf(pm.on)).received += Number(pm.amount || 0); });
      });

      const list = Object.values(months).sort((a, b) => b.key.localeCompare(a.key));
      const totals = list.reduce((t, m) => ({
        sold: t.sold + m.sold, cost: t.cost + m.cost, margin: t.margin + m.margin,
        jobs: t.jobs + m.jobs, received: t.received + m.received,
        lost: t.lost + m.lost, lostJobs: t.lostJobs + m.lostJobs
      }), { sold: 0, cost: 0, margin: 0, jobs: 0, received: 0, lost: 0, lostJobs: 0 });

      // Everything invoiced and not yet paid, whatever month it sits in.
      const owing = jobs.filter(j => mine(j) && j.status === 'active' && jobCost(j))
        .map(j => ({ job: j, owing: owingOn(j) }))
        .filter(x => x.owing > 0 && liveDocs(x.job.id).some(d => d.type === 'invoice'))
        .sort((a, b) => String(a.job.cust.moveDate).localeCompare(String(b.job.cust.moveDate)));

      return { months: list, totals, owing,
        owed: owing.reduce((t, x) => t + x.owing, 0),
        marginRate: totals.sold ? totals.margin / totals.sold : MARGIN };
    },

    /* ---- the day before -------------------------------------------
       Everything happening tomorrow, with the message already written
       for the customer and for each crew. */
    tomorrow(forOwner, mineOnly = false) {
      const iso = isoDate(addDays(startOfDay(new Date()), 1));
      const mine = j => !mineOnly || j.owner === forOwner;
      return jobs.filter(j => j.status === 'active' && mine(j) && j.cust.moveDate === iso)
        .map(j => ({
          job: j,
          crews: livePos(j).map(p => ({
            no: p.no, key: p.key, service: SERVICES[p.key], status: p.status,
            name: getContractor(p.contractorId)?.name || 'Contractor removed',
            phone: getContractor(p.contractorId)?.phone || '',
            confirmed: p.status === 'accepted' || p.status === 'done'
          })),
          unconfirmed: livePos(j).filter(p => p.status !== 'accepted' && p.status !== 'done').length,
          owing: owingOn(j)
        }));
    },

    /* ---- the whole lot, as one file -------------------------------
       The panel's data lives with the Netlify site and nowhere else.
       One wrong setting and there is no copy anywhere, so there needs
       to be a way to take one. */
    backup() {
      /* Version 2 adds the money records and the logins. A version 1
         file restores fine — the newer collections simply come back
         empty, which is what they were when it was taken.

         Code hashes travel with the users, so restoring a backup
         restores everybody's sign-in too. They are hashes, not codes,
         but the file is still worth treating as sensitive. */
      return {
        format: 'flatout-panel-backup',
        version: 2,
        takenAt: new Date().toISOString(),
        counts: { jobs: jobs.length, customers: customers.length,
          contractors: contractors.length, documents: documents.length,
          expenses: expenses.length, trips: trips.length,
          assets: assets.length, hours: hoursLog.length, users: users.length },
        jobs, customers, contractors, documents, acceptances,
        portals: portalGates, templates, alerts,
        expenses, trips, assets, hours: hoursLog, users,
        settings: alertSettings, business
      };
    },

    /* Put a backup back. Everything currently stored is replaced, so
       the UI asks properly before calling this. */
    async restore(data, byOwner) {
      if (!data || data.format !== 'flatout-panel-backup') {
        return { error: "That is not a FlatOut backup file." };
      }
      const put = (kind, id, value) => queueSave(kind, id, value);
      (data.contractors || []).forEach(c => put('contractor', c.id, c));
      (data.customers || []).forEach(c => put('customer', c.id, c));
      (data.jobs || []).forEach(j => put('job', j.id, j));
      (data.documents || []).forEach(d => put('document', d.id, d));
      (data.acceptances || []).forEach(a => put('acceptance', a.jobId, a));
      (data.portals || []).forEach(g => put('portal', g.jobId, g));
      (data.templates || []).forEach(t => put('template', t.id, t));
      (data.expenses || []).forEach(x => put('expense', x.id, x));
      (data.trips || []).forEach(x => put('trip', x.id, x));
      (data.assets || []).forEach(x => put('asset', x.id, x));
      (data.hours || []).forEach(x => put('hours', x.id, x));
      (data.users || []).forEach(x => put('user', x.id, x));
      if (data.settings) put('settings', '', data.settings);
      if (data.business) put('business', '', data.business);

      contractors = data.contractors || [];
      customers = (data.customers || []).sort((a, b) => a.name.localeCompare(b.name));
      jobs = (data.jobs || []).map(migrateJob).sort((a, b) => String(b.id).localeCompare(String(a.id)));
      documents = data.documents || [];
      acceptances = data.acceptances || [];
      portalGates = data.portals || [];
      templates = data.templates || templates;
      expenses = data.expenses || expenses;
      trips = data.trips || trips; assets = data.assets || assets; hoursLog = data.hours || hoursLog;
      if (data.settings) alertSettings = data.settings;
      if (data.business) business = Object.assign({}, BUSINESS_DEFAULTS, data.business);
      return { restored: data.counts || {}, by: byOwner };
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
        const cost = jobCost(j), price = customerPrice(cost, j), t = paymentTerms(j);
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
