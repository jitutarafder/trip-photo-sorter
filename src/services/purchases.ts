import { useState, useEffect, useCallback } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import { isPro, setPro } from '../db/repositories/settings';
import { getTripById } from '../db/repositories/trips';
import { CONFIG } from '../domain/config';

export interface TripFreeTierStatus {
  tripId: string;
  scannedCount: number;
  limit: number;
  isPro: boolean;
  isGateEnabled: boolean;
  canScanMore: boolean;
  remainingFreeScans: number;
  requiresPaywall: boolean;
}

export interface ProProductDetails {
  id: string;
  title: string;
  price: string;
  currency: string;
  benefits: string[];
}

export interface UseProStatusResult {
  isPro: boolean;
  isPurchased: boolean;
  isGateEnabled: boolean;
  isLoading: boolean;
  error: Error | null;
  unlockPro: () => Promise<boolean>;
  restorePurchases: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

export interface UseTripFreeTierResult {
  status: TripFreeTierStatus | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Returns product details for the Pro unlock tier.
 * (Source of truth: PRD §8 Open Decision D-2 & AppFlow §3.8)
 */
export function getProProductDetails(): ProProductDetails {
  return {
    id: 'trip_photo_sorter_pro',
    title: 'Trip Photo Sorter Pro',
    price: CONFIG.PRO_PRICE_USD,
    currency: 'USD',
    benefits: [
      'Unlimited photos scanned per trip (free limit: 50 photos)',
      'Export unlimited high-resolution photos and ZIPs',
      'Batch export all people at once',
      '100% on-device & private forever',
    ],
  };
}

/**
 * Checks whether the current user has Pro status unlocked.
 *
 * Rules (PRD US-11, TRD §1, 06_Plan Task 2.9):
 * - If `ENABLE_PRO_GATE` is false (default in $0 MVP), returns `true` (everything unlocked).
 * - If `overrideGate` is explicitly true (or `ENABLE_PRO_GATE` is true), checks SQLite `settings.is_pro`.
 */
export async function isProUser(
  db?: SQLiteDatabase,
  overrideGate?: boolean
): Promise<boolean> {
  const isGateActive = overrideGate !== undefined ? overrideGate : CONFIG.ENABLE_PRO_GATE;
  if (!isGateActive) {
    // Feature flag OFF ($0 MVP): everything is unlocked
    return true;
  }
  const database = db ?? (await getDatabase());
  return await isPro(database);
}

/**
 * Updates the user's Pro status in local SQLite settings.
 */
export async function setProStatus(
  value: boolean,
  db?: SQLiteDatabase
): Promise<void> {
  const database = db ?? (await getDatabase());
  await setPro(value, database);
}

/**
 * Calculates the free-tier status and remaining quota for a trip.
 *
 * Rules (05_Schema §3 Key Queries, PRD US-11):
 * - Free limit is 50 scanned photos per trip (`CONFIG.FREE_SCAN_LIMIT_PER_TRIP`).
 * - Free-tier check: `trips.scanned_count < 50` unless `settings.is_pro = '1'`.
 */
export async function getTripFreeTierStatus(
  tripId: string,
  db?: SQLiteDatabase,
  overrideGate?: boolean
): Promise<TripFreeTierStatus> {
  const database = db ?? (await getDatabase());
  const trip = await getTripById(tripId, database);
  const isGateActive = overrideGate !== undefined ? overrideGate : CONFIG.ENABLE_PRO_GATE;
  const isUserPro = await isProUser(database, overrideGate);

  const scannedCount = trip?.scanned_count ?? 0;
  const limit = CONFIG.FREE_SCAN_LIMIT_PER_TRIP;

  if (isUserPro) {
    return {
      tripId,
      scannedCount,
      limit,
      isPro: true,
      isGateEnabled: isGateActive,
      canScanMore: true,
      remainingFreeScans: Infinity,
      requiresPaywall: false,
    };
  }

  const remainingFreeScans = Math.max(0, limit - scannedCount);
  const canScanMore = scannedCount < limit;
  const requiresPaywall = scannedCount >= limit;

  return {
    tripId,
    scannedCount,
    limit,
    isPro: false,
    isGateEnabled: isGateActive,
    canScanMore,
    remainingFreeScans,
    requiresPaywall,
  };
}

/**
 * Checks whether a batch of photos can be scanned under the free-tier rules.
 */
export async function canScanPhotos(
  tripId: string,
  requestedCount: number,
  db?: SQLiteDatabase,
  overrideGate?: boolean
): Promise<{ allowed: boolean; allowedCount: number; requiresPaywall: boolean }> {
  const status = await getTripFreeTierStatus(tripId, db, overrideGate);
  if (status.isPro) {
    return { allowed: true, allowedCount: requestedCount, requiresPaywall: false };
  }

  const allowedCount = Math.min(requestedCount, status.remainingFreeScans);
  const allowed = allowedCount > 0;
  const requiresPaywall = status.requiresPaywall || allowedCount < requestedCount;

  return {
    allowed,
    allowedCount,
    requiresPaywall,
  };
}

/**
 * Purchases stub to simulate unlocking Pro.
 * (Full StoreKit integration deferred until paid developer account exists, PRD §7/§8).
 */
export async function unlockProStub(db?: SQLiteDatabase): Promise<boolean> {
  const database = db ?? (await getDatabase());
  await setPro(true, database);
  return true;
}

/**
 * Purchases stub to simulate restoring previous purchases.
 */
export async function restorePurchasesStub(db?: SQLiteDatabase): Promise<boolean> {
  const database = db ?? (await getDatabase());
  return await isPro(database);
}

/**
 * Placeholder receipt validation stub.
 * Note: per 04_TRD §6, network calls (`fetch`) are exclusively permitted in this file.
 */
export async function verifyReceiptStub(
  _receiptData: string
): Promise<{ valid: boolean; isPro: boolean }> {
  // In production with store backend:
  // const response = await fetch('https://api.storekit.receipt-validator.com/verify', ...);
  return { valid: true, isPro: true };
}

/**
 * Hook to observe user Pro status with refresh and stub purchase triggers.
 */
export function useProStatus(
  db?: SQLiteDatabase,
  overrideGate?: boolean
): UseProStatusResult {
  const [proStatus, setProStatusState] = useState<boolean>(true);
  const [isPurchasedState, setIsPurchasedState] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const isGateEnabled = overrideGate !== undefined ? overrideGate : CONFIG.ENABLE_PRO_GATE;

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const database = db ?? (await getDatabase());
      const pro = await isProUser(database, overrideGate);
      setProStatusState(pro);
      const purchased = await isPro(database);
      setIsPurchasedState(purchased);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [db, overrideGate]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const unlockPro = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await unlockProStub(db);
      await fetchStatus();
      return res;
    } finally {
      setIsLoading(false);
    }
  }, [db, fetchStatus]);

  const restorePurchases = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await restorePurchasesStub(db);
      await fetchStatus();
      return res;
    } finally {
      setIsLoading(false);
    }
  }, [db, fetchStatus]);

  return {
    isPro: proStatus,
    isPurchased: isPurchasedState,
    isGateEnabled,
    isLoading,
    error,
    unlockPro,
    restorePurchases,
    refresh: fetchStatus,
  };
}

/**
 * Hook to observe a trip's free-tier scanning quota and status.
 */
export function useTripFreeTier(
  tripId: string,
  db?: SQLiteDatabase,
  overrideGate?: boolean
): UseTripFreeTierResult {
  const [status, setStatus] = useState<TripFreeTierStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await getTripFreeTierStatus(tripId, db, overrideGate);
      setStatus(res);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [tripId, db, overrideGate]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return {
    status,
    isLoading,
    error,
    refresh: fetchStatus,
  };
}
