import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Pressable,
  Animated,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { Check, Compass, Image as ImageIcon } from 'lucide-react-native';
import type { TripRow, TripScanStatus } from '../../db/types';
import { formatTripDateRange } from '../../domain/tripDetection';
import { useTheme } from '../../hooks/useTheme';

export interface TripCardProps {
  trip: TripRow;
  onPress?: (trip: TripRow) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * TripCard Component (03_UI_Spec §6, 02_AppFlow §3.2)
 *
 * Card displaying:
 * - Cover photo with bottom readability scrim (max 40% black)
 * - Trip name
 * - Date range (human-readable)
 * - Photo count
 * - Scan status badge (not_scanned · scanning · paused · clustering · scanned · failed)
 * - Press scale interaction (0.97 over 90 ms)
 */
export const TripCard: React.FC<TripCardProps> = ({
  trip,
  onPress,
  style,
  testID,
}) => {
  const { colors, tokens } = useTheme();
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  // Resolve cover photo URI asynchronously via MediaLibrary
  useEffect(() => {
    let isMounted = true;
    if (!trip.cover_photo_id) {
      setCoverUri(null);
      return;
    }

    MediaLibrary.getAssetInfoAsync(trip.cover_photo_id)
      .then((asset) => {
        if (!isMounted) return;
        if (asset) {
          setCoverUri(asset.localUri || asset.uri || null);
        }
      })
      .catch(() => {
        if (isMounted) {
          setCoverUri(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [trip.cover_photo_id]);

  const handlePressIn = () => {
    Animated.timing(scaleAnim, {
      toValue: 0.97,
      duration: 90,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      damping: 15,
      stiffness: 200,
      useNativeDriver: true,
    }).start();
  };

  const renderScanBadge = (status: TripScanStatus) => {
    switch (status) {
      case 'scanned':
        return (
          <View
            testID="scan-badge-scanned"
            style={[
              styles.badge,
              {
                backgroundColor: 'rgba(61, 219, 138, 0.2)',
                borderColor: colors.success,
              },
            ]}
          >
            <Check size={12} color={colors.success} strokeWidth={2.5} style={styles.badgeIcon} />
            <Text style={[styles.badgeText, { color: colors.success }]}>Scanned</Text>
          </View>
        );
      case 'scanning':
        return (
          <View
            testID="scan-badge-scanning"
            style={[
              styles.badge,
              {
                backgroundColor: 'rgba(108, 140, 255, 0.2)',
                borderColor: colors.primary,
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: colors.primary }]}>Scanning...</Text>
          </View>
        );
      case 'clustering':
        return (
          <View
            testID="scan-badge-clustering"
            style={[
              styles.badge,
              {
                backgroundColor: 'rgba(61, 219, 176, 0.2)',
                borderColor: colors.accent,
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: colors.accent }]}>Clustering...</Text>
          </View>
        );
      case 'paused':
        return (
          <View
            testID="scan-badge-paused"
            style={[
              styles.badge,
              {
                backgroundColor: 'rgba(255, 184, 77, 0.2)',
                borderColor: colors.warning,
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: colors.warning }]}>Paused</Text>
          </View>
        );
      case 'failed':
        return (
          <View
            testID="scan-badge-failed"
            style={[
              styles.badge,
              {
                backgroundColor: 'rgba(255, 92, 108, 0.2)',
                borderColor: colors.danger,
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: colors.danger }]}>Failed</Text>
          </View>
        );
      case 'not_scanned':
      default:
        return (
          <View
            testID="scan-badge-not_scanned"
            style={[
              styles.badge,
              {
                backgroundColor: 'rgba(11, 13, 18, 0.45)',
                borderColor: 'rgba(255, 255, 255, 0.2)',
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: 'rgba(255, 255, 255, 0.85)' }]}>
              Not Scanned
            </Text>
          </View>
        );
    }
  };

  const dateRangeString = formatTripDateRange(trip.start_at, trip.end_at);
  const photoCountString =
    trip.photo_count === 1 ? '1 photo' : `${trip.photo_count} photos`;

  return (
    <Animated.View style={[{ transform: [{ scale: scaleAnim }] }, style]}>
      <Pressable
        testID={testID ?? `trip-card-${trip.id}`}
        onPress={() => onPress?.(trip)}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          styles.cardContainer,
          {
            backgroundColor: colors.surfaceAlt,
            borderColor: colors.border,
            borderRadius: tokens.radius.lg,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${trip.name}, ${dateRangeString}, ${photoCountString}`}
      >
        {/* Cover Photo or Fallback Graphic */}
        {coverUri ? (
          <Image
            testID="trip-card-cover-image"
            source={{ uri: coverUri }}
            style={[styles.coverImage, { borderRadius: tokens.radius.lg }]}
            resizeMode="cover"
          />
        ) : (
          <View
            testID="trip-card-fallback-cover"
            style={[
              styles.fallbackCover,
              {
                backgroundColor: colors.surfaceAlt,
                borderRadius: tokens.radius.lg,
              },
            ]}
          >
            <Compass size={40} color={colors.textMuted} strokeWidth={1.5} />
          </View>
        )}

        {/* Top Badges: Scan Status & Photo Count */}
        <View style={styles.topRow}>
          <View
            style={[
              styles.photoCountPill,
              {
                backgroundColor: 'rgba(11, 13, 18, 0.55)',
                borderRadius: tokens.radius.pill,
              },
            ]}
          >
            <ImageIcon size={12} color="#FFFFFF" strokeWidth={2} style={styles.badgeIcon} />
            <Text style={styles.photoCountText}>{photoCountString}</Text>
          </View>

          {renderScanBadge(trip.scan_status)}
        </View>

        {/* Bottom Scrim & Info Overlay (03_UI_Spec §2: max 40% black bottom scrim) */}
        <View
          style={[
            styles.bottomScrim,
            {
              borderBottomLeftRadius: tokens.radius.lg,
              borderBottomRightRadius: tokens.radius.lg,
            },
          ]}
        >
          <Text
            style={[
              styles.tripName,
              {
                fontSize: tokens.typography.heading.fontSize,
                fontWeight: tokens.typography.heading.fontWeight,
              },
            ]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {trip.name}
          </Text>

          <Text
            style={[
              styles.tripDates,
              {
                fontSize: tokens.typography.caption.fontSize,
                fontWeight: tokens.typography.caption.fontWeight,
                marginTop: tokens.spacing.xs / 2,
              },
            ]}
            numberOfLines={1}
          >
            {dateRangeString}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  cardContainer: {
    height: 160,
    width: '100%',
    position: 'relative',
    overflow: 'hidden',
    borderWidth: 1,
  },
  coverImage: {
    ...StyleSheet.absoluteFillObject,
  },
  fallbackCover: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRow: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 2,
  },
  photoCountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 0.5,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  photoCountText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeIcon: {
    marginRight: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  bottomScrim: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 14,
    paddingBottom: 12,
    paddingTop: 28,
    backgroundColor: 'rgba(11, 13, 18, 0.65)',
    zIndex: 2,
  },
  tripName: {
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  tripDates: {
    color: 'rgba(255, 255, 255, 0.85)',
  },
});
