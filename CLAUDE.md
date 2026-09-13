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

- [ ] **#1 — Railway rate limit** — Email Railway support to raise the Hikari per-IP rate limit on `/api/write`. Draft and send the support ticket. *(OVERDUE since 2026-09-04)*
- [ ] **#2 — Resend DNS** — Verify advancedsteeldrafting.com domain shows "Verified" in Resend dashboard. Check DNS records via lookup if possible. *(OVERDUE since 2026-09-06)*
- [ ] **#3 — UptimeRobot target** — Confirm UptimeRobot monitor is pinging `https://www.advancedsteeldrafting.com.au/api/health` (not root URL).
- [ ] **#4 — Remove SMTP env vars** — Delete SMTP_USER, SMTP_PASS, SMTP_HOST, SMTP_PORT from Railway environment variables (switched to Resend).
- [ ] **#5 — Delete OneDrive folder** — Delete `C:\Users\BEAST\OneDrive\Desktop\ASD - APP` (stale copy; active project is at `C:\Users\BEAST\Projects\ASD-APP`).

Mark each `[x]` when confirmed done. Claude must attempt each task autonomously before asking the user.
