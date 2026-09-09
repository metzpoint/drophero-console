# DropHero console

Static hosting for the DropHero **owner dashboard** (`index.html`) and **VA portal** (`va.html`).

## Why this repository is separate, and public

Supabase rewrites the response headers of anything served from its shared `*.supabase.co` domain:
`Content-Type` becomes `text/plain` and the CSP becomes `default-src 'none'; sandbox`. That is their
anti-phishing rule for the shared origin, it applies to Edge Functions and to public Storage objects
alike, and no setting inside either can opt out of it — so the dashboard rendered as source code
instead of as a dashboard. These two files are the same HTML served from an origin that does not
rewrite it.

GitHub Pages is free for public repositories only, which is why this one is public. The application
code, database migrations and history stay in the private `DropHero-Outreach` repository.

## What is and is not exposed here

These files contain the Supabase project URL and its **publishable** key. That key is designed to be
public — it is present in every Supabase browser app — and it grants nothing on its own:

- every table has row level security enabled, and an unauthenticated caller reads **zero rows** from
  all of them;
- every dashboard function checks that the caller is the owner, and every VA function checks the
  caller is that VA, before returning anything;
- signing up grants no access at all unless the address was invited beforehand.

So a stranger who opens this URL sees a login form and can get nothing else.

## Updating

Do not edit these files here. They are generated from the single source of truth in the private
repository and overwritten on the next build:

```
node scripts/build-console-pages.mjs --url https://<project>.supabase.co --key <publishable key>
```
