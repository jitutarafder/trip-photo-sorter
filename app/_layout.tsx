import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { ThemeProvider, useTheme } from '../src/theme';
import { ErrorBoundary, ErrorFallback } from '../src/components/ErrorBoundary';
import { useOrphanSweep } from '../src/hooks/useOrphanSweep';
import { reconcileInterruptedTripScans } from '../src/db/repositories/trips';

// Prevent splash screen from auto-hiding until fonts are loaded
SplashScreen.preventAutoHideAsync().catch(() => {
  /* ignore error in tests or unsupported environments */
});

/**
 * Route-level ErrorBoundary for Expo Router (02_AppFlow §4).
 */
export function RootRouteErrorBoundary({
  error,
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  return <ErrorFallback error={error} onRestart={retry} />;
}

export { RootRouteErrorBoundary as ErrorBoundary };

/**
 * Inner navigation stack styled with active theme tokens.
 */
function RootNavigation() {
  const { colors, tokens, isDark } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: colors.surface,
          },
          headerTintColor: colors.text,
          headerTitleStyle: {
            fontSize: tokens.typography.heading.fontSize,
            fontWeight: tokens.typography.heading.fontWeight,
          },
          headerShadowVisible: false,
          contentStyle: {
            backgroundColor: colors.bg,
          },
        }}
      >
        {/* Home Screen: Detected Trips */}
        <Stack.Screen
          name="index"
          options={{
            title: 'Trips',
          }}
        />

        {/* Onboarding & Permission */}
        <Stack.Screen
          name="onboarding"
          options={{
            headerShown: false,
            gestureEnabled: false,
          }}
        />

        {/* Settings */}
        <Stack.Screen
          name="settings"
          options={{
            title: 'Settings',
          }}
        />

        {/* Paywall (Modal) */}
        <Stack.Screen
          name="paywall"
          options={{
            presentation: 'modal',
            title: 'Trip Photo Sorter Pro',
          }}
        />

        {/* Trip Detail */}
        <Stack.Screen
          name="trip/[id]/index"
          options={{
            title: 'Trip',
          }}
        />

        {/* Scan Progress (Modal) */}
        <Stack.Screen
          name="trip/[id]/scan"
          options={{
            presentation: 'modal',
            title: 'Scanning Faces',
            gestureEnabled: false,
          }}
        />

        {/* People Grid */}
        <Stack.Screen
          name="trip/[id]/people"
          options={{
            title: 'People',
          }}
        />

        {/* Person Detail */}
        <Stack.Screen
          name="person/[id]"
          options={{
            title: 'Person',
          }}
        />

        {/* Export Review */}
        <Stack.Screen
          name="export/[tripId]"
          options={{
            title: 'Export Review',
          }}
        />
      </Stack>
    </View>
  );
}

/**
 * Root Layout Component (Task 3.2, 04_TRD §3, 03_UI_Spec §3)
 * Manages font loading, theme provider, safe area provider, orphan sweeps, and error boundary.
 */
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Launch-time orphan export sweep (04_TRD §6, 05_Schema §4)
  useOrphanSweep();

  // Reconcile interrupted scans on app launch (02_AppFlow §2)
  useEffect(() => {
    reconcileInterruptedTripScans().catch((err) => {
      console.warn('[RootLayout] Error reconciling interrupted trip scans on launch:', err);
    });
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {
        /* ignore */
      });
    }
  }, [fontsLoaded, fontError]);

  // Keep splash screen visible until fonts are loaded (unless font loading failed)
  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ErrorBoundary>
          <RootNavigation />
        </ErrorBoundary>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
