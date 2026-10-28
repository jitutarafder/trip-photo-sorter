import React, { createContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, tokens, ThemeColors } from './tokens';

export interface ThemeContextValue {
  colorScheme: 'dark' | 'light';
  isDark: boolean;
  colors: ThemeColors;
  tokens: typeof tokens;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  colorScheme?: 'dark' | 'light';
}

/**
 * ThemeProvider component (Task 3.2, 03_UI_Spec §2)
 * Supplies theme tokens (dark by default, follows system setting or explicit override).
 */
export const ThemeProvider: React.FC<ThemeProviderProps> = ({
  children,
  colorScheme: colorSchemeOverride,
}) => {
  const systemColorScheme = useColorScheme();
  const activeScheme: 'dark' | 'light' =
    colorSchemeOverride ?? (systemColorScheme === 'light' ? 'light' : 'dark');
  const isDark = activeScheme === 'dark';

  const value = useMemo<ThemeContextValue>(
    () => ({
      colorScheme: activeScheme,
      isDark,
      colors: isDark ? darkColors : lightColors,
      tokens,
    }),
    [activeScheme, isDark]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

/**
 * Hook to read theme context value, safely supporting both React component renders
 * and direct function calls in test environments.
 */
export function useThemeContext(): ThemeContextValue {
  const systemColorScheme = useColorScheme();

  // Safely check if a React component render dispatcher is currently active
  const reactInternals =
    (React as any)?.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
    (React as any)?.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = reactInternals?.ReactCurrentDispatcher?.current;

  const context: ThemeContextValue | null = dispatcher
    ? dispatcher.readContext(ThemeContext)
    : ((ThemeContext as any)?._currentValue ?? null);

  if (context) {
    return context;
  }

  // Fallback if rendered outside ThemeProvider or outside React render tree
  const isDark = systemColorScheme !== 'light';
  return {
    colorScheme: isDark ? 'dark' : 'light',
    isDark,
    colors: isDark ? darkColors : lightColors,
    tokens,
  };
}
