import { useColorScheme } from 'react-native';
import { darkColors, lightColors, tokens, ThemeColors } from '../theme/tokens';

export interface Theme {
  colorScheme: 'dark' | 'light';
  isDark: boolean;
  colors: ThemeColors;
  tokens: typeof tokens;
}

/**
 * Hook to access current theme tokens based on device color scheme.
 * Follows system setting (useColorScheme), dark-first by default.
 */
export function useTheme(): Theme {
  const systemColorScheme = useColorScheme();
  const colorScheme = systemColorScheme === 'light' ? 'light' : 'dark';
  const isDark = colorScheme === 'dark';

  return {
    colorScheme,
    isDark,
    colors: isDark ? darkColors : lightColors,
    tokens,
  };
}
