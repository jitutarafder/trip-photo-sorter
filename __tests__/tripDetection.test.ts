import {
  detectTrips,
  formatTripDateRange,
  generateDefaultTripName,
  type PhotoTimestampItem,
} from '../src/domain/tripDetection';
import { CONFIG } from '../src/domain/config';

describe('Trip Detection Domain Engine', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const BASE_TIME = Date.UTC(2026, 9, 24, 8, 0, 0); // 2026-10-24 08:00:00 UTC

  /**
   * Helper to generate a sequence of photos with uniform time intervals.
   */
  function createPhotoSequence(
    count: number,
    intervalMs: number,
    startMs: number = BASE_TIME,
    idPrefix: string = 'p'
  ): PhotoTimestampItem[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `${idPrefix}_${i + 1}`,
      taken_at: startMs + i * intervalMs,
    }));
  }

  describe('Date range formatting & trip naming', () => {
    it('formats single-day trip name correctly', () => {
      const start = Date.UTC(2026, 9, 24, 9, 0, 0);
      const end = Date.UTC(2026, 9, 24, 18, 0, 0);
      const name = generateDefaultTripName(start, end, { timeZone: 'UTC' });
      expect(name).toBe('Trip · Oct 24, 2026');
    });

    it('formats multi-day same-month trip name correctly', () => {
      const start = Date.UTC(2026, 9, 24, 9, 0, 0);
      const end = Date.UTC(2026, 9, 27, 18, 0, 0);
      const name = generateDefaultTripName(start, end, { timeZone: 'UTC' });
      expect(name).toBe('Trip · Oct 24–27, 2026');
    });

    it('formats multi-day across-month trip name correctly', () => {
      const start = Date.UTC(2026, 9, 28, 9, 0, 0);
      const end = Date.UTC(2026, 10, 2, 18, 0, 0);
      const name = generateDefaultTripName(start, end, { timeZone: 'UTC' });
      expect(name).toBe('Trip · Oct 28 – Nov 2, 2026');
    });

    it('formats across-year trip name correctly', () => {
      const start = Date.UTC(2026, 11, 30, 9, 0, 0);
      const end = Date.UTC(2027, 0, 3, 18, 0, 0);
      const name = generateDefaultTripName(start, end, { timeZone: 'UTC' });
      expect(name).toBe('Trip · Dec 30, 2026 – Jan 3, 2027');
    });

    it('formats date range string directly', () => {
      const start = Date.UTC(2026, 4, 1, 10, 0, 0);
      const end = Date.UTC(2026, 4, 5, 12, 0, 0);
      expect(formatTripDateRange(start, end, { timeZone: 'UTC' })).toBe('May 1–5, 2026');
    });
  });

  describe('Time-gap clustering rules', () => {
    it('groups photos with gap <= 12 hours into the same trip', () => {
      // 20 photos, 30 minutes apart (span = 9.5 hours, all gaps = 0.5h <= 12h)
      const photos = createPhotoSequence(20, 30 * 60 * 1000, BASE_TIME);
      const trips = detectTrips(photos, { timeZone: 'UTC' });

      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(20);
      expect(trips[0].cover_photo_id).toBe('p_1');
      expect(trips[0].start_at).toBe(photos[0].taken_at);
      expect(trips[0].end_at).toBe(photos[photos.length - 1].taken_at);
      expect(trips[0].photo_ids).toEqual(photos.map((p) => p.id));
    });

    it('keeps photos in the same cluster on exact 12-hour gap boundary', () => {
      // 15 photos: first 14 spaced 15 minutes apart, 15th taken exactly 12 hours after 14th
      const first14 = createPhotoSequence(14, 15 * 60 * 1000, BASE_TIME, 'a');
      const last14Time = first14[first14.length - 1].taken_at;
      const photo15: PhotoTimestampItem = {
        id: 'a_15',
        taken_at: last14Time + CONFIG.TRIP_GAP_HOURS * HOUR_MS, // exactly 12 hours
      };

      const trips = detectTrips([...first14, photo15], { timeZone: 'UTC' });
      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(15);
      expect(trips[0].end_at).toBe(photo15.taken_at);
    });

    it('splits clusters when gap exceeds 12 hours (> 12h)', () => {
      // Trip 1: 15 photos, 20 min apart (span = 4.67 hours)
      const trip1Photos = createPhotoSequence(15, 20 * 60 * 1000, BASE_TIME, 't1');
      const trip1End = trip1Photos[trip1Photos.length - 1].taken_at;

      // 12 hours + 1 minute gap
      const trip2Start = trip1End + 12 * HOUR_MS + 60 * 1000;
      // Trip 2: 16 photos, 15 min apart (span = 3.75 hours)
      const trip2Photos = createPhotoSequence(16, 15 * 60 * 1000, trip2Start, 't2');

      const allPhotos = [...trip1Photos, ...trip2Photos];
      const trips = detectTrips(allPhotos, { timeZone: 'UTC' });

      expect(trips).toHaveLength(2);
      expect(trips[0].photo_count).toBe(15);
      expect(trips[0].cover_photo_id).toBe('t1_1');
      expect(trips[1].photo_count).toBe(16);
      expect(trips[1].cover_photo_id).toBe('t2_1');
      expect(trips[0].end_at).toBe(trip1End);
      expect(trips[1].start_at).toBe(trip2Start);
    });
  });

  describe('Midnight crossings and multi-day trips', () => {
    it('detects a trip spanning midnight across two calendar days', () => {
      // Starts at 22:00 on Day 1, photos every 1 hour until 14:00 next day (17 photos, span = 16h)
      const startNight = Date.UTC(2026, 9, 24, 22, 0, 0);
      const photos = createPhotoSequence(17, HOUR_MS, startNight, 'midnight');

      const trips = detectTrips(photos, { timeZone: 'UTC' });
      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(17);
      expect(trips[0].name).toBe('Trip · Oct 24–25, 2026');
      expect(trips[0].start_at).toBe(startNight);
      expect(trips[0].end_at).toBe(startNight + 16 * HOUR_MS);
    });

    it('detects a multi-day trip with regular gaps across 4 days', () => {
      // 25 photos, 4 hours apart (total span = 96 hours = 4 days, all gaps 4h < 12h)
      const photos = createPhotoSequence(25, 4 * HOUR_MS, BASE_TIME, 'multi');
      const trips = detectTrips(photos, { timeZone: 'UTC' });

      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(25);
      expect(trips[0].name).toBe('Trip · Oct 24–28, 2026');
    });
  });

  describe('Single-photo days and sparse days rejection', () => {
    it('discards single-photo days taken across consecutive days', () => {
      // 1 photo per day for 10 days (gap between photos = 24 hours > 12h)
      const singlePhotos: PhotoTimestampItem[] = Array.from({ length: 10 }, (_, i) => ({
        id: `daily_${i + 1}`,
        taken_at: BASE_TIME + i * 24 * HOUR_MS,
      }));

      const trips = detectTrips(singlePhotos, { timeZone: 'UTC' });
      expect(trips).toEqual([]);
    });

    it('discards cluster with fewer than 15 photos even if span >= 3 hours', () => {
      // 14 photos, 30 minutes apart (span = 6.5 hours >= 3 hours, but count = 14 < 15)
      const photos = createPhotoSequence(14, 30 * 60 * 1000, BASE_TIME, 'sparse');
      const trips = detectTrips(photos, { timeZone: 'UTC' });

      expect(trips).toHaveLength(0);
    });

    it('discards cluster with >= 15 photos when span is less than 3 hours', () => {
      // 30 photos taken during a 45-minute event (interval = 1.5 min, span = 43.5 min < 3 hours)
      const photos = createPhotoSequence(30, 90 * 1000, BASE_TIME, 'burst');
      const trips = detectTrips(photos, { timeZone: 'UTC' });

      expect(trips).toHaveLength(0);
    });

    it('discards cluster when span is 1 ms short of 3 hours', () => {
      // 15 photos: first 14 at BASE_TIME, 15th at BASE_TIME + 3h - 1ms
      const photos: PhotoTimestampItem[] = Array.from({ length: 14 }, (_, i) => ({
        id: `almost_${i + 1}`,
        taken_at: BASE_TIME,
      }));
      photos.push({
        id: 'almost_15',
        taken_at: BASE_TIME + 3 * HOUR_MS - 1,
      });

      const trips = detectTrips(photos, { timeZone: 'UTC' });
      expect(trips).toHaveLength(0);
    });
  });

  describe('Boundary thresholds & acceptance', () => {
    it('accepts trip meeting exact minimum thresholds: 15 photos and exactly 3-hour span', () => {
      // 15 photos: spaced 3h / 14 intervals apart (span = exactly 3 hours)
      const interval = (3 * HOUR_MS) / 14;
      const photos = createPhotoSequence(15, interval, BASE_TIME, 'exact');

      const trips = detectTrips(photos, { timeZone: 'UTC' });
      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(15);
      expect(trips[0].end_at - trips[0].start_at).toBe(3 * HOUR_MS);
    });

    it('isolates a valid trip surrounded by single-photo days', () => {
      const beforeDaily: PhotoTimestampItem[] = [
        { id: 'pre_1', taken_at: BASE_TIME - 48 * HOUR_MS },
        { id: 'pre_2', taken_at: BASE_TIME - 24 * HOUR_MS },
      ];

      const validTrip = createPhotoSequence(18, 20 * 60 * 1000, BASE_TIME, 'trip');

      const lastTripPhotoTime = validTrip[validTrip.length - 1].taken_at;
      const afterDaily: PhotoTimestampItem[] = [
        { id: 'post_1', taken_at: lastTripPhotoTime + 24 * HOUR_MS },
        { id: 'post_2', taken_at: lastTripPhotoTime + 48 * HOUR_MS },
      ];

      const all = [...beforeDaily, ...validTrip, ...afterDaily];
      const trips = detectTrips(all, { timeZone: 'UTC' });

      expect(trips).toHaveLength(1);
      expect(trips[0].cover_photo_id).toBe('trip_1');
      expect(trips[0].photo_count).toBe(18);
    });
  });

  describe('Robustness and edge cases', () => {
    it('handles out-of-order input by sorting chronologically', () => {
      const photos = createPhotoSequence(16, 20 * 60 * 1000, BASE_TIME, 'shuffle');
      // Shuffled copy
      const shuffled = [...photos].sort(() => Math.random() - 0.5);

      const trips = detectTrips(shuffled, { timeZone: 'UTC' });
      expect(trips).toHaveLength(1);
      expect(trips[0].cover_photo_id).toBe('shuffle_1');
      expect(trips[0].start_at).toBe(photos[0].taken_at);
      expect(trips[0].end_at).toBe(photos[photos.length - 1].taken_at);
      expect(trips[0].photo_ids).toEqual(photos.map((p) => p.id));
    });

    it('handles photos with identical timestamps', () => {
      const photos: PhotoTimestampItem[] = [];
      // 5 photos at time 0, 5 photos at time +1.5h, 5 photos at time +3h
      for (let i = 0; i < 5; i++) {
        photos.push({ id: `a_${i + 1}`, taken_at: BASE_TIME });
        photos.push({ id: `b_${i + 1}`, taken_at: BASE_TIME + 1.5 * HOUR_MS });
        photos.push({ id: `c_${i + 1}`, taken_at: BASE_TIME + 3 * HOUR_MS });
      }

      const trips = detectTrips(photos, { timeZone: 'UTC' });
      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(15);
      expect(trips[0].end_at - trips[0].start_at).toBe(3 * HOUR_MS);
    });

    it('returns empty array when input is empty', () => {
      expect(detectTrips([])).toEqual([]);
    });

    it('filters out invalid or malformed photo entries', () => {
      const valid = createPhotoSequence(15, 20 * 60 * 1000, BASE_TIME, 'valid');
      const malformed: unknown[] = [
        null,
        undefined,
        {},
        { id: '', taken_at: BASE_TIME },
        { id: 'no_time' },
        { id: 'nan_time', taken_at: NaN },
        { id: 'neg_time', taken_at: -100 },
      ];

      const trips = detectTrips([...(malformed as PhotoTimestampItem[]), ...valid], {
        timeZone: 'UTC',
      });
      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(15);
    });

    it('supports custom options overrides', () => {
      // 5 photos, 1 hour apart (span = 4 hours)
      const photos = createPhotoSequence(5, HOUR_MS, BASE_TIME, 'custom');

      // With default config, 5 photos is rejected (< 15)
      expect(detectTrips(photos)).toHaveLength(0);

      // With custom options: minPhotos: 5, minHours: 2, gapHours: 4
      const trips = detectTrips(photos, {
        minPhotos: 5,
        minHours: 2,
        gapHours: 4,
        timeZone: 'UTC',
      });
      expect(trips).toHaveLength(1);
      expect(trips[0].photo_count).toBe(5);
    });
  });
});
