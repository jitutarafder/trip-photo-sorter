# CLAUDE.md — Trip Photo Sorter

On-device iOS-first React Native (Expo) app: detects trips from the photo library, groups faces locally, exports one ZIP per person. **No backend, no accounts, no uploads.**

## Mandatory Workflow
1. **Before ANY task, read all six files in `/docs` in order:** `01_PRD.md`, `02_AppFlow.md`, `03_UI_Spec.md`, `04_TRD.md`, `05_Schema.md`, `06_Plan.md`.
2. Work on **only the first unticked task** in `06_Plan.md`. Do not skip ahead or batch tasks.
3. After finishing: run `npm run check` (tsc + eslint + jest). Fix failures before continuing. Then make **one git commit**: `task <id>: <summary>`.
4. **Update `docs/06_Plan.md`**: tick the box and add a line to Progress Log (`date | task id | note`). If blocked, mark `[!]` with the reason.
5. Stop and summarise what changed, what to test on device, and any decision needed.

## Hard Rules
- **Public repo = no personal data.** Never commit photos, face crops, embeddings, or eval labels. `eval/` stays gitignored.
- Phase 0.5 (spike) must PASS its gate (task S.4) before any Phase 1+ work. If it fails, stop and report.
- **$0 budget.** Never add or suggest anything that costs money (paid accounts, services, APIs, EAS paid tiers, store fees). If a task seems to need it, stop and ask.
- Docs are the source of truth. If code and docs disagree, or a request conflicts with a doc, **stop and ask**; update the doc first, then code.
- Never add libraries, change versions, or add features outside `04_TRD.md` / `01_PRD.md`. Anything in PRD §7 Non-Goals is forbidden.
- No network calls for photos/faces/embeddings. `fetch`/`axios` only allowed in `src/services/purchases.ts`.
- Never write to, edit, or delete the user's gallery.
- All SQL lives in `src/db/repositories/`. Schema changes = new migration file + update `05_Schema.md`.
- No hard-coded colours/sizes/fonts: use `src/theme/tokens.ts`.
- Routes in `app/` stay thin; logic in `src/services` and `src/domain`.
- TypeScript strict; no `any` without a justifying comment. Domain code is pure and unit-tested.
- Temp ZIPs must be deleted on every exit path.
- Do not log embeddings, file paths with personal names, or photo contents.
- Install packages with `npx expo install`, never guess versions.

## Environment Notes
- Developer uses Windows + iPhone. Native changes require a new GitHub Actions iOS build + Sideloadly install (free Apple ID, 7-day re-sign); Expo Go is not sufficient. Tell the user when a task needs a new build.
- Prefer small, reviewable diffs. Ask before large refactors.

## Commands
- `npm run check` — typecheck, lint, test (must pass before ticking a task)
- `npx expo start --dev-client` — run with the development build
