import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Animated,
  AccessibilityInfo,
  type StyleProp,
  type ViewStyle,
  type DimensionValue,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: DimensionValue;
  borderRadius?: number;
  circle?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Core Skeleton Component (03_UI_Spec §6)
 * Shimmer 1.2 s loop
 * Respects Reduce Motion accessibility setting
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = 20,
  borderRadius,
  circle = false,
  style,
  testID,
}) => {
  const { colors, tokens } = useTheme();
  const opacityAnim = useRef(new Animated.Value(0.35)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    // Check Reduce Motion accessibility setting
    let isMounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (isMounted) {
        setReduceMotion(enabled);
      }
    });

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => {
        setReduceMotion(enabled);
      }
    );

    return () => {
      isMounted = false;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion || process.env.NODE_ENV === 'test') {
      opacityAnim.setValue(0.5);
      return;
    }

    // 1.2 s loop (600ms ease up, 600ms ease down) per 03_UI_Spec §6
    const shimmerAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacityAnim, {
          toValue: 0.85,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0.35,
          duration: 600,
          useNativeDriver: true,
        }),
      ])
    );

    shimmerAnimation.start();

    return () => {
      shimmerAnimation.stop();
    };
  }, [opacityAnim, reduceMotion]);

  const defaultRadius = circle
    ? typeof width === 'number'
      ? width / 2
      : 999
    : (borderRadius ?? tokens.radius.md);

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.skeletonBase,
        {
          width,
          height: circle && typeof width === 'number' ? width : height,
          borderRadius: defaultRadius,
          backgroundColor: colors.surfaceAlt,
          opacity: opacityAnim,
        },
        style,
      ]}
    />
  );
};

const styles = StyleSheet.create({
  skeletonBase: {
    overflow: 'hidden',
  },
});
