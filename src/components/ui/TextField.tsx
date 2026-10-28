import React, { useState, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  Pressable,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useTheme } from '../../hooks/useTheme';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  clearable?: boolean;
  disabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  testID?: string;
}

/**
 * Core TextField Component (03_UI_Spec §6)
 * States: default, focused (primary border), error (danger border + message), disabled
 * Minimum touch target: 44x44
 */
export const TextField: React.FC<TextFieldProps> = ({
  label,
  error,
  helperText,
  leftIcon,
  rightIcon,
  clearable = false,
  disabled = false,
  value,
  onChangeText,
  placeholder,
  containerStyle,
  inputStyle,
  testID,
  onFocus,
  onBlur,
  ...rest
}) => {
  const { colors, tokens } = useTheme();
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const hasError = Boolean(error);

  const getBorderColor = () => {
    if (disabled) return colors.border;
    if (hasError) return colors.danger;
    if (isFocused) return colors.primary;
    return colors.border;
  };

  const handleClear = () => {
    if (onChangeText) {
      onChangeText('');
    }
  };

  const showClearButton = clearable && !disabled && Boolean(value && value.length > 0);

  return (
    <View style={[styles.wrapper, containerStyle]}>
      {label && (
        <Text
          style={[
            styles.label,
            {
              color: hasError ? colors.danger : colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              lineHeight: tokens.typography.caption.lineHeight,
              fontWeight: tokens.typography.caption.fontWeight,
            },
          ]}
        >
          {label}
        </Text>
      )}

      <View
        style={[
          styles.inputContainer,
          {
            backgroundColor: colors.surfaceAlt,
            borderColor: getBorderColor(),
            borderWidth: isFocused || hasError ? 1.5 : 1,
            borderRadius: tokens.radius.md,
            minHeight: tokens.layout.minTouchTarget,
          },
          disabled && styles.disabledContainer,
        ]}
      >
        {leftIcon && <View style={styles.leftIconContainer}>{leftIcon}</View>}

        <TextInput
          ref={inputRef}
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          editable={!disabled}
          onFocus={(e) => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setIsFocused(false);
            onBlur?.(e);
          }}
          style={[
            styles.input,
            {
              color: colors.text,
              fontSize: tokens.typography.body.fontSize,
              lineHeight: tokens.typography.body.lineHeight,
            },
            inputStyle,
          ]}
          {...rest}
        />

        {showClearButton && (
          <Pressable
            testID={`${testID ?? 'text-field'}-clear`}
            accessibilityRole="button"
            accessibilityLabel="Clear text"
            onPress={handleClear}
            style={styles.iconButton}
          >
            <X size={18} color={colors.textMuted} strokeWidth={2} />
          </Pressable>
        )}

        {rightIcon && !showClearButton && (
          <View style={styles.rightIconContainer}>{rightIcon}</View>
        )}
      </View>

      {hasError ? (
        <Text
          testID={`${testID ?? 'text-field'}-error`}
          style={[
            styles.helperText,
            {
              color: colors.danger,
              fontSize: tokens.typography.caption.fontSize,
              lineHeight: tokens.typography.caption.lineHeight,
            },
          ]}
        >
          {error}
        </Text>
      ) : helperText ? (
        <Text
          style={[
            styles.helperText,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.caption.fontSize,
              lineHeight: tokens.typography.caption.lineHeight,
            },
          ]}
        >
          {helperText}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    marginBottom: 8,
  },
  label: {
    marginBottom: 6,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  disabledContainer: {
    opacity: 0.5,
  },
  input: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  leftIconContainer: {
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightIconContainer: {
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    padding: 6,
    marginLeft: 4,
  },
  helperText: {
    marginTop: 4,
    marginLeft: 2,
  },
});
