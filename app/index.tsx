import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../src/theme';
import { Banner } from '../src/components/ui/Banner';
import { useLibraryPermission } from '../src/hooks/useLibraryPermission';
import { isOnboarded } from '../src/db/repositories/settings';

/**
 * Home Screen route (02_AppFlow §2 & §3.2)
 * Handles launch redirection to /onboarding if not onboarded or permission is denied,
 * and renders limited photo access banner when access is limited.
 */
export default function HomeScreen() {
  const { colors, tokens } = useTheme();
  const router = useRouter();
  const { status, isLoading: isPermissionLoading, presentPicker } = useLibraryPermission();
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);

  useEffect(() => {
    async function checkState() {
      try {
        const onboarded = await isOnboarded();

        if (!onboarded || status === 'denied') {
          router.replace('/onboarding');
          return;
        }
      } catch {
        // If DB fails to read, proceed safely
      } finally {
        setCheckingOnboarding(false);
      }
    }

    if (!isPermissionLoading) {
      checkState();
    }
  }, [router, status, isPermissionLoading]);

  if (checkingOnboarding) {
    return <View testID="home-loading" style={[styles.container, { backgroundColor: colors.bg }]} />;
  }

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
      {/* Limited photo access warning banner (02_AppFlow §3.1) */}
      {status === 'limited' && (
        <Banner
          testID="limited-library-banner"
          variant="warning"
          title="Limited Photo Access"
          message="Only selected photos visible."
          action={{
            label: 'Manage',
            onPress: () => {
              if (presentPicker) {
                Promise.resolve(presentPicker()).catch(() => {
                  /* ignore */
                });
              }
            },
          }}
          style={{ marginBottom: tokens.spacing.lg, width: '100%' }}
        />
      )}

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
