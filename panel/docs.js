/* =====================================================================
   FlatOut Employees Panel — DOCUMENTS
   =====================================================================
   Renders the four customer documents: estimate, quote, invoice,
   receipt.

   WHY THIS FILE EXISTS SEPARATELY
   The HTML a document renders to is FROZEN the moment you issue it and
   stored with the job. What the customer opens in six months is what
   you sent, even if your rates, your terms or this file have changed
   since. That only works if rendering is a pure function of a snapshot
   — so everything this file needs arrives in `ctx`, and it reads
   nothing live.

   Nothing in here talks to the server or to Data.
   ===================================================================== */

const Docs = (() => {
  'use strict';

  const TYPES = {
    estimate: { label: 'Estimate', prefix: 'EST', heading: 'ESTIMATE' },
    quote:    { label: 'Quote',    prefix: 'QTE', heading: 'QUOTE' },
    invoice:  { label: 'Invoice',  prefix: 'INV', heading: 'INVOICE' },
    receipt:  { label: 'Receipt',  prefix: 'REC', heading: 'RECEIPT' }
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => 'NZD $' + Number(n || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const plain = n => Number(n || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = iso => {
    if (!iso) return '—';
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  const shortDate = iso => {
    if (!iso) return '—';
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  /* The page's own stylesheet travels inside the frozen document, so it
     looks the same wherever it is opened and whatever the site's CSS
     does later. A4 at 96dpi. */
  const CSS = `
*{box-sizing:border-box}
.fo-doc{width:794px;min-height:1123px;margin:0 auto;padding:56px 64px 44px;background:#fff;
  font-family:Karla,system-ui,-apple-system,"Segoe UI",sans-serif;color:#14283A;display:flex;flex-direction:column}
.fo-doc .ser{font-family:Fraunces,Georgia,"Times New Roman",serif}
.fo-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
.fo-head img{width:86px;height:86px;object-fit:contain}
.fo-biz{text-align:right;font-size:12px;line-height:1.55;color:#3B4A58}
.fo-biz b{display:block;font-size:17px;font-weight:600;color:#14283A;letter-spacing:.2px}
.fo-title{display:flex;align-items:center;gap:18px;margin-top:34px}
.fo-title span{font-size:22px;font-weight:600;letter-spacing:3px}
.fo-title i{flex:1;height:1px;background:#C9D1D8}
.fo-parties{display:flex;justify-content:space-between;align-items:flex-start;gap:32px;margin-top:30px}
.fo-to{font-size:13px;line-height:1.6}
.fo-to .lbl{font-size:11px;letter-spacing:1.4px;color:#5A6B78;font-weight:600;margin-bottom:6px}
.fo-to .nm{font-size:15px;font-weight:700}
.fo-meta{text-align:right;font-size:13px;line-height:1.75}
.fo-meta .k{color:#5A6B78}
.fo-badge{display:inline-block;margin-top:10px;border:1.5px solid;border-radius:4px;padding:5px 12px;
  font-size:12px;font-weight:700;letter-spacing:1.2px}
.fo-badge.warn{border-color:#9A5420;color:#9A5420}
.fo-badge.ok{border-color:#2C6E66;color:#2C6E66}
.fo-badge.paid{border-width:2px;border-color:#2C6E66;color:#2C6E66;padding:7px 18px;font-size:17px;
  font-weight:600;letter-spacing:2px;font-family:Fraunces,Georgia,serif}
.fo-badge.void{border-color:#C24444;color:#C24444}
.fo-note{margin-top:26px;padding:14px 18px;font-size:13px;line-height:1.6;border-left:3px solid}
.fo-note.cream{background:#F4F0E8;border-color:#D97A35}
.fo-note.amber{background:#FBF1E8;border-color:#9A5420}
.fo-note.teal{background:#EBF2F1;border-color:#2C6E66}
.fo-doc table{width:100%;border-collapse:collapse;font-size:13px}
.fo-doc thead tr{background:#14283A;color:#fff;text-align:left}
.fo-doc th{padding:10px 14px;font-size:11px;letter-spacing:1.2px;font-weight:700}
.fo-doc td{padding:13px 14px;vertical-align:top;line-height:1.6;border-bottom:1px solid #DCE2E7}
.fo-doc td.num,.fo-doc th.num{text-align:right}
.fo-sum{margin-top:20px;display:flex;justify-content:flex-end}
.fo-sum>div{width:340px}
.fo-sum .line{display:flex;justify-content:space-between;font-size:13px;padding:5px 0;color:#3B4A58}
.fo-sum .grand{display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid #14283A;
  padding-top:12px;margin-top:8px}
.fo-sum .grand .l{font-size:17px;font-weight:600}
.fo-sum .grand .v{font-size:26px;font-weight:600}
.fo-sum .after{text-align:right;font-size:11.5px;color:#5A6B78;margin-top:7px;line-height:1.5}
.fo-box{margin-top:26px;border:1px solid #DCE2E7;border-radius:6px;padding:18px 20px}
.fo-box.strong{border:1.5px solid #14283A}
.fo-box .lbl{font-size:11px;letter-spacing:1.4px;color:#5A6B78;font-weight:700;margin-bottom:12px}
.fo-pay{display:flex;gap:32px;font-size:13px;line-height:1.9}
.fo-pay .k{color:#5A6B78;display:inline-block;width:120px}
.fo-pay .k.sm{width:90px}
.fo-pay .sep{border-left:1px solid #DCE2E7;padding-left:32px}
.fo-small{margin-top:20px;font-size:11.5px;line-height:1.6;color:#3B4A58}
.fo-small b{color:#14283A}
.fo-grow{flex:1}
.fo-foot{border-top:1px solid #DCE2E7;padding-top:12px;display:flex;justify-content:space-between;
  align-items:flex-end;gap:20px;font-size:10.5px;color:#5A6B78;line-height:1.6;margin-top:24px}
.fo-foot .legal{max-width:430px}
.fo-foot .sign{text-align:right}
.fo-foot .sign .rule{border-top:1px solid #8B98A3;width:170px;margin-left:auto;padding-top:5px}
.fo-foot .sign img{display:block;height:46px;margin:0 0 -6px auto;object-fit:contain}
.fo-void{position:relative}
.fo-void::after{content:"VOIDED";position:absolute;top:44%;left:0;right:0;text-align:center;
  font-family:Fraunces,Georgia,serif;font-size:110px;font-weight:600;letter-spacing:12px;
  color:rgba(194,68,68,.16);pointer-events:none}
.fo-next{display:flex;gap:20px;font-size:12.5px;line-height:1.6}
.fo-next>div{flex:1}
.fo-next b{display:block;font-size:13px;margin-bottom:3px}
.fo-next span{color:#3B4A58}
@media print{
  body{margin:0;background:#fff}
  .fo-doc{width:auto;min-height:0;padding:14mm 16mm;margin:0}
  .fo-noprint{display:none !important}
}
@media (max-width:820px){
  .fo-doc{width:100%;padding:24px 18px 28px}
  .fo-head,.fo-parties,.fo-pay,.fo-next{flex-direction:column;gap:14px}
  .fo-biz,.fo-meta{text-align:left}
  .fo-sum{justify-content:stretch}
  .fo-sum>div{width:100%}
  .fo-foot{flex-direction:column;align-items:flex-start}
  .fo-foot .sign{text-align:left}
  .fo-foot .sign .rule{margin-left:0}
  .fo-foot .sign img{margin-left:0}
  .fo-pay .sep{border-left:0;padding-left:0;border-top:1px solid #DCE2E7;padding-top:10px}
  .fo-void::after{font-size:58px;letter-spacing:6px}
}`;

  /* ---------- the shared furniture --------------------------------- */
  function head(ctx) {
    const b = ctx.business;
    return `<div class="fo-head">
      ${b.logo ? `<img src="${esc(b.logo)}" alt="FlatOut">` : '<div style="width:86px"></div>'}
      <div class="fo-biz">
        <b class="ser">${esc(b.name)}</b>
        <div>${esc(b.entity)}${b.nzbn ? ' · NZBN ' + esc(b.nzbn) : ''}</div>
        ${b.gstNumber ? `<div>GST ${esc(b.gstNumber)}</div>` : ''}
        <div>${esc(b.place)}</div>
        <div>${esc(b.phone)} · ${esc(b.web)}</div>
      </div>
    </div>`;
  }

  function title(t) {
    return `<div class="fo-title"><i></i><span class="ser">${esc(t)}</span><i></i></div>`;
  }

  function parties(ctx, label, meta, badge) {
    const c = ctx.customer;
    return `<div class="fo-parties">
      <div class="fo-to">
        <div class="lbl">${esc(label)}</div>
        <div class="nm">${esc(c.name)}</div>
        <div>${esc(ctx.job.address)}</div>
        ${c.email ? `<div style="margin-top:6px;color:#3B4A58">${esc(c.email)}</div>` : ''}
        ${!c.email && c.phone ? `<div style="margin-top:6px;color:#3B4A58">${esc(c.phone)}</div>` : ''}
      </div>
      <div class="fo-meta">
        ${meta.map(([k, v]) => `<div><span class="k">${esc(k)}</span> &nbsp;<b>${esc(v)}</b></div>`).join('')}
        ${badge ? `<div class="fo-badge ${badge[0]}">${esc(badge[1])}</div>` : ''}
      </div>
    </div>`;
  }

  /* Services are described in full; the money is ONE figure. That is
     what the terms promise the customer, and it keeps contractor rates
     off a document that leaves the building. */
  function serviceTable(ctx, heading) {
    return `<div style="margin-top:26px"><table>
      <thead><tr><th style="width:34%">SERVICE</th><th>${esc(heading)}</th></tr></thead>
      <tbody>${ctx.services.map(s => `<tr>
        <td><b>${esc(s.name)}</b>${s.when ? `<br><span style="color:#5A6B78;font-size:12px">${esc(s.when)}</span>` : ''}</td>
        <td>${esc(s.detail)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function totals(ctx, rows, grandLabel, grandValue, after) {
    return `<div class="fo-sum"><div>
      ${rows.map(([k, v]) => `<div class="line"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}
      <div class="grand"><div class="ser l">${esc(grandLabel)}</div><div class="ser v">${esc(grandValue)}</div></div>
      ${after ? `<div class="after">${after}</div>` : ''}
    </div></div>`;
  }

  /* GST only ever appears when the business says it is registered. An
     unregistered business issuing something headed "Tax Invoice", or
     showing a GST line, is a problem with Inland Revenue rather than a
     cosmetic one. */
  function gstLines(ctx) {
    if (!ctx.business.gstRegistered) return [];
    const net = ctx.total / (1 + ctx.business.gstRate);
    return [['Subtotal', '$' + plain(net)],
      [`GST (${Math.round(ctx.business.gstRate * 100)}%)`, '$' + plain(ctx.total - net)]];
  }
  const gstNote = ctx => ctx.business.gstRegistered
    ? `Prices include GST at ${Math.round(ctx.business.gstRate * 100)}%.`
    : 'No GST component — see below.';

  function foot(ctx) {
    const b = ctx.business;
    /* An unregistered business must not put out something that reads
       as a tax invoice, so the money documents say so outright rather
       than leaving it to be inferred from a missing line. */
    const gst = b.gstRegistered
      ? `${esc(b.name)} is registered for GST (${esc(b.gstNumber || 'number pending')}). ${ctx.type === 'invoice' ? 'This is a tax invoice.' : 'This document shows'} GST at ${Math.round(b.gstRate * 100)}%.`
      : `${esc(b.name)} is ${esc(b.entity.toLowerCase())} and is <b>not registered for GST</b>, so these prices include no GST component.` +
        (ctx.type === 'invoice' ? ' This is not a tax invoice and no GST is charged or claimable.'
          : ctx.type === 'receipt' ? ' This is not a GST receipt and no GST was charged.' : '');
    return `<div class="fo-grow"></div><div class="fo-foot">
      <div class="legal">${gst} Full terms at ${esc(b.web)}/terms${ctx.termsVersion ? ` (version ${esc(ctx.termsVersion)})` : ''}. Nothing here affects your rights under the Consumer Guarantees Act.</div>
      <div class="sign">
        ${b.signature ? `<img src="${esc(b.signature)}" alt="">` : ''}
        <div class="rule">${esc(ctx.issuedVerb || 'Prepared by')} <b style="color:#14283A">${esc(ctx.issuedBy)}</b></div>
        <div>${esc(ctx.issuedByTitle || '')}${ctx.issuedByTitle ? ', ' : ''}${esc(b.name)}</div>
      </div>
    </div>`;
  }

  const wrap = (ctx, inner, voided) =>
    `<div class="fo-doc${voided ? ' fo-void' : ''}">${inner}</div>`;

  /* ---------- the four documents ----------------------------------- */

  function estimate(ctx) {
    return wrap(ctx, head(ctx) + title('ESTIMATE') +
      parties(ctx, 'ESTIMATE FOR', [
        ['Estimate no.', ctx.no], ['Job no.', ctx.job.id],
        ['Issued', longDate(ctx.issued)], ['Valid until', longDate(ctx.validUntil)]
      ], ['warn', 'INDICATIVE']) +
      `<div class="fo-note amber"><b>This is an estimate, not a fixed price.</b> It is what we expect the job to cost based on walking through the property. Once our contractors confirm they can do it on your date, we will send a formal quote with a firm price. If anything changes the figure, we will tell you before any work starts — we will not do extra work and bill you for it.</div>` +
      serviceTable(ctx, "WHAT WE'D DO") +
      totals(ctx, gstLines(ctx), 'Estimated all-in', money(ctx.total),
        `One figure covering everything above.<br>${gstNote(ctx)}`) +
      `<div class="fo-box"><div class="lbl">WHAT HAPPENS NEXT</div><div class="fo-next">
        <div><b>1 &nbsp;You tell us you're keen</b><span>Reply to this, or text ${esc(ctx.business.phone)}. Nothing is booked and nothing is owed yet.</span></div>
        <div><b>2 &nbsp;We confirm contractors</b><span>We check the crews can do ${esc(shortDate(ctx.job.date))} and hold the slot.</span></div>
        <div><b>3 &nbsp;You get a firm quote</b><span>A fixed price you can accept online. Payment only becomes due after that.</span></div>
      </div></div>` +
      `<div class="fo-small"><b>If you go ahead.</b> ${esc(ctx.payment.sentence)} You can cancel or reschedule at no cost up to 48 hours before the job.</div>` +
      foot(ctx), ctx.voided);
  }

  function quote(ctx) {
    return wrap(ctx, head(ctx) + title('QUOTE') +
      parties(ctx, 'QUOTE FOR', [
        ['Quote no.', ctx.no], ['Job no.', ctx.job.id],
        ['Issued', longDate(ctx.issued)], ['Valid until', longDate(ctx.validUntil)]
      ], ctx.voided ? ['void', 'VOIDED'] : ['ok', 'FIRM PRICE']) +
      `<div class="fo-note cream"><b>Move-out at ${esc(ctx.job.address)} on ${esc(shortDate(ctx.job.date))}.</b> Your contractors are confirmed and this price is fixed for the work described below.</div>` +
      serviceTable(ctx, "WHAT'S INCLUDED") +
      totals(ctx, gstLines(ctx), 'All-in price', money(ctx.total),
        `One figure covering everything above.<br>${gstNote(ctx)}`) +
      `<div style="margin-top:26px;display:flex;gap:22px;align-items:stretch">
        <div style="flex:1;border:1px solid #DCE2E7;border-radius:6px;padding:16px 18px">
          <div class="lbl" style="font-size:11px;letter-spacing:1.4px;color:#5A6B78;font-weight:700;margin-bottom:10px">WHEN IT'S DUE</div>
          <table style="border-collapse:collapse;width:100%"><tbody>
          ${ctx.payment.schedule.map(s => `<tr>
            <td style="padding:4px 0;border:0">${esc(s.what)}</td>
            <td style="padding:4px 0;border:0;text-align:right"><b>$${plain(s.amount)}</b></td>
            <td style="padding:4px 0;border:0;text-align:right;color:#3B4A58">${esc(shortDate(s.due))}</td></tr>`).join('')}
          </tbody></table>
          <div style="font-size:11.5px;color:#3B4A58;margin-top:10px;line-height:1.5">${esc(ctx.payment.warning)}</div>
        </div>
        <div style="width:266px;background:#14283A;color:#fff;border-radius:6px;padding:16px 18px">
          <div style="font-size:11px;letter-spacing:1.4px;font-weight:700;color:#9FC3C0;margin-bottom:10px">TO ACCEPT</div>
          <div style="font-size:13px;line-height:1.6">Open the link we sent you and tap <b>Accept this quote</b>.</div>
          ${ctx.portalUrl ? `<div style="font-size:12.5px;line-height:1.6;margin-top:10px;color:#CFD9E0;word-break:break-all">${esc(ctx.portalUrl)}</div>` : ''}
          <div style="font-size:11.5px;line-height:1.5;margin-top:12px;color:#9FB0BD">Or just reply to this. Accepting confirms you have read the terms linked below.</div>
        </div>
      </div>` +
      `<div class="fo-small"><b>Changing or cancelling.</b> More than 48 hours before the job: cancel or reschedule at no cost, deposit refunded in full. Within 48 hours: we may keep up to 50% of the price, because contractors have held the slot. On the day, or if nobody can give us access: the full price is payable. If we cancel or cannot deliver on the agreed date, you get a full refund of anything you have paid.</div>` +
      foot(ctx), ctx.voided);
  }

  function invoice(ctx) {
    const bank = ctx.business.bank || {};
    const ready = bank.accountNumber && bank.accountName;
    return wrap(ctx, head(ctx) + title('INVOICE') +
      parties(ctx, 'BILL TO', [
        ['Invoice no.', ctx.no],
        ...(ctx.quoteNo ? [['Quote no.', ctx.quoteNo]] : []),
        ['Job no.', ctx.job.id], ['Issued', longDate(ctx.issued)]
      ], ctx.voided ? ['void', 'VOIDED'] : ['warn', ctx.instalmentLabel || 'DUE']) +
      `<div style="margin-top:26px"><table>
        <thead><tr><th>DESCRIPTION</th><th class="num" style="width:140px">AMOUNT</th></tr></thead>
        <tbody>
          <tr><td><b>Move-out services at ${esc(ctx.job.address)}</b><br>
            <span style="color:#3B4A58;font-size:12.5px">${esc(ctx.services.map(s => s.name).join(' and '))}, ${esc(shortDate(ctx.job.date))}.${ctx.quoteNo ? ` As quoted on ${esc(ctx.quoteNo)}${ctx.acceptedOn ? `, accepted ${esc(longDate(ctx.acceptedOn))}` : ''}.` : ''}</span></td>
            <td class="num">${plain(ctx.total)}</td></tr>
          ${ctx.alreadyPaid ? `<tr><td><b>Already paid</b><br><span style="color:#3B4A58;font-size:12.5px">Received with thanks.</span></td><td class="num">−${plain(ctx.alreadyPaid)}</td></tr>` : ''}
          ${ctx.notYetDue ? `<tr><td><b>Not due yet</b><br><span style="color:#3B4A58;font-size:12.5px">Invoiced separately${ctx.balanceDue ? `, due ${esc(shortDate(ctx.balanceDue))}` : ''}.</span></td><td class="num">−${plain(ctx.notYetDue)}</td></tr>` : ''}
        </tbody></table></div>` +
      totals(ctx, [...gstLines(ctx), ['Total job price', '$' + plain(ctx.total)],
        ...(ctx.alreadyPaid ? [['Already paid', '$' + plain(ctx.alreadyPaid)]] : []),
        ...(ctx.notYetDue ? [['Not due yet', '$' + plain(ctx.notYetDue)]] : [])],
        'Amount due', money(ctx.amountDue),
        `<b style="color:#14283A;font-size:12.5px">Due ${esc(longDate(ctx.dueDate))}</b><br>${gstNote(ctx)}`) +
      `<div class="fo-box strong"><div class="lbl">HOW TO PAY</div>
        <div class="fo-pay">
          <div>
            <div><span class="k">Account name</span><b>${esc(ready ? bank.accountName : '[ACCOUNT NAME]')}</b></div>
            <div><span class="k">Account number</span><b>${esc(ready ? bank.accountNumber : '[00-0000-0000000-00]')}</b></div>
            ${bank.bank || !ready ? `<div><span class="k">Bank</span><b>${esc(bank.bank || '[BANK]')}</b></div>` : ''}
          </div>
          <div class="sep">
            <div><span class="k sm">Particulars</span><b>FlatOut</b></div>
            <div><span class="k sm">Code</span><b>${esc(ctx.no)}</b></div>
            <div><span class="k sm">Reference</span><b>${esc(ctx.customer.surname || ctx.customer.name)}</b></div>
          </div>
        </div>
        <div style="font-size:11.5px;color:#3B4A58;margin-top:12px;line-height:1.5">Please use those three fields exactly — they are how we match your payment to your job. Bank transfer only; we do not take card payments.</div>
      </div>` +
      `<div class="fo-small"><b>If this is not paid by the due date</b> the job cannot go ahead, and we will let you know rather than sending contractors to a job we cannot pay for. Overdue amounts carry a $30 administration fee and interest of 2% per month on the outstanding balance — these cover what chasing late payment actually costs us and are not a penalty.</div>` +
      foot(ctx), ctx.voided);
  }

  function receipt(ctx) {
    return wrap(ctx, head(ctx) + title('RECEIPT') +
      parties(ctx, 'RECEIVED FROM', [
        ['Receipt no.', ctx.no],
        ...(ctx.invoiceNo ? [['For invoice', ctx.invoiceNo]] : []),
        ['Job no.', ctx.job.id], ['Issued', longDate(ctx.issued)]
      ], ctx.voided ? ['void', 'VOIDED'] : ['paid', 'PAID']) +
      `<div class="fo-note teal">
        <div class="ser" style="font-size:20px;font-weight:600">$${plain(ctx.received)} received, thank you.</div>
        <div style="font-size:13px;line-height:1.6;margin-top:6px;color:#2E3E4B">${ctx.outstanding > 0
          ? `Your move-out on <b>${esc(shortDate(ctx.job.date))}</b> is confirmed.`
          : `That settles your account in full. Thanks for using FlatOut.`}</div>
      </div>` +
      `<div style="margin-top:26px"><table>
        <thead><tr><th>PAYMENT RECEIVED</th><th style="width:150px">DATE</th><th class="num" style="width:130px">AMOUNT</th></tr></thead>
        <tbody><tr>
          <td><b>${esc(ctx.forWhat)}</b><br><span style="color:#3B4A58;font-size:12.5px">${esc(ctx.method)}${ctx.invoiceNo ? `, ref ${esc(ctx.invoiceNo)}` : ''}</span></td>
          <td>${esc(shortDate(ctx.receivedOn))}</td>
          <td class="num"><b>${plain(ctx.received)}</b></td>
        </tr></tbody></table></div>` +
      totals(ctx, [['Total job price', '$' + plain(ctx.total)], ['Paid to date', '$' + plain(ctx.paidToDate)]],
        ctx.outstanding > 0 ? 'Still to come' : 'Outstanding', money(ctx.outstanding),
        ctx.outstanding > 0
          ? `Due <b style="color:#14283A">${esc(longDate(ctx.balanceDue))}</b><br>We will send that invoice closer to the time.`
          : 'Nothing further owing.') +
      `<div class="fo-small"><b>${ctx.outstanding > 0 ? 'Still able to change your mind.' : 'Keep this receipt.'}</b> ${ctx.outstanding > 0
        ? 'You can cancel or reschedule at no cost up to 48 hours before the job, and anything paid is refunded in full. Within 48 hours we may keep up to 50% of the price, because the contractors have held the slot. '
        : ''}It is your proof of payment.</div>` +
      foot(ctx), ctx.voided);
  }

  const RENDER = { estimate, quote, invoice, receipt };

  return {
    TYPES,
    CSS,
    /* The one entry point. ctx is a snapshot — see data.js buildCtx. */
    render(type, ctx) {
      const fn = RENDER[type];
      if (!fn) throw new Error('Unknown document type: ' + type);
      return fn(ctx);
    },
    /* A whole standalone page, used for the frozen copy and the print
       view. Fonts are linked rather than embedded: if they fail to load
       the document still reads, in Georgia and the system sans. */
    page(title, bodyHtml) {
      return `<!doctype html>
<html lang="en-NZ"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Karla:wght@400;500;600;700&display=swap">
<style>body{margin:0;background:#EEF0F1}${CSS}</style>
</head><body>${bodyHtml}</body></html>`;
    },
    esc, money, plain, longDate, shortDate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Docs;
