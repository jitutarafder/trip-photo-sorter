import React, { useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Animated,
  Easing,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { useReduceMotion } from '../../hooks/useReduceMotion';

export interface ProgressRingProps {
  /** Value from 0.0 to 1.0 for determinate mode; if omitted or indeterminate=true, spins indefinitely */
  progress?: number;
  indeterminate?: boolean;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  showPercentText?: boolean;
  centerText?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
}

/**
 * Core ProgressRing Component (03_UI_Spec §6)
 * States: determinate · indeterminate
 * Implemented with pure React Native views & animations (zero external native dependencies)
 */
export const ProgressRing: React.FC<ProgressRingProps> = ({
  progress,
  indeterminate = false,
  size = 48,
  strokeWidth = 4,
  color,
  trackColor,
  showPercentText = false,
  centerText,
  style,
  textStyle,
  testID,
}) => {
  const { colors, tokens } = useTheme();
  const spinAnim = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  const activeColor = color ?? colors.accent;
  const activeTrackColor = trackColor ?? colors.surfaceAlt;

  const isIndeterminate = indeterminate || progress === undefined;

  useEffect(() => {
    if (isIndeterminate) {
      if (process.env.NODE_ENV === 'test' || reduceMotion) {
        spinAnim.setValue(0);
        return;
      }
      const loop = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      loop.start();
      return () => {
        loop.stop();
      };
    } else {
      spinAnim.setValue(0);
    }
  }, [isIndeterminate, spinAnim, reduceMotion]);

  const clampedProgress = Math.min(1, Math.max(0, progress ?? 0));
  const degrees = clampedProgress * 360;

  // Spin rotation for indeterminate
  const spinInterpolation = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const halfSize = size / 2;

  // Half-circle math for determinate progress
  const rightRotate = Math.min(180, degrees);
  const leftRotate = Math.max(0, degrees - 180);

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          width: size,
          height: size,
        },
        style,
      ]}
    >
      {isIndeterminate ? (
        /* Indeterminate spinning ring */
        <Animated.View
          testID={`${testID ?? 'progress-ring'}-indeterminate`}
          style={[
            styles.indeterminateRing,
            {
              width: size,
              height: size,
              borderRadius: halfSize,
              borderWidth: strokeWidth,
              borderColor: activeTrackColor,
              borderTopColor: activeColor,
              borderRightColor: activeColor,
              transform: [{ rotate: spinInterpolation }],
            },
          ]}
        />
      ) : (
        /* Determinate dual half-circle ring */
        <View
          testID={`${testID ?? 'progress-ring'}-determinate`}
          style={[styles.determinateWrapper, { width: size, height: size }]}
        >
          {/* Background track circle */}
          <View
            style={[
              styles.trackCircle,
              {
                width: size,
                height: size,
                borderRadius: halfSize,
                borderWidth: strokeWidth,
                borderColor: activeTrackColor,
              },
            ]}
          />

          {/* Right half (0 to 180 deg) */}
          <View
            style={[
              styles.halfContainer,
              {
                width: halfSize,
                height: size,
                left: halfSize,
              },
            ]}
          >
            <View
              style={[
                styles.halfCircle,
                {
                  width: size,
                  height: size,
                  borderRadius: halfSize,
                  borderWidth: strokeWidth,
                  borderColor: activeColor,
                  borderLeftColor: 'transparent',
                  borderBottomColor: 'transparent',
                  left: -halfSize,
                  transform: [{ rotate: `${-135 + rightRotate}deg` }],
                },
              ]}
            />
          </View>

          {/* Left half (180 to 360 deg) */}
          <View
            style={[
              styles.halfContainer,
              {
                width: halfSize,
                height: size,
                left: 0,
              },
            ]}
          >
            <View
              style={[
                styles.halfCircle,
                {
                  width: size,
                  height: size,
                  borderRadius: halfSize,
                  borderWidth: strokeWidth,
                  borderColor: activeColor,
                  borderRightColor: 'transparent',
                  borderTopColor: 'transparent',
                  left: 0,
                  transform: [{ rotate: `${-135 + leftRotate}deg` }],
                },
              ]}
            />
          </View>
        </View>
      )}

      {/* Center Label (percentage or custom text) */}
      {(showPercentText || centerText) && (
        <View style={styles.centerTextWrapper}>
          <Text
            maxFontSizeMultiplier={1.3}
            style={[
              styles.centerText,
              {
                color: colors.text,
                fontSize: Math.max(10, Math.round(size * 0.22)),
                fontWeight: tokens.typography.bodyStrong.fontWeight,
              },
              textStyle,
            ]}
            numberOfLines={1}
          >
            {centerText ?? `${Math.round(clampedProgress * 100)}%`}
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  indeterminateRing: {
    position: 'absolute',
  },
  determinateWrapper: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackCircle: {
    position: 'absolute',
  },
  halfContainer: {
    position: 'absolute',
    top: 0,
    overflow: 'hidden',
  },
  halfCircle: {
    position: 'absolute',
    top: 0,
  },
  centerTextWrapper: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerText: {
    textAlign: 'center',
  },
});
