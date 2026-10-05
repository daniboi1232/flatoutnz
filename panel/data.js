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
  const STAGES = ['Walk-through', 'Estimate sent', 'Estimate accepted', 'Quote sent',
    'Paid / deposit in', 'Job orders out', 'Completed'];
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

  /* ---------- in-memory model, filled by init() -------------------- */
  let contractors = [], jobs = [], templates = [], alerts = [];
  let alertSettings = {};
  let ready = false;

  const getContractor = id => contractors.find(c => c.id === id) || null;
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

  /* ---------- money ------------------------------------------------ */
  function sectionCost(section) {
    return Object.entries(section.lines).reduce((t, [iid, q]) => {
      const i = getRateItem(section.contractorId, iid);
      return t + (i ? q * i.rate : 0);
    }, 0);
  }
  function jobCost(job) {
    return Object.values(job.sections).reduce((t, s) => t + sectionCost(s), 0);
  }
  const customerPrice = cost => Math.round(cost * (1 + MARGIN));

  function paymentTerms(job) {
    const total = customerPrice(jobCost(job));
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
      jobs = (d.jobs || []).sort((a, b) => String(b.id).localeCompare(String(a.id)));
      templates = d.templates || [];
      alerts = (d.alerts || []).sort((a, b) => String(b.id).localeCompare(String(a.id)));
      alertSettings = d.settings || {};
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

    /* ---- jobs ---------------------------------------------------- */
    listJobs: () => jobs.slice(),
    getJob, livePos, findPo,

    saveJob(draft, byOwner) {
      const sections = {};
      Object.entries(draft.sections).forEach(([k, s]) => {
        if (Object.keys(s.lines).length) sections[k] = s;
      });
      const id = nextJobId();
      const job = { id, owner: byOwner, stage: 0, preparedBy: byOwner,
        cust: draft.cust, sections, pos: [], log: [`Walk-through saved by ${byOwner}`] };
      jobs.unshift(job);
      saveJobRecord(job);
      return id;
    },

    createJob(cust, byOwner) {
      const id = nextJobId();
      const job = { id, owner: byOwner, stage: 0, preparedBy: byOwner,
        cust, sections: {}, pos: [], log: [`Job created by ${byOwner}`] };
      jobs.unshift(job);
      saveJobRecord(job);
      return job;
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
      j.stage = 1;
      j.log.push(`Estimate sent to the customer by ${byOwner}`);
      saveJobRecord(j);
      return j;
    },

    markEstimateAccepted(id) {
      const j = getJob(id);
      j.stage = 2;
      j.log.push('Customer accepted the estimate');
      raiseAlert(j, 'accept', `${j.cust.name} accepted the estimate for ${j.id}`);
      saveJobRecord(j);
      return j;
    },

    markFormalQuoteSent(id, byOwner) {
      const j = getJob(id);
      j.stage = 3;
      j.log.push(`Formal quote sent by ${byOwner}`);
      saveJobRecord(j);
      return j;
    },

    markPaymentReceived(id) {
      const j = getJob(id);
      const pos = this.createPurchaseOrders(id);
      j.stage = 5;
      j.log.push(`${paymentTerms(j).kind} received`,
        `Job orders issued: ${pos.map(p => p.no + ' to ' + (getContractor(p.contractorId)?.name || '?')).join(', ')}`);
      raiseAlert(j, 'pay', `${paymentTerms(j).kind} received from ${j.cust.name}. Job orders issued.`);
      saveJobRecord(j);
      return { job: j, pos };
    },

    createPurchaseOrders(jobId) {
      const j = getJob(jobId);
      j.pos = Object.entries(j.sections).map(([k, s]) => ({
        no: nextPoNoFor(j), key: k, contractorId: s.contractorId,
        status: 'awaiting', due: addBusinessDays(new Date(), 2).toISOString().slice(0, 10), photos: 0
      }));
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
      if (old.status === 'silent') old.wasSilent = true;
      old.status = 'replaced';
      const fresh = { no: nextPoNoFor(j), key: old.key, contractorId: newContractorId,
        status: 'awaiting', due: addBusinessDays(new Date(), 2).toISOString().slice(0, 10), photos: 0 };
      j.pos.push(fresh);
      const matched = Object.keys(lines).length;
      j.log.push(`${fresh.no} issued to ${to.name} to replace ${old.no} (${from?.name || '?'}). ` +
        (matched ? 'Items were matched by name, so check the price.' : 'None of the items matched, so re-price this section.'));
      saveJobRecord(j);
      return { po: fresh, matched };
    },

    signOffJob(id, byOwner) {
      const j = getJob(id);
      j.stage = 6;
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

    /* ---- payments ------------------------------------------------
       Display only. Zoho does the invoicing; you tick the stage over
       here when you see the money land. */
    getPayments() {
      const now = new Date(); now.setHours(0, 0, 0, 0);
      return jobs.filter(j => j.stage >= 2 && j.stage < 6).map(j => {
        const t = paymentTerms(j);
        const paid = j.stage >= 4;
        return { job: j, terms: t, paid, overdue: !paid && t.due < now };
      });
    }
  };

  function nextPoNoFor(job) {
    const all = jobs.flatMap(j => j.pos).concat(job.pos || []);
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
