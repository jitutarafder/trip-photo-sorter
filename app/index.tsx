import React from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { useTheme } from '../src/theme';

/**
 * Placeholder Home Screen route (to be fleshed out in Task 3.4).
 */
export default function HomeScreen() {
  const { colors, tokens } = useTheme();

  return (
    <View
      testID="home-screen"
      style={[
        styles.container,
        {
          backgroundColor: colors.bg,
          padding: tokens.spacing.screenPadding,
        },
      ]}
    >
      <Text
        style={[
          styles.text,
          {
            color: colors.text,
            fontSize: tokens.typography.heading.fontSize,
            fontWeight: tokens.typography.heading.fontWeight,
          },
        ]}
      >
        Trips
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    textAlign: 'center',
  },
});
