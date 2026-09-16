# ASD App — Claude Standing Instructions

## Rules (apply every session, no exceptions)

1. **Pre-deploy audit** — Before every deploy: check race conditions, stale closures, event leaks, missing preventDefault, async races across the full codebase.
2. **Data loss audit** — Before every deploy: run 5-point data loss checklist (skipFirstWrite guard, snapshot replace, setDoc collision, _updatedAt stamps, empty-array-wins bug).
3. **Security audit** — After every code change: run 5-point security checklist (XSS/esc(), auth gates, data exposure, SRI, input validation). Show results explicitly.
4. **Deploy both branches** — Every build goes to `main` (Railway) AND `gh-pages`. No exceptions.
5. **Build → Deploy → Test** — Verify live site works before reporting done.
6. **Diagnose before fixing** — Read everything, list ALL causes, eliminate wrong ones, then fix.
7. **Permanent solutions only** — Never workarounds.
8. **Re-entrancy check** — Before every async function, explicitly consider re-entrancy.
9. **Data structure integrity** — Every time a new array is stored in `usePersistentState`, or a new item type is added to an existing one: (a) object items MUST have a stable `id` field (`Math.random().toString(36).slice(2,9)` on creation), OR (b) plain strings are already safe (string-key merge logic). Missing `id` fields cause the in-flight merge to silently produce empty arrays — concurrent adds from other devices get wiped on next reconciliation. Check ALL `usePersistentState` array keys in the file when adding any new one.
10. **Show all checklists explicitly** — Run the data loss audit, security audit, and pre-deploy audit before every deploy. Show results for each, numbered, explicitly. Never say "looks clean" without showing the checklist.

## ⚠ OPEN TASKS — tick these off one by one

These must be shown at the start of every session until completed.
It is Claude's job to proactively work on completing each one.

- [x] **#1 — Railway Hikari bot-detection** — RESOLVED 2026-09-15. User disabled "Under Attack Mode" in Railway. `/api/health` now returns 200 OK, rate429LastMin=0, errorsLastMin=0, 135/135 writes OK. Pro Workspace also confirmed active.
- [ ] **#2 — Resend DNS** — DNS records for advancedsteeldrafting.com are MISSING as of 2026-09-16. Zone EXISTS in Google Cloud DNS (ns-cloud-d1-4.googledomains.com, SOA serial=5, has SPF TXT) but is NOT accessible under raj@advancedsteeldrafting.com — not in ASD tracker, ASD Portal, or My First Project, and not in Squarespace. Zone was set up under a DIFFERENT Google account (probably personal gmail). **User must**: (1) identify which Google account set up the DNS, (2) log into GCP Console with that account, (3) go to Network Services → Cloud DNS → advancedsteeldrafting.com zone, (4) add 3 records: DKIM TXT `resend._domainkey` → `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7iM4JApNd5oc7jVDU3ZqA1R4uVaXR+n8q/zwSuPKqupZ5xpxJblAFivTVPxZFvAzP4/gDT8NgLlJR2VO2RkrDzxDFgaKu3c3sUGfePKScSUwNAUz2s6Ir8xDIh0rSWg2tfL+Q7ggjujSr0NwWoBAeSWlxlgss7lkw5WmM6GyGWQIDAQAB`, CNAME `rsend` → `rsend-apne1.forge.rmta.net`, CNAME `send` → `send.forge.rmta.net`; (5) click "Restart verification" in Resend. *(OVERDUE since 2026-09-06)*
- [ ] **#3 — UptimeRobot target** — Confirm UptimeRobot monitor is pinging `https://www.advancedsteeldrafting.com.au/api/health` (not root URL). Task #1 (Hikari) is now resolved so UptimeRobot should be returning UP if pointed at the correct URL.
- [x] **#4 — Remove SMTP env vars** — Confirmed 2026-09-15: SMTP_USER, SMTP_PASS, SMTP_HOST, SMTP_PORT are NOT present in Railway env vars (only 15 vars, none are SMTP). Already done.
- [ ] **#5 — Delete OneDrive folder** — Delete `C:\Users\BEAST\OneDrive\Desktop\ASD - APP` (stale copy; active project is at `C:\Users\BEAST\Projects\ASD-APP`).

Mark each `[x]` when confirmed done. Claude must attempt each task autonomously before asking the user.
