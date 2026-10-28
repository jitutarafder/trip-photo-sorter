import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  Sparkles,
  Infinity as InfinityIcon,
  FolderArchive,
  Zap,
  ShieldCheck,
  Check,
} from 'lucide-react-native';
import { useTheme } from '../src/theme';
import { Button } from '../src/components/ui/Button';
import { Banner, type BannerVariant } from '../src/components/ui/Banner';
import { useProStatus, getProProductDetails } from '../src/services/purchases';
import { CONFIG } from '../src/domain/config';

interface BenefitItemProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  testID?: string;
}

function BenefitItem({ icon, title, description, testID }: BenefitItemProps) {
  const { colors, tokens } = useTheme();

  return (
    <View
      testID={testID}
      style={[
        styles.benefitRow,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: tokens.radius.md,
          padding: tokens.spacing.md,
        },
      ]}
    >
      <View
        style={[
          styles.benefitIconBox,
          {
            backgroundColor: colors.surfaceAlt,
            borderRadius: tokens.radius.sm,
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
              fontSize: tokens.typography.bodyStrong.fontSize,
              fontWeight: tokens.typography.bodyStrong.fontWeight,
            },
          ]}
        >
          {title}
        </Text>
        <Text
          style={[
            styles.benefitDesc,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              lineHeight: tokens.typography.caption.lineHeight,
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
 * Paywall Modal Screen (02_AppFlow §3.8, 01_PRD US-11/US-12, 06_Plan Task 3.10)
 *
 * Displays Pro benefits list, one-time price, Unlock Pro button, Restore Purchase button,
 * and close button (✕).
 * Pro gating is feature-flagged behind `CONFIG.ENABLE_PRO_GATE`.
 */
export default function PaywallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, tokens } = useTheme();
  const product = getProProductDetails();

  const {
    isPurchased,
    isGateEnabled,
    unlockPro,
    restorePurchases,
  } = useProStatus();

  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [feedback, setFeedback] = useState<{
    variant: BannerVariant;
    title?: string;
    message: string;
  } | null>(null);

  const handleClose = () => {
    router.back();
  };

  const handleUnlockPro = async () => {
    setIsUnlocking(true);
    setFeedback(null);
    try {
      const success = await unlockPro();
      if (success) {
        setFeedback({
          variant: 'success',
          title: 'Pro Unlocked',
          message: 'Welcome to Pro! All features are now unlocked on your phone.',
        });
        setTimeout(() => {
          router.back();
        }, 800);
      } else {
        setFeedback({
          variant: 'error',
          message: 'Unable to complete purchase. Please try again.',
        });
      }
    } catch (err: unknown) {
      setFeedback({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Purchase failed. Please try again.',
      });
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleRestorePurchases = async () => {
    setIsRestoring(true);
    setFeedback(null);
    try {
      const restored = await restorePurchases();
      if (restored) {
        setFeedback({
          variant: 'success',
          title: 'Purchases Restored',
          message: 'Your Pro lifetime purchase has been successfully restored!',
        });
        setTimeout(() => {
          router.back();
        }, 800);
      } else {
        setFeedback({
          variant: 'info',
          message: 'No previous Pro purchases were found for this Apple ID.',
        });
      }
    } catch (err: unknown) {
      setFeedback({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to restore purchases.',
      });
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <View
      testID="paywall-screen"
      style={[
        styles.container,
        {
          backgroundColor: colors.bg,
          paddingTop: insets.top > 0 ? insets.top : tokens.spacing.md,
          paddingBottom: insets.bottom > 0 ? insets.bottom : tokens.spacing.md,
        },
      ]}
    >
      {/* Top Bar with Close Button (✕) */}
      <View style={[styles.topBar, { paddingHorizontal: tokens.spacing.lg }]}>
        <View style={styles.topBarSpacer} />
        <Pressable
          testID="paywall-close-button"
          accessibilityLabel="Close paywall"
          accessibilityRole="button"
          onPress={handleClose}
          hitSlop={12}
          style={({ pressed }) => [
            styles.closeButton,
            {
              backgroundColor: colors.surfaceAlt,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <X size={20} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingHorizontal: tokens.spacing.lg,
            paddingBottom: tokens.spacing.xl,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero Section */}
        <View style={styles.heroSection}>
          <View
            style={[
              styles.heroIconBox,
              {
                backgroundColor: colors.surface,
                borderColor: colors.primary,
              },
            ]}
          >
            <Sparkles size={36} color={colors.primary} />
          </View>
          <Text
            style={[
              styles.heroTitle,
              {
                color: colors.text,
                fontSize: tokens.typography.title.fontSize,
                fontWeight: tokens.typography.title.fontWeight,
                lineHeight: tokens.typography.title.lineHeight,
              },
            ]}
          >
            {product.title}
          </Text>
          <Text
            style={[
              styles.heroSubtitle,
              {
                color: colors.textMuted,
                fontSize: tokens.typography.body.fontSize,
                lineHeight: tokens.typography.body.lineHeight,
              },
            ]}
          >
            Sort, group, and share all your trip memories without limits.
          </Text>
        </View>

        {/* Feature Flag Notice (When gate is OFF in $0 MVP) */}
        {!isGateEnabled && (
          <View style={styles.bannerContainer}>
            <Banner
              testID="beta-unlocked-banner"
              variant="info"
              message="Beta Preview: Pro gating is currently disabled ($0 MVP). All Pro features are unlocked for free!"
            />
          </View>
        )}

        {/* Pro Active Banner */}
        {isPurchased && (
          <View style={styles.bannerContainer}>
            <Banner
              testID="pro-active-banner"
              variant="success"
              title="Pro Active"
              message="You have unlocked lifetime access to all Pro features."
            />
          </View>
        )}

        {/* Dynamic Action Feedback */}
        {feedback && (
          <View style={styles.bannerContainer}>
            <Banner
              testID="paywall-feedback-banner"
              variant={feedback.variant}
              title={feedback.title}
              message={feedback.message}
              onDismiss={() => setFeedback(null)}
            />
          </View>
        )}

        {/* Benefits List */}
        <View style={styles.benefitsSection}>
          <Text
            style={[
              styles.sectionTitle,
              {
                color: colors.text,
                fontSize: tokens.typography.heading.fontSize,
                fontWeight: tokens.typography.heading.fontWeight,
                marginBottom: tokens.spacing.md,
              },
            ]}
          >
            Pro Features
          </Text>

          <BenefitItem
            testID="benefit-unlimited-scans"
            icon={<InfinityIcon size={22} color={colors.primary} />}
            title="Unlimited Photos Scanned"
            description="Scan entire multi-day trips and large events with 300+ photos (free limit: 50 photos per trip)."
          />

          <BenefitItem
            testID="benefit-full-quality"
            icon={<FolderArchive size={22} color={colors.accent} />}
            title="Full Quality ZIP & Photos"
            description="Export individual high-res original photos or ZIP files with zero compression."
          />

          <BenefitItem
            testID="benefit-batch-export"
            icon={<Zap size={22} color={colors.warning} />}
            title="One-Tap Batch Queue"
            description="Export everyone at once sequentially with progress and instant sharing."
          />

          <BenefitItem
            testID="benefit-privacy"
            icon={<ShieldCheck size={22} color={colors.success} />}
            title="100% On-Device Privacy"
            description="No cloud servers, no account required, no tracking. Your photos never leave your device."
          />
        </View>

        {/* Pricing Card */}
        <View
          testID="paywall-pricing-card"
          style={[
            styles.pricingCard,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing.lg,
            },
          ]}
        >
          <View style={styles.pricingBadgeRow}>
            <View
              style={[
                styles.lifetimeBadge,
                {
                  backgroundColor: colors.surfaceAlt,
                  borderRadius: tokens.radius.pill,
                },
              ]}
            >
              <Text
                style={[
                  styles.lifetimeBadgeText,
                  {
                    color: colors.accent,
                    fontSize: tokens.typography.micro.fontSize,
                    fontWeight: tokens.typography.micro.fontWeight,
                  },
                ]}
              >
                ONE-TIME PURCHASE
              </Text>
            </View>
          </View>

          <View style={styles.priceRow}>
            <Text
              testID="paywall-price-text"
              style={[
                styles.priceText,
                {
                  color: colors.text,
                  fontSize: tokens.typography.display.fontSize,
                  fontWeight: tokens.typography.display.fontWeight,
                },
              ]}
            >
              {CONFIG.PRO_PRICE_USD}
            </Text>
            <Text
              style={[
                styles.pricePeriod,
                {
                  color: colors.textMuted,
                  fontSize: tokens.typography.body.fontSize,
                },
              ]}
            >
              {' '}lifetime access
            </Text>
          </View>

          <Text
            style={[
              styles.pricingSubtitle,
              {
                color: colors.textMuted,
                fontSize: tokens.typography.caption.fontSize,
                lineHeight: tokens.typography.caption.lineHeight,
              },
            ]}
          >
            No subscriptions. No recurring fees. Yours forever.
          </Text>
        </View>

        {/* Action Buttons */}
        <View style={styles.actionsSection}>
          {isPurchased ? (
            <Button
              testID="paywall-done-button"
              title="Done"
              variant="primary"
              size="lg"
              icon={<Check size={18} color={colors.onPrimary} />}
              onPress={handleClose}
            />
          ) : (
            <Button
              testID="unlock-pro-button"
              title={`Unlock Pro · ${CONFIG.PRO_PRICE_USD}`}
              variant="primary"
              size="lg"
              loading={isUnlocking}
              icon={<Sparkles size={18} color={colors.onPrimary} />}
              onPress={handleUnlockPro}
            />
          )}

          <Button
            testID="restore-purchase-button"
            title="Restore Purchase"
            variant="ghost"
            size="md"
            loading={isRestoring}
            onPress={handleRestorePurchases}
            style={styles.restoreButton}
          />
        </View>

        {/* Privacy & Store Notice */}
        <Text
          style={[
            styles.footnote,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.micro.fontSize,
              lineHeight: tokens.typography.micro.lineHeight,
            },
          ]}
        >
          Purchases are securely linked to your Apple ID. All facial recognition and photo grouping run 100% on-device.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  topBarSpacer: {
    width: 36,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    paddingTop: 8,
  },
  heroSection: {
    alignItems: 'center',
    marginBottom: 20,
  },
  heroIconBox: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  heroTitle: {
    textAlign: 'center',
    marginBottom: 8,
  },
  heroSubtitle: {
    textAlign: 'center',
    maxWidth: 320,
  },
  bannerContainer: {
    marginBottom: 16,
  },
  benefitsSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    letterSpacing: -0.2,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  benefitIconBox: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  benefitTextContainer: {
    flex: 1,
  },
  benefitTitle: {
    marginBottom: 4,
  },
  benefitDesc: {},
  pricingCard: {
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    marginBottom: 24,
  },
  pricingBadgeRow: {
    marginBottom: 8,
  },
  lifetimeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  lifetimeBadgeText: {
    letterSpacing: 0.8,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  priceText: {},
  pricePeriod: {},
  pricingSubtitle: {
    textAlign: 'center',
  },
  actionsSection: {
    marginBottom: 20,
    gap: 12,
  },
  restoreButton: {
    alignSelf: 'center',
  },
  footnote: {
    textAlign: 'center',
    paddingHorizontal: 16,
  },
});
