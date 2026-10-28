// Pure TypeScript Trip Detection Engine (TRD §4, PRD US-02)
// No imports from React, React Native, or Expo

import { CONFIG } from './config';

export interface PhotoTimestampItem {
  id: string;
  taken_at: number;
}

export interface FormatDateOptions {
  timeZone?: string;
}

export interface TripDetectionOptions extends FormatDateOptions {
  gapHours?: number;
  minPhotos?: number;
  minHours?: number;
}

export interface DetectedTrip {
  name: string;
  start_at: number;
  end_at: number;
  photo_count: number;
  cover_photo_id: string;
  photo_ids: string[];
}

/**
 * Formats a date range into a concise human-readable string.
 * Examples:
 * - "Oct 24, 2026" (single day)
 * - "Oct 24–27, 2026" (same month and year)
 * - "Oct 28 – Nov 2, 2026" (different month, same year)
 * - "Dec 30, 2026 – Jan 3, 2027" (different year)
 */
export function formatTripDateRange(
  startMs: number,
  endMs: number,
  options?: FormatDateOptions
): string {
  const timeZone = options?.timeZone;
  const start = new Date(startMs);
  const end = new Date(endMs);

  const getParts = (d: Date) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    });
    const parts = formatter.formatToParts(d);
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = parts.find((p) => p.type === 'day')?.value ?? '';
    const year = parts.find((p) => p.type === 'year')?.value ?? '';
    return { month, day, year };
  };

  const startParts = getParts(start);
  const endParts = getParts(end);

  if (
    startParts.year === endParts.year &&
    startParts.month === endParts.month &&
    startParts.day === endParts.day
  ) {
    return `${startParts.month} ${startParts.day}, ${startParts.year}`;
  }

  if (
    startParts.year === endParts.year &&
    startParts.month === endParts.month
  ) {
    return `${startParts.month} ${startParts.day}–${endParts.day}, ${startParts.year}`;
  }

  if (startParts.year === endParts.year) {
    return `${startParts.month} ${startParts.day} – ${endParts.month} ${endParts.day}, ${startParts.year}`;
  }

  return `${startParts.month} ${startParts.day}, ${startParts.year} – ${endParts.month} ${endParts.day}, ${endParts.year}`;
}

/**
 * Generates the default trip name according to TRD §4:
 * "Trip · {Mon D–D, YYYY}"
 */
export function generateDefaultTripName(
  startMs: number,
  endMs: number,
  options?: FormatDateOptions
): string {
  return `Trip · ${formatTripDateRange(startMs, endMs, options)}`;
}

/**
 * Detects trips from photo timestamps using the time-gap rule.
 *
 * Rules (TRD §4 / PRD US-02):
 * 1. Photos sorted chronologically by `taken_at`.
 * 2. New trip cluster boundary when gap between consecutive photos > 12 h (CONFIG.TRIP_GAP_HOURS).
 * 3. Candidate clusters with < 15 photos (CONFIG.MIN_TRIP_PHOTOS) or span < 3 h (CONFIG.MIN_TRIP_HOURS) are discarded.
 * 4. GPS / "away from home" logic is strictly v2 and not applied.
 */
export function detectTrips(
  photos: readonly PhotoTimestampItem[],
  options?: TripDetectionOptions
): DetectedTrip[] {
  if (!photos || photos.length === 0) {
    return [];
  }

  // Filter out items with missing or invalid timestamps
  const validPhotos = photos.filter(
    (p): p is PhotoTimestampItem =>
      Boolean(p) &&
      typeof p.id === 'string' &&
      p.id.length > 0 &&
      typeof p.taken_at === 'number' &&
      !Number.isNaN(p.taken_at) &&
      p.taken_at > 0
  );

  if (validPhotos.length === 0) {
    return [];
  }

  // Sort ascending by timestamp; break ties with photo ID for deterministic results
  const sorted = [...validPhotos].sort((a, b) => {
    if (a.taken_at !== b.taken_at) {
      return a.taken_at - b.taken_at;
    }
    return a.id.localeCompare(b.id);
  });

  const gapHours = options?.gapHours ?? CONFIG.TRIP_GAP_HOURS;
  const minPhotos = options?.minPhotos ?? CONFIG.MIN_TRIP_PHOTOS;
  const minHours = options?.minHours ?? CONFIG.MIN_TRIP_HOURS;

  const gapMs = gapHours * 60 * 60 * 1000;
  const minSpanMs = minHours * 60 * 60 * 1000;

  const detectedTrips: DetectedTrip[] = [];
  let currentCluster: PhotoTimestampItem[] = [];

  const evaluateCluster = (cluster: PhotoTimestampItem[]) => {
    if (cluster.length < minPhotos) {
      return;
    }
    const startAt = cluster[0].taken_at;
    const endAt = cluster[cluster.length - 1].taken_at;
    const spanMs = endAt - startAt;

    if (spanMs < minSpanMs) {
      return;
    }

    detectedTrips.push({
      name: generateDefaultTripName(startAt, endAt, { timeZone: options?.timeZone }),
      start_at: startAt,
      end_at: endAt,
      photo_count: cluster.length,
      cover_photo_id: cluster[0].id,
      photo_ids: cluster.map((p) => p.id),
    });
  };

  for (let i = 0; i < sorted.length; i++) {
    const photo = sorted[i];
    if (currentCluster.length === 0) {
      currentCluster.push(photo);
      continue;
    }

    const prevPhoto = currentCluster[currentCluster.length - 1];
    const timeDiff = photo.taken_at - prevPhoto.taken_at;

    if (timeDiff > gapMs) {
      evaluateCluster(currentCluster);
      currentCluster = [photo];
    } else {
      currentCluster.push(photo);
    }
  }

  if (currentCluster.length > 0) {
    evaluateCluster(currentCluster);
  }

  return detectedTrips;
}
