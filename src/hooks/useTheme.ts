import { useThemeContext, type ThemeContextValue } from '../theme/ThemeProvider';

export type Theme = ThemeContextValue;

/**
 * Hook to access current theme tokens based on device color scheme or ThemeProvider.
 * Follows system setting (useColorScheme), dark-first by default.
 */
export function useTheme(): Theme {
  return useThemeContext();
}
