# FlatOut Employees Panel

Internal tool for Daniel Bell and Rocky Lin. Not for customers, not for
contractors, not linked from anywhere public except one plain
"Employees" link in the site footer.

Live at **/panel** on flatoutnz.co.nz, behind a password. Data is stored
in **Netlify Blobs** — no separate database account, nothing to resume
after a quiet month.

---

## Setting it up

### 1. The password

Netlify → Site configuration → **Environment variables** → Add a
variable, twice:

| Variable | What it is |
| --- | --- |
| `PANEL_USER` | the username, e.g. `daniel` |
| `PANEL_PASS` | a long random password |

**Use a proper random password**, 20+ characters from a password
manager. Once this panel holds customer names, addresses and phone
numbers, that password is the only thing between them and the internet.

**Redeploy after adding or changing either one.** The edge function
reads them from the deployed environment, so a change does not take
effect until the next deploy.

If the variables are missing, the panel returns 503 and refuses to load.
That is deliberate: a misconfigured deploy must fail closed rather than
accidentally publishing the panel.

Both of you share one login. Separate logins would mean adding Supabase
Auth, which is a later decision.

### 2. Nothing else

Netlify Blobs needs no account, no keys and no configuration — it is
provisioned automatically. The first time the panel loads it writes the
six starting contractors and the five message templates, then never
seeds again.

`package.json` at the repo root exists only so Netlify installs
`@netlify/blobs`. The website itself still has no build step.

---

## Customers

**Customers** is a tab of its own. One record per person, with their
name, phone, email and which of the two they want to be contacted on.
A job points at a customer rather than carrying its own copy, so
**changing a phone number or email changes it on every job of theirs**,
and writes a line into each of those jobs' history.

Phone and email are two separate fields. The quote form only ever asks
for one of them, so a customer who chose email usually has no phone
number on file until you add one. Where that matters — they want email
and there is no email address — the panel says so rather than quietly
pointing at the wrong field.

**Customers appear on their own as you enter jobs.** "Add customer" is
there for someone who got in touch another way.

### Returning customers

When a pasted row or a typed-in number matches a customer you already
have, the panel says so before you save and offers to put the job on
their existing record. Matching is on **phone and email only** — never
the address, because students move every year and two flatmates share
one address while being two different people. A phone number matches on
its last eight digits, so `021 123 4567` and `+64 21 123 4567` are the
same person.

Their job page then shows "3rd job with FlatOut" and lists what they
had before, so you can price with that in front of you. There is no
automatic discount — that call is yours.

If there is already a job at the same address it says so separately.
That is usually two flatmates booking individually, which is fine; it
is flagged in case one whole-flat job has gone in twice.

### When one person ends up with two records

New number, a flatmate booking on their behalf, a maiden name. Open
either record and use **Same person as another record**. The jobs move
across, the notes are kept, and the record you merged away goes.

**A customer cannot be deleted** — only merged. A job pointing at a
record that has gone is exactly the kind of thing that breaks a page.

### Jobs entered before customers existed

Those jobs carry their customer's details inside them. The Customers
tab offers a one-off tidy-up: it builds a record for each person,
groups anyone sharing a phone or email, and shows you the whole list
before writing anything. Check the phone and email columns on that
list, then run it. It is the only thing in the panel that rewrites
records you already have.

## How a job runs

Eight stages. Every one of them you move yourself — nothing in here
talks to Zoho, so each button records something that already happened
somewhere else.

| Stage | What it means | What moves it on |
| --- | --- | --- |
| **New** | Entered from a quote request. Nothing owed, nothing sent. | Walk through the property and price it |
| **Scoped** | Priced, but the customer hasn't seen it. | Send the estimate from Zoho, then tick it here |
| **Estimate sent** | With the customer. | They accept — portal, email or phone |
| **Accepted** | They're in. | Confirm with contractors, send the formal quote from Zoho |
| **Quote sent** | Waiting on money. | The payment lands in Zoho |
| **Paid** | Money in, contractors not told yet. | Issue the job orders |
| **Job orders out** | Contractors have their orders. | They accept, do it, and you sign it off |
| **Done** | Signed off. | — |

A job can also be marked **lost**, **cancelled** or **on standby**, with
a reason. It keeps its record but drops out of the pipeline counts and
the attention list. You can reopen it later.

## Standby

For the flat that is doing it themselves but wants you on file in case
they need a last-minute clean. Put the job on standby and it goes quiet:
nothing owed, nothing chased, no contractor told, out of the pipeline and
off the attention list.

It stays on the calendar in grey — handy for spotting a parked flat on a
day you are already working nearby — and it can never cause a clash,
because nobody is booked.

**Nothing deletes itself.** There is no server ticking away: the panel
only does anything when one of you has it open. So on their move-out
date it appears on **Home** under "Needs you", marked *Coming up* rather
than urgent, saying the date has passed. From there:

- They rang and want it after all → **They got in touch — bring it back**.
  It returns to the stage it was at and asks for a new date, since the
  old one has almost certainly gone by.
- You never heard → **Mark cancelled**. The record is kept, as with any
  cancelled job.

Either way their name, phone and email are safe on the Customers tab
regardless, because customers are never deleted.

## Starting a job from a quote request

Walk-through tab → **New job**. Pick Tenant or Landlord, select the
whole row in Google Sheets, copy it, paste it in, and press **Read the
row**. It fills the form in for you to check.

It reads dates in several shapes — `13/11/2026`, `2026-11-13`,
`13 November 2026`, or the bare serial number Sheets uses when a cell
was never formatted as a date. Day/month order is read the New Zealand
way, so `3/4/2026` is the third of April. **Whatever it works out shows
in the form before anything is saved**, so a misread column is visible
rather than silently becoming a wrong job.

If the reference, phone or address matches a job you already have, it
says so and offers to open that one instead.

## Sending contractors their job orders

There is no vendor portal, so you send these yourself. On a job at
**Job orders out**, each contractor has a **Copy the job order to send**
button. That gives you the address, date, what's needed, access notes,
what you're paying and the PO number — and deliberately no customer
name, phone or email, because you arrange access and they never need
them.

Then record what they told you: **They accepted**, **They declined**
with a reason, or **No reply**. A no-reply adds a strike. Three
unexplained silences gets flagged, but the panel never drops a
contractor by itself.

## First things to do once it's live

1. **Enter your real contractor rates.** Contractors → each card →
   **+ Add item**. The rate cards start empty on purpose — the
   walk-through can't produce a real price until the real prices are in
   it.
2. **Fill in contacts, phone numbers, job-order emails and insurance
   expiry dates** on each contractor.
3. Check the insurance dates flag correctly: "Renew soon" inside 60
   days, "Expired" after, "No certificate on file" when empty.

## Getting your data out

**Jobs**, **Customers** and **Contractors** each have an **Export to
spreadsheet** button. They download as CSV, which opens straight in Excel or Google
Sheets.

Worth knowing: a spreadsheet flattens things, so a job's individual line
items become one summary column. It is for reading, records and your
accountant — **not a file you could restore the panel from**.

## Changing things after the fact

**Edit details** on a job header changes the address, date, reference,
number of people and what they told you. The customer's name, phone and
email are not here — those live on their customer record, because
changing them should change every job of theirs.

**Moving the date** moves the payment dates with it. If a contractor is
already holding a job order, the panel says who, both before you save
and in the job's history. It cannot tell them; you have to.

**Put it back to <stage>** under the next action undoes a stage ticked
by mistake. Nothing else is undone and the correction is written into
the history.

**Something changed — re-issue this order** on a job order supersedes it
and sends a fresh number to the same contractor, with their reply window
started again. No strike: this is your correction, not their silence.
Change the items or the date first, then re-issue. To move the work to a
*different* contractor, use the replace flow on a declined order instead.

## Prices stop moving once you quote

A job is priced from the contractor's rate card, and rate cards change.
So **sending the estimate takes a copy of every rate the job uses**, and
from then on that job is priced from its own copy.

Without this, putting GECS's hourly rate up would quietly rewrite what
every past job says it cost — including ones already quoted, accepted
and paid.

While a job is still being priced it follows the live rate card, which
is what you want. After it is locked the owner breakdown says
"Prices locked" with the date, and there is a **Re-price at today's
rates** link for when a contractor's price genuinely changes before the
customer accepts. That one tells you what the customer was already
quoted, because if it moves you need to tell them.

## Today

A tab for the morning: what is on today and tomorrow, which contractors
are meant to be there, and whether they have actually confirmed. Phone
numbers are tap-to-call. Jobs whose orders haven't gone out are flagged
in red.

## Seeing each other's work

The panel re-checks the server every 45 seconds and when you switch back
to the tab, so Rocky's changes turn up without a reload.

It never redraws while you are in the middle of something: not with a
form open, not while you are typing, and not while one of your own saves
is still going. If the job you have open is the one that changed, a bar
appears at the top saying so and you tap it when you are ready, rather
than the page changing under you.

## Documents and the customer's page

Four documents, issued from the job: **estimate**, **quote**,
**invoice**, **receipt**. Each type has its own number run (EST-, QTE-,
INV-, REC-) that counts up and never restarts.

**An estimate needs almost nothing.** A name, a phone number or email,
and a price. No address and no date — because an estimate is what you
send after a phone call, before you have been anywhere. The document
adjusts: it says you have not seen the property, offers to come and
look, and states the payment rule instead of inventing due dates.

A **quote, invoice or receipt** does need the address and the date.
Those are firm documents and one without a property or a day on it is
not worth much. Add them with **Edit details**, and Home nudges you
about any priced job still missing them.

**Estimates and quotes are itemised.** Every line the customer pays for
has its own price — "Bedroom clean × 4 · 437.00" — and the lines always
add up to the figure at the bottom. The line prices are the customer's
prices, margin already in them; contractor rates never appear on
anything that leaves the building, and nor do the site notes you write
for contractors.

One thing to know: your terms page says prices are "a single all-in
figure". That is still true of what they pay, but the documents now
show the breakdown behind it. Worth a look at that wording next time
you touch the terms.

**Download PDF** is on every document, in the panel and on the
customer's page. It opens the browser's print dialog — choose "Save as
PDF" as the destination. The file is named for you: *FlatOut Quote
QTE-0014.pdf*. The documents are laid out to come out as one clean A4
page with nothing of the browser on it.

**Issuing moves the stage.** Sending the estimate puts the job at
Estimate sent; issuing a quote once they have accepted puts it at
Quote sent. One action, not two. A quote issued before they have
accepted leaves the stage alone, because nothing has been accepted yet.

**Issued means frozen.** The moment you issue something, the exact
document — its wording, its figures, its stylesheet — is stored. What
the customer opens in six months is what you sent, whatever has changed
since: the rate card, the terms, the logo, the code. That is the point.

**A wrong document is never edited.** Void it, and it keeps its number
and stays visible with a VOIDED stamp, or use **Void and replace** to
issue a corrected one in the same move. Nothing disappears.

### The customer's page

One link per job, at `/j/#<token>`, plus a **4-digit code you text them
separately**. The code is on the job in the panel so you can re-send it
in a tap, and their phone remembers it so they type it once.

They see: their documents, where the job is up to, what is paid and what
is left, and the completion photos once the job is signed off. They can
accept their quote there, which records who accepted what and against
which version of your terms.

They never see contractor costs, your margin, rate cards, your notes or
the job's history. **Contractor names appear only from the morning of
the job onwards** — before that it says "Cleaning crew, being
confirmed". Your supplier list is the one thing a competitor would most
like, and students talk to each other.

After eight wrong codes the page locks. Give them a new code from the
job and text it to them.

**The quote's Accept button stops on its valid-until date.** The page
stays readable — they can still see what they were quoted — but a
document that says "valid until the 23rd" must not still be acceptable
in March.

### Money

Recorded by hand: you read your bank, press **Mark received**, and the
receipt is issued and appears on their page. The panel tells you on Home
when an invoice is due or overdue, and when it is time to send the
balance invoice. Nothing reaches a customer without you pressing
something.

### Before any of this works

**Settings → Bank account.** Estimates and quotes work without it;
invoices and receipts refuse to be issued until it is filled in, because
an invoice nobody can pay is worse than no invoice. Check it character
by character.

**Settings → GST** is off, and every document says plainly that no GST
is charged and that an invoice is not a tax invoice. You must register
once turnover passes $60,000 in any twelve months — turn the switch on
then, and new documents carry the GST lines, the number and the words
"Tax Invoice". Documents already issued are frozen and stay as they
were, which is correct.

**Settings → Terms version.** Bump it whenever you change the terms
page. Each acceptance records which version the customer actually saw.

## Getting around

**The back button works inside the panel.** Every tab and every job
you open gets its own address, so Back goes Job → Jobs → Home and only
leaves the panel once you are already at Home. Swipe-back on a phone
does the same thing.

**Every screen has a link.** `/panel/#jobs/J-1004` opens that job
straight away — handy for sending Rocky a job rather than telling him
where to find it. A link to a job that has since gone falls back to the
jobs list rather than a blank page.

**The logo goes Home**, and the **Website** link opens the public site
in a new tab so it never navigates the panel away from under you.

## Money

A tab of its own, with two things kept apart on purpose.

**Work done** is by job date: what customers were charged that month,
what the contractors cost, and what you kept. **Cash in** is by the day
a payment actually landed. They never match — a deposit arrives before
the job and the balance a fortnight after — and a single number
pretending otherwise would be wrong both ways.

**Still owed** lists every invoice issued and not yet paid, oldest job
first, with anything past its job date in red.

The "you kept" figure is before your own time, fuel, phone and
anything you refund. It is the margin, not the profit.

## The day before

Jobs happening tomorrow appear on **Home** with the messages already
written: one for the customer, one for the crews. Copy and send. A crew
that hasn't confirmed is flagged in red — ring those rather than
texting.

## Signing off

A job cannot be signed off while money is still owing. You can override
it — sometimes you have agreed something — but it has to be a decision,
and it goes in the job's history either way. Sign-off is the last time
anyone looks at a job, so a balance left there is a balance that never
gets chased.

## Backing it up

**Settings → Backup → Download a backup.** Everything in the panel
lives with the Netlify site and nowhere else: one wrong setting and
there is no copy anywhere. This takes a complete one — every job,
customer, contractor, document, payment and setting — as a single file.

Unlike the spreadsheet exports, this is a file you could actually
restore from. **Keep it somewhere that is not Netlify.** Do it before
November, and again whenever you have done a solid week's work.

**Restore** replaces everything currently stored. There is no undo, so
it asks you to type the word first.

## How to remove the whole thing

1. Delete the `panel/` folder and `site/j/`.
2. Delete `netlify/` (the edge function and both serverless functions).
3. Delete `package.json` from the repo root.
4. Remove the footer "Employees" links from the site pages.
5. In Netlify: delete the `PANEL_USER` and `PANEL_PASS` environment
   variables.

The website is then exactly as it was. Nothing else touches the panel:
no page links to it apart from the footer, `sitemap.xml` doesn't list
it, `_redirects` doesn't mention it, and `css/site.css` is not used by
it — the panel carries its own copy of the colour tokens on purpose, so
the website's stylesheet and the panel can change independently.

The only shared files are `/fonts/fraunces-600.woff2`,
`/fonts/karla-variable.woff2` and `/images/logo-icon.png`. Those belong
to the website and stay.

**Deleting the panel does not delete the stored data.** Blobs live with
the Netlify site, not in the repo. To clear them, delete the
`flatout-panel` store from the Netlify dashboard.

---

## What's here

| File | What it does |
| --- | --- |
| `panel/index.html` | the whole interface |
| `panel/data.js` | every read and write, and nothing else |
| `panel/docs.js` | how the four documents are drawn |
| `site/j/index.html` | the page the customer opens — no password |
| `netlify/functions/panel-data.js` | storage — the only thing that touches Blobs |
| `netlify/functions/panel-public.js` | the customer's endpoint, outside the gate |
| `netlify/edge-functions/panel-auth.js` | the password gate |
| `package.json` | so Netlify installs `@netlify/blobs` |

`index.html` never touches data directly. Every read and write goes
through a function on `Data` in `data.js`, which calls the storage
function. If the panel ever outgrows Blobs, `data.js` is the only file
that changes.

---

## How the data is stored

One blob per record, keyed by id:

```
job/J-1001           one job
customer/mere-harris one customer and how to reach them
document/D-xyz       one issued document, frozen as it was sent
acceptance/J-1001    that the customer accepted their quote
portal/J-1001        wrong-code count for the customer's page
contractor/gecs      one contractor and their rate card
template/estimate    one message template
alert/<id>           one alert
settings             alert preferences for both owners
photo/<id>           an uploaded image
```

One blob per record rather than one big blob of everything, **so that
you and Rocky editing two different jobs cannot overwrite each other.**
With a single "jobs" blob, whoever saved last would silently wipe the
other's work, and that would happen exactly when you are both busy.

Job numbers and PO numbers are worked out from what already exists
rather than from a stored counter, so a stale counter can't hand two
people the same number.

---

## Things worth knowing

**Changes save as you make them.** The indicator in the header says
"Saved", "Saving…", or "Not saved — retrying". If it says the last one,
your change is safe in the browser but hasn't reached the server; it
keeps retrying and goes back to "Saved" when it gets through. **Don't
close the tab while it says that.**

**Rocky's changes arrive on their own** — see "Seeing each other's
work" above. You still each hold your own copy between refreshes, so a
change you both make to the same job in the same minute is last-write-
wins on that record.

**Photos are downscaled in the browser before upload** — to 1600px on
the long edge — so a 4MB phone photo arrives as a few hundred KB. They
are served back through the same password, so they never become public
URLs.

**Basic auth has no logout button.** Close the browser, or use a private
window.

**Enquiries are pasted in from the sheet.** Reading them automatically
is the next thing to add; when it arrives, only `listEnquiries()` in
`data.js` changes.

**Home shows what needs you**, worst first — contractors past their
reply date, money due or overdue, a job tomorrow where someone hasn't
confirmed, anything finished and waiting to be signed off, and jobs that
are nearly due and still unscoped.

**Zoho is untouched.** The panel issues its own job order numbers and
records contractor responses itself. You do quotes, invoices and
payments in Zoho exactly as you do now, and tick the stage over here
when the money lands. Nothing in the panel needs a paid Zoho plan.

---

## The one thing without a password

`/j/` and `/j/api` sit outside the password gate, because the customer
is not logging in. Everything protecting them is in
`netlify/functions/panel-public.js`, and it is deliberately narrow:

- It answers exactly two questions: *show me this one job* and *I accept
  this quote*. It cannot list, search, or reach anything else.
- It builds its answer field by field rather than handing back a record
  with bits removed, so a field added to a job later cannot leak through
  it by accident.
- **It never writes a job.** The two things it records — that someone
  got in, and that they accepted — go in blobs of their own. The panel
  holds jobs in memory and saves them whole, so a write there could be
  wiped by the next save from the panel; and an unauthenticated writer
  should not be able to touch the record that holds everything.
- The token is the real secret. The code is a second channel, not a
  password, so wrong codes are counted and the page locks.

If you ever change that file, those four things are the reason it is
written the way it is.
