import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Sparkles,
  Users,
  Archive,
  ShieldCheck,
  ShieldAlert,
  Settings,
  Lock,
  RefreshCw,
} from 'lucide-react-native';
import { useTheme } from '../src/theme';
import { Button } from '../src/components/ui/Button';
import { useLibraryPermission } from '../src/hooks/useLibraryPermission';
import { setOnboarded } from '../src/db/repositories/settings';

export interface BenefitCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  testID?: string;
}

/**
 * Benefit Card component for Onboarding (02_AppFlow §3.1, 03_UI_Spec §6)
 */
export function BenefitCard({ icon, title, description, testID }: BenefitCardProps) {
  const { colors, tokens } = useTheme();

  return (
    <View
      testID={testID}
      style={[
        styles.benefitCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing.lg,
        },
      ]}
    >
      <View
        style={[
          styles.benefitIconContainer,
          {
            backgroundColor: colors.surfaceAlt,
            borderRadius: tokens.radius.md,
          },
        ]}
      >
        {icon}
      </View>
      <View style={styles.benefitTextContainer}>
        <Text
          style={[
            styles.benefitTitle,
            {
              color: colors.text,
              fontSize: tokens.typography.heading.fontSize,
              lineHeight: tokens.typography.heading.lineHeight,
              fontWeight: tokens.typography.heading.fontWeight,
            },
          ]}
        >
          {title}
        </Text>
        <Text
          style={[
            styles.benefitDescription,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.body.fontSize,
              lineHeight: tokens.typography.body.lineHeight,
              fontWeight: tokens.typography.body.fontWeight,
              marginTop: tokens.spacing.xs,
            },
          ]}
        >
          {description}
        </Text>
      </View>
    </View>
  );
}

/**
 * Permission Denied View component (02_AppFlow §3.1)
 * Explains why photo access is needed, reassures 100% on-device privacy,
 * and provides "Open Settings" CTA.
 */
export function PermissionDeniedView({
  onOpenSettings,
  onCheckAgain,
  isChecking = false,
}: {
  onOpenSettings: () => void;
  onCheckAgain?: () => void;
  isChecking?: boolean;
}) {
  const { colors, tokens } = useTheme();

  return (
    <View testID="permission-denied-view" style={styles.deniedContainer}>
      <View
        style={[
          styles.deniedIconCircle,
          {
            backgroundColor: colors.surfaceAlt,
            borderColor: colors.border,
          },
        ]}
      >
        <ShieldAlert size={44} color={colors.danger} strokeWidth={1.8} />
      </View>

      <Text
        style={[
          styles.deniedTitle,
          {
            color: colors.text,
            fontSize: tokens.typography.title.fontSize,
            lineHeight: tokens.typography.title.lineHeight,
            fontWeight: tokens.typography.title.fontWeight,
            marginTop: tokens.spacing.xl,
          },
        ]}
      >
        Photo Access Needed
      </Text>

      <Text
        style={[
          styles.deniedDescription,
          {
            color: colors.textMuted,
            fontSize: tokens.typography.body.fontSize,
            lineHeight: tokens.typography.body.lineHeight,
            fontWeight: tokens.typography.body.fontWeight,
            marginTop: tokens.spacing.md,
          },
        ]}
      >
        Trip Photo Sorter needs access to your photo library to detect trips and group friends&apos;
        faces.
      </Text>

      <View
        style={[
          styles.privacyCallout,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderRadius: tokens.radius.md,
            padding: tokens.spacing.lg,
            marginTop: tokens.spacing.xl,
          },
        ]}
      >
        <View style={styles.privacyCalloutHeader}>
          <Lock size={18} color={colors.accent} strokeWidth={2} />
          <Text
            style={[
              styles.privacyCalloutTitle,
              {
                color: colors.text,
                fontSize: tokens.typography.bodyStrong.fontSize,
                fontWeight: tokens.typography.bodyStrong.fontWeight,
                marginLeft: tokens.spacing.sm,
              },
            ]}
          >
            Nothing leaves your phone.
          </Text>
        </View>
        <Text
          style={[
            styles.privacyCalloutBody,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              lineHeight: tokens.typography.caption.lineHeight,
              marginTop: tokens.spacing.xs,
            },
          ]}
        >
          All face detection and trip sorting run locally on your device. We never upload photos or
          share your data with anyone.
        </Text>
      </View>

      <View style={[styles.deniedActions, { marginTop: tokens.spacing.xxl }]}>
        <Button
          testID="open-settings-button"
          title="Open Settings"
          variant="primary"
          size="lg"
          icon={<Settings size={18} color={colors.onPrimary} strokeWidth={2} />}
          onPress={onOpenSettings}
          style={styles.fullWidthButton}
        />

        {onCheckAgain && (
          <Button
            testID="check-again-button"
            title="Check Again"
            variant="ghost"
            size="md"
            loading={isChecking}
            icon={<RefreshCw size={16} color={colors.text} strokeWidth={2} />}
            onPress={onCheckAgain}
            style={[styles.fullWidthButton, { marginTop: tokens.spacing.sm }]}
          />
        )}
      </View>
    </View>
  );
}

/**
 * Onboarding & Permission Screen (02_AppFlow §3.1, 01_PRD US-01, 03_UI_Spec §6)
 */
export default function OnboardingScreen() {
  const { colors, tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    status,
    granted,
    isLoading: isPermissionLoading,
    requestPermission,
    refreshPermission,
    openSettings,
  } = useLibraryPermission();

  const [isRequesting, setIsRequesting] = useState<boolean>(false);

  // When permission is granted or limited, mark onboarded and navigate to home
  useEffect(() => {
    if (granted || status === 'full' || status === 'limited') {
      setOnboarded(true)
        .then(() => {
          router.replace('/');
        })
        .catch(() => {
          // If setting fails, navigate anyway
          router.replace('/');
        });
    }
  }, [granted, status, router]);

  const handleAllowAccess = async () => {
    setIsRequesting(true);
    try {
      const result = await requestPermission();
      if (result.granted || result.status === 'full' || result.status === 'limited') {
        await setOnboarded(true);
        router.replace('/');
        return;
      }
    } catch {
      // Permission request handled gracefully
    }
    setIsRequesting(false);
  };

  const handleOpenSettings = async () => {
    try {
      if (typeof openSettings === 'function') {
        await openSettings();
      } else {
        await Linking.openSettings();
      }
    } catch {
      /* ignore */
    }
  };

  const handleCheckAgain = async () => {
    setIsRequesting(true);
    try {
      const result = await refreshPermission();
      if (result.granted || result.status === 'full' || result.status === 'limited') {
        await setOnboarded(true);
        router.replace('/');
        return;
      }
    } catch {
      /* ignore */
    }
    setIsRequesting(false);
  };

  // Determine if we should show Permission Denied view:
  // Show when status is 'denied', or when user has triggered the prompt and was denied
  const isDenied = status === 'denied';

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.bg }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingHorizontal: tokens.spacing.screenPadding,
            paddingTop: Math.max(insets.top, tokens.spacing.lg),
            paddingBottom: Math.max(insets.bottom + tokens.spacing.xl, tokens.spacing.xxl),
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {isDenied ? (
          <PermissionDeniedView
            onOpenSettings={handleOpenSettings}
            onCheckAgain={handleCheckAgain}
            isChecking={isRequesting}
          />
        ) : (
          <View testID="onboarding-main-view" style={styles.mainContainer}>
            {/* Header: App Title & Reassurance Tag */}
            <View style={styles.header}>
              <View
                style={[
                  styles.privacyTag,
                  {
                    backgroundColor: colors.surfaceAlt,
                    borderColor: colors.border,
                    borderRadius: tokens.radius.pill,
                    paddingHorizontal: tokens.spacing.md,
                    paddingVertical: tokens.spacing.xs,
                  },
                ]}
              >
                <ShieldCheck size={16} color={colors.accent} strokeWidth={2} />
                <Text
                  style={[
                    styles.privacyTagText,
                    {
                      color: colors.textMuted,
                      fontSize: tokens.typography.caption.fontSize,
                      fontWeight: tokens.typography.caption.fontWeight,
                      marginLeft: tokens.spacing.xs,
                    },
                  ]}
                >
                  100% On-Device
                </Text>
              </View>

              <Text
                style={[
                  styles.title,
                  {
                    color: colors.text,
                    fontSize: tokens.typography.display.fontSize,
                    lineHeight: tokens.typography.display.lineHeight,
                    fontWeight: tokens.typography.display.fontWeight,
                    marginTop: tokens.spacing.md,
                  },
                ]}
              >
                Trip Photo Sorter
              </Text>

              <Text
                style={[
                  styles.subtitle,
                  {
                    color: colors.textMuted,
                    fontSize: tokens.typography.body.fontSize,
                    lineHeight: tokens.typography.body.lineHeight,
                    marginTop: tokens.spacing.xs,
                  },
                ]}
              >
                Sort and share memorable moments from your getaways in seconds.
              </Text>
            </View>

            {/* 3 Benefit Cards (02_AppFlow §3.1) */}
            <View style={[styles.benefitCardsList, { marginVertical: tokens.spacing.xl }]}>
              <BenefitCard
                testID="benefit-card-1"
                icon={<Sparkles size={24} color={colors.primary} strokeWidth={1.8} />}
                title="Find trips automatically"
                description="Smart clustering identifies your getaways by date and time gap so you never have to search."
              />

              <BenefitCard
                testID="benefit-card-2"
                icon={<Users size={24} color={colors.accent} strokeWidth={1.8} />}
                title="Group faces on your phone"
                description="On-device face grouping groups friends together without uploading a single photo anywhere."
              />

              <BenefitCard
                testID="benefit-card-3"
                icon={<Archive size={24} color={colors.primary} strokeWidth={1.8} />}
                title="Share 1 ZIP per friend"
                description="Export full-quality photo sets or single ZIP archives directly into your favorite messaging apps."
              />
            </View>

            {/* Privacy Reassurance Note */}
            <View
              style={[
                styles.privacyGuarantee,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  borderRadius: tokens.radius.md,
                  padding: tokens.spacing.md,
                  marginBottom: tokens.spacing.xl,
                },
              ]}
            >
              <View style={styles.privacyGuaranteeHeader}>
                <Lock size={16} color={colors.accent} strokeWidth={2} />
                <Text
                  style={[
                    styles.privacyGuaranteeTitle,
                    {
                      color: colors.text,
                      fontSize: tokens.typography.bodyStrong.fontSize,
                      fontWeight: tokens.typography.bodyStrong.fontWeight,
                      marginLeft: tokens.spacing.xs,
                    },
                  ]}
                >
                  Nothing leaves your phone.
                </Text>
              </View>
              <Text
                style={[
                  styles.privacyGuaranteeText,
                  {
                    color: colors.textMuted,
                    fontSize: tokens.typography.caption.fontSize,
                    lineHeight: tokens.typography.caption.lineHeight,
                    marginTop: tokens.spacing.xs,
                  },
                ]}
              >
                Your gallery is strictly read-only. Faces and trips are analyzed locally without any
                cloud servers, logins, or tracking.
              </Text>
            </View>

            {/* Action CTA */}
            <View style={styles.actionArea}>
              <Button
                testID="allow-access-button"
                title="Allow Photo Access"
                variant="primary"
                size="lg"
                loading={isRequesting || isPermissionLoading}
                onPress={handleAllowAccess}
                style={styles.fullWidthButton}
              />
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  mainContainer: {
    flex: 1,
    justifyContent: 'space-between',
  },
  header: {
    alignItems: 'center',
    textAlign: 'center',
    marginTop: 8,
  },
  privacyTag: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  privacyTagText: {
    letterSpacing: 0.3,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
  },
  benefitCardsList: {
    gap: 12,
  },
  benefitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  benefitIconContainer: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  benefitTextContainer: {
    flex: 1,
  },
  benefitTitle: {},
  benefitDescription: {},
  privacyGuarantee: {
    borderWidth: 1,
  },
  privacyGuaranteeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  privacyGuaranteeTitle: {},
  privacyGuaranteeText: {},
  actionArea: {
    width: '100%',
  },
  fullWidthButton: {
    width: '100%',
  },
  deniedContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
  },
  deniedIconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deniedTitle: {
    textAlign: 'center',
  },
  deniedDescription: {
    textAlign: 'center',
    maxWidth: 320,
  },
  privacyCallout: {
    width: '100%',
    borderWidth: 1,
  },
  privacyCalloutHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  privacyCalloutTitle: {},
  privacyCalloutBody: {},
  deniedActions: {
    width: '100%',
  },
});
