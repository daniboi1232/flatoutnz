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

## First things to do once it's live

1. **Enter your real contractor rates.** Contractors → each card → the
   rate table and **+ Add item**. The rate cards start empty on purpose
   — nothing in here is invented, and the walk-through can't produce a
   real price until the real prices are in it.
2. **Fill in contacts, phone numbers, job-order emails and insurance
   expiry dates** on each contractor.
3. Check the insurance dates flag correctly: "Renew soon" inside 60
   days, "Expired" after, "No certificate on file" when empty.

---

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

**Enquiries are typed in by hand for now.** Reading them straight from
the quote sheet is the next thing to add; when it arrives, only
`listEnquiries()` in `data.js` changes.

**Zoho is untouched.** The panel issues its own job order numbers and
records contractor responses itself. You do quotes, invoices and
payments in Zoho exactly as you do now, and tick the stage over here
when the money lands. Nothing in the panel needs a paid Zoho plan.
