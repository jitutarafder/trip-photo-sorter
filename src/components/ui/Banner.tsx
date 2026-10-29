import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  Info,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  X,
} from 'lucide-react-native';
import { useTheme } from '../../hooks/useTheme';

export type BannerVariant = 'info' | 'warning' | 'error' | 'success';

export interface BannerAction {
  label: string;
  onPress: () => void;
}

export interface BannerProps {
  variant?: BannerVariant;
  message: string;
  title?: string;
  action?: BannerAction;
  onDismiss?: () => void;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Core Banner Component (03_UI_Spec §6)
 * Variants: info, warning, error, success
 * Displays icon + text + optional action
 */
export const Banner: React.FC<BannerProps> = ({
  variant = 'info',
  message,
  title,
  action,
  onDismiss,
  icon,
  style,
  testID,
}) => {
  const { colors, tokens } = useTheme();

  const getVariantConfig = () => {
    switch (variant) {
      case 'warning':
        return {
          color: colors.warning,
          defaultIcon: <AlertTriangle size={20} color={colors.warning} strokeWidth={2} />,
          borderColor: colors.warning,
        };
      case 'error':
        return {
          color: colors.danger,
          defaultIcon: <AlertCircle size={20} color={colors.danger} strokeWidth={2} />,
          borderColor: colors.danger,
        };
      case 'success':
        return {
          color: colors.success,
          defaultIcon: <CheckCircle size={20} color={colors.success} strokeWidth={2} />,
          borderColor: colors.success,
        };
      case 'info':
      default:
        return {
          color: colors.primary,
          defaultIcon: <Info size={20} color={colors.primary} strokeWidth={2} />,
          borderColor: colors.primary,
        };
    }
  };

  const config = getVariantConfig();

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          backgroundColor: colors.surfaceAlt,
          borderColor: config.borderColor,
          borderRadius: tokens.radius.md,
        },
        style,
      ]}
    >
      <View style={styles.iconContainer}>{icon ?? config.defaultIcon}</View>

      <View style={styles.textContainer}>
        {title && (
          <Text
            maxFontSizeMultiplier={1.3}
            style={[
              styles.title,
              {
                color: colors.text,
                fontSize: tokens.typography.caption.fontSize,
                lineHeight: tokens.typography.caption.lineHeight,
                fontWeight: tokens.typography.bodyStrong.fontWeight,
              },
            ]}
          >
            {title}
          </Text>
        )}
        <Text
          maxFontSizeMultiplier={1.3}
          style={[
            styles.message,
            {
              color: colors.text,
              fontSize: tokens.typography.caption.fontSize,
              lineHeight: tokens.typography.caption.lineHeight,
            },
          ]}
        >
          {message}
        </Text>

        {action && (
          <Pressable
            testID={`${testID ?? 'banner'}-action`}
            accessibilityRole="button"
            onPress={action.onPress}
            style={styles.actionBtn}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              style={[
                styles.actionText,
                {
                  color: config.color,
                  fontWeight: tokens.typography.bodyStrong.fontWeight,
                },
              ]}
            >
              {action.label}
            </Text>
          </Pressable>
        )}
      </View>

      {onDismiss && (
        <Pressable
          testID={`${testID ?? 'banner'}-dismiss`}
          accessibilityRole="button"
          accessibilityLabel="Dismiss banner"
          onPress={onDismiss}
          style={styles.dismissBtn}
        >
          <X size={16} color={colors.textMuted} strokeWidth={2} />
        </Pressable>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    padding: 12,
    borderWidth: 1,
    alignItems: 'flex-start',
    marginVertical: 6,
  },
  iconContainer: {
    marginRight: 10,
    marginTop: 2,
  },
  textContainer: {
    flex: 1,
  },
  title: {
    marginBottom: 2,
  },
  message: {
    flexWrap: 'wrap',
  },
  actionBtn: {
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  actionText: {
    fontSize: 13,
  },
  dismissBtn: {
    padding: 4,
    marginLeft: 8,
  },
});
