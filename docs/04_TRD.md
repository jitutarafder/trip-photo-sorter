# 04_TRD — Technical Requirements (Locked Stack)

> **Version rule:** versions below target **Expo SDK 54** (React Native 0.81, New Architecture on). The agent must install with `npx expo install <pkg>` so Expo resolves the SDK-compatible version, then record the resolved version in `package.json`. Do NOT upgrade the SDK without editing this file.
> Verify the Expo SDK release notes before Phase 0; if a newer SDK is current, update this table once, then lock.

## 1. Stack
| Concern | Choice | Version target | Notes |
|---------|--------|----------------|-------|
| Language | TypeScript (strict) | ~5.9 | `"strict": true`, no `any` without comment |
| Framework | Expo + React Native | SDK 54 / RN 0.81 | **Development build** (not Expo Go) — native modules required |
| Routing | expo-router | ~6 | File-based |
| Lists | @shopify/flash-list | 2.x | All photo grids |
| Animation | react-native-reanimated + react-native-worklets | ~4.1 | UI-thread only |
| Drawing (bubbles) | @shopify/react-native-skia | 2.x | Phase 5 only |
| Gestures | react-native-gesture-handler | ~2.28 | |
| Database | expo-sqlite | ~16 | WAL mode, sync + async API |
| Photos | expo-media-library | ~18 | Read-only |
| Files | expo-file-system | ~19 | Temp dir for ZIPs |
| ZIP | react-native-zip-archive | 7.x | Native zipping, streams from disk (do NOT use JSZip — loads files into JS memory) |
| Sharing | expo-sharing (single ZIP) + react-native-share (multiple photo files) | ~14 / latest | Free/MIT. **Verify multi-file share works on iOS dev build in task 2.8**; if not, fall back to ZIP only |
| Image crops | expo-image-manipulator | ~14 | Face crop → model input |
| Face detection | **BlazeFace short-range (TFLite)** via `react-native-fast-tflite` | 1.x | 128×128 input; anchor decoding + NMS written in TypeScript (`src/domain/blazeface.ts`, unit-tested). No custom native code |
| Face embedding | **MobileFaceNet (TFLite, 128-d)** via `react-native-fast-tflite` | 1.x | CoreML delegate on iOS. Model file bundled in `assets/models/` |
| State (UI) | zustand | 5.x | UI state only; data lives in SQLite |
| Purchases | *(deferred — needs paid store account)* | — | Pro tier is feature-flagged off in MVP; see PRD |
| Keep awake | expo-keep-awake | ~15 | During scan |
| Tests | jest-expo + @testing-library/react-native | latest | Unit + component |
| Lint/format | eslint (expo config) + prettier | latest | CI gate |

### Why not what the early plan said
| Early idea | Problem | Decision |
|-----------|---------|----------|
| Run via Expo Go | Native modules (TFLite, zip) don't run in Expo Go | Use a **dev-client build** made by GitHub Actions and sideloaded |
| "Apple Vision does face grouping" | Vision gives **no identity embedding**, and a custom Swift module is painful to debug without a Mac (10–20 min CI build per try) | BlazeFace (TFLite) for detection, MobileFaceNet for embeddings, our own clustering; zero custom native code |
| Zip with expo-file-system | It has no zip API | `react-native-zip-archive` |
| Matter.js bubbles | Physics runs on JS thread → drops frames, conflicts with 120 Hz goal | Reanimated worklets (+ Skia) with simple drift/spring math |
| TestFlight at $0 | TestFlight requires the $99 Apple Developer Program | GitHub Actions unsigned IPA + Sideloadly with free Apple ID (7-day re-sign) |

## 2. Environment (Windows PC + iPhone) — HARD RULE: $0 SPEND
No paid account of any kind (no Apple Developer $99, no Play Console $25, no paid EAS, no paid APIs). Every task must be doable for free.

**Build + install path (iOS, free):**
1. Code lives in a **public GitHub repo** (GitHub Actions macOS runners are free for public repos; private repos have a small monthly quota that macOS burns fast).
2. GitHub Actions workflow (`.github/workflows/ios-build.yml`) on `macos-latest`: `npx expo prebuild --platform ios` → `xcodebuild archive` with code signing disabled → package **unsigned `.ipa`** → upload as artifact.
3. Download the `.ipa` on Windows, install with **Sideloadly** (or AltStore/iPASide) using a **free Apple ID** over USB.
4. Free Apple ID limits: app expires every **7 days** (re-sign weekly; Sideloadly can auto-refresh while the PC is connected), max **3 sideloaded apps**, limited App IDs per period. Use a secondary Apple ID if you don't want to enter your main one.
5. Dev loop: JS-only changes → only rebuild when native code changes (use `expo-dev-client` so the installed app can load JS from your PC's Metro server on the same Wi-Fi). Native changes → push to GitHub → wait for Action → re-sideload.

**Fallbacks (also free):**
- *Expo Go only* — no custom native modules; face pipeline would have to run in JS/WASM (very slow). Use only for UI work before the first dev build is ready.
- *Android first* — builds locally on Windows with Android Studio (free), APK sideloads to friends with no fee. Needs an Android phone for real gallery testing.

**Not possible at $0:** App Store, TestFlight, Google Play Store release, in-app purchases (StoreKit/Play Billing need paid developer accounts). Distribution = sideloaded builds to friends only. See PRD §7/§8.

## 3. Folder Structure
```
/
├─ CLAUDE.md
├─ .cursorrules
├─ docs/                      # 01–06 files (source of truth)
├─ app/                       # expo-router routes (thin, no logic)
│  ├─ _layout.tsx
│  ├─ index.tsx
│  ├─ onboarding.tsx
│  ├─ settings.tsx
│  ├─ paywall.tsx
│  ├─ trip/[id]/index.tsx
│  ├─ trip/[id]/scan.tsx
│  ├─ trip/[id]/people.tsx
│  ├─ person/[id].tsx
│  └─ export/[tripId].tsx
├─ src/
│  ├─ db/                     # client.ts, migrations/, repositories/
│  ├─ domain/                 # pure TS: tripDetection.ts, clustering.ts, naming.ts
│  ├─ services/               # library.ts, faceScan.ts, exporter.ts, purchases.ts
│  ├─ components/             # ui/ (Button…), photos/, people/
│  ├─ hooks/
│  ├─ stores/                 # zustand
│  ├─ theme/                  # tokens.ts
│  └─ utils/
├─ assets/models/             # blazeface.tflite, mobilefacenet.tflite
├─ __tests__/
└─ eas.json, app.json, tsconfig.json
```
Rules: routes import from `src/`; `src/domain` imports nothing from React/Expo (pure, unit-testable); only `src/db/repositories` run SQL.

## 4. Algorithms (locked defaults — tune only via constants file `src/domain/config.ts`)
**Trip detection (MVP: time gaps only)**
- Sort photos by `taken_at`. New trip when gap between consecutive photos > **12 h** (`TRIP_GAP_HOURS`).
- Discard candidates with < **15 photos** (`MIN_TRIP_PHOTOS`) or span < **3 h**.
- GPS / "away from home" logic is **v2** — do not build. `photos.lat/lng` and `trips.is_away` stay in the schema but unused.
- Name: "Trip · {Mon D–D, YYYY}" until the user renames.

**Face pipeline per photo**
1. Load a downscaled image (max 1280 px long edge) — never full-res.
2. BlazeFace detect (letterbox to 128×128, decode anchors, NMS) → drop faces with short edge < **48 px** or confidence < **0.6**.
3. Crop with 20 % margin, resize 112×112, normalise, run MobileFaceNet → 128-d L2-normalised vector.
4. Save to `faces`. Process **sequentially with concurrency 2**; release image buffers each iteration.

**Face quality filter** (before clustering and centroids)
- Reject faces with short edge < 48 px, detector confidence < 0.6, blur score (Laplacian variance of the grey crop) below `BLUR_MIN`, or extreme yaw (from BlazeFace keypoints) above `YAW_MAX`. Store them with `quality_ok = 0`; they can still be assigned to a person by nearest centroid but never form or move a centroid.

**Clustering**
- Agglomerative (average linkage) on cosine distance, threshold `CLUSTER_DISTANCE` (starting guess 0.45), over `quality_ok = 1` faces only, in batches.
- Clusters with 1 face → "Others".

**Name-first assignment**
- When the user names/confirms a person: centroid = L2-normalised mean of that person's `quality_ok` face embeddings (`people.centroid`). Re-assign every `assignment='auto'` face to the nearest centroid if cosine distance < `ASSIGN_DISTANCE` (starting guess 0.50), else leave in Others.
- `assignment='manual'` (pinned) faces are never changed by clustering, rescans, or re-assignment. Centroids are recomputed after any manual edit.

**Threshold tuning**
- All thresholds live in `src/domain/config.ts`. Starting values are guesses; final values come from the local eval harness (plan task 2.10) on the developer's labelled photos. Eval photos/labels/embeddings are **never committed** (public repo, friends' faces).

## 5. Performance Budget
- Cold start to Home < 2.0 s (after first sync).
- Grid scroll ≥ 58 fps on iPhone 12 (≥ 110 on ProMotion).
- Peak RAM < 400 MB during scan; no full-resolution decode in JS.
- DB queries for grids paged (limit 120), indexed (see 05_Schema).

## 6. Security & Privacy Constraints
- **No network code** for photos/faces. Only network use: purchase verification (store APIs). Lint rule forbids `fetch`/`axios` outside `src/services/purchases.ts`.
- Public repo rule: never commit photos, face crops, embeddings, or labels (`eval/` is gitignored).
- Face embeddings are biometric-like data: stored only in the app sandbox SQLite; the DB file is **excluded from iCloud/iTunes backup** (`NSURLIsExcludedFromBackupKey`).
- No analytics SDKs, no crash reporters that upload images. If crash reporting is added, it must exclude photo data and filenames.
- Photo library permission: read only (`readOnly` where API allows); no `WRITE`.
- Temp ZIPs live in `FileSystem.cacheDirectory + 'exports/'`; deleted after share, on cancel, on failure, and by launch-time sweep.
- Sanitise filenames: strip `/ \ : * ? " < > |`, trim, max 40 chars; ZIP name `{Trip}_{Person}.zip`. Photos mode shares up to 30 original files; larger sets use ZIP.
- `Info.plist` strings: `NSPhotoLibraryUsageDescription` must state on-device processing.
- ATT/tracking: none declared. App Store privacy label: "Data Not Collected".

## 7. Third-Party Services
None. (Purchase APIs deferred until a paid store account exists.)

## 8. Open Decisions
| # | Question | Decision / Status |
|---|----------|-------------------|
| D-5 | Confirm BlazeFace + MobileFaceNet licence/model source | **Resolved in Task S.1**:<br>• **BlazeFace (short-range)**: Google MediaPipe (`face_detection_short_range.tflite`), Apache 2.0 License. Stored at `assets/models/blazeface.tflite`.<br>• **MobileFaceNet (128-d)**: MobileFaceNet (`mobilefacenet.tflite`), Apache 2.0 / MIT License. Stored at `assets/models/mobilefacenet.tflite`. Both models are permissive and free to bundle. |

## 9. Quality Gates
`tsc --noEmit`, `eslint`, `jest` must pass before any step in `06_Plan.md` is ticked.
