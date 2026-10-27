import * as ReactNative from 'react-native';
import { darkColors, lightColors, tokens } from '../src/theme/tokens';
import { useTheme } from '../src/hooks/useTheme';

describe('Theme Tokens (03_UI_Spec)', () => {
  it('defines dark color tokens matching 03_UI_Spec', () => {
    expect(darkColors.bg).toBe('#0B0D12');
    expect(darkColors.surface).toBe('#141822');
    expect(darkColors.surfaceAlt).toBe('#1D2330');
    expect(darkColors.border).toBe('#2A3142');
    expect(darkColors.text).toBe('#F2F4F8');
    expect(darkColors.textMuted).toBe('#98A2B3');
    expect(darkColors.primary).toBe('#6C8CFF');
    expect(darkColors.primaryPressed).toBe('#5877EB');
    expect(darkColors.onPrimary).toBe('#0B0D12');
    expect(darkColors.accent).toBe('#3DDBB0');
    expect(darkColors.success).toBe('#3DDB8A');
    expect(darkColors.warning).toBe('#FFB84D');
    expect(darkColors.danger).toBe('#FF5C6C');
    expect(darkColors.overlay).toBe('rgba(0,0,0,0.6)');
  });

  it('defines light color tokens matching 03_UI_Spec', () => {
    expect(lightColors.bg).toBe('#F6F7FB');
    expect(lightColors.surface).toBe('#FFFFFF');
    expect(lightColors.surfaceAlt).toBe('#EBEEF5');
    expect(lightColors.border).toBe('#D9DEEA');
    expect(lightColors.text).toBe('#0B0D12');
    expect(lightColors.textMuted).toBe('#5B6475');
    expect(lightColors.primary).toBe('#4A6CF7');
    expect(lightColors.primaryPressed).toBe('#3957DD');
    expect(lightColors.onPrimary).toBe('#FFFFFF');
    expect(lightColors.accent).toBe('#14B88E');
    expect(lightColors.success).toBe('#17A35E');
    expect(lightColors.warning).toBe('#C77A00');
    expect(lightColors.danger).toBe('#D6293D');
    expect(lightColors.overlay).toBe('rgba(11,13,18,0.4)');
  });

  it('defines typography styles matching 03_UI_Spec', () => {
    expect(tokens.typography.display.fontSize).toBe(32);
    expect(tokens.typography.title.fontSize).toBe(24);
    expect(tokens.typography.heading.fontSize).toBe(18);
    expect(tokens.typography.body.fontSize).toBe(16);
    expect(tokens.typography.bodyStrong.fontSize).toBe(16);
    expect(tokens.typography.caption.fontSize).toBe(13);
    expect(tokens.typography.micro.fontSize).toBe(11);
  });

  it('defines spacing and radius matching 03_UI_Spec', () => {
    expect(tokens.spacing.screenPadding).toBe(16);
    expect(tokens.spacing.photoGridGap).toBe(2);
    expect(tokens.radius.sm).toBe(8);
    expect(tokens.radius.md).toBe(12);
    expect(tokens.radius.lg).toBe(20);
    expect(tokens.radius.pill).toBe(999);
    expect(tokens.radius.photo).toBe(4);
    expect(tokens.layout.minTouchTarget).toBe(44);
    expect(tokens.layout.tripCardHeight).toBe(160);
  });
});

describe('useTheme hook', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults to dark theme when colorScheme is dark or undefined', () => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');
    const result = useTheme();

    expect(result.colorScheme).toBe('dark');
    expect(result.isDark).toBe(true);
    expect(result.colors).toEqual(darkColors);
  });

  it('returns light theme when colorScheme is light', () => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('light');
    const result = useTheme();

    expect(result.colorScheme).toBe('light');
    expect(result.isDark).toBe(false);
    expect(result.colors).toEqual(lightColors);
  });

  it('falls back to dark-first design when colorScheme is null', () => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(null);
    const result = useTheme();

    expect(result.colorScheme).toBe('dark');
    expect(result.isDark).toBe(true);
    expect(result.colors).toEqual(darkColors);
  });
});

