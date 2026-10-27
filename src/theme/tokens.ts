/**
 * Design Tokens as specified in docs/03_UI_Spec.md.
 * Single source of truth for visuals. Never hard-code a colour, size, or font in a component.
 */

export const darkColors = {
  bg: '#0B0D12',
  surface: '#141822',
  surfaceAlt: '#1D2330',
  border: '#2A3142',
  text: '#F2F4F8',
  textMuted: '#98A2B3',
  primary: '#6C8CFF',
  primaryPressed: '#5877EB',
  onPrimary: '#0B0D12',
  accent: '#3DDBB0',
  success: '#3DDB8A',
  warning: '#FFB84D',
  danger: '#FF5C6C',
  overlay: 'rgba(0,0,0,0.6)',
} as const;

export const lightColors = {
  bg: '#F6F7FB',
  surface: '#FFFFFF',
  surfaceAlt: '#EBEEF5',
  border: '#D9DEEA',
  text: '#0B0D12',
  textMuted: '#5B6475',
  primary: '#4A6CF7',
  primaryPressed: '#3957DD',
  onPrimary: '#FFFFFF',
  accent: '#14B88E',
  success: '#17A35E',
  warning: '#C77A00',
  danger: '#D6293D',
  overlay: 'rgba(11,13,18,0.4)',
} as const;

export type ColorToken = keyof typeof darkColors;
export type ThemeColors = { [K in ColorToken]: string };

export const colors = {
  dark: darkColors,
  light: lightColors,
  bubbleGradient: ['#6C8CFF', '#3DDBB0'] as const,
  bubbleRingOpacity: 0.25,
} as const;

export const typography = {
  display: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700' as const,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '700' as const,
  },
  heading: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '600' as const,
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '400' as const,
  },
  bodyStrong: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600' as const,
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500' as const,
  },
  micro: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500' as const,
  },
} as const;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  screenPadding: 16,
  photoGridGap: 2,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
  photo: 4,
} as const;

export const layout = {
  tripCardHeight: 160,
  minTouchTarget: 44,
} as const;

export const elevation = {
  dark: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  light: {
    shadowColor: '#0B0D12',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
} as const;

export const motion = {
  standardDurationMs: 220,
  pressDurationMs: 90,
  pressScale: 0.97,
  springConfig: {
    damping: 14,
    stiffness: 160,
  },
} as const;

export const tokens = {
  colors,
  typography,
  spacing,
  radius,
  layout,
  elevation,
  motion,
} as const;
