import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Image,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { Check, ImageOff } from 'lucide-react-native';
import { useTheme } from '../../hooks/useTheme';

export interface PhotoTileProps {
  photoId: string;
  uri?: string | null;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * PhotoTile Component (03_UI_Spec §6)
 *
 * States:
 * - default: displays resolved photo from gallery/filesystem with 4px border radius
 * - selected: 2px primary border + checkmark badge in corner
 * - loading: surfaceAlt placeholder
 * - broken: surfaceAlt placeholder with broken icon
 */
export const PhotoTile: React.FC<PhotoTileProps> = ({
  photoId,
  uri: directUri,
  selected = false,
  onPress,
  onLongPress,
  style,
  testID,
  accessibilityLabel,
}) => {
  const { colors, tokens } = useTheme();
  const [resolvedUri, setResolvedUri] = useState<string | null>(directUri ?? null);
  const [isLoading, setIsLoading] = useState<boolean>(!directUri);
  const [hasError, setHasError] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    if (directUri) {
      setResolvedUri(directUri);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    if (!photoId) {
      setIsLoading(false);
      setHasError(true);
      return;
    }

    setIsLoading(true);
    setHasError(false);

    MediaLibrary.getAssetInfoAsync(photoId)
      .then((asset) => {
        if (!isMounted) return;
        if (asset && (asset.localUri || asset.uri)) {
          setResolvedUri(asset.localUri || asset.uri);
          setHasError(false);
        } else {
          setHasError(true);
        }
      })
      .catch(() => {
        if (isMounted) {
          setHasError(true);
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [photoId, directUri]);

  return (
    <Pressable
      testID={testID ?? `photo-tile-${photoId}`}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Photo ${photoId}`}
      accessibilityState={{ selected }}
      style={[
        styles.container,
        {
          borderRadius: tokens.radius.photo,
          backgroundColor: colors.surfaceAlt,
          borderColor: selected ? colors.primary : 'transparent',
          borderWidth: selected ? 2 : 0,
        },
        style,
      ]}
    >
      {resolvedUri && !hasError ? (
        <Image
          testID={`photo-image-${photoId}`}
          source={{ uri: resolvedUri }}
          style={[styles.image, { borderRadius: tokens.radius.photo - 1 }]}
          resizeMode="cover"
          onError={() => setHasError(true)}
        />
      ) : null}

      {isLoading && !resolvedUri ? (
        <View
          testID={`photo-tile-loading-${photoId}`}
          style={[
            styles.fallback,
            { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.photo },
          ]}
        />
      ) : null}

      {hasError ? (
        <View
          testID={`photo-tile-broken-${photoId}`}
          style={[
            styles.fallback,
            { backgroundColor: colors.surfaceAlt, borderRadius: tokens.radius.photo },
          ]}
        >
          <ImageOff size={20} color={colors.textMuted} strokeWidth={1.5} />
        </View>
      ) : null}

      {selected ? (
        <View
          testID={`photo-tile-selected-${photoId}`}
          style={[
            styles.selectedBadge,
            { backgroundColor: colors.primary, borderRadius: tokens.radius.pill },
          ]}
        >
          <Check size={12} color={colors.onPrimary} strokeWidth={3} />
        </View>
      ) : null}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    aspectRatio: 1,
    overflow: 'hidden',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
