import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import {
  ArrowLeft,
  Check,
  CheckSquare,
  Square,
  Share2,
  FileArchive,
  Image as ImageIcon,
  User,
  Sparkles,
} from 'lucide-react-native';
import { useTheme } from '../../src/hooks/useTheme';
import { getTripById } from '../../src/db/repositories/trips';
import {
  getExportPeopleSummary,
  type ExportPersonSummary,
} from '../../src/db/repositories/people';
import type { TripRow } from '../../src/db/types';
import { Button, Banner, EmptyState, ProgressRing } from '../../src/components/ui';
import { exportPerson, type ExportResult } from '../../src/services/exporter';
import { getTripFreeTierStatus, type TripFreeTierStatus } from '../../src/services/purchases';

export interface PersonExportOption {
  selected: boolean;
  mode: 'photos' | 'zip';
  soloOnly: boolean;
  status: 'idle' | 'done' | 'cancelled' | 'failed';
}

const ESTIMATED_MB_PER_PHOTO = 3.5;

export default function ExportReviewScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const router = useRouter();
  const { colors, tokens } = useTheme();

  const [trip, setTrip] = useState<TripRow | null>(null);
  const [people, setPeople] = useState<ExportPersonSummary[]>([]);
  const [freeTierStatus, setFreeTierStatus] = useState<TripFreeTierStatus | null>(null);
  const [freeStorageBytes, setFreeStorageBytes] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Per-person export configuration: keyed by personId
  const [configs, setConfigs] = useState<Record<string, PersonExportOption>>({});

  // Batch Export Queue state
  const [isQueueActive, setIsQueueActive] = useState<boolean>(false);
  const [queueIndex, setQueueIndex] = useState<number>(0);
  const [queueTotal, setQueueTotal] = useState<number>(0);
  const [queuePersonName, setQueuePersonName] = useState<string>('');

  // Toast / Feedback message
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  // Load data
  const loadData = useCallback(async () => {
    if (!tripId) return;
    try {
      setError(null);
      const [tripData, peopleData, tierStatus] = await Promise.all([
        getTripById(tripId),
        getExportPeopleSummary(tripId),
        getTripFreeTierStatus(tripId),
      ]);

      setTrip(tripData);
      setPeople(peopleData);
      setFreeTierStatus(tierStatus);

      // Initialize per-person configurations
      setConfigs((prev) => {
        const next: Record<string, PersonExportOption> = { ...prev };
        for (const person of peopleData) {
          if (!next[person.id]) {
            const isNamed = Boolean(person.name && person.name.trim().length > 0 && !person.is_others);
            const count = person.photo_count;
            next[person.id] = {
              selected: isNamed && count > 0,
              mode: count <= 30 ? 'photos' : 'zip',
              soloOnly: false,
              status: 'idle',
            };
          }
        }
        return next;
      });

      // Check available storage space
      try {
        const freeBytes = await LegacyFileSystem.getFreeDiskStorageAsync();
        setFreeStorageBytes(freeBytes);
      } catch {
        setFreeStorageBytes(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load export details';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Named people eligible for export
  const exportablePeople = useMemo(() => {
    return people.filter((p) => !p.is_others);
  }, [people]);

  // Selected people
  const selectedPeople = useMemo(() => {
    return exportablePeople.filter((p) => p.name && configs[p.id]?.selected);
  }, [exportablePeople, configs]);

  // Calculations for counts and estimated size
  const totalSelectedPhotos = useMemo(() => {
    return selectedPeople.reduce((sum, p) => {
      const cfg = configs[p.id];
      const count = cfg?.soloOnly ? p.solo_photo_count : p.photo_count;
      return sum + count;
    }, 0);
  }, [selectedPeople, configs]);

  const totalEstimatedMb = useMemo(() => {
    return totalSelectedPhotos * ESTIMATED_MB_PER_PHOTO;
  }, [totalSelectedPhotos]);

  const isLargeExport = totalEstimatedMb > 500;

  const isLowStorage = useMemo(() => {
    if (!freeStorageBytes) return false;
    const requiredBytes = totalEstimatedMb * 1024 * 1024 * 2; // 2x required free space (02_AppFlow §3.7)
    return freeStorageBytes < requiredBytes;
  }, [freeStorageBytes, totalEstimatedMb]);

  // Toggle selection for a single person
  const handleTogglePerson = (personId: string) => {
    setConfigs((prev) => {
      const curr = prev[personId];
      if (!curr) return prev;
      return {
        ...prev,
        [personId]: {
          ...curr,
          selected: !curr.selected,
        },
      };
    });
  };

  // Select all / deselect all
  const handleSelectAllToggle = () => {
    const namedWithPhotos = exportablePeople.filter((p) => p.name && p.photo_count > 0);
    const areAllSelected = namedWithPhotos.every((p) => configs[p.id]?.selected);

    setConfigs((prev) => {
      const next = { ...prev };
      for (const p of namedWithPhotos) {
        if (next[p.id]) {
          next[p.id] = {
            ...next[p.id],
            selected: !areAllSelected,
          };
        }
      }
      return next;
    });
  };

  // Change format mode: 'photos' | 'zip'
  const handleSetMode = (personId: string, mode: 'photos' | 'zip') => {
    setConfigs((prev) => {
      const curr = prev[personId];
      if (!curr) return prev;
      return {
        ...prev,
        [personId]: {
          ...curr,
          mode,
        },
      };
    });
  };

  // Toggle solo-only for a person
  const handleToggleSoloOnly = (personId: string) => {
    setConfigs((prev) => {
      const curr = prev[personId];
      if (!curr) return prev;
      const nextSoloOnly = !curr.soloOnly;
      const person = people.find((p) => p.id === personId);
      const count = nextSoloOnly ? (person?.solo_photo_count ?? 0) : (person?.photo_count ?? 0);

      return {
        ...prev,
        [personId]: {
          ...curr,
          soloOnly: nextSoloOnly,
          // If count exceeds 30, force ZIP mode
          mode: count > 30 ? 'zip' : curr.mode,
        },
      };
    });
  };

  // Sequential batch export queue runner (01_PRD US-10, 02_AppFlow §3.7)
  const handleStartExport = async () => {
    if (!tripId || selectedPeople.length === 0) return;

    if (freeTierStatus?.requiresPaywall) {
      router.push('/paywall');
      return;
    }

    if (isLowStorage) {
      Alert.alert(
        'Not Enough Storage',
        `Not enough space: need at least ${(totalEstimatedMb * 2).toFixed(0)} MB free space.`
      );
      return;
    }

    // If total size > 500 MB, confirm first (02_AppFlow §3.7)
    if (isLargeExport) {
      Alert.alert(
        'Large Export Warning',
        `Total export size is estimated at ~${totalEstimatedMb.toFixed(0)} MB (> 500 MB). Proceed?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Proceed', onPress: () => void executeBatchQueue() },
        ]
      );
      return;
    }

    await executeBatchQueue();
  };

  const executeBatchQueue = async () => {
    if (!tripId) return;
    setIsQueueActive(true);
    setQueueTotal(selectedPeople.length);

    let completedCount = 0;
    let cancelledCount = 0;
    let failedCount = 0;
    let totalSkippedCount = 0;
    const currentQueue = [...selectedPeople];

    for (let i = 0; i < currentQueue.length; i++) {
      const person = currentQueue[i];
      const cfg = configs[person.id] || { mode: 'zip', soloOnly: false };

      setQueueIndex(i + 1);
      setQueuePersonName(person.name || 'Person');

      try {
        const result: ExportResult = await exportPerson({
          personId: person.id,
          tripId,
          mode: cfg.mode,
          soloOnly: cfg.soloOnly,
        });

        if (result.skippedCount && result.skippedCount > 0) {
          totalSkippedCount += result.skippedCount;
        }

        if (result.status === 'cancelled') {
          cancelledCount++;
          // Share cancelled -> uncheck row (02_AppFlow §3.7)
          setConfigs((prev) => ({
            ...prev,
            [person.id]: {
              ...prev[person.id],
              selected: false,
              status: 'cancelled',
            },
          }));
        } else if (result.status === 'done') {
          completedCount++;
          setConfigs((prev) => ({
            ...prev,
            [person.id]: {
              ...prev[person.id],
              status: 'done',
            },
          }));
        }
      } catch {
        failedCount++;
        setConfigs((prev) => ({
          ...prev,
          [person.id]: {
            ...prev[person.id],
            status: 'failed',
          },
        }));
      }
    }

    setIsQueueActive(false);

    let summary = '';
    if (completedCount > 0) {
      summary = `Export complete! Shared ${completedCount} ${completedCount === 1 ? 'person' : 'people'}.`;
    } else if (cancelledCount > 0) {
      summary = 'Share was cancelled.';
    } else if (failedCount > 0) {
      summary = 'Export failed. Please check available storage.';
    } else {
      summary = 'Export finished.';
    }

    if (totalSkippedCount > 0) {
      summary += ` (${totalSkippedCount} missing or deleted ${
        totalSkippedCount === 1 ? 'photo was' : 'photos were'
      } skipped)`;
    }

    setFeedbackMessage(summary);
  };

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !trip) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
        <View style={styles.errorContainer}>
          <EmptyState
            testID="export-error-state"
            title="Trip Not Found"
            body={error ?? 'Could not find the requested trip.'}
            actionTitle="Back"
            onActionPress={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  const allNamedSelected =
    exportablePeople.filter((p) => p.name && p.photo_count > 0).length > 0 &&
    exportablePeople
      .filter((p) => p.name && p.photo_count > 0)
      .every((p) => configs[p.id]?.selected);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View
        testID="export-header"
        style={[styles.header, { borderBottomColor: colors.border }]}
      >
        <View style={styles.headerLeft}>
          <Pressable
            testID="back-button"
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <ArrowLeft size={22} color={colors.text} />
          </Pressable>
          <View style={styles.headerTitleCol}>
            <Text
              numberOfLines={1}
              style={[tokens.typography.heading, { color: colors.text }]}
            >
              Export Review
            </Text>
            <Text
              style={[tokens.typography.micro, { color: colors.textMuted }]}
            >
              {trip.name} · {selectedPeople.length} selected (~{totalEstimatedMb.toFixed(0)} MB)
            </Text>
          </View>
        </View>
      </View>

      {/* Warning & Free Tier Banners */}
      {freeTierStatus?.requiresPaywall && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="paywall-banner"
            variant="warning"
            message={`Free limit reached (${freeTierStatus.scannedCount} photos scanned). Unlock Pro to export.`}
            action={{
              label: 'Unlock Pro',
              onPress: () => router.push('/paywall'),
            }}
          />
        </View>
      )}

      {isLowStorage && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="low-storage-banner"
            variant="error"
            message={`Not enough space: need at least ${(totalEstimatedMb * 2).toFixed(0)} MB free storage space.`}
          />
        </View>
      )}

      {isLargeExport && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="large-export-banner"
            variant="warning"
            message={`Large export (~${totalEstimatedMb.toFixed(0)} MB > 500 MB). Make sure you have enough free space.`}
          />
        </View>
      )}

      {feedbackMessage && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="feedback-banner"
            variant="success"
            message={feedbackMessage}
            onDismiss={() => setFeedbackMessage(null)}
          />
        </View>
      )}

      {/* Select All Bar */}
      <View
        testID="select-all-bar"
        style={[
          styles.selectAllBar,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <Pressable
          testID="select-all-toggle-button"
          accessibilityRole="button"
          accessibilityLabel="Select All Toggle"
          onPress={handleSelectAllToggle}
          style={styles.selectAllBtn}
        >
          {allNamedSelected ? (
            <CheckSquare size={20} color={colors.primary} />
          ) : (
            <Square size={20} color={colors.textMuted} />
          )}
          <Text
            style={[
              tokens.typography.caption,
              { color: colors.text, fontWeight: '600', marginLeft: 8 },
            ]}
          >
            {allNamedSelected ? 'Deselect All' : 'Select All'}
          </Text>
        </Pressable>

        <Text
          style={[tokens.typography.caption, { color: colors.textMuted }]}
        >
          {totalSelectedPhotos} photos total
        </Text>
      </View>

      {/* List of People */}
      {exportablePeople.length === 0 ? (
        <View style={styles.emptyContainer}>
          <EmptyState
            testID="empty-people-state"
            title="No People Detected"
            body="Scan faces first before exporting per-person photos."
            actionTitle="Back"
            onActionPress={() => router.back()}
          />
        </View>
      ) : (
        <ScrollView
          testID="export-people-scroll"
          contentContainerStyle={styles.scrollContent}
        >
          {exportablePeople.map((person) => {
            const isNamed = Boolean(person.name && person.name.trim().length > 0);
            const cfg = configs[person.id] || {
              selected: false,
              mode: 'zip',
              soloOnly: false,
              status: 'idle',
            };

            const currentCount = cfg.soloOnly ? person.solo_photo_count : person.photo_count;
            const canUsePhotosMode = currentCount <= 30;
            const personEstimatedMb = (currentCount * ESTIMATED_MB_PER_PHOTO).toFixed(1);

            return (
              <View
                key={person.id}
                testID={`person-export-card-${person.id}`}
                style={[
                  styles.personCard,
                  {
                    backgroundColor: colors.surface,
                    borderColor: cfg.selected ? colors.primary : colors.border,
                  },
                ]}
              >
                {/* Top Row: Checkbox, Name, Count */}
                <View style={styles.cardHeader}>
                  <Pressable
                    testID={`person-checkbox-${person.id}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: cfg.selected, disabled: !isNamed || currentCount === 0 }}
                    disabled={!isNamed || currentCount === 0}
                    onPress={() => handleTogglePerson(person.id)}
                    style={styles.checkboxWrapper}
                  >
                    {!isNamed || currentCount === 0 ? (
                      <Square size={20} color={colors.border} />
                    ) : cfg.selected ? (
                      <CheckSquare size={20} color={colors.primary} />
                    ) : (
                      <Square size={20} color={colors.textMuted} />
                    )}
                  </Pressable>

                  <View style={styles.personInfo}>
                    <Text
                      numberOfLines={1}
                      style={[
                        tokens.typography.bodyStrong,
                        { color: isNamed ? colors.text : colors.textMuted },
                      ]}
                    >
                      {person.name || 'Unnamed Person'}
                    </Text>
                    <Text
                      style={[tokens.typography.micro, { color: colors.textMuted }]}
                    >
                      {currentCount} photos · ~{personEstimatedMb} MB
                    </Text>
                  </View>

                  {/* Status Badges */}
                  {!isNamed ? (
                    <Pressable
                      testID={`name-first-badge-${person.id}`}
                      onPress={() => router.push({ pathname: '/person/[id]', params: { id: person.id } })}
                      style={[styles.nameFirstBadge, { backgroundColor: colors.surfaceAlt }]}
                    >
                      <Sparkles size={12} color={colors.warning} />
                      <Text
                        style={[
                          tokens.typography.micro,
                          { color: colors.warning, marginLeft: 4, fontWeight: '600' },
                        ]}
                      >
                        Name first
                      </Text>
                    </Pressable>
                  ) : cfg.status === 'done' ? (
                    <View style={[styles.doneBadge, { backgroundColor: colors.surfaceAlt }]}>
                      <Check size={12} color={colors.success} strokeWidth={3} />
                      <Text
                        style={[
                          tokens.typography.micro,
                          { color: colors.success, marginLeft: 4, fontWeight: '600' },
                        ]}
                      >
                        Exported
                      </Text>
                    </View>
                  ) : cfg.status === 'cancelled' ? (
                    <Text
                      style={[tokens.typography.micro, { color: colors.textMuted }]}
                    >
                      Cancelled
                    </Text>
                  ) : null}
                </View>

                {/* Per-Person Controls (Visible if Named) */}
                {isNamed && (
                  <View style={[styles.controlsRow, { borderTopColor: colors.border }]}>
                    {/* Format Selector: Photos vs ZIP */}
                    <View style={styles.formatSegment}>
                      <Pressable
                        testID={`format-photos-${person.id}`}
                        accessibilityRole="button"
                        accessibilityLabel="Photos Format"
                        disabled={!canUsePhotosMode}
                        onPress={() => handleSetMode(person.id, 'photos')}
                        style={[
                          styles.segmentBtn,
                          cfg.mode === 'photos' && {
                            backgroundColor: colors.primary,
                          },
                          !canUsePhotosMode && styles.segmentBtnDisabled,
                        ]}
                      >
                        <ImageIcon
                          size={13}
                          color={
                            !canUsePhotosMode
                              ? colors.border
                              : cfg.mode === 'photos'
                                ? colors.onPrimary
                                : colors.textMuted
                          }
                        />
                        <Text
                          style={[
                            tokens.typography.micro,
                            {
                              color: !canUsePhotosMode
                                ? colors.border
                                : cfg.mode === 'photos'
                                  ? colors.onPrimary
                                  : colors.textMuted,
                              marginLeft: 4,
                            },
                          ]}
                        >
                          Photos {canUsePhotosMode ? '' : '(≤30)'}
                        </Text>
                      </Pressable>

                      <Pressable
                        testID={`format-zip-${person.id}`}
                        accessibilityRole="button"
                        accessibilityLabel="ZIP Format"
                        onPress={() => handleSetMode(person.id, 'zip')}
                        style={[
                          styles.segmentBtn,
                          cfg.mode === 'zip' && {
                            backgroundColor: colors.primary,
                          },
                        ]}
                      >
                        <FileArchive
                          size={13}
                          color={cfg.mode === 'zip' ? colors.onPrimary : colors.textMuted}
                        />
                        <Text
                          style={[
                            tokens.typography.micro,
                            {
                              color: cfg.mode === 'zip' ? colors.onPrimary : colors.textMuted,
                              marginLeft: 4,
                            },
                          ]}
                        >
                          ZIP
                        </Text>
                      </Pressable>
                    </View>

                    {/* Solo-only Toggle Chip */}
                    <Pressable
                      testID={`solo-toggle-${person.id}`}
                      accessibilityRole="button"
                      accessibilityLabel="Solo Only Toggle"
                      onPress={() => handleToggleSoloOnly(person.id)}
                      style={[
                        styles.soloChip,
                        {
                          borderColor: cfg.soloOnly ? colors.accent : colors.border,
                          backgroundColor: cfg.soloOnly ? colors.surfaceAlt : 'transparent',
                        },
                      ]}
                    >
                      <User size={12} color={cfg.soloOnly ? colors.accent : colors.textMuted} />
                      <Text
                        style={[
                          tokens.typography.micro,
                          {
                            color: cfg.soloOnly ? colors.accent : colors.textMuted,
                            marginLeft: 4,
                            fontWeight: cfg.soloOnly ? '600' : '400',
                          },
                        ]}
                      >
                        Solo only
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Bottom Export Action Bar */}
      <View
        testID="export-action-bar"
        style={[
          styles.bottomBar,
          { backgroundColor: colors.surface, borderTopColor: colors.border },
        ]}
      >
        <Button
          testID="start-export-button"
          title={
            selectedPeople.length > 0
              ? `Export ${selectedPeople.length} ${selectedPeople.length === 1 ? 'Person' : 'People'}`
              : 'Select people to export'
          }
          variant="primary"
          size="lg"
          icon={<Share2 size={18} color={colors.onPrimary} />}
          disabled={selectedPeople.length === 0 || isLowStorage || isQueueActive}
          onPress={handleStartExport}
        />
      </View>

      {/* Batch Export Queue Modal (01_PRD US-10) */}
      <Modal
        visible={isQueueActive}
        transparent
        animationType="fade"
      >
        <View style={[styles.queueModalOverlay, { backgroundColor: colors.overlay }]}>
          <View
            testID="batch-queue-modal"
            style={[styles.queueCard, { backgroundColor: colors.surface }]}
          >
            <ProgressRing
              progress={queueTotal > 0 ? queueIndex / queueTotal : 0}
              size={64}
              strokeWidth={5}
              showPercentText
            />

            <Text
              style={[
                tokens.typography.heading,
                { color: colors.text, marginTop: 16, textAlign: 'center' },
              ]}
            >
              Exporting Photos…
            </Text>

            <Text
              testID="queue-status-text"
              style={[
                tokens.typography.body,
                { color: colors.textMuted, marginTop: 8, textAlign: 'center' },
              ]}
            >
              Person {queueIndex} of {queueTotal}: {queuePersonName}
            </Text>

            <Text
              style={[
                tokens.typography.caption,
                { color: colors.textMuted, marginTop: 12, textAlign: 'center' },
              ]}
            >
              The share sheet will open for each person sequentially.
            </Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerTitleCol: {
    marginLeft: 12,
    flex: 1,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerWrapper: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  selectAllBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  selectAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    minHeight: 44,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  personCard: {
    borderRadius: 12,
    borderWidth: 1.5,
    padding: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkboxWrapper: {
    paddingRight: 10,
    paddingVertical: 4,
    minHeight: 44,
    justifyContent: 'center',
  },
  personInfo: {
    flex: 1,
  },
  nameFirstBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  formatSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  segmentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    minHeight: 32,
  },
  segmentBtnDisabled: {
    opacity: 0.4,
  },
  soloChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 32,
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  queueModalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  queueCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
  },
});
