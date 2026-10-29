import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  body: string;
  actionTitle?: string;
  onActionPress?: () => void;
  actionVariant?: 'primary' | 'secondary' | 'ghost';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Core EmptyState Component (03_UI_Spec §6)
 * Displays icon + title + body + optional CTA
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  body,
  actionTitle,
  onActionPress,
  actionVariant = 'primary',
  style,
  testID,
}) => {
  const { colors, tokens } = useTheme();

  return (
    <View testID={testID} style={[styles.container, style]}>
      {icon && <View style={styles.iconWrapper}>{icon}</View>}

      <Text
        maxFontSizeMultiplier={1.3}
        style={[
          styles.title,
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
        maxFontSizeMultiplier={1.3}
        style={[
          styles.body,
          {
            color: colors.textMuted,
            fontSize: tokens.typography.body.fontSize,
            lineHeight: tokens.typography.body.lineHeight,
          },
        ]}
      >
        {body}
      </Text>

      {actionTitle && onActionPress && (
        <View style={styles.actionWrapper}>
          <Button
            testID={`${testID ?? 'empty-state'}-action`}
            title={actionTitle}
            variant={actionVariant}
            onPress={onActionPress}
            size="md"
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 36,
  },
  iconWrapper: {
    marginBottom: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    textAlign: 'center',
    marginBottom: 8,
  },
  body: {
    textAlign: 'center',
    marginBottom: 20,
    maxWidth: 320,
  },
  actionWrapper: {
    marginTop: 4,
  },
});
