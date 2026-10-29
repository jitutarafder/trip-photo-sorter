import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Modal,
  ScrollView,
  Pressable,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import {
  MoreVertical,
  Calendar,
  GitMerge,
  EyeOff,
  Edit2,
  X,
  AlertCircle,
} from 'lucide-react-native';
import { useTheme } from '../../../src/hooks/useTheme';
import {
  Button,
  Banner,
  EmptyState,
  Skeleton,
  TextField,
} from '../../../src/components/ui';
import { PhotoTile } from '../../../src/components/photos/PhotoTile';
import {
  getTripById,
  updateTrip,
  getAllTrips,
  mergeTrips,
} from '../../../src/db/repositories/trips';
import { getPhotosByTripId } from '../../../src/db/repositories/photos';
import { adjustTripDates } from '../../../src/services/tripService';
import { useTripFreeTier } from '../../../src/services/purchases';
import { formatTripDateRange } from '../../../src/domain/tripDetection';
import type { TripRow, PhotoRow } from '../../../src/db/types';

/**
 * Trip Detail Screen (02_AppFlow §3.3, 03_UI_Spec, PRD US-03/US-04)
 *
 * Displays:
 * - Header with trip name, date range, photo count, and overflow menu button
 * - Free-tier gate banner when photo_count > 50 and not Pro
 * - Primary action button based on trip.scan_status
 * - FlashList 3-column photo grid (gap: 2, radius: 4)
 * - Empty state with "Adjust dates" CTA when 0 photos in range
 * - Modals for Rename, Adjust Dates, Merge With..., and Hide Trip
 */
export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, tokens } = useTheme();

  const [trip, setTrip] = useState<TripRow | null>(null);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Overflow menu & dialog states
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const [isRenameModalOpen, setIsRenameModalOpen] = useState<boolean>(false);
  const [isAdjustDatesModalOpen, setIsAdjustDatesModalOpen] = useState<boolean>(false);
  const [isMergeModalOpen, setIsMergeModalOpen] = useState<boolean>(false);
  const [isHideConfirmOpen, setIsHideConfirmOpen] = useState<boolean>(false);

  // Form input states
  const [renameValue, setRenameValue] = useState<string>('');
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const [startDateInput, setStartDateInput] = useState<string>('');
  const [endDateInput, setEndDateInput] = useState<string>('');
  const [datesError, setDatesError] = useState<string | undefined>(undefined);

  // Available trips for merge
  const [otherTrips, setOtherTrips] = useState<TripRow[]>([]);
  const [selectedMergeTripId, setSelectedMergeTripId] = useState<string | null>(null);

  // Free tier status
  const { status: freeTierStatus } = useTripFreeTier(id ?? '');

  // Load trip and photo data
  const loadTripData = useCallback(async () => {
    if (!id) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const tripData = await getTripById(id);
      if (!tripData) {
        setLoadError('Trip not found');
        return;
      }
      setTrip(tripData);
      setRenameValue(tripData.name);

      const dStart = new Date(tripData.start_at);
      const dEnd = new Date(tripData.end_at);
      setStartDateInput(dStart.toISOString().slice(0, 10));
      setEndDateInput(dEnd.toISOString().slice(0, 10));

      const photosData = await getPhotosByTripId(id);
      setPhotos(photosData);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load trip');
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadTripData();
  }, [loadTripData]);

  // Load other trips when merge modal opens
  const openMergeModal = async () => {
    setIsMenuOpen(false);
    try {
      const all = await getAllTrips({ includeHidden: false });
      const candidates = all.filter((t) => t.id !== id);
      setOtherTrips(candidates);
      setSelectedMergeTripId(candidates[0]?.id ?? null);
      setIsMergeModalOpen(true);
    } catch {
      Alert.alert('Error', 'Unable to fetch other trips for merge.');
    }
  };

  // Handler: Rename trip
  const handleSaveRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError('Trip name cannot be empty');
      return;
    }
    if (!trip) return;

    try {
      const updated = await updateTrip(trip.id, {
        name: trimmed,
        is_user_edited: 1,
      });
      if (updated) {
        setTrip(updated);
      }
      setIsRenameModalOpen(false);
      setRenameError(undefined);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename trip');
    }
  };

  // Handler: Adjust trip dates
  const handleSaveAdjustDates = async () => {
    if (!trip) return;

    const startMs = Date.parse(startDateInput + 'T00:00:00');
    const endMs = Date.parse(endDateInput + 'T23:59:59.999');

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      setDatesError('Please enter valid dates (YYYY-MM-DD)');
      return;
    }

    if (startMs > endMs) {
      setDatesError('Start date must be before end date');
      return;
    }

    try {
      const updated = await adjustTripDates(trip.id, startMs, endMs);
      setTrip(updated);
      const updatedPhotos = await getPhotosByTripId(trip.id);
      setPhotos(updatedPhotos);
      setIsAdjustDatesModalOpen(false);
      setDatesError(undefined);
    } catch (err) {
      setDatesError(err instanceof Error ? err.message : 'Failed to adjust dates');
    }
  };

  // Handler: Merge trip
  const handleConfirmMerge = async () => {
    if (!trip || !selectedMergeTripId) return;

    try {
      setIsLoading(true);
      const merged = await mergeTrips(trip.id, selectedMergeTripId);
      setTrip(merged);
      const updatedPhotos = await getPhotosByTripId(merged.id);
      setPhotos(updatedPhotos);
      setIsMergeModalOpen(false);
    } catch (err) {
      Alert.alert('Merge Failed', err instanceof Error ? err.message : 'Could not merge trips');
    } finally {
      setIsLoading(false);
    }
  };

  // Handler: Hide trip
  const handleConfirmHide = async () => {
    if (!trip) return;
    try {
      await updateTrip(trip.id, {
        is_hidden: 1,
        is_user_edited: 1,
      });
      setIsHideConfirmOpen(false);
      router.back();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not hide trip');
    }
  };

  // Primary action button setup
  const primaryButtonConfig = useMemo(() => {
    if (!trip) return null;

    switch (trip.scan_status) {
      case 'scanned':
        return {
          title: 'View people',
          variant: 'primary' as const,
          onPress: () => router.push(`/trip/${trip.id}/people`),
        };
      case 'paused':
        return {
          title: 'Resume scan',
          variant: 'primary' as const,
          onPress: () => router.push(`/trip/${trip.id}/scan`),
        };
      case 'scanning':
      case 'clustering':
        return {
          title: 'Scanning in progress...',
          variant: 'secondary' as const,
          onPress: () => router.push(`/trip/${trip.id}/scan`),
        };
      case 'failed':
        return {
          title: 'Retry scan',
          variant: 'primary' as const,
          onPress: () => router.push(`/trip/${trip.id}/scan`),
        };
      case 'not_scanned':
      default:
        return {
          title: 'Scan faces',
          variant: 'primary' as const,
          onPress: () => router.push(`/trip/${trip.id}/scan`),
        };
    }
  }, [trip, router]);

  // Render individual photo tile in 3-column grid
  const renderPhotoItem: ListRenderItem<PhotoRow> = useCallback(
    ({ item }) => (
      <View style={styles.gridItemWrapper}>
        <PhotoTile photoId={item.id} testID={`trip-photo-${item.id}`} />
      </View>
    ),
    []
  );

  // Header content rendered inside list or above grid
  const renderListHeader = () => {
    if (!trip) return null;

    const dateRange = formatTripDateRange(trip.start_at, trip.end_at);
    const photoCountStr = photos.length === 1 ? '1 photo' : `${photos.length} photos`;
    const showFreeLimitBanner =
      freeTierStatus &&
      !freeTierStatus.isPro &&
      freeTierStatus.isGateEnabled &&
      trip.photo_count > 50;

    return (
      <View style={styles.headerContainer}>
        {/* Trip Title & Overflow Trigger */}
        <View style={styles.titleRow}>
          <Pressable
            testID="trip-name-pressable"
            onPress={() => {
              setRenameValue(trip.name);
              setIsRenameModalOpen(true);
            }}
            style={styles.nameContainer}
            accessibilityRole="button"
            accessibilityLabel={`Rename ${trip.name}`}
          >
            <Text
              style={[
                styles.titleText,
                {
                  fontSize: tokens.typography.title.fontSize,
                  fontWeight: tokens.typography.title.fontWeight,
                  color: colors.text,
                },
              ]}
              numberOfLines={2}
            >
              {trip.name}
            </Text>
            <Edit2
              size={16}
              color={colors.textMuted}
              strokeWidth={2}
              style={styles.inlineEditIcon}
            />
          </Pressable>

          <Pressable
            testID="overflow-menu-button"
            onPress={() => setIsMenuOpen(true)}
            style={[styles.iconButton, { backgroundColor: colors.surfaceAlt }]}
            accessibilityRole="button"
            accessibilityLabel="Trip actions menu"
          >
            <MoreVertical size={20} color={colors.text} strokeWidth={2} />
          </Pressable>
        </View>

        {/* Date Range & Photo Count */}
        <View style={styles.metaRow}>
          <Calendar size={14} color={colors.textMuted} strokeWidth={2} />
          <Text
            style={[
              styles.metaText,
              {
                fontSize: tokens.typography.caption.fontSize,
                color: colors.textMuted,
              },
            ]}
          >
            {dateRange} · {photoCountStr}
          </Text>
        </View>

        {/* Notice for skipped iCloud photos (02_AppFlow §4, 01_PRD §7) */}
        {photos.filter((p) => p.is_local === 0 || p.scan_status === 'skipped').length > 0 ? (
          <Banner
            testID="trip-icloud-skipped-banner"
            variant="info"
            message={`${photos.filter((p) => p.is_local === 0 || p.scan_status === 'skipped').length} ${
              photos.filter((p) => p.is_local === 0 || p.scan_status === 'skipped').length === 1
                ? 'photo in iCloud was'
                : 'photos in iCloud were'
            } skipped. Download to this device to scan faces.`}
            style={styles.bannerSpacing}
          />
        ) : null}

        {/* Free-limit banner (02_AppFlow §3.3) */}
        {showFreeLimitBanner ? (
          <Banner
            variant="warning"
            message="Free scans first 50 photos. Unlock Pro."
            action={{
              label: 'Unlock Pro',
              onPress: () => router.push('/paywall'),
            }}
            testID="free-limit-banner"
            style={styles.bannerSpacing}
          />
        ) : null}

        {/* Primary Action Button */}
        {primaryButtonConfig ? (
          <View style={styles.primaryButtonWrapper}>
            <Button
              variant={primaryButtonConfig.variant}
              title={primaryButtonConfig.title}
              onPress={primaryButtonConfig.onPress}
              testID="trip-primary-button"
              accessibilityLabel={primaryButtonConfig.title}
            />
          </View>
        ) : null}
      </View>
    );
  };

  // Loading state
  if (isLoading && !trip) {
    return (
      <View
        testID="trip-detail-loading"
        style={[styles.container, { backgroundColor: colors.bg }]}
      >
        <Stack.Screen options={{ title: 'Trip' }} />
        <View style={styles.loadingPadding}>
          <Skeleton width="70%" height={28} borderRadius={tokens.radius.sm} />
          <Skeleton
            width="40%"
            height={16}
            borderRadius={tokens.radius.sm}
            style={{ marginTop: 8 }}
          />
          <Skeleton
            width="100%"
            height={44}
            borderRadius={tokens.radius.pill}
            style={{ marginTop: 16 }}
          />
          <View style={styles.skeletonGrid}>
            {[...Array(9)].map((_, i) => (
              <Skeleton
                key={`skel-${i}`}
                width="32%"
                height={100}
                borderRadius={tokens.radius.photo}
                style={{ marginBottom: 4 }}
              />
            ))}
          </View>
        </View>
      </View>
    );
  }

  // Error state
  if (loadError || !trip) {
    return (
      <View
        testID="trip-detail-error"
        style={[styles.container, styles.centered, { backgroundColor: colors.bg }]}
      >
        <Stack.Screen options={{ title: 'Trip' }} />
        <AlertCircle size={48} color={colors.danger} strokeWidth={1.5} />
        <Text
          style={[
            styles.errorTitle,
            {
              fontSize: tokens.typography.heading.fontSize,
              fontWeight: tokens.typography.heading.fontWeight,
              color: colors.text,
            },
          ]}
        >
          {loadError ?? 'Trip not found'}
        </Text>
        <Button
          variant="primary"
          title="Retry"
          onPress={loadTripData}
          testID="trip-retry-button"
          style={{ marginTop: tokens.spacing.md }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: trip.name }} />

      {/* Main Content: FlashList or EmptyState */}
      {photos.length === 0 ? (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {renderListHeader()}
          <EmptyState
            title="No photos in this range"
            body="Adjust the date boundaries to include photos from your library."
            actionTitle="Adjust dates"
            onActionPress={() => {
              setDatesError(undefined);
              setIsAdjustDatesModalOpen(true);
            }}
            testID="empty-photos-state"
            style={{ marginTop: tokens.spacing.xl }}
          />
        </ScrollView>
      ) : (
        <FlashList
          data={photos}
          keyExtractor={(item) => item.id}
          numColumns={3}
          renderItem={renderPhotoItem}
          ListHeaderComponent={renderListHeader}
          contentContainerStyle={styles.listContent}
          testID="trip-photo-grid"
        />
      )}

      {/* Overflow Menu Sheet / Modal */}
      <Modal
        visible={isMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsMenuOpen(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => setIsMenuOpen(false)}
          testID="overflow-menu-overlay"
        >
          <View
            style={[
              styles.menuContainer,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderRadius: tokens.radius.lg,
              },
            ]}
          >
            <Pressable
              testID="menu-action-rename"
              style={styles.menuItem}
              onPress={() => {
                setIsMenuOpen(false);
                setRenameError(undefined);
                setRenameValue(trip.name);
                setIsRenameModalOpen(true);
              }}
            >
              <Edit2 size={18} color={colors.text} strokeWidth={2} />
              <Text style={[styles.menuItemText, { color: colors.text }]}>Rename</Text>
            </Pressable>

            <Pressable
              testID="menu-action-merge"
              style={styles.menuItem}
              onPress={openMergeModal}
            >
              <GitMerge size={18} color={colors.text} strokeWidth={2} />
              <Text style={[styles.menuItemText, { color: colors.text }]}>Merge with…</Text>
            </Pressable>

            <Pressable
              testID="menu-action-adjust-dates"
              style={styles.menuItem}
              onPress={() => {
                setIsMenuOpen(false);
                setDatesError(undefined);
                setIsAdjustDatesModalOpen(true);
              }}
            >
              <Calendar size={18} color={colors.text} strokeWidth={2} />
              <Text style={[styles.menuItemText, { color: colors.text }]}>Adjust dates</Text>
            </Pressable>

            <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />

            <Pressable
              testID="menu-action-hide"
              style={styles.menuItem}
              onPress={() => {
                setIsMenuOpen(false);
                setIsHideConfirmOpen(true);
              }}
            >
              <EyeOff size={18} color={colors.danger} strokeWidth={2} />
              <Text style={[styles.menuItemText, { color: colors.danger }]}>Hide trip</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Rename Modal */}
      <Modal
        visible={isRenameModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsRenameModalOpen(false)}
      >
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View
            style={[
              styles.dialogContainer,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderRadius: tokens.radius.lg,
              },
            ]}
          >
            <View style={styles.dialogHeader}>
              <Text
                style={[
                  styles.dialogTitle,
                  {
                    fontSize: tokens.typography.heading.fontSize,
                    fontWeight: tokens.typography.heading.fontWeight,
                    color: colors.text,
                  },
                ]}
              >
                Rename Trip
              </Text>
              <Pressable
                onPress={() => setIsRenameModalOpen(false)}
                testID="rename-close-button"
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>

            <TextField
              value={renameValue}
              onChangeText={(text) => {
                setRenameValue(text);
                if (renameError) setRenameError(undefined);
              }}
              placeholder="Trip name"
              error={renameError}
              autoFocus
              testID="rename-input"
            />

            <View style={styles.dialogButtons}>
              <Button
                variant="ghost"
                title="Cancel"
                onPress={() => setIsRenameModalOpen(false)}
                testID="rename-cancel-button"
              />
              <Button
                variant="primary"
                title="Save"
                onPress={handleSaveRename}
                testID="rename-save-button"
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Adjust Dates Modal */}
      <Modal
        visible={isAdjustDatesModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsAdjustDatesModalOpen(false)}
      >
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View
            style={[
              styles.dialogContainer,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderRadius: tokens.radius.lg,
              },
            ]}
          >
            <View style={styles.dialogHeader}>
              <Text
                style={[
                  styles.dialogTitle,
                  {
                    fontSize: tokens.typography.heading.fontSize,
                    fontWeight: tokens.typography.heading.fontWeight,
                    color: colors.text,
                  },
                ]}
              >
                Adjust Dates
              </Text>
              <Pressable
                onPress={() => setIsAdjustDatesModalOpen(false)}
                testID="adjust-dates-close-button"
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>

            <Text
              style={[
                styles.dialogSubtitle,
                {
                  fontSize: tokens.typography.caption.fontSize,
                  color: colors.textMuted,
                  marginBottom: tokens.spacing.sm,
                },
              ]}
            >
              Enter start and end dates (YYYY-MM-DD):
            </Text>

            <TextField
              label="Start Date"
              value={startDateInput}
              onChangeText={(t) => {
                setStartDateInput(t);
                if (datesError) setDatesError(undefined);
              }}
              placeholder="YYYY-MM-DD"
              testID="start-date-input"
            />

            <View style={{ height: tokens.spacing.xs }} />

            <TextField
              label="End Date"
              value={endDateInput}
              onChangeText={(t) => {
                setEndDateInput(t);
                if (datesError) setDatesError(undefined);
              }}
              placeholder="YYYY-MM-DD"
              error={datesError}
              testID="end-date-input"
            />

            <View style={styles.dialogButtons}>
              <Button
                variant="ghost"
                title="Cancel"
                onPress={() => setIsAdjustDatesModalOpen(false)}
                testID="adjust-dates-cancel-button"
              />
              <Button
                variant="primary"
                title="Save"
                onPress={handleSaveAdjustDates}
                testID="adjust-dates-save-button"
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Merge Trip Modal */}
      <Modal
        visible={isMergeModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsMergeModalOpen(false)}
      >
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View
            style={[
              styles.dialogContainer,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderRadius: tokens.radius.lg,
                maxHeight: '80%',
              },
            ]}
          >
            <View style={styles.dialogHeader}>
              <Text
                style={[
                  styles.dialogTitle,
                  {
                    fontSize: tokens.typography.heading.fontSize,
                    fontWeight: tokens.typography.heading.fontWeight,
                    color: colors.text,
                  },
                ]}
              >
                Merge With…
              </Text>
              <Pressable
                onPress={() => setIsMergeModalOpen(false)}
                testID="merge-close-button"
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>

            {otherTrips.length === 0 ? (
              <Text
                style={[
                  styles.dialogSubtitle,
                  {
                    fontSize: tokens.typography.body.fontSize,
                    color: colors.textMuted,
                    paddingVertical: tokens.spacing.md,
                  },
                ]}
              >
                No other trips available to merge with.
              </Text>
            ) : (
              <ScrollView style={styles.mergeList}>
                {otherTrips.map((ot) => {
                  const isSelected = selectedMergeTripId === ot.id;
                  const otRange = formatTripDateRange(ot.start_at, ot.end_at);
                  return (
                    <Pressable
                      key={ot.id}
                      testID={`merge-candidate-${ot.id}`}
                      onPress={() => setSelectedMergeTripId(ot.id)}
                      style={[
                        styles.mergeItem,
                        {
                          borderColor: isSelected ? colors.primary : colors.border,
                          backgroundColor: isSelected
                            ? 'rgba(108, 140, 255, 0.1)'
                            : colors.surfaceAlt,
                          borderRadius: tokens.radius.md,
                        },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.mergeItemName,
                            {
                              fontSize: tokens.typography.bodyStrong.fontSize,
                              fontWeight: tokens.typography.bodyStrong.fontWeight,
                              color: colors.text,
                            },
                          ]}
                          numberOfLines={1}
                        >
                          {ot.name}
                        </Text>
                        <Text
                          style={[
                            styles.mergeItemDates,
                            {
                              fontSize: tokens.typography.caption.fontSize,
                              color: colors.textMuted,
                            },
                          ]}
                        >
                          {otRange} · {ot.photo_count} photos
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}

            <View style={styles.dialogButtons}>
              <Button
                variant="ghost"
                title="Cancel"
                onPress={() => setIsMergeModalOpen(false)}
                testID="merge-cancel-button"
              />
              <Button
                variant="primary"
                title="Merge"
                disabled={!selectedMergeTripId || otherTrips.length === 0}
                onPress={handleConfirmMerge}
                testID="merge-confirm-button"
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Hide Trip Confirmation Dialog */}
      <Modal
        visible={isHideConfirmOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsHideConfirmOpen(false)}
      >
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View
            style={[
              styles.dialogContainer,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderRadius: tokens.radius.lg,
              },
            ]}
          >
            <Text
              style={[
                styles.dialogTitle,
                {
                  fontSize: tokens.typography.heading.fontSize,
                  fontWeight: tokens.typography.heading.fontWeight,
                  color: colors.text,
                },
              ]}
            >
              Hide this trip?
            </Text>
            <Text
              style={[
                styles.dialogSubtitle,
                {
                  fontSize: tokens.typography.body.fontSize,
                  color: colors.textMuted,
                  marginTop: tokens.spacing.xs,
                  marginBottom: tokens.spacing.md,
                },
              ]}
            >
              This trip will be hidden from your trips list. You can restore hidden trips
              anytime from Settings.
            </Text>

            <View style={styles.dialogButtons}>
              <Button
                variant="ghost"
                title="Cancel"
                onPress={() => setIsHideConfirmOpen(false)}
                testID="hide-cancel-button"
              />
              <Button
                variant="danger"
                title="Hide Trip"
                onPress={handleConfirmHide}
                testID="hide-confirm-button"
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  nameContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
    minHeight: 44,
  },
  titleText: {
    letterSpacing: -0.3,
  },
  inlineEditIcon: {
    marginLeft: 8,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  metaText: {
    marginLeft: 6,
  },
  bannerSpacing: {
    marginTop: 12,
  },
  primaryButtonWrapper: {
    marginTop: 14,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  scrollContent: {
    paddingBottom: 32,
  },
  gridItemWrapper: {
    flex: 1 / 3,
    padding: 1, // 2px gap between cells
  },
  loadingPadding: {
    padding: 16,
  },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  errorTitle: {
    marginTop: 16,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  menuContainer: {
    position: 'absolute',
    top: 70,
    right: 16,
    width: 200,
    borderWidth: 1,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  menuItemText: {
    fontSize: 15,
    fontWeight: '500',
    marginLeft: 12,
  },
  menuDivider: {
    height: 1,
    marginVertical: 4,
  },
  dialogContainer: {
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    padding: 20,
  },
  dialogHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  dialogTitle: {
    letterSpacing: -0.2,
  },
  dialogSubtitle: {
    lineHeight: 20,
  },
  dialogButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 20,
  },
  mergeList: {
    maxHeight: 260,
    marginVertical: 8,
  },
  mergeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderWidth: 1.5,
    marginBottom: 8,
    minHeight: 52,
  },
  mergeItemName: {
    marginBottom: 2,
  },
  mergeItemDates: {},
});
