import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ShieldCheck,
  Sparkles,
  RefreshCw,
  Trash2,
  ExternalLink,
  Image as ImageIcon,
  Check,
} from 'lucide-react-native';
import { useTheme } from '../src/theme';
import { Button } from '../src/components/ui/Button';
import { Banner, type BannerVariant } from '../src/components/ui/Banner';
import { useLibraryPermission } from '../src/hooks/useLibraryPermission';
import { useProStatus } from '../src/services/purchases';
import {
  syncLibrary,
  getLastLibrarySync,
} from '../src/services/library';
import { detectAndPersistTrips } from '../src/services/tripService';
import { resetAllAppData } from '../src/services/appData';
import { CONFIG } from '../src/domain/config';

interface SettingsCardProps {
  children: React.ReactNode;
  testID?: string;
}

function SettingsCard({ children, testID }: SettingsCardProps) {
  const { colors, tokens } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing.lg,
        },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Settings Screen (02_AppFlow §3.9, 01_PRD §4/§5, 06_Plan Task 3.11)
 *
 * Includes:
 * 1. Photo library permission status & management
 * 2. Library re-sync
 * 3. Pro status & restore purchase
 * 4. 100% on-device privacy statement
 * 5. Danger zone: reset all app data (with confirmation)
 * 6. App version and metadata
 */
export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, tokens } = useTheme();

  // 1. Library Permission
  const {
    status: permissionStatus,
    openSettings,
    presentPicker,
    refreshPermission,
  } = useLibraryPermission();

  // 2. Purchases & Pro
  const {
    isPro,
    isPurchased,
    restorePurchases,
  } = useProStatus();

  // 3. Sync State
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [bannerFeedback, setBannerFeedback] = useState<{
    variant: BannerVariant;
    title?: string;
    message: string;
  } | null>(null);

  const fetchSyncDate = useCallback(async () => {
    try {
      const ts = await getLastLibrarySync();
      setLastSyncAt(ts);
    } catch {
      // Ignore in mock or fresh database
    }
  }, []);

  useEffect(() => {
    void fetchSyncDate();
  }, [fetchSyncDate]);

  // Handle Re-sync Library
  const handleResyncLibrary = async () => {
    setIsSyncing(true);
    setBannerFeedback(null);
    try {
      const syncResult = await syncLibrary({ forceFullSync: true });
      await detectAndPersistTrips();
      await fetchSyncDate();
      setBannerFeedback({
        variant: 'success',
        title: 'Library Re-synced',
        message: `Successfully synchronized ${syncResult.syncedCount} photos. Trips updated.`,
      });
    } catch (err: unknown) {
      setBannerFeedback({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to re-sync photo library.',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  // Handle Restore Purchases
  const handleRestorePurchases = async () => {
    setIsRestoring(true);
    setBannerFeedback(null);
    try {
      const restored = await restorePurchases();
      if (restored) {
        setBannerFeedback({
          variant: 'success',
          title: 'Purchases Restored',
          message: 'Your Pro lifetime purchase has been restored successfully!',
        });
      } else {
        setBannerFeedback({
          variant: 'info',
          message: 'No previous Pro purchases were found for this Apple ID.',
        });
      }
    } catch (err: unknown) {
      setBannerFeedback({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to restore purchases.',
      });
    } finally {
      setIsRestoring(false);
    }
  };

  // Handle Reset All App Data
  const handleResetAllData = () => {
    Alert.alert(
      'Reset All App Data?',
      'This will delete all detected trips, face clusters, custom names, and export caches. Your original photos in your gallery remain completely untouched.\n\nThis action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset Everything',
          style: 'destructive',
          onPress: async () => {
            setIsResetting(true);
            try {
              await resetAllAppData();
              router.replace('/onboarding');
            } catch (err: unknown) {
              setBannerFeedback({
                variant: 'error',
                message: err instanceof Error ? err.message : 'Failed to reset application data.',
              });
            } finally {
              setIsResetting(false);
            }
          },
        },
      ]
    );
  };

  // Format timestamp helper
  const formattedSyncTime = lastSyncAt
    ? new Date(lastSyncAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'Never';

  return (
    <ScrollView
      testID="settings-screen"
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={[
        styles.contentContainer,
        {
          paddingBottom: insets.bottom > 0 ? insets.bottom + 24 : tokens.spacing.xl,
          paddingHorizontal: tokens.spacing.lg,
        },
      ]}
      showsVerticalScrollIndicator={false}
    >
      {/* Banner Feedback */}
      {bannerFeedback && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="settings-feedback-banner"
            variant={bannerFeedback.variant}
            title={bannerFeedback.title}
            message={bannerFeedback.message}
            onDismiss={() => setBannerFeedback(null)}
          />
        </View>
      )}

      {/* 1. Photo Library Permission Section */}
      <View style={styles.section}>
        <Text
          style={[
            styles.sectionHeader,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              fontWeight: tokens.typography.caption.fontWeight,
            },
          ]}
        >
          PHOTO LIBRARY PERMISSIONS
        </Text>
        <SettingsCard testID="settings-permission-card">
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardTitleWithIcon}>
              <View
                style={[
                  styles.iconBox,
                  { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.sm },
                ]}
              >
                <ImageIcon size={20} color={colors.primary} />
              </View>
              <Text
                style={[
                  styles.cardTitle,
                  {
                    color: colors.text,
                    fontSize: tokens.typography.bodyStrong.fontSize,
                    fontWeight: tokens.typography.bodyStrong.fontWeight,
                  },
                ]}
              >
                Gallery Access
              </Text>
            </View>

            {/* Permission Badge */}
            <View
              testID="permission-status-badge"
              style={[
                styles.badge,
                {
                  backgroundColor:
                    permissionStatus === 'full'
                      ? colors.surfaceAlt
                      : permissionStatus === 'limited'
                        ? colors.surfaceAlt
                        : colors.surfaceAlt,
                  borderRadius: tokens.radius.pill,
                },
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  {
                    color:
                      permissionStatus === 'full'
                        ? colors.success
                        : permissionStatus === 'limited'
                          ? colors.warning
                          : colors.danger,
                    fontSize: tokens.typography.micro.fontSize,
                    fontWeight: tokens.typography.micro.fontWeight,
                  },
                ]}
              >
                {permissionStatus === 'full'
                  ? 'FULL ACCESS'
                  : permissionStatus === 'limited'
                    ? 'LIMITED ACCESS'
                    : 'DENIED'}
              </Text>
            </View>
          </View>

          <Text
            style={[
              styles.cardDescription,
              {
                color: colors.textMuted,
                fontSize: tokens.typography.caption.fontSize,
                lineHeight: tokens.typography.caption.lineHeight,
              },
            ]}
          >
            {permissionStatus === 'full'
              ? 'SnapPhoto has access to read photos from your gallery to detect trips and group faces.'
              : permissionStatus === 'limited'
                ? 'Only selected photos are visible to the app. You can grant access to more photos or full library.'
                : 'Photo library access is denied. SnapPhoto cannot scan trips or faces without read access.'}
          </Text>

          <View style={styles.actionButtonsRow}>
            {permissionStatus === 'limited' && (
              <Button
                testID="settings-select-more-photos-button"
                title="Select More Photos"
                variant="secondary"
                size="sm"
                onPress={() => {
                  if (presentPicker) {
                    Promise.resolve(presentPicker())
                      .then(() => refreshPermission?.())
                      .catch(() => {});
                  }
                }}
              />
            )}

            <Button
              testID="settings-open-settings-button"
              title="Manage in iOS Settings"
              variant={permissionStatus === 'full' ? 'ghost' : 'secondary'}
              size="sm"
              icon={<ExternalLink size={14} color={permissionStatus === 'full' ? colors.primary : colors.text} />}
              iconPosition="right"
              onPress={() => {
                if (openSettings) {
                  openSettings();
                }
              }}
            />
          </View>
        </SettingsCard>
      </View>

      {/* 2. Library Sync Section */}
      <View style={styles.section}>
        <Text
          style={[
            styles.sectionHeader,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              fontWeight: tokens.typography.caption.fontWeight,
            },
          ]}
        >
          LIBRARY SYNCHRONIZATION
        </Text>
        <SettingsCard testID="settings-sync-card">
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardTitleWithIcon}>
              <View
                style={[
                  styles.iconBox,
                  { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.sm },
                ]}
              >
                <RefreshCw size={20} color={colors.accent} />
              </View>
              <Text
                style={[
                  styles.cardTitle,
                  {
                    color: colors.text,
                    fontSize: tokens.typography.bodyStrong.fontSize,
                    fontWeight: tokens.typography.bodyStrong.fontWeight,
                  },
                ]}
              >
                Photo Sync
              </Text>
            </View>
          </View>

          <Text
            style={[
              styles.cardDescription,
              {
                color: colors.textMuted,
                fontSize: tokens.typography.caption.fontSize,
                lineHeight: tokens.typography.caption.lineHeight,
              },
            ]}
          >
            Last synced: <Text style={{ color: colors.text }}>{formattedSyncTime}</Text>
          </Text>

          <Button
            testID="settings-resync-button"
            title="Re-sync library"
            variant="secondary"
            size="md"
            loading={isSyncing}
            icon={<RefreshCw size={16} color={colors.text} />}
            onPress={handleResyncLibrary}
            style={styles.cardSingleAction}
          />
        </SettingsCard>
      </View>

      {/* 3. Pro & Purchases Section */}
      <View style={styles.section}>
        <Text
          style={[
            styles.sectionHeader,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              fontWeight: tokens.typography.caption.fontWeight,
            },
          ]}
        >
          PRO MEMBERSHIP
        </Text>
        <SettingsCard testID="settings-purchases-card">
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardTitleWithIcon}>
              <View
                style={[
                  styles.iconBox,
                  { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.sm },
                ]}
              >
                <Sparkles size={20} color={colors.warning} />
              </View>
              <Text
                style={[
                  styles.cardTitle,
                  {
                    color: colors.text,
                    fontSize: tokens.typography.bodyStrong.fontSize,
                    fontWeight: tokens.typography.bodyStrong.fontWeight,
                  },
                ]}
              >
                Pro Status
              </Text>
            </View>

            <View
              testID="pro-status-badge"
              style={[
                styles.badge,
                {
                  backgroundColor: colors.surfaceAlt,
                  borderRadius: tokens.radius.pill,
                },
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  {
                    color: isPurchased || (!CONFIG.ENABLE_PRO_GATE && isPro) ? colors.accent : colors.textMuted,
                    fontSize: tokens.typography.micro.fontSize,
                    fontWeight: tokens.typography.micro.fontWeight,
                  },
                ]}
              >
                {isPurchased ? 'LIFETIME PRO' : !CONFIG.ENABLE_PRO_GATE ? 'FREE BETA' : 'FREE TIER'}
              </Text>
            </View>
          </View>

          <Text
            style={[
              styles.cardDescription,
              {
                color: colors.textMuted,
                fontSize: tokens.typography.caption.fontSize,
                lineHeight: tokens.typography.caption.lineHeight,
              },
            ]}
          >
            {isPurchased
              ? 'You have unlimited scans, high-resolution exports, and batch sharing unlocked.'
              : !CONFIG.ENABLE_PRO_GATE
                ? 'All Pro features are currently unlocked for free during beta testing ($0 MVP).'
                : 'Free tier scans up to 50 photos per trip. Upgrade to Pro for unlimited scans.'}
          </Text>

          <View style={styles.actionButtonsRow}>
            {!isPurchased && (
              <Button
                testID="settings-view-pro-button"
                title="View Pro Details"
                variant="primary"
                size="sm"
                onPress={() => router.push('/paywall')}
              />
            )}

            <Button
              testID="settings-restore-purchase-button"
              title="Restore Purchase"
              variant="ghost"
              size="sm"
              loading={isRestoring}
              onPress={handleRestorePurchases}
            />
          </View>
        </SettingsCard>
      </View>

      {/* 4. Privacy Statement Section */}
      <View style={styles.section}>
        <Text
          style={[
            styles.sectionHeader,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              fontWeight: tokens.typography.caption.fontWeight,
            },
          ]}
        >
          PRIVACY & ON-DEVICE SECURITY
        </Text>
        <SettingsCard testID="settings-privacy-card">
          <View style={styles.privacyHeader}>
            <View
              style={[
                styles.iconBox,
                { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.sm },
              ]}
            >
              <ShieldCheck size={20} color={colors.success} />
            </View>
            <Text
              style={[
                styles.privacyTitle,
                {
                  color: colors.text,
                  fontSize: tokens.typography.bodyStrong.fontSize,
                  fontWeight: tokens.typography.bodyStrong.fontWeight,
                },
              ]}
            >
              Nothing leaves your phone.
            </Text>
          </View>

          <View style={styles.privacyList}>
            <View style={styles.privacyItem}>
              <Check size={16} color={colors.accent} style={styles.privacyCheck} />
              <Text style={[styles.privacyItemText, { color: colors.textMuted, fontSize: tokens.typography.caption.fontSize }]}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>100% On-Device AI: </Text>
                Face detection and clustering run exclusively on your iPhone Neural Engine.
              </Text>
            </View>

            <View style={styles.privacyItem}>
              <Check size={16} color={colors.accent} style={styles.privacyCheck} />
              <Text style={[styles.privacyItemText, { color: colors.textMuted, fontSize: tokens.typography.caption.fontSize }]}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>Read-Only Gallery: </Text>
                The app never alters, deletes, or uploads your original photos.
              </Text>
            </View>

            <View style={styles.privacyItem}>
              <Check size={16} color={colors.accent} style={styles.privacyCheck} />
              <Text style={[styles.privacyItemText, { color: colors.textMuted, fontSize: tokens.typography.caption.fontSize }]}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>Zero Trash: </Text>
                Temporary ZIP archives are deleted immediately after sharing.
              </Text>
            </View>

            <View style={styles.privacyItem}>
              <Check size={16} color={colors.accent} style={styles.privacyCheck} />
              <Text style={[styles.privacyItemText, { color: colors.textMuted, fontSize: tokens.typography.caption.fontSize }]}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>No Cloud Accounts: </Text>
                No logins, no tracking, and biometric face data is excluded from iCloud backups.
              </Text>
            </View>
          </View>
        </SettingsCard>
      </View>

      {/* 5. Danger Zone: Reset All App Data */}
      <View style={styles.section}>
        <Text
          style={[
            styles.sectionHeader,
            {
              color: colors.danger,
              fontSize: tokens.typography.caption.fontSize,
              fontWeight: tokens.typography.caption.fontWeight,
            },
          ]}
        >
          DATA MANAGEMENT
        </Text>
        <SettingsCard testID="settings-danger-card">
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardTitleWithIcon}>
              <View
                style={[
                  styles.iconBox,
                  { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.sm },
                ]}
              >
                <Trash2 size={20} color={colors.danger} />
              </View>
              <Text
                style={[
                  styles.cardTitle,
                  {
                    color: colors.text,
                    fontSize: tokens.typography.bodyStrong.fontSize,
                    fontWeight: tokens.typography.bodyStrong.fontWeight,
                  },
                ]}
              >
                Reset All App Data
              </Text>
            </View>
          </View>

          <Text
            style={[
              styles.cardDescription,
              {
                color: colors.textMuted,
                fontSize: tokens.typography.caption.fontSize,
                lineHeight: tokens.typography.caption.lineHeight,
              },
            ]}
          >
            Deletes all detected trips, scanned face groups, custom names, and export caches. Original photos in your library remain 100% untouched.
          </Text>

          <Button
            testID="settings-reset-data-button"
            title="Reset All App Data"
            variant="danger"
            size="md"
            loading={isResetting}
            icon={<Trash2 size={16} color="#FFFFFF" />}
            onPress={handleResetAllData}
            style={styles.cardSingleAction}
          />
        </SettingsCard>
      </View>

      {/* 6. About & Version Section */}
      <View style={styles.aboutSection}>
        <Text
          style={[
            styles.aboutAppName,
            {
              color: colors.text,
              fontSize: tokens.typography.bodyStrong.fontSize,
              fontWeight: tokens.typography.bodyStrong.fontWeight,
            },
          ]}
        >
          Trip Photo Sorter
        </Text>
        <Text
          style={[
            styles.aboutAppVersion,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
            },
          ]}
        >
          Version 1.0.0 (Build 1)
        </Text>
        <Text
          style={[
            styles.aboutAppNotice,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.micro.fontSize,
            },
          ]}
        >
          $0 Budget • 100% On-Device • iOS First
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingTop: 16,
  },
  bannerWrapper: {
    marginBottom: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  cardTitleWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBox: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  cardTitle: {},
  cardDescription: {
    marginBottom: 14,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeText: {
    letterSpacing: 0.6,
  },
  actionButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  cardSingleAction: {
    alignSelf: 'flex-start',
  },
  privacyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  privacyTitle: {},
  privacyList: {
    gap: 10,
  },
  privacyItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  privacyCheck: {
    marginRight: 8,
    marginTop: 2,
  },
  privacyItemText: {
    flex: 1,
    lineHeight: 18,
  },
  aboutSection: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 4,
  },
  aboutAppName: {},
  aboutAppVersion: {},
  aboutAppNotice: {},
});
