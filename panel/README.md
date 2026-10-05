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

A job can also be marked **lost** or **cancelled**, with a reason. It
keeps its record but drops out of the pipeline counts and the attention
list. You can reopen it later.

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

**Jobs** and **Contractors** each have an **Export to spreadsheet**
button. They download as CSV, which opens straight in Excel or Google
Sheets.

Worth knowing: a spreadsheet flattens things, so a job's individual line
items become one summary column. It is for reading, records and your
accountant — **not a file you could restore the panel from**.

## How to remove the whole thing

1. Delete the `panel/` folder.
2. Delete `netlify/` (the edge function and the storage function).
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
| `netlify/functions/panel-data.js` | storage — the only thing that touches Blobs |
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

**You won't see Rocky's changes until you reload**, and he won't see
yours. At two people and a few jobs a week that is fine. If it starts
causing confusion the fix is a periodic refresh.

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
