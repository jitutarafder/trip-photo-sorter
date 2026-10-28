import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  Sparkles,
  Users,
  Clock,
  AlertCircle,
  Pause,
  AlertTriangle,
  Lightbulb,
} from 'lucide-react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useTheme } from '../../../src/theme';
import { Button, ProgressRing, Banner } from '../../../src/components/ui';
import { getTripById } from '../../../src/db/repositories/trips';
import { useFaceScan, type ScanTripFacesResult } from '../../../src/services/faceScan';

const DEFAULT_SCAN_OPTIONS = {
  keepAwake: true,
  pauseOnBackground: true,
};

/**
 * Scan Progress Modal (02_AppFlow §3.4, 03_UI_Spec, PRD US-04)
 *
 * Features:
 * - Deterministic progress ring with n / total photos
 * - Faces found counter & dynamic ETA calculation
 * - Keep-awake active while scanning
 * - Auto-pauses on app backgrounding, allows resuming on foreground
 * - Auto-navigates to /trip/[id]/people when complete with > 0 faces
 * - Handles zero faces detected with actionable tips and Back button
 * - Handles single-photo error counts gracefully
 * - Free-tier paywall gate handling when limit is reached
 */
export default function ScanProgressModal() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, tokens } = useTheme();

  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [isClustering, setIsClustering] = useState<boolean>(false);
  const [zeroFacesDetected, setZeroFacesDetected] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<ScanTripFacesResult | null>(null);

  // Guard to ensure initial scan only kicks off once
  const hasStartedRef = useRef<boolean>(false);

  // Timing for ETA calculation
  const scanStartTimeRef = useRef<number | null>(null);

  const {
    isScanning,
    isPaused,
    progress,
    error: scanError,
    startScan,
    resumeScan,
    cancelScan,
  } = useFaceScan(id ?? '', DEFAULT_SCAN_OPTIONS);

  // Calculate ETA string from start time and current progress
  const getEtaString = useCallback((): string => {
    if (!scanStartTimeRef.current || progress.current <= 0 || progress.total <= 0) {
      return 'Estimating time...';
    }

    const elapsedMs = Date.now() - scanStartTimeRef.current;
    const avgTimePerPhoto = elapsedMs / progress.current;
    const remainingPhotos = Math.max(0, progress.total - progress.current);

    if (remainingPhotos === 0) {
      return 'Wrapping up...';
    }

    const etaSeconds = Math.ceil((remainingPhotos * avgTimePerPhoto) / 1000);

    if (etaSeconds < 5) {
      return 'A few seconds remaining';
    }
    if (etaSeconds < 60) {
      return `About ${etaSeconds}s remaining`;
    }

    const minutes = Math.floor(etaSeconds / 60);
    const seconds = etaSeconds % 60;
    return seconds > 0 ? `About ${minutes}m ${seconds}s remaining` : `About ${minutes}m remaining`;
  }, [progress]);

  // Keep-awake management in UI
  useEffect(() => {
    if (isScanning) {
      activateKeepAwakeAsync().catch(() => {});
    } else {
      try {
        deactivateKeepAwake();
      } catch {
        // ignore in tests
      }
    }

    return () => {
      try {
        deactivateKeepAwake();
      } catch {
        // ignore in tests
      }
    };
  }, [isScanning]);

  // Monitor AppState foreground/background
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextAppState: AppStateStatus) => {
        if (nextAppState.match(/inactive|background/) && isScanning) {
          cancelScan(); // pause controller
        }
      }
    );

    return () => {
      subscription.remove();
    };
  }, [isScanning, cancelScan]);

  // Handle scan execution and completion
  const handleExecuteScan = useCallback(async () => {
    if (!id) return;
    scanStartTimeRef.current = Date.now();
    setZeroFacesDetected(false);

    try {
      const result = await startScan();
      setScanResult(result);

      if (result.status === 'completed') {
        if (result.facesFound === 0) {
          setZeroFacesDetected(true);
        } else {
          // Auto-navigate to people screen (02_AppFlow §3.4)
          router.replace(`/trip/${id}/people`);
        }
      }
    } catch {
      // scanError state captured by useFaceScan
    }
  }, [id, startScan, router]);

  // Initial load: fetch trip and kick off scan if not yet scanned or resumed
  useEffect(() => {
    let isMounted = true;
    if (!id || hasStartedRef.current) return;
    hasStartedRef.current = true;

    getTripById(id)
      .then((tripData) => {
        if (!isMounted) return;
        setInitialLoading(false);

        if (!tripData) return;

        // Auto-start scan if not completed
        if (tripData.scan_status !== 'scanned') {
          void handleExecuteScan();
        } else {
          // Already scanned -> navigate directly to people
          router.replace(`/trip/${id}/people`);
        }
      })
      .catch(() => {
        if (isMounted) setInitialLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [id, handleExecuteScan, router]);

  // Monitor scan stages (scanning vs clustering)
  useEffect(() => {
    if (progress.total > 0 && progress.current >= progress.total && isScanning) {
      setIsClustering(true);
    } else {
      setIsClustering(false);
    }
  }, [progress, isScanning]);

  // Action: Cancel scan
  const handleCancelPress = () => {
    cancelScan();
    router.back();
  };

  // Action: Resume scan
  const handleResumePress = async () => {
    scanStartTimeRef.current = Date.now();
    try {
      const result = await resumeScan();
      setScanResult(result);

      if (result.status === 'completed') {
        if (result.facesFound === 0) {
          setZeroFacesDetected(true);
        } else {
          router.replace(`/trip/${id}/people`);
        }
      }
    } catch {
      // handled
    }
  };

  // Percentage progress value (0.0 to 1.0)
  const progressRatio =
    progress.total > 0 ? Math.min(1, Math.max(0, progress.current / progress.total)) : 0;
  const progressPercent = Math.round(progressRatio * 100);

  // Render: Initial loading
  if (initialLoading) {
    return (
      <View
        testID="scan-initial-loading"
        style={[styles.container, styles.centered, { backgroundColor: colors.bg }]}
      >
        <Stack.Screen options={{ title: 'Scanning Faces' }} />
        <ProgressRing indeterminate size={64} color={colors.primary} />
        <Text
          style={[
            styles.loadingText,
            { color: colors.textMuted, fontSize: tokens.typography.body.fontSize },
          ]}
        >
          Preparing scan...
        </Text>
      </View>
    );
  }

  // Render: Zero faces detected state (02_AppFlow §3.4)
  if (zeroFacesDetected) {
    return (
      <View
        testID="zero-faces-view"
        style={[styles.container, styles.paddedContent, { backgroundColor: colors.bg }]}
      >
        <Stack.Screen options={{ title: 'No Faces Detected' }} />
        <ScrollView contentContainerStyle={styles.scrollInner}>
          <View
            style={[
              styles.iconCircle,
              { backgroundColor: 'rgba(255, 184, 77, 0.15)', borderColor: colors.warning },
            ]}
          >
            <AlertTriangle size={36} color={colors.warning} strokeWidth={2} />
          </View>

          <Text
            style={[
              styles.stateTitle,
              {
                fontSize: tokens.typography.title.fontSize,
                fontWeight: tokens.typography.title.fontWeight,
                color: colors.text,
              },
            ]}
          >
            No faces detected
          </Text>

          <Text
            style={[
              styles.stateSubtitle,
              {
                fontSize: tokens.typography.body.fontSize,
                color: colors.textMuted,
              },
            ]}
          >
            We scanned all photos in this trip, but couldn&apos;t detect any clear faces.
          </Text>

          {/* Tips card */}
          <View
            style={[
              styles.tipsCard,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderRadius: tokens.radius.md,
              },
            ]}
          >
            <View style={styles.tipsHeader}>
              <Lightbulb size={18} color={colors.accent} strokeWidth={2} />
              <Text
                style={[
                  styles.tipsTitle,
                  {
                    fontSize: tokens.typography.bodyStrong.fontSize,
                    fontWeight: tokens.typography.bodyStrong.fontWeight,
                    color: colors.text,
                  },
                ]}
              >
                Tips for better detection
              </Text>
            </View>

            <Text
              style={[
                styles.tipItem,
                { fontSize: tokens.typography.caption.fontSize, color: colors.textMuted },
              ]}
            >
              • Photos where people are facing towards the camera work best
            </Text>
            <Text
              style={[
                styles.tipItem,
                { fontSize: tokens.typography.caption.fontSize, color: colors.textMuted },
              ]}
            >
              • Blurry, dark, or very distant faces are excluded for accuracy
            </Text>
            <Text
              style={[
                styles.tipItem,
                { fontSize: tokens.typography.caption.fontSize, color: colors.textMuted },
              ]}
            >
              • You can adjust the trip date range to include other photos
            </Text>
          </View>

          <View style={styles.actionButtons}>
            <Button
              variant="primary"
              title="Back to Trip"
              onPress={() => router.back()}
              testID="back-to-trip-button"
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  // Render: Fatal error state
  if (scanError && !isScanning && !isPaused) {
    return (
      <View
        testID="scan-failed-view"
        style={[styles.container, styles.centered, { backgroundColor: colors.bg }]}
      >
        <Stack.Screen options={{ title: 'Scan Failed' }} />
        <AlertCircle size={48} color={colors.danger} strokeWidth={2} />
        <Text
          style={[
            styles.stateTitle,
            {
              fontSize: tokens.typography.heading.fontSize,
              fontWeight: tokens.typography.heading.fontWeight,
              color: colors.text,
              marginTop: tokens.spacing.md,
            },
          ]}
        >
          Scan failed
        </Text>
        <Text
          style={[
            styles.stateSubtitle,
            {
              fontSize: tokens.typography.body.fontSize,
              color: colors.textMuted,
            },
          ]}
        >
          {scanError.message || 'An error occurred while scanning photos.'}
        </Text>

        <View style={styles.dialogButtons}>
          <Button
            variant="ghost"
            title="Cancel"
            onPress={() => router.back()}
            testID="error-cancel-button"
          />
          <Button
            variant="primary"
            title="Retry Scan"
            onPress={handleExecuteScan}
            testID="retry-scan-button"
          />
        </View>
      </View>
    );
  }

  // Render: Paused state
  if (isPaused && !isScanning) {
    return (
      <View
        testID="scan-paused-view"
        style={[styles.container, styles.centered, { backgroundColor: colors.bg }]}
      >
        <Stack.Screen options={{ title: 'Scan Paused' }} />
        <View
          style={[
            styles.iconCircle,
            { backgroundColor: 'rgba(255, 184, 77, 0.15)', borderColor: colors.warning },
          ]}
        >
          <Pause size={36} color={colors.warning} strokeWidth={2} />
        </View>

        <Text
          style={[
            styles.stateTitle,
            {
              fontSize: tokens.typography.title.fontSize,
              fontWeight: tokens.typography.title.fontWeight,
              color: colors.text,
            },
          ]}
        >
          Scan Paused
        </Text>

        <Text
          style={[
            styles.stateSubtitle,
            {
              fontSize: tokens.typography.body.fontSize,
              color: colors.textMuted,
            },
          ]}
        >
          Scanning was paused. Pick up right where you left off.
        </Text>

        {/* Progress snapshot */}
        <View style={styles.pausedStats}>
          <Text
            testID="paused-progress-text"
            style={[
              styles.metaText,
              { fontSize: tokens.typography.bodyStrong.fontSize, color: colors.text },
            ]}
          >
            {progress.current} of {progress.total} photos scanned · {progress.facesFound} faces
            found
          </Text>
        </View>

        <View style={styles.actionButtons}>
          <Button
            variant="primary"
            title="Resume Scan"
            onPress={handleResumePress}
            testID="resume-scan-button"
          />
          <View style={{ height: tokens.spacing.sm }} />
          <Button
            variant="ghost"
            title="Cancel"
            onPress={handleCancelPress}
            testID="paused-cancel-button"
          />
        </View>
      </View>
    );
  }

  // Render: Active scanning / clustering state
  return (
    <View style={[styles.container, styles.centered, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          title: isClustering ? 'Grouping Faces' : 'Scanning Faces',
          gestureEnabled: false,
        }}
      />

      {/* Free limit hit banner if paywall required */}
      {scanResult?.paywallRequired ? (
        <Banner
          variant="warning"
          message="Free limit reached (50 photos). Unlock Pro to scan all photos."
          action={{
            label: 'Unlock Pro',
            onPress: () => router.push('/paywall'),
          }}
          testID="scan-paywall-banner"
          style={styles.bannerSpacing}
        />
      ) : null}

      {/* Main Progress Ring */}
      <View style={styles.ringContainer}>
        <ProgressRing
          progress={isClustering ? undefined : progressRatio}
          indeterminate={isClustering}
          size={140}
          strokeWidth={8}
          color={isClustering ? colors.accent : colors.primary}
          trackColor={colors.surfaceAlt}
          testID="scan-progress-ring"
        />

        {/* Center percentage or icon */}
        <View style={styles.ringCenter}>
          {isClustering ? (
            <Users size={32} color={colors.accent} strokeWidth={2} />
          ) : (
            <Text
              testID="scan-progress-percent"
              style={[
                styles.percentText,
                {
                  fontSize: tokens.typography.title.fontSize,
                  fontWeight: tokens.typography.title.fontWeight,
                  color: colors.text,
                },
              ]}
            >
              {progressPercent}%
            </Text>
          )}
        </View>
      </View>

      {/* Status Title & Subtitle */}
      <Text
        testID="scan-status-title"
        style={[
          styles.stateTitle,
          {
            fontSize: tokens.typography.heading.fontSize,
            fontWeight: tokens.typography.heading.fontWeight,
            color: colors.text,
          },
        ]}
      >
        {isClustering ? 'Grouping people...' : 'Scanning for faces...'}
      </Text>

      {/* Photo count (n / total) */}
      <Text
        testID="scan-photo-count"
        style={[
          styles.photoCountText,
          {
            fontSize: tokens.typography.body.fontSize,
            color: colors.textMuted,
          },
        ]}
      >
        {progress.current} of {progress.total} photos
      </Text>

      {/* Metrics Row: Faces Found & ETA */}
      <View style={styles.metricsContainer}>
        <View
          style={[
            styles.metricPill,
            { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.pill },
          ]}
        >
          <Sparkles size={14} color={colors.accent} strokeWidth={2} />
          <Text
            testID="scan-faces-found"
            style={[
              styles.metricText,
              { fontSize: tokens.typography.caption.fontSize, color: colors.text },
            ]}
          >
            {progress.facesFound} {progress.facesFound === 1 ? 'face' : 'faces'} found
          </Text>
        </View>

        {!isClustering && (
          <View
            style={[
              styles.metricPill,
              { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.pill },
            ]}
          >
            <Clock size={14} color={colors.textMuted} strokeWidth={2} />
            <Text
              testID="scan-eta-text"
              style={[
                styles.metricText,
                { fontSize: tokens.typography.caption.fontSize, color: colors.textMuted },
              ]}
            >
              {getEtaString()}
            </Text>
          </View>
        )}
      </View>

      {/* Notice for skipped / failed single photos (02_AppFlow §3.4) */}
      {scanResult?.failedCount && scanResult.failedCount > 0 ? (
        <Text
          testID="scan-skipped-count"
          style={[
            styles.failedNotice,
            { fontSize: tokens.typography.micro.fontSize, color: colors.warning },
          ]}
        >
          {scanResult.failedCount} photos could not be processed and were skipped
        </Text>
      ) : null}

      {/* Privacy note */}
      <Text
        style={[
          styles.privacyNote,
          { fontSize: tokens.typography.micro.fontSize, color: colors.textMuted },
        ]}
      >
        100% on-device · Nothing leaves your phone
      </Text>

      {/* Bottom Cancel Button */}
      <View style={styles.bottomBar}>
        <Button
          variant="secondary"
          title="Cancel"
          onPress={handleCancelPress}
          testID="cancel-scan-button"
        />
      </View>
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
  paddedContent: {
    padding: 24,
  },
  scrollInner: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  loadingText: {
    marginTop: 16,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  ringContainer: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  ringCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  percentText: {
    letterSpacing: -0.5,
  },
  stateTitle: {
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  stateSubtitle: {
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 320,
    marginBottom: 24,
  },
  photoCountText: {
    marginBottom: 16,
  },
  metricsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 24,
  },
  metricPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
  },
  metricText: {
    fontWeight: '500',
  },
  pausedStats: {
    marginVertical: 16,
  },
  metaText: {
    textAlign: 'center',
  },
  failedNotice: {
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 12,
  },
  privacyNote: {
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 28,
  },
  tipsCard: {
    width: '100%',
    maxWidth: 380,
    borderWidth: 1,
    padding: 16,
    marginBottom: 28,
  },
  tipsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  tipsTitle: {},
  tipItem: {
    lineHeight: 18,
    marginBottom: 8,
  },
  actionButtons: {
    width: '100%',
    maxWidth: 320,
  },
  dialogButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  bottomBar: {
    width: '100%',
    maxWidth: 240,
  },
  bannerSpacing: {
    marginBottom: 20,
    width: '100%',
  },
});
