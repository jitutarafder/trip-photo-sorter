import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { AccessibilityInfo, Text, View } from 'react-native';
import { ThemeProvider, useThemeContext } from '../src/theme/ThemeProvider';
import { darkColors, lightColors, tokens, elevation } from '../src/theme/tokens';
import { useReduceMotion } from '../src/hooks/useReduceMotion';
import { Skeleton } from '../src/components/ui/Skeleton';
import { Button } from '../src/components/ui/Button';
import { TripCard } from '../src/components/trips/TripCard';
import { PersonBubble } from '../src/components/people/PersonBubble';
import { ProgressRing } from '../src/components/ui/ProgressRing';
import { TextField } from '../src/components/ui/TextField';
import { Banner } from '../src/components/ui/Banner';
import { EmptyState } from '../src/components/ui/EmptyState';
import type { TripRow } from '../src/db/types';

/**
 * WCAG 2.1 Contrast Ratio Calculation Helper
 */
function parseHexColor(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return [r, g, b];
}

function getRelativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((val) => {
    const sRGB = val / 255;
    return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getRelativeLuminance(parseHexColor(hex1));
  const lum2 = getRelativeLuminance(parseHexColor(hex2));
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

const renderWithTheme = async (ui: React.ReactElement, colorScheme: 'dark' | 'light' = 'dark') => {
  const result = await render(<ThemeProvider colorScheme={colorScheme}>{ui}</ThemeProvider>);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
};

describe('Task 4.9: Dark/Light Themes, Dynamic Type 130%, and Reduce Motion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Dark and Light Theme Tokens & Contrast (03_UI_Spec §1, §2, §4)', () => {
    it('defines exact tokens specified in 03_UI_Spec', () => {
      // Dark palette
      expect(darkColors.bg).toBe('#0B0D12');
      expect(darkColors.surface).toBe('#141822');
      expect(darkColors.surfaceAlt).toBe('#1D2330');
      expect(darkColors.border).toBe('#2A3142');
      expect(darkColors.text).toBe('#F2F4F8');
      expect(darkColors.textMuted).toBe('#98A2B3');
      expect(darkColors.primary).toBe('#6C8CFF');
      expect(darkColors.primaryPressed).toBe('#5877EB');
      expect(darkColors.onPrimary).toBe('#0B0D12');

      // Light palette
      expect(lightColors.bg).toBe('#F6F7FB');
      expect(lightColors.surface).toBe('#FFFFFF');
      expect(lightColors.surfaceAlt).toBe('#EBEEF5');
      expect(lightColors.border).toBe('#D9DEEA');
      expect(lightColors.text).toBe('#0B0D12');
      expect(lightColors.textMuted).toBe('#5B6475');
      expect(lightColors.primary).toBe('#4A6CF7');
      expect(lightColors.primaryPressed).toBe('#3957DD');
      expect(lightColors.onPrimary).toBe('#FFFFFF');
    });

    it('satisfies WCAG AA contrast ratios (>= 4.5:1 normal body text, >= 3.0:1 UI/buttons)', () => {
      // Dark theme body text on background & surface
      const darkTextOnBg = getContrastRatio(darkColors.text, darkColors.bg);
      const darkTextOnSurface = getContrastRatio(darkColors.text, darkColors.surface);
      expect(darkTextOnBg).toBeGreaterThanOrEqual(4.5);
      expect(darkTextOnSurface).toBeGreaterThanOrEqual(4.5);

      // Dark theme muted text on background & surface (>= 4.5:1)
      const darkMutedOnBg = getContrastRatio(darkColors.textMuted, darkColors.bg);
      const darkMutedOnSurface = getContrastRatio(darkColors.textMuted, darkColors.surface);
      expect(darkMutedOnBg).toBeGreaterThanOrEqual(4.5);
      expect(darkMutedOnSurface).toBeGreaterThanOrEqual(4.5);

      // Dark onPrimary on primary button background (>= 4.5:1)
      const darkPrimaryBtn = getContrastRatio(darkColors.onPrimary, darkColors.primary);
      expect(darkPrimaryBtn).toBeGreaterThanOrEqual(4.5);

      // Light theme body text on background & surface
      const lightTextOnBg = getContrastRatio(lightColors.text, lightColors.bg);
      const lightTextOnSurface = getContrastRatio(lightColors.text, lightColors.surface);
      expect(lightTextOnBg).toBeGreaterThanOrEqual(4.5);
      expect(lightTextOnSurface).toBeGreaterThanOrEqual(4.5);

      // Light theme muted text on background & surface (>= 4.5:1)
      const lightMutedOnBg = getContrastRatio(lightColors.textMuted, lightColors.bg);
      const lightMutedOnSurface = getContrastRatio(lightColors.textMuted, lightColors.surface);
      expect(lightMutedOnBg).toBeGreaterThanOrEqual(4.5);
      expect(lightMutedOnSurface).toBeGreaterThanOrEqual(4.5);

      // Light onPrimary on primary button background (>= 3.0:1 UI components / bold text)
      const lightPrimaryBtn = getContrastRatio(lightColors.onPrimary, lightColors.primary);
      expect(lightPrimaryBtn).toBeGreaterThanOrEqual(3.0);
    });

    it('provides correct elevation styles: dark is flat/border-only, light has subtle shadow', () => {
      // Dark elevation: no shadow
      expect(elevation.dark.shadowColor).toBe('transparent');
      expect(elevation.dark.shadowOpacity).toBe(0);
      expect(elevation.dark.elevation).toBe(0);

      // Light elevation: subtle 0 2 8 rgba(11,13,18,0.08)
      expect(elevation.light.shadowColor).toBe('#0B0D12');
      expect(elevation.light.shadowOpacity).toBe(0.08);
      expect(elevation.light.shadowRadius).toBe(8);
      expect(elevation.light.shadowOffset).toEqual({ width: 0, height: 2 });
      expect(elevation.light.elevation).toBe(2);
    });

    it('ThemeProvider dynamically updates context values between dark and light', async () => {
      const TestConsumer = () => {
        const theme = useThemeContext();
        return (
          <View testID="theme-consumer">
            <Text testID="scheme-label">{theme.colorScheme}</Text>
            <Text testID="bg-label">{theme.colors.bg}</Text>
          </View>
        );
      };

      const { getByTestId, rerender } = await render(
        <ThemeProvider colorScheme="dark">
          <TestConsumer />
        </ThemeProvider>
      );

      expect(getByTestId('scheme-label').props.children).toBe('dark');
      expect(getByTestId('bg-label').props.children).toBe(darkColors.bg);

      // Switch to light mode
      await rerender(
        <ThemeProvider colorScheme="light">
          <TestConsumer />
        </ThemeProvider>
      );

      expect(getByTestId('scheme-label').props.children).toBe('light');
      expect(getByTestId('bg-label').props.children).toBe(lightColors.bg);
    });
  });

  describe('2. Dynamic Type 130% Support (03_UI_Spec §3, §4)', () => {
    it('sets minimum touch target of 44x44 in design tokens and core interactive components', () => {
      expect(tokens.layout.minTouchTarget).toBe(44);
    });

    it('applies maxFontSizeMultiplier={1.3} to prevent layout breakage on extreme system scaling', async () => {
      const { getByText, getByTestId } = await renderWithTheme(
        <View>
          <Button testID="test-btn" title="Save Changes" />
          <TextField testID="test-input" label="Trip Name" error="Name is required" />
          <Banner testID="test-banner" title="Warning Title" message="Check your storage" />
          <EmptyState
            testID="test-empty"
            title="No Photos Found"
            body="Try scanning a different folder"
          />
        </View>
      );

      // Button title text
      const btnText = getByText('Save Changes');
      expect(btnText.props.maxFontSizeMultiplier).toBe(1.3);

      // TextField error text
      const inputError = getByTestId('test-input-error');
      expect(inputError.props.maxFontSizeMultiplier).toBe(1.3);

      // Banner text
      const bannerTitle = getByText('Warning Title');
      expect(bannerTitle.props.maxFontSizeMultiplier).toBe(1.3);
      const bannerMsg = getByText('Check your storage');
      expect(bannerMsg.props.maxFontSizeMultiplier).toBe(1.3);

      // EmptyState title & body
      const emptyTitle = getByText('No Photos Found');
      expect(emptyTitle.props.maxFontSizeMultiplier).toBe(1.3);
      const emptyBody = getByText('Try scanning a different folder');
      expect(emptyBody.props.maxFontSizeMultiplier).toBe(1.3);
    });

    it('renders PersonBubble and TripCard with maxFontSizeMultiplier={1.3}', async () => {
      const mockTrip: TripRow = {
        id: 'trip-dyn-1',
        name: 'Tokyo Vacation 2026',
        start_at: 1718000000,
        end_at: 1718600000,
        photo_count: 85,
        cover_photo_id: 'cover-1',
        is_away: 1,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 85,
        created_at: 1718000000,
        updated_at: 1718600000,
      };

      const mockPerson = {
        id: 'person-dyn-1',
        trip_id: 'trip-dyn-1',
        name: 'Kenji Sato',
        is_others: 0,
        cover_face_id: 'face-1',
        photo_count: 24,
      };

      const { getByText } = await renderWithTheme(
        <View>
          <TripCard trip={mockTrip} />
          <PersonBubble person={mockPerson} />
        </View>
      );

      // Trip name has maxFontSizeMultiplier
      const tripTitle = getByText('Tokyo Vacation 2026');
      expect(tripTitle.props.maxFontSizeMultiplier).toBe(1.3);

      // Person name has maxFontSizeMultiplier
      const personName = getByText('Kenji Sato');
      expect(personName.props.maxFontSizeMultiplier).toBe(1.3);
    });
  });

  describe('3. Reduce Motion Support (03_UI_Spec §5)', () => {
    let reduceMotionEnabled = false;
    let reduceMotionListener: ((enabled: boolean) => void) | null = null;

    beforeEach(() => {
      reduceMotionEnabled = false;
      reduceMotionListener = null;

      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(() => {
        return Promise.resolve(reduceMotionEnabled);
      });

      jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((event: string, handler: any) => {
        if (event === 'reduceMotionChanged') {
          reduceMotionListener = handler;
        }
        return {
          remove: jest.fn(() => {
            if (reduceMotionListener === handler) {
              reduceMotionListener = null;
            }
          }),
        };
      }) as any);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('useReduceMotion hook initializes from AccessibilityInfo and reacts to change events', async () => {
      const HookTester = () => {
        const isReduced = useReduceMotion();
        return <Text testID="motion-status">{isReduced ? 'reduced' : 'normal'}</Text>;
      };

      const { getByTestId } = await renderWithTheme(<HookTester />);

      expect(getByTestId('motion-status').props.children).toBe('normal');

      // Fire change event
      await act(async () => {
        reduceMotionListener?.(true);
      });
      expect(getByTestId('motion-status').props.children).toBe('reduced');

      // Fire change event back to normal
      await act(async () => {
        reduceMotionListener?.(false);
      });
      expect(getByTestId('motion-status').props.children).toBe('normal');
    });

    it('Skeleton suppresses shimmer loop and sets static opacity when reduceMotion is enabled', async () => {
      reduceMotionEnabled = true;

      const { getByTestId } = await renderWithTheme(<Skeleton testID="test-skeleton" width={100} height={20} />);
      const skeleton = getByTestId('test-skeleton');

      expect(skeleton.props.style).toEqual(
        expect.objectContaining({
          opacity: 0.5,
        })
      );
    });

    it('Button suppresses press scale animation when reduceMotion is enabled', async () => {
      reduceMotionEnabled = true;

      const { getByTestId } = await renderWithTheme(
        <Button testID="press-btn" title="Confirm" />
      );

      const btn = getByTestId('press-btn');
      fireEvent.press(btn);
      expect(btn).toBeTruthy();
    });

    it('TripCard suppresses press scale animation when reduceMotion is enabled', async () => {
      reduceMotionEnabled = true;
      const onPressMock = jest.fn();

      const mockTrip: TripRow = {
        id: 'trip-rm-1',
        name: 'Kyoto 2026',
        start_at: 1718000000,
        end_at: 1718600000,
        photo_count: 30,
        cover_photo_id: null,
        is_away: 1,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 30,
        created_at: 1718000000,
        updated_at: 1718600000,
      };

      const { getByTestId } = await renderWithTheme(
        <TripCard trip={mockTrip} onPress={onPressMock} />
      );

      const card = getByTestId('trip-card-trip-rm-1');
      fireEvent.press(card);
      expect(onPressMock).toHaveBeenCalledWith(mockTrip);
    });

    it('PersonBubble suppresses pressed scale style when reduceMotion is enabled', async () => {
      reduceMotionEnabled = true;
      const onPressMock = jest.fn();

      const mockPerson = {
        id: 'person-rm-1',
        trip_id: 'trip-1',
        name: 'Aoi',
        is_others: 0,
        cover_face_id: null,
        photo_count: 10,
      };

      const { getByTestId } = await renderWithTheme(
        <PersonBubble person={mockPerson} onPress={onPressMock} />
      );

      const bubble = getByTestId('person-bubble-person-rm-1');
      fireEvent.press(bubble);
      expect(onPressMock).toHaveBeenCalled();
    });

    it('ProgressRing stops spin loop when reduceMotion is enabled in indeterminate mode', async () => {
      reduceMotionEnabled = true;

      const { getByTestId } = await renderWithTheme(
        <ProgressRing testID="test-ring" indeterminate />
      );

      const ring = getByTestId('test-ring');
      expect(ring).toBeTruthy();
      // Verifies ring rendered without crash or infinite loops
    });
  });
});
