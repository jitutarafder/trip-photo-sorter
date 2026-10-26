# 01_PRD — Trip Photo Sorter

> Status: LOCKED for MVP. Changes require editing this file first, then `06_Plan.md`.

## 1. Core Problem
After a trip, the gallery holds hundreds of photos. Sending each friend "their" photos means scrolling and hand-picking. It takes hours, so most photos never get shared.

## 2. Solution (one sentence)
Detect the trip automatically, group faces **on-device**, let the user name the groups, then export one ZIP per friend and share it in one tap.

## 3. Target Persona
**Primary — "The Trip Photographer"**: 18–35, the person in a friend group who takes most photos and is asked "send me my pics". iPhone user, shares via WhatsApp. Distrusts uploading friends' faces to a cloud.

**Highest-impact persona — "The Event Organizer"**: the one person who takes 300–500 photos at a class tour, office picnic, wedding or convocation and gets 30–50 "send my photos" requests. Original quality matters (WhatsApp compresses normal photo sends; ZIP/document keeps quality). The first real test should be an event like this, not a 5-friend trip.

Secondary: attendees of small friend-group trips (5–15 people).

## 4. Product Principles
1. **100% on-device.** No server, no account, no upload. Ever.
2. **Gallery is read-only.** The app never edits or deletes originals.
3. **Zero trash.** Temporary ZIPs are deleted right after sharing.
4. **Correctable.** AI grouping is a suggestion; the user can always fix it.

## 5. MVP User Stories
| ID | As a… | I want… | Acceptance criteria |
|----|-------|---------|---------------------|
| US-01 | user | to grant photo access once | Permission screen explains why; handles Full / Limited / Denied |
| US-02 | user | the app to find my trips automatically | Photos clustered by time gap (and GPS if present); trips listed newest first with cover, date range, photo count |
| US-03 | user | to rename, merge, or split a trip | Rename inline; merge two trips; adjust boundaries by date |
| US-04 | user | to scan a trip for faces | Progress bar, cancel/resume, runs in foreground, survives app backgrounding via resume |
| US-05 | user | to see people grouped by face | Grid of person bubbles, each with face crop + photo count; "Unknown/Others" bucket |
| US-06 | user | to name a person | Name stored locally; used as ZIP filename |
| US-07 | user | to fix wrong grouping | Move photo/face to another person, merge two people, remove a face from a person |
| US-08 | user | to preview a person's photo set before export | Scrollable grid, deselect individual photos |
| US-09 | user | to export a person's photos in one tap | **Photos mode** (≤ 30 photos, shared directly so WhatsApp shows previews) or **ZIP mode** for bigger sets; share sheet opens; temp files deleted after share/cancel |
| US-09b | user | to choose solo-only or include group photos | Toggle per export; default = include group photos |
| US-05b | user | to name one face and have the app find the rest | After naming, other photos of that person are auto-added; manual fixes are never overwritten |
| US-10 | user | to batch-export all named people | Sequential queue with progress; each ZIP shared in turn |
| US-11 *(deferred, flag off)* | free user | to try the app free | Free tier scans up to **50 photos per trip**; paywall on the 51st. Disabled in $0 MVP (everything unlocked) |
| US-12 *(deferred, flag off)* | user | to unlock Pro once | Needs a paid store account; build only after budget exists |

## 6. Success Metrics
| Metric | Target (beta, 20+ users) |
|--------|--------------------------|
| Time from open → first export shared | < 3 min for a 300-photo trip |
| Face grouping precision (same person in one cluster) | ≥ 90% on test set |
| Face grouping recall (person not split into many clusters) | ≥ 80% before manual fix |
| Scan speed | ≥ 5 photos/sec on iPhone 12+ |
| Crash-free sessions | ≥ 99% |
| Event stress test (Phase 7.1) | 150–500 photos, 15+ people, ≥ 90% grouping precision, organizer time saved vs manual recorded |
| Users who share ≥ 1 ZIP | ≥ 60% of activated users |
| Peak memory during scan | < 400 MB |

## 7. Out of Scope (Non-Goals) — DO NOT BUILD
- **Anything that costs money**: App Store/Play Store release, TestFlight, in-app purchases, paid services. MVP is distributed by sideloading to friends only.
- Any backend, cloud storage, user accounts, login, or sync
- Cloud face recognition or sending images/embeddings off device
- Photo editing, filters, enhancement, deletion, or moving originals
- Video support (photos only in MVP)
- Android release (iOS first; Android is post-MVP)
- GPS "away from home" trip detection (v2; MVP uses time gaps only)
- Cross-trip "global people" identity (people are scoped per trip in MVP)
- Social features, in-app chat, shareable links
- iCloud-only (not downloaded) photos: skip with a visible notice
- Auto-sending to WhatsApp contacts (we only open the share sheet)
- Web version and Bangla UI in the MVP (planned post-MVP: Plan Phase 7)
- Matter.js physics engine (replaced by Reanimated-based bubbles; see TRD)

## 7b. MVP Build Order
Core loop first: **trip → scan → name → export**. A risk spike (Phase 0.5) must pass before UI work. Antigravity bubbles come last and may be cut.

## 8. Open Decisions (resolve before Phase 5)
| # | Question | Default if unanswered |
|---|----------|-----------------------|
| D-1 | Free scan limit: 30 or 50? | 50 |
| D-2 | Pro price: $2.99 or $4.99? | $4.99 |
| D-3 | Final app name | "Trip Photo Sorter" (working title) |
