# YouNMeSign

Send documents for signature, sign them, and keep a tamper-evident signed copy with a certificate. Built to run for $0 on
free tiers. (The project folder and database keep the old working name, EasySign.)

## Quick start on this PC (Windows)

1. **Start it:** double-click `Start-YouNMeSign.cmd` in `C:\Users\sande\Desktop\EasySign`. Two windows open (the website and the
   background worker) and then your browser at http://localhost:3000. Keep both windows open while you use it; close them to stop.
2. **Sign in or create an account** at http://localhost:3000. New accounts are approved by an administrator before they can send.
3. **Send a document:** *New document* → upload a PDF (or a PNG or JPG picture, which becomes a PDF) → add the people who sign → place the
   fields (Signature, Date, …) on the page → *Send*. Each person gets a personal link by email, or you copy the links yourself.
4. **Follow it:** the dashboard shows who has signed. When everyone has, the signed PDF and its certificate of completion are
   ready to download, and anyone can check a signed PDF at `/verify`.

Emails are **not really sent** on this PC: they are saved as files in `app\.dev-outbox` (setting `NOTIFY_MODE=log`). Real email
needs a few one-time steps (`docs\EMAIL_SETUP.md`) and your go-ahead.

## Where to find more

| You want to… | Read |
|---|---|
| use it (senders, signers, administrators) | `docs\USER_GUIDE.md` |
| connect another system (REST API, webhooks) | `docs\API.md`, and the live page `/developers` |
| run, check, back up or fix it | `docs\RUNBOOK.md` |
| know what it cannot do yet | `docs\KNOWN_LIMITATIONS.md` |
| see why things are the way they are | `docs\DECISIONS.md` |
| see where the project stands | `STATUS.md` (in the project folder) |

## Checking that everything works

In a command window in this folder (`app`), with the app and worker running:

```
npm run verify:phase4
```

It runs the type check, lint, unit tests, the free-limit check, the secret scan, the route tests, the database tests, a
production build and the accessibility audit, and ends with one line per check. Each feature also has its own end-to-end
check (`npm run e2e:...`, listed in the runbook).

## For developers

Next.js 16 (App Router) and React 19 in TypeScript; Supabase (Postgres with row-level security, Auth, Storage) on the free
plan; a separate Node worker (`npm run worker`) for sealing, email, reminders, bulk sends and webhooks; pdf-lib and a
PKCS#7 seal for signed PDFs. Secrets live only in `app\.env.local` (never committed; create it with `npm run setup:env`).
Database changes are migrations in `supabase\migrations`, with their tests in `supabase\tests` (`npm run test:sql`).
