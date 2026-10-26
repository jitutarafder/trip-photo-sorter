# 03_UI_Spec — Design System

Single source of truth for visuals. Never hard-code a colour, size, or font in a component — import from `src/theme/tokens.ts`.

## 1. Colour Tokens
| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `bg` | `#0B0D12` | `#F6F7FB` | App background |
| `surface` | `#141822` | `#FFFFFF` | Cards, sheets |
| `surfaceAlt` | `#1D2330` | `#EBEEF5` | Inputs, chips |
| `border` | `#2A3142` | `#D9DEEA` | Dividers |
| `text` | `#F2F4F8` | `#0B0D12` | Primary text |
| `textMuted` | `#98A2B3` | `#5B6475` | Secondary text |
| `primary` | `#6C8CFF` | `#4A6CF7` | Buttons, links |
| `primaryPressed` | `#5877EB` | `#3957DD` | Pressed state |
| `onPrimary` | `#0B0D12` | `#FFFFFF` | Text on primary |
| `accent` | `#3DDBB0` | `#14B88E` | Highlights, progress |
| `success` | `#3DDB8A` | `#17A35E` | Success |
| `warning` | `#FFB84D` | `#C77A00` | Warnings |
| `danger` | `#FF5C6C` | `#D6293D` | Destructive/errors |
| `overlay` | `rgba(0,0,0,0.6)` | `rgba(11,13,18,0.4)` | Modal scrim |

Bubble gradient pair (Antigravity): `#6C8CFF → #3DDBB0` at 25% opacity ring.

## 2. Theme Rules
- Follow system setting (`useColorScheme`); manual override not in MVP.
- Dark is the design-first theme; verify light separately.
- Text/background contrast ≥ 4.5:1 (body), ≥ 3:1 (large text, icons).
- Photos are never tinted or overlaid except a bottom gradient (max 40% black) for text.

## 3. Typography
Font: **Inter** (via `@expo-google-fonts/inter`: 400, 500, 600, 700). Fallback: system.
| Style | Size / Line | Weight | Use |
|-------|-------------|--------|-----|
| `display` | 32 / 38 | 700 | Onboarding titles |
| `title` | 24 / 30 | 700 | Screen titles |
| `heading` | 18 / 24 | 600 | Section headers |
| `body` | 16 / 22 | 400 | Default |
| `bodyStrong` | 16 / 22 | 600 | Emphasis |
| `caption` | 13 / 18 | 500 | Metadata |
| `micro` | 11 / 14 | 500 | Badges |
Support Dynamic Type up to 130%; layouts must not clip.

## 4. Spacing, Radius, Elevation
- Spacing scale (px): `4, 8, 12, 16, 24, 32, 48`. Screen horizontal padding: `16`.
- Radius: `sm 8`, `md 12`, `lg 20`, `pill 999`, photos in grid `4`.
- Photo grid gap: `2`. Trip card height: `160`.
- Elevation: dark = border only; light = shadow `0 2 8 rgba(11,13,18,0.08)`.
- Min touch target: **44×44**.

## 5. Motion
- Standard transition: 220 ms, ease-out. Press scale: 0.97 over 90 ms.
- Target 120 Hz on ProMotion (`CADisableMinimumFrameDurationOnPhone = true`); animation runs on the UI thread (worklets) only.
- Respect Reduce Motion: disable floating bubbles, use fades.
- **Antigravity bubbles** (Phase 5): slow drift (±6 px, 4–7 s loops), spring on tap (`damping 14, stiffness 160`), max 24 animated bubbles; beyond that render static.

## 6. Core Components & States
| Component | States |
|-----------|--------|
| `Button` (primary/secondary/ghost/danger) | default · pressed · disabled (50% opacity) · loading (spinner, width locked) |
| `TripCard` | default · pressed · scanning (progress bar) · scanned (check badge) |
| `PhotoTile` | default · selected (2 px `primary` ring + check) · loading (placeholder `surfaceAlt`) · broken (icon) |
| `PersonBubble` | default · pressed · selected (merge mode) · unnamed (dashed ring) · floating (Phase 5) |
| `TextField` | default · focused (`primary` border) · error (`danger` border + message) · disabled |
| `ProgressRing` | determinate · indeterminate |
| `Banner` | info · warning · error (icon + text + optional action) |
| `Sheet` | closed · open · dragging |
| `EmptyState` | icon + title + body + optional CTA |
| `Skeleton` | shimmer 1.2 s loop |

## 7. Iconography
`lucide-react-native`, 24 px, stroke 1.75, colour = `text` or `textMuted`.

## 8. Copy Tone
Short, friendly, no jargon. Never say "AI model" or "embedding" in UI; say "faces" and "on your phone".
