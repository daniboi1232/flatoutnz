# FlatOut NZ website — rules for Claude

Static HTML/CSS site for FlatOut NZ (flatoutnz.co.nz), hosted on Netlify and
deployed on every push to `main`. No build step.

## SEO work: what may change, and how it goes live

### Plumbing — may be pushed straight to `main`
Changes Google reads but customers don't read as copy:
- `<title>`, meta description, canonical, Open Graph and Twitter tags
- JSON-LD structured data
- `_redirects`, `netlify.toml` redirects, `robots.txt`, `sitemap.xml`
- image `alt` text, internal link targets, removing stray/duplicate files

Before pushing, confirm the visible text of every changed page is identical
to before (strip `<head>`, `<script>`, `<style>` and compare). If it isn't,
it is not plumbing — treat it as a copy change.

### Copy — pull request only, never pushed to `main`
Anything a visitor reads on the page: headings, body text, buttons, FAQ
answers, new pages. Open a pull request and wait for Dan to merge it.

## No new promises to customers
Never add, in copy OR in structured data / meta descriptions:
- prices, price ranges, discounts or "free" claims beyond what the site says
- turnaround or response times, availability, guarantees ("bond back
  guaranteed", "100%", "same day")
- reviews, ratings, testimonials, customer or job counts, statistics
- endorsements or partnerships (no UC, UCSA or UniLodge claims)
- contractor names other than the ones already on the site
- service areas, services or hours not already stated on the site

New content may only restate facts already on the live site. If something
would need a new fact, leave it out and ask Dan.

Contractors that must never be named publicly: GECS, Happy Helpers.

## Facts used in structured data (all already on the site)
- Name: FlatOut NZ (alternate: FlatOut) — a partnership, NZBN 9429053975751
- Phone +64 27 408 6895, email admin@flatoutnz.co.nz
- Area: Christchurch — Ilam, Riccarton, Upper Riccarton, Addington
- Services: moving, end-of-tenancy cleaning, rubbish removal, storage

## Don't touch without being asked
- `panel/`, `j/`, `netlify/`, `google-apps-script.js` (the employees panel,
  customer job pages and the form endpoint)
- the quote form's fields — they map to columns in the Google Sheet
