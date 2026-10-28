import React, { useRef } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  View,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
  type GestureResponderEvent,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  onPress?: (event: GestureResponderEvent) => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  children?: React.ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * Core Button Component (03_UI_Spec §6)
 * Variants: primary, secondary, ghost, danger
 * States: default, pressed (scale 0.97 over 90ms), disabled (50% opacity), loading (width locked spinner)
 * Minimum touch target: 44x44
 */
export const Button: React.FC<ButtonProps> = ({
  title,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  iconPosition = 'left',
  onPress,
  style,
  textStyle,
  children,
  testID,
  accessibilityLabel,
}) => {
  const { colors, tokens } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    if (disabled || loading) return;
    if (process.env.NODE_ENV === 'test') {
      scaleAnim.setValue(tokens.motion.pressScale);
      return;
    }
    Animated.timing(scaleAnim, {
      toValue: tokens.motion.pressScale, // 0.97
      duration: tokens.motion.pressDurationMs, // 90ms
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    if (disabled || loading) return;
    if (process.env.NODE_ENV === 'test') {
      scaleAnim.setValue(1);
      return;
    }
    Animated.timing(scaleAnim, {
      toValue: 1,
      duration: tokens.motion.pressDurationMs,
      useNativeDriver: true,
    }).start();
  };

  // Variant color definitions
  const getVariantStyles = (): {
    container: ViewStyle;
    text: TextStyle;
    spinnerColor: string;
  } => {
    switch (variant) {
      case 'primary':
        return {
          container: {
            backgroundColor: colors.primary,
            borderColor: 'transparent',
          },
          text: {
            color: colors.onPrimary,
          },
          spinnerColor: colors.onPrimary,
        };
      case 'secondary':
        return {
          container: {
            backgroundColor: colors.surfaceAlt,
            borderColor: colors.border,
            borderWidth: 1,
          },
          text: {
            color: colors.text,
          },
          spinnerColor: colors.text,
        };
      case 'ghost':
        return {
          container: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
          },
          text: {
            color: colors.primary,
          },
          spinnerColor: colors.primary,
        };
      case 'danger':
        return {
          container: {
            backgroundColor: colors.danger,
            borderColor: 'transparent',
          },
          text: {
            color: '#FFFFFF',
          },
          spinnerColor: '#FFFFFF',
        };
    }
  };

  // Size definitions
  const getSizeStyles = (): {
    container: ViewStyle;
    text: TextStyle;
  } => {
    switch (size) {
      case 'sm':
        return {
          container: {
            minHeight: tokens.layout.minTouchTarget, // Maintain 44px touch target accessibility
            paddingHorizontal: tokens.spacing.sm, // 12
            paddingVertical: tokens.spacing.xs, // 8
            borderRadius: tokens.radius.sm, // 8
          },
          text: {
            fontSize: tokens.typography.caption.fontSize,
            lineHeight: tokens.typography.caption.lineHeight,
            fontWeight: tokens.typography.caption.fontWeight,
          },
        };
      case 'lg':
        return {
          container: {
            minHeight: 52,
            paddingHorizontal: tokens.spacing.lg, // 24
            paddingVertical: tokens.spacing.md, // 16
            borderRadius: tokens.radius.md, // 12
          },
          text: {
            fontSize: tokens.typography.bodyStrong.fontSize,
            lineHeight: tokens.typography.bodyStrong.lineHeight,
            fontWeight: tokens.typography.bodyStrong.fontWeight,
          },
        };
      case 'md':
      default:
        return {
          container: {
            minHeight: tokens.layout.minTouchTarget, // 44px
            paddingHorizontal: tokens.spacing.md, // 16
            paddingVertical: tokens.spacing.sm, // 12
            borderRadius: tokens.radius.md, // 12
          },
          text: {
            fontSize: tokens.typography.bodyStrong.fontSize,
            lineHeight: tokens.typography.bodyStrong.lineHeight,
            fontWeight: tokens.typography.bodyStrong.fontWeight,
          },
        };
    }
  };

  const variantStyles = getVariantStyles();
  const sizeStyles = getSizeStyles();

  const isInteractive = !disabled && !loading;

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ disabled: !isInteractive, busy: loading }}
        activeOpacity={0.88}
        disabled={!isInteractive}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          styles.baseContainer,
          sizeStyles.container,
          variantStyles.container,
          disabled && styles.disabledContainer,
          style,
        ]}
      >
        {loading ? (
          <View style={styles.loadingWrapper}>
            <ActivityIndicator
              size="small"
              color={variantStyles.spinnerColor}
              testID={`${testID ?? 'button'}-spinner`}
            />
          </View>
        ) : (
          <View style={styles.contentRow}>
            {icon && iconPosition === 'left' && (
              <View style={styles.iconLeft}>{icon}</View>
            )}
            {children ? (
              children
            ) : title ? (
              <Text
                style={[
                  styles.baseText,
                  sizeStyles.text,
                  variantStyles.text,
                  disabled && { opacity: 0.8 },
                  textStyle,
                ]}
                numberOfLines={1}
              >
                {title}
              </Text>
            ) : null}
            {icon && iconPosition === 'right' && (
              <View style={styles.iconRight}>{icon}</View>
            )}
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  baseContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  baseText: {
    textAlign: 'center',
  },
  disabledContainer: {
    opacity: 0.5, // 50% opacity per 03_UI_Spec §6
  },
  loadingWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 20,
  },
  iconLeft: {
    marginRight: 8,
  },
  iconRight: {
    marginLeft: 8,
  },
});
