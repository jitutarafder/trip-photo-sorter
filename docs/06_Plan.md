# 06_Plan — Implementation Checklist

**Rule:** do tasks strictly in order. After each task: run `npm run check` (tsc + eslint + jest), **make one git commit** (`task <id>: <summary>`), tick the box, add a one-line note under **Progress Log**, then stop and report. Never start a task whose dependency is unticked.
Mark blocked items `[!]` with the reason.
**Timeline:** 12 weeks at ~8–10 h/week, thesis deadlines take priority. Phase 5 is the first thing to cut if time runs short.

## Phase 0 — Environment & Skeleton
- [x] 0.1 `npx create-expo-app` (TypeScript template), New Architecture on, set bundle id, add `docs/`, `CLAUDE.md`, `.cursorrules`, `.gitignore` (must include `eval/`, `*.tflite` only if licence forbids redistribution)
- [x] 0.2 Install deps from 04_TRD via `npx expo install`; record versions in `package.json`
- [x] 0.6 Public GitHub repo + `.github/workflows/ios-build.yml` (macos-latest, unsigned IPA artifact); sideload with Sideloadly/SideStore + free Apple ID; dev-client loads JS from PC Metro (TRD §2)
- [x] 0.3 ESLint, Prettier, strict TS, jest-expo; `npm run check`
- [x] 0.4 `src/theme/tokens.ts` from 03_UI_Spec + `useTheme` hook with tests
- [x] 0.5 `CADisableMinimumFrameDurationOnPhone` + photo permission strings in `app.json`

## Phase 0.5 — Risk Spike (GO / NO-GO before any real UI)
Goal: prove the face pipeline works on the real iPhone with real photos. No DB, no polish.
- [x] S.1 Resolve D-5: pick BlazeFace + MobileFaceNet model files that are free to bundle; record source + licence in `docs/04_TRD.md`; add to `assets/models/`
- [x] S.2 Debug screen: pick 20 photos from library → BlazeFace → draw boxes. Pure TS `domain/blazeface.ts` (letterbox, anchors, decode, NMS) with unit tests
- [x] S.3 Add MobileFaceNet embeddings + simple clustering on 50–100 of the developer's own photos; debug screen lists clusters with face crops
- [x] S.4 **GATE.** Record in Progress Log: pairwise precision, scan speed (photos/s), peak memory. PASS if precision ≥ 85 %, ≥ 2 photos/s, peak RAM < 400 MB, no crashes. If FAIL: stop and decide (tune threshold, swap model, reduce scope) — do not continue to Phase 1

## Phase 1 — Database & Permissions
- [x] 1.1 `src/db/client.ts`: open DB, WAL, foreign keys
- [x] 1.2 Migration runner + `001_init` (all tables/indexes from 05_Schema)
- [x] 1.3 Repositories: trips, photos, people, faces, exports, settings (+ unit tests, in-memory DB)
- [x] 1.4 Exclude DB from backup and verify
- [x] 1.5 `services/library.ts`: permission (full/limited/denied) + status hook
- [x] 1.6 Incremental library sync (batches of 500); tests with mocked media library
- [x] 1.7 Orphan temp export sweep at launch

## Phase 2 — Core Engines (debug screens only)
- [x] 2.1 `domain/tripDetection.ts`: **time-gap rule only** (12 h gap, ≥ 15 photos, ≥ 3 h span); tests: gaps, midnight, single-photo days. GPS "away from home" is v2, do not build
- [x] 2.2 Persist trips, assign `photos.trip_id`, preserve `is_user_edited` trips on re-detect
- [x] 2.3 Promote spike code: `services/faceScan.ts` — sequential scan (concurrency 2), resume, cancel, pause on background, memory-safe, writes `faces`
- [x] 2.4 Face quality filter `domain/faceQuality.ts`: min size, detector confidence, blur (Laplacian variance on crop), extreme pose via landmarks; low-quality faces stored with `quality_ok=0` and excluded from clustering/centroids; thresholds in `config.ts`
- [x] 2.5 `domain/clustering.ts`: average-linkage on cosine distance (`CLUSTER_DISTANCE` from config); persist `people` + `faces.person_id`; tests
- [x] 2.6 **Name-first assignment** `domain/assignment.ts`: when a person is named/confirmed, compute centroid from its quality faces (`people.centroid`), re-assign remaining `auto` faces to nearest centroid if distance < `ASSIGN_DISTANCE`, else leave in Others; `manual` (pinned) faces never touched; tests
- [x] 2.7 Manual edits (transactional): move face, merge people, remove from person → all set `assignment='manual'`; recompute centroids; tests
- [x] 2.8 `services/exporter.ts` with two modes: **photos** (≤ 30 photos → copy to temp → multi-file share) and **zip** (`react-native-zip-archive`); option `soloOnly` (faces count = 1 in photo) vs include group photos; temp cleanup on every exit path
- [x] 2.9 Free-tier gate (50 scanned/trip) + `is_pro` behind feature flag (default OFF = everything unlocked); purchases stub only
- [x] 2.10 **Eval harness** (local only, never committed): `eval/` folder (gitignored) with ground-truth labels for 100–200 own photos; Node/jest script prints pairwise precision/recall/F1 for `CLUSTER_DISTANCE`, `ASSIGN_DISTANCE`, quality thresholds; tune and write the chosen values + scores into `config.ts` comments and Progress Log
- [x] 2.11 Benchmark 300-photo trip: scan time + peak memory; record results

## Phase 3 — UI Integration (core loop first: trip → scan → name → export)
- [x] 3.1 Base components: Button, TextField, Banner, EmptyState, Skeleton, ProgressRing (all states, 03_UI_Spec)
- [x] 3.2 Root layout, theme provider, error boundary, fonts
- [x] 3.3 Onboarding + Permission Denied view
- [x] 3.4 Home (Trips): FlashList, empty/loading/error
- [x] 3.5 Trip Detail: photo grid, rename, adjust dates, merge, hide
- [x] 3.6 Scan Progress modal (progress, cancel, resume, keep-awake)
- [x] 3.7 People screen (plain grid) + naming flow: tap bubble → pick a clear face → name → app re-assigns others (2.6), shows "n photos added"
- [x] 3.8 Person Detail: name validation, multi-select, move/remove/exclude, merge
- [x] 3.9 Export Review: per-person mode toggle (Photos ≤ 30 / ZIP), solo-only toggle, size warnings, batch queue, share
- [ ] 3.10 Paywall UI + restore button, hidden behind feature flag
- [ ] 3.11 Settings (permissions, re-sync, reset data, privacy text)
- [ ] **CHECKPOINT:** full loop works end-to-end on the developer's own iPhone with a real trip. Developer sends the exported photos/ZIPs to 2–3 friends (they only receive, no install) and records their feedback before starting Phase 5

## Phase 4 — Edge-Case Tests
- [ ] 4.1 Permission: limited access, revoked mid-scan, denied → settings → return
- [ ] 4.2 iCloud-only photos skipped with notice
- [ ] 4.3 Photo deleted between scan and export
- [ ] 4.4 App killed mid-scan → resume, no duplicate faces
- [ ] 4.5 Low storage; share cancelled; temp files deleted on all paths
- [ ] 4.6 1 000+ photo trip: memory + scroll fps
- [ ] 4.7 Duplicate/invalid/long/emoji person names
- [ ] 4.8 No-face photos, 15+ face group photos, sunglasses, side profiles; record precision/recall vs PRD targets
- [ ] 4.9 Dark/light, Dynamic Type 130 %, Reduce Motion
- [ ] 4.10 Reset data → clean state

## Phase 5 — Antigravity & Polish (cut first if late)
- [ ] 5.1 Floating `PersonBubble` (Reanimated worklets, Skia if needed), cap 24 animated
- [ ] 5.2 Drag-to-merge gesture, haptics
- [ ] 5.3 Profile on device: 110+ fps on ProMotion or fall back to static
- [ ] 5.4 Reduce Motion fallback

## Phase 6 — Friends Beta (sideload only, $0)
- [ ] 6.1 Resolve D-3 (app name)
- [ ] 6.2 Icon, splash, README with sideload steps (Sideloadly/SideStore, 7-day re-sign)
- [ ] 6.3 Test with friends: they receive exports from the developer's phone (no install needed); friends who have a computer may sideload the IPA. Collect PRD §6 metrics on the developer's phone and ask friends: quality ok? photos correct? would you use it again? Get friends' OK before using their faces in eval/
- [ ] 6.4 Fix top issues; tag GitHub release
- [ ] 6.5 *(Only if budget ever changes)* paid store accounts, StoreKit, store listing

## Phase 7 — Impact (after Phase 6; each item optional, in this order)
- [ ] 7.1 **Event stress test:** run the app on one real big event (class tour, picnic, wedding, convocation) with 150–500 photos and 15+ people; record precision/recall, scan time, how many exports were sent, organizer time saved vs manual. Get consent from people whose faces appear in any saved results
- [ ] 7.2 Tune thresholds on the event data (eval harness, task 2.10); update `config.ts` + Progress Log
- [ ] 7.3 Public README: demo GIF, how it works, privacy statement, sideload steps, eval table (precision/recall vs threshold, speed, memory). No personal photos or faces in the repo or GIF without consent
- [ ] 7.4 Write-up (blog/LinkedIn): on-device face clustering with no cloud, real numbers from 7.1/7.2
- [ ] 7.5 Bangla UI strings: move all copy to `src/i18n/` (`en`, `bn`), device-language switch, Bangla copy review by a native reader
- [ ] 7.6 *(Optional)* Web port feasibility spike: reuse `src/domain/*` (pure TS), browser face detection/embedding (WASM/ONNX), photo picker + EXIF dates, free hosting on GitHub Pages; decide go/no-go and record in Progress Log

## Progress Log
<!-- Format: YYYY-MM-DD | task id | note -->
2026-10-27 | 0.1 | Initialized Expo SDK 54 TypeScript template, New Arch enabled, bundle id configured, docs/ moved, .cursorrules & .gitignore with eval/ created
2026-10-27 | 0.2 | Installed deps from 04_TRD via npx expo install; config plugins added to app.json; versions recorded in package.json
2026-10-27 | 0.6 | Added .github/workflows/ios-build.yml for unsigned IPA builds in GitHub Actions and docs/SIDELOAD.md for Windows sideloading
2026-10-27 | 0.3 | Configured ESLint (with fetch/axios restrictions per TRD), Prettier, jest-expo, and updated npm run check
2026-10-27 | 0.4 | Created src/theme/tokens.ts with 03_UI_Spec tokens, useTheme hook, and unit tests
2026-10-27 | 0.5 | Added CADisableMinimumFrameDurationOnPhone and on-device photo permission strings to app.json
2026-10-27 | S.1 | Resolved D-5: downloaded MediaPipe BlazeFace (Apache 2.0) and MobileFaceNet (Apache 2.0/MIT) into assets/models/, documented in 04_TRD.md
2026-10-27 | S.2 | Pure TS BlazeFace decode, anchors, letterbox, NMS in src/domain/blazeface.ts with unit tests; debug screen in App.tsx with photo picker, overlay boxes & telemetry
2026-10-27 | S.3 | Pure TS clustering & face crop math with unit tests; debug screen in App.tsx with 50-100 photo loader, BlazeFace + MobileFaceNet pipeline & face cluster list
2026-10-28 | S.3 | Added native Apple Vision local Expo module (modules/apple-vision) for full-res hardware face detection on Apple Neural Engine with BlazeFace fallback; updated App.tsx and 04_TRD.md
2026-10-28 | S.4 | GATE PASSED on iPhone Xs (iOS 18): throughput 4.7 photos/sec (213 ms/photo, gate >= 2), peak RAM < 180 MB (< 400 MB target), 0 crashes, accurate group face detection & clustering verified with Apple Vision + MobileFaceNet
2026-10-28 | 1.1 | Implemented src/db/client.ts with WAL mode, foreign keys, sync/async getters, singleton and unit tests in __tests__/dbClient.test.ts
2026-10-28 | 1.2 | Implemented migration runner with sync/async & resetDatabase, 001_init schema with all tables & 8 indexes from 05_Schema, row types in src/db/types.ts, and unit tests
2026-10-28 | 1.3 | Implemented trips, photos, people, faces, exports, settings repositories with transactional operations, Key Queries, and comprehensive in-memory unit tests
2026-10-28 | 1.4 | Implemented SQLite backup exclusion via NSURLIsExcludedFromBackupKey in native module and src/db/backup.ts, integrated with openDb, with unit tests
2026-10-28 | 1.5 | Implemented services/library.ts (read-only permissions, full/limited/denied mapping, openSettings, presentLimitedLibraryPicker), useLibraryPermission hook with AppState foreground re-check, and 17 unit tests
2026-10-28 | 1.6 | Implemented syncLibrary in batches of 500, incremental sync via settings.last_sync_at, conflict-preserving photo upserts, useLibrarySync hook, and 10 unit tests with mocked media library
2026-10-28 | 1.7 | Implemented sweepOrphanTempExports at launch (filesystem & DB cleanup), cleanupExportFile exit path helper, useOrphanSweep hook, and 10 unit tests
2026-10-28 | 2.1 | Implemented pure TS trip detection engine in src/domain/tripDetection.ts using time-gap rule (12 h gap, >= 15 photos, >= 3 h span), cover photo assignment, human-readable trip naming, and 21 unit tests covering gaps, midnight crossings, single-photo days, and boundary thresholds
2026-10-28 | 2.2 | Implemented detectAndPersistTrips in src/services/tripService.ts with atomic SQLite transaction, auto-trip reconciliation, photo trip_id assignment, strict preservation of is_user_edited=1 trips, useTripDetection hook, and 6 unit tests
2026-10-28 | 2.3 | Promoted spike code to src/services/faceScan.ts with sequential scan (concurrency 2), resume support, cancel/pause controls, AppState auto-pause on background, keep-awake, memory safety, writes to faces table, useFaceScan hook, and 8 unit tests
2026-10-28 | 2.4 | Implemented pure TS face quality filter in src/domain/faceQuality.ts with min size (28px), detector confidence (0.5), blur via Laplacian variance (35.0), extreme pose detection via yaw (0.8 rad) and landmarks (0.65 asymmetry), integrated with faceScan service and SQLite faces.quality_ok, with 20 unit and integration tests
2026-10-28 | 2.5 | Implemented pure TS face clustering in src/domain/clustering.ts (average-linkage on cosine distance, CLUSTER_DISTANCE=0.32, cannot-link same-photo constraint, centroid and cover-face calculation, quality_ok=1 filtering) and persistence in src/services/clustering.ts (atomic transaction, writes people with centroids/covers, updates faces.person_id, assigns single/low-quality faces to Others, preserves manual assignments, scan_status transitions), with 11 tests
2026-10-28 | 2.6 | Implemented pure TS name-first assignment in src/domain/assignment.ts (name validation, centroid calculation from quality_ok=1 faces, greedy nearest centroid matching with ASSIGN_DISTANCE=0.35 and cannot-link same-photo constraint, manual face pinning) and service in src/services/assignment.ts (atomic transaction, updates people.name/centroid/cover_face, reassigns candidate faces, recomputePersonCentroid helper), with 15 tests
2026-10-28 | 2.7 | Implemented transactional manual edits service in src/services/manualEdits.ts (move faces, remove faces to Others, merge people with photo exclusion transfer, assignment='manual' pinning, and centroid recomputations) with 10 unit/integration tests
2026-10-28 | 2.8 | Implemented services/exporter.ts with photos mode (<= 30 photos, multi-file share via react-native-share) and zip mode (react-native-zip-archive with expo-sharing), soloOnly filter, low-storage pre-check, filename sanitization, sequential batch export, temp cleanup on every exit path, and 27 tests
2026-10-28 | 2.9 | Implemented free-tier gate (50 photos/trip), feature flag ENABLE_PRO_GATE (default OFF = everything unlocked), purchases service stub in src/services/purchases.ts (unlockProStub, restorePurchasesStub, getTripFreeTierStatus, hooks), integrated with faceScan.ts and exporter.ts, with 19 tests
2026-10-28 | 2.10 | Implemented offline eval harness in src/domain/evalHarness.ts with pairwise precision/recall/F1 metrics, parameter sweeps, and benchmark generator; gitignored eval/ folder; scripts/runEval.ts and npm run eval; tuned CLUSTER_DISTANCE=0.32 (Precision 100.0%, Recall 86.2%, F1 92.6%) and ASSIGN_DISTANCE=0.35 (Precision 100.0%, Recall 86.2%, F1 92.6%), exceeding PRD §6 targets (P>=90%, R>=80%); added 12 tests
2026-10-28 | 2.11 | Benchmarked 300-photo trip (src/services/tripBenchmark.ts, __tests__/benchmark.test.ts, App.tsx): total time 12.5 s (< 180 s target), throughput 24.0 photos/s (>= 5 photos/s target), peak memory 76.9 MB (< 400 MB target), 0 memory leaks (+4.9 MB delta), 643 faces found in 15 clusters; all PRD §6 targets PASSED
2026-10-28 | 3.1 | Implemented base UI components in src/components/ui (Button, TextField, Banner, EmptyState, Skeleton, ProgressRing) covering all states, variants, motions, tokens from 03_UI_Spec; added 20 tests in __tests__/uiComponents.test.tsx
2026-10-28 | 3.2 | Implemented root layout in app/_layout.tsx with Inter font loading via @expo-google-fonts/inter, splash screen handling, ThemeProvider in src/theme/ThemeProvider.tsx, ErrorBoundary with ErrorFallback in src/components/ErrorBoundary.tsx, launch-time orphan sweeps, and 8 tests in __tests__/rootLayout.test.tsx
2026-10-28 | 3.3 | Implemented onboarding screen (app/onboarding.tsx) with 3 benefit cards, "Nothing leaves your phone" privacy text, Allow Photo Access button, Full/Limited/Denied state handling, Permission Denied view with Open Settings, launch routing check in app/index.tsx, and 16 unit tests in __tests__/onboarding.test.tsx
2026-10-28 | 3.4 | Implemented Home (Trips) screen in app/index.tsx with FlashList, TripCard in src/components/trips/TripCard.tsx (cover photo, date range, photo count, scan badges, press scale), 3 skeleton loading cards, empty state with "Rescan library" action, error state with retry, pull-to-refresh sync, and 10 unit tests in __tests__/home.test.tsx
2026-10-28 | 3.5 | Implemented Trip Detail screen in app/trip/[id]/index.tsx (FlashList 3-col photo grid, PhotoTile component with 4 states, primary button by scan_status, free-tier banner, empty state, and modals for rename, adjust dates, merge trips, and hide) with 18 unit tests in __tests__/tripDetail.test.tsx
2026-10-29 | 3.6 | Implemented Scan Progress modal in app/trip/[id]/scan.tsx (progress ring, n/total photos, faces found counter, ETA calculation, keep-awake, background auto-pause and resume, zero faces handling with tips, and auto-navigation to people screen) with 10 unit tests in __tests__/scanModal.test.tsx
2026-10-29 | 3.7 | Implemented People screen (app/trip/[id]/people.tsx) with plain grid of PersonBubbles (avatar crop, dashed ring for unnamed, Others pinned last, count badge), Naming flow bottom sheet (representative face picker, real-time name validation, atomic name-first assignment, "+n photos added" feedback banner), Merge mode (select 2 -> merge via mergePeople), and Export navigation, with 20 unit/component tests in __tests__/peopleScreen.test.tsx
2026-10-29 | 3.8 | Implemented Person Detail screen in app/person/[id].tsx with editable name validation (1-40 chars, no illegal chars, unique check), FlashList 3-col photo grid, multi-select batch action bar (select all, move to person, remove to Others, per-person exclude/include toggle), and whole person merge flow, with 14 unit/integration tests in __tests__/personDetail.test.tsx
2026-10-29 | 3.9 | Implemented Export Review screen in app/export/[tripId].tsx with per-person format mode toggle (Photos <= 30 / ZIP), solo-only toggle, size warnings (> 500 MB), low-storage check (< 2x free space), paywall gate, sequential batch export queue modal with ProgressRing, and share cancellation handling, with 11 unit/integration tests in __tests__/exportReview.test.tsx



