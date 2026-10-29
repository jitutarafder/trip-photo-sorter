import React, { useEffect, useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Settings, Compass, AlertCircle } from 'lucide-react-native';
import { useTheme } from '../src/theme';
import { Banner } from '../src/components/ui/Banner';
import { Skeleton } from '../src/components/ui/Skeleton';
import { EmptyState } from '../src/components/ui/EmptyState';
import { TripCard } from '../src/components/trips/TripCard';
import { useLibraryPermission } from '../src/hooks/useLibraryPermission';
import { isOnboarded } from '../src/db/repositories/settings';
import { getAllTrips } from '../src/db/repositories/trips';
import { syncLibrary } from '../src/services/library';
import { detectAndPersistTrips } from '../src/services/tripService';
import type { TripRow } from '../src/db/types';

/**
 * Home Screen route (02_AppFlow §3.2, 01_PRD US-02, 03_UI_Spec §6)
 *
 * Displays:
 * - Header with title "Trips" and gear icon navigating to /settings
 * - Warning banner if library permission is limited
 * - FlashList of detected trips (sorted start_at DESC)
 * - TripCard with cover, date range, photo count, scan status badge, and press scale
 * - Loading state with 3 skeleton cards
 * - Empty state with "No trips found yet" + "Rescan library" action
 * - Error state with error message + "Retry" action
 * - Pull-to-refresh library re-sync and trip re-detection
 */
export default function HomeScreen() {
  const { colors, tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { status, isLoading: isPermissionLoading, presentPicker } = useLibraryPermission();

  const [checkingOnboarding, setCheckingOnboarding] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trips, setTrips] = useState<TripRow[]>([]);

  // 1. Initial Onboarding & Permission Check
  useEffect(() => {
    async function checkState() {
      try {
        const onboarded = await isOnboarded();

        if (!onboarded || status === 'denied') {
          router.replace('/onboarding');
          return;
        }
      } catch {
        // If DB fails to read or is fresh, safely redirect to onboarding
        router.replace('/onboarding');
        return;
      } finally {
        setCheckingOnboarding(false);
      }
    }

    if (!isPermissionLoading) {
      checkState();
    }
  }, [router, status, isPermissionLoading]);

  // 2. Fetch Trips from Local SQLite
  const loadTripsFromDb = useCallback(async (): Promise<TripRow[]> => {
    const rows = await getAllTrips({ includeHidden: false });
    setTrips(rows);
    return rows;
  }, []);

  // 3. Sync Library & Detect Trips
  const syncAndDetectTrips = useCallback(
    async (forceFull = false) => {
      try {
        setError(null);
        // Step 1: Incremental library sync
        await syncLibrary({ forceFullSync: forceFull });
        // Step 2: Auto-detect trips from synced photos
        await detectAndPersistTrips();
        // Step 3: Refresh trips list from SQLite
        await loadTripsFromDb();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    },
    [loadTripsFromDb]
  );

  // Initial data load when onboarding check completes
  useEffect(() => {
    if (checkingOnboarding || status === 'denied') return;

    let isMounted = true;

    async function initialLoad() {
      setIsLoading(true);
      setError(null);
      try {
        const cachedTrips = await loadTripsFromDb();
        if (!isMounted) return;

        // If no cached trips exist yet, run initial sync & detection
        if (cachedTrips.length === 0) {
          await syncAndDetectTrips(false);
        } else {
          // If cached trips exist, sync in background without blocking UI
          syncAndDetectTrips(false).catch(() => {
            /* ignore background sync error */
          });
        }
      } catch (err) {
        if (!isMounted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    initialLoad();

    return () => {
      isMounted = false;
    };
  }, [checkingOnboarding, status, loadTripsFromDb, syncAndDetectTrips]);

  // Pull-to-refresh handler
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await syncAndDetectTrips(false);
    } finally {
      setIsRefreshing(false);
    }
  }, [syncAndDetectTrips]);

  // Force Rescan handler (for empty state CTA)
  const handleRescan = useCallback(async () => {
    setIsLoading(true);
    try {
      await syncAndDetectTrips(true);
    } finally {
      setIsLoading(false);
    }
  }, [syncAndDetectTrips]);

  // If still checking onboarding status, render background container
  if (checkingOnboarding) {
    return (
      <View testID="home-loading-check" style={[styles.container, { backgroundColor: colors.bg }]} />
    );
  }

  // Render Header Settings Gear Action
  const renderHeaderRight = () => (
    <TouchableOpacity
      testID="header-settings-button"
      onPress={() => router.push('/settings')}
      style={styles.headerButton}
      accessibilityRole="button"
      accessibilityLabel="Settings"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Settings size={22} color={colors.text} strokeWidth={1.8} />
    </TouchableOpacity>
  );

  // Render 3 Skeleton Cards during initial loading (02_AppFlow §3.2)
  const renderLoadingSkeletons = () => (
    <View testID="home-loading-skeletons" style={styles.skeletonsContainer}>
      <Skeleton height={160} borderRadius={tokens.radius.lg} style={styles.skeletonCard} />
      <Skeleton height={160} borderRadius={tokens.radius.lg} style={styles.skeletonCard} />
      <Skeleton height={160} borderRadius={tokens.radius.lg} style={styles.skeletonCard} />
    </View>
  );

  // Render Error State with Retry (02_AppFlow §3.2)
  const renderErrorState = () => (
    <View testID="home-error-state" style={styles.centeredContainer}>
      <EmptyState
        testID="home-error-empty-state"
        icon={<AlertCircle size={44} color={colors.danger} strokeWidth={1.75} />}
        title="Couldn't load trips"
        body={error ?? 'An unexpected error occurred while loading your trips.'}
        actionTitle="Retry"
        onActionPress={() => {
          setIsLoading(true);
          syncAndDetectTrips(false).finally(() => setIsLoading(false));
        }}
      />
    </View>
  );

  // Render Empty State when 0 trips are detected (02_AppFlow §3.2)
  const renderEmptyState = () => (
    <View testID="home-empty-state" style={styles.centeredContainer}>
      <EmptyState
        testID="home-empty-trips-state"
        icon={<Compass size={48} color={colors.primary} strokeWidth={1.75} />}
        title="No trips found yet"
        body="Photos taken within 12 hours of each other (at least 15 photos spanning 3+ hours) are automatically grouped into trips."
        actionTitle="Rescan library"
        onActionPress={handleRescan}
      />
    </View>
  );

  return (
    <View testID="home-screen" style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          title: 'Trips',
          headerRight: renderHeaderRight,
        }}
      />

      {/* Limited photo access warning banner (02_AppFlow §3.1) */}
      {status === 'limited' && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="limited-library-banner"
            variant="warning"
            title="Limited Photo Access"
            message="Only selected photos visible."
            action={{
              label: 'Manage',
              onPress: () => {
                if (presentPicker) {
                  Promise.resolve(presentPicker()).catch(() => {
                    /* ignore */
                  });
                }
              },
            }}
          />
        </View>
      )}

      {/* Body States: Loading -> Error -> Empty -> FlashList */}
      {isLoading ? (
        renderLoadingSkeletons()
      ) : error ? (
        renderErrorState()
      ) : trips.length === 0 ? (
        renderEmptyState()
      ) : (
        <View testID="home-trips-list" style={styles.listWrapper}>
          <FlashList
            testID="trips-flash-list"
            data={trips}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TripCard
                trip={item}
                onPress={() => router.push(`/trip/${item.id}`)}
              />
            )}
            contentContainerStyle={{
              paddingHorizontal: tokens.spacing.screenPadding,
              paddingTop: tokens.spacing.md,
              paddingBottom: insets.bottom + tokens.spacing.xl,
            }}
            ItemSeparatorComponent={() => <View style={{ height: tokens.spacing.lg }} />}
            refreshControl={
              <RefreshControl
                testID="home-refresh-control"
                refreshing={isRefreshing}
                onRefresh={handleRefresh}
                tintColor={colors.primary}
                colors={[colors.primary]}
              />
            }
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  bannerWrapper: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  headerButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skeletonsContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  skeletonCard: {
    marginBottom: 16,
  },
  centeredContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  listWrapper: {
    flex: 1,
  },
});
