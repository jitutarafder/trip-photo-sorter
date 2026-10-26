# 02_AppFlow — Screens, Routes, State Machine

Router: `expo-router` (file-based). All state is local (SQLite + Zustand for UI state).

## 1. Route Map
| Route | Screen | Purpose |
|-------|--------|---------|
| `/onboarding` | Onboarding + Permission | Explain privacy, request photo access |
| `/` | Home (Trips) | List detected trips |
| `/trip/[id]` | Trip Detail | Photos grid, scan CTA, rename/merge |
| `/trip/[id]/scan` | Scan Progress (modal) | Face scan progress |
| `/trip/[id]/people` | People | Bubble/grid of person clusters |
| `/person/[id]` | Person Detail | Photos of one person, correction tools |
| `/export/[tripId]` | Export Review | Select people, create ZIPs |
| `/paywall` | Paywall (modal) | Pro unlock |
| `/settings` | Settings | Permissions, reset data, restore purchase, about |

## 2. App-Level State Machine
```
LAUNCH
  ├─ no onboarding flag ──────────────► ONBOARDING
  ├─ permission = denied ─────────────► PERMISSION_DENIED
  └─ permission = granted/limited ────► LIBRARY_SYNC ─► HOME
```
### Library Sync
`IDLE → SYNCING (read assets, upsert photos) → DETECTING_TRIPS → READY | ERROR`
- Incremental: only assets newer than `settings.last_sync_at` or with changed `modificationTime`.
- Runs in batches of 500; UI shows skeleton until first batch is stored.

### Scan State (per trip) — column `trips.scan_status`
```
NOT_SCANNED ─start─► SCANNING ─done─► CLUSTERING ─done─► SCANNED
     ▲                  │ cancel/background-kill              │ rescan
     │                  ▼                                     ▼
     └──────────────  PAUSED (resumable) ◄────────────  NOT_SCANNED
SCANNING/CLUSTERING ─fatal error─► FAILED ─retry─► SCANNING
```
Resume rule: on re-entry, scan only photos where `photos.scan_status != 'done'`.

### Export State (per person) — column `exports.status`
`PENDING → ZIPPING → READY → SHARING → DONE | CANCELLED | FAILED` — temp ZIP is deleted on DONE, CANCELLED, FAILED, and at next app launch (orphan sweep).

## 3. Screen Specs

### 3.1 Onboarding / Permission
- Content: 3 cards (Find trips · Group faces · Share ZIPs) + privacy line "Nothing leaves your phone."
- Button **Allow Photo Access** → system prompt.
- Outcomes: granted → `/`; limited → `/` with banner "Only selected photos visible — Manage"; denied → Permission Denied view.
- **Permission Denied view**: explanation + button **Open Settings** (`Linking.openSettings()`); re-check on app foreground.

### 3.2 Home (Trips)
- Data: trips sorted by `start_at DESC`; card = cover photo, name, date range, photo count, scan badge.
- Actions: tap card → `/trip/[id]`; pull-to-refresh → re-sync; header gear → `/settings`.
- **Empty**: "No trips found yet" + explanation of detection rule + button **Rescan library**.
- **Loading**: 3 skeleton cards. **Error**: message + **Retry**.

### 3.3 Trip Detail
- Header: editable name, date range. FlashList photo grid (3 cols).
- Primary button: **Scan faces** (or **Resume scan** / **View people** by state).
- Overflow menu: Rename · Merge with… · Adjust dates · Hide trip.
- Free-limit banner when `photo_count > 50` and not Pro: "Free scans first 50 photos. Unlock Pro."
- **Empty (0 photos after hide/adjust)**: "No photos in this range" + Adjust dates.

### 3.4 Scan Progress (modal)
- Shows: progress ring, `n / total`, faces found, ETA, **Cancel** button.
- Keep-awake enabled while active. Backgrounded → state `PAUSED`; on return show **Resume**.
- Done → auto-navigate to `/trip/[id]/people`.
- **Zero faces found**: "No faces detected" + tips; button Back.
- **Error on single photo**: mark `photos.scan_status='failed'`, continue; show count at end.

### 3.5 People
- Bubble grid (Antigravity bubbles in Phase 5; plain grid until then).
- Bubble: face crop, name or "Unnamed", photo count. Sort: count DESC; "Others" last.
- Actions: tap → `/person/[id]`; long-press → merge mode (select 2 → **Merge**); button **Export** → `/export/[tripId]`.
- **Naming flow:** tap an unnamed bubble → sheet shows its clearest faces → user picks one + types a name → app re-assigns other faces by similarity (toast: "+n photos added to Rafi"). Faces moved manually are pinned and never re-assigned.
- **Empty**: same as zero-faces state.

### 3.6 Person Detail
- Editable name field (required before export; trimmed 1–40 chars, no `/ \ :`).
- Photo grid with multi-select. Actions on selection: **Move to…** (pick person), **Remove from person** (→ Others), **Exclude from export**.
- **Merge into…** whole person.
- Validation: duplicate name within a trip → inline error "Name already used".

### 3.7 Export Review
- List of named people with checkbox, photo count, estimated size.
- Per-export options: **Format** segmented control (`Photos` available when ≤ 30 photos, else `ZIP`), **Include group photos** toggle (default on).
- **Export selected** → creates files per person (photos or ZIP), then share sheet per person.
- Warnings: size > 500 MB → confirm dialog; unnamed people disabled with hint "Name first".
- Free-limit: exporting blocked beyond 50 scanned photos → `/paywall`.
- Error: low storage (< 2× ZIP size free) → "Not enough space" with required MB.
- Share cancelled → ZIP deleted, row returns to unchecked state.

### 3.8 Paywall
Pro benefits list, price, **Unlock Pro**, **Restore purchase**, close ✕. Success → dismiss and resume the blocked action.

### 3.9 Settings
Permission status + manage · Re-sync library · Reset all app data (confirm) · Restore purchase · Privacy statement · Version.

## 4. Global Error Handling
| Case | Behaviour |
|------|-----------|
| Permission revoked mid-session | Toast + route to Permission Denied view |
| Photo asset deleted from gallery | Remove from DB on next sync; skip silently in export, counted in summary |
| iCloud-only asset (not local) | Skip, mark `photos.is_local=0`, show "n photos in iCloud skipped" |
| DB migration failure | Block UI with "Update failed — Reset data" option |
| Unhandled JS error | Error boundary screen with **Restart** |
