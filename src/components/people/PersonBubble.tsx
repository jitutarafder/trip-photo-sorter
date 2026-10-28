import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Users, User, Check } from 'lucide-react-native';
import { useTheme } from '../../hooks/useTheme';
import { getFaceThumbnail } from '../../services/faceThumbnail';

export interface PersonBubbleData {
  id: string;
  trip_id: string;
  name: string | null;
  is_others: number;
  cover_face_id: string | null;
  photo_count?: number;
  cover_photo_id?: string | null;
  cover_bbox_x?: number | null;
  cover_bbox_y?: number | null;
  cover_bbox_w?: number | null;
  cover_bbox_h?: number | null;
}

export interface PersonBubbleProps {
  person: PersonBubbleData;
  faceUri?: string | null;
  selected?: boolean;
  isMergeMode?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  size?: number;
}

/**
 * PersonBubble Component (03_UI_Spec §6, 02_AppFlow §3.5)
 *
 * States:
 * - default: circular face crop, name text, photo count badge
 * - pressed: press scale / feedback
 * - selected: 3px primary border + checkmark badge (merge mode)
 * - unnamed: 2px dashed ring border, "Unnamed" label
 * - others: special Users icon, "Others" label, pinned last
 */
export const PersonBubble: React.FC<PersonBubbleProps> = ({
  person,
  faceUri: directFaceUri,
  selected = false,
  isMergeMode = false,
  onPress,
  onLongPress,
  style,
  testID = `person-bubble-${person.id}`,
  size = 76,
}) => {
  const { colors, tokens } = useTheme();
  const [resolvedUri, setResolvedUri] = useState<string | null>(directFaceUri ?? null);
  const isUnnamed = !person.is_others && (!person.name || person.name.trim().length === 0);
  const isOthers = person.is_others === 1;
  const photoCount = person.photo_count ?? 0;

  useEffect(() => {
    let isMounted = true;
    if (directFaceUri) {
      setResolvedUri(directFaceUri);
      return;
    }

    if (isOthers || !person.cover_photo_id) {
      setResolvedUri(null);
      return;
    }

    getFaceThumbnail({
      faceId: person.cover_face_id,
      photoId: person.cover_photo_id,
      bbox_x: person.cover_bbox_x,
      bbox_y: person.cover_bbox_y,
      bbox_w: person.cover_bbox_w,
      bbox_h: person.cover_bbox_h,
    })
      .then((uri) => {
        if (isMounted) {
          setResolvedUri(uri);
        }
      })
      .catch(() => {
        if (isMounted) {
          setResolvedUri(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [
    directFaceUri,
    isOthers,
    person.cover_face_id,
    person.cover_photo_id,
    person.cover_bbox_x,
    person.cover_bbox_y,
    person.cover_bbox_w,
    person.cover_bbox_h,
  ]);

  const accessibilityLabel = isOthers
    ? `Others, ${photoCount} photos`
    : isUnnamed
      ? `Unnamed person, ${photoCount} photos`
      : `${person.name}, ${photoCount} photos`;

  // Avatar border style based on state
  const avatarBorderStyle: ViewStyle = selected
    ? {
        borderWidth: 3,
        borderColor: colors.primary,
        borderStyle: 'solid',
      }
    : isUnnamed
      ? {
          borderWidth: 2,
          borderColor: colors.border,
          borderStyle: 'dashed',
        }
      : {
          borderWidth: 1.5,
          borderColor: colors.border,
          borderStyle: 'solid',
        };

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.container,
        pressed && styles.pressed,
        style,
      ]}
    >
      <View style={[styles.avatarWrapper, { width: size, height: size }]}>
        <View
          testID={`${testID}-avatar`}
          style={[
            styles.avatarCircle,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: colors.surfaceAlt,
            },
            avatarBorderStyle,
          ]}
        >
          {isOthers ? (
            <Users size={size * 0.45} color={colors.textMuted} />
          ) : resolvedUri ? (
            <Image
              testID={`${testID}-image`}
              source={{ uri: resolvedUri }}
              style={{
                width: size - 4,
                height: size - 4,
                borderRadius: (size - 4) / 2,
              }}
              resizeMode="cover"
            />
          ) : (
            <User size={size * 0.45} color={colors.textMuted} />
          )}
        </View>

        {/* Selected Checkmark Badge (Merge Mode) */}
        {selected && (
          <View
            testID={`${testID}-selected-badge`}
            style={[
              styles.selectedBadge,
              {
                backgroundColor: colors.primary,
                borderColor: colors.bg,
              },
            ]}
          >
            <Check size={12} color={colors.onPrimary} strokeWidth={3} />
          </View>
        )}

        {/* Photo Count Badge */}
        <View
          testID={`${testID}-count-badge`}
          style={[
            styles.countBadge,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <Text
            style={[
              tokens.typography.micro,
              { color: colors.textMuted },
            ]}
          >
            {photoCount}
          </Text>
        </View>
      </View>

      {/* Name Label */}
      <Text
        testID={`${testID}-name`}
        numberOfLines={1}
        ellipsizeMode="tail"
        style={[
          tokens.typography.caption,
          styles.nameText,
          {
            color: isUnnamed ? colors.textMuted : colors.text,
            fontStyle: isUnnamed ? 'italic' : 'normal',
            fontWeight: isUnnamed ? '400' : '600',
          },
        ]}
      >
        {isOthers ? 'Others' : person.name || 'Unnamed'}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    minWidth: 44,
    minHeight: 44,
  },
  pressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.9,
  },
  avatarWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarCircle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  selectedBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  countBadge: {
    position: 'absolute',
    bottom: -4,
    right: -2,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  nameText: {
    marginTop: 8,
    textAlign: 'center',
    maxWidth: 96,
  },
});
