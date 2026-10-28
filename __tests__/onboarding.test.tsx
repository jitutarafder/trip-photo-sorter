import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import OnboardingScreen, {
  BenefitCard,
  PermissionDeniedView,
} from '../app/onboarding';
import HomeScreen from '../app/index';
import { ThemeProvider } from '../src/theme';
import * as settingsRepo from '../src/db/repositories/settings';
import * as libraryHooks from '../src/hooks/useLibraryPermission';

// Mock expo-router
const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  back: jest.fn(),
};
const mockReplace = mockRouter.replace;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  Stack: Object.assign(() => null, { Screen: () => null }),
  SplashScreen: {
    preventAutoHideAsync: jest.fn().mockResolvedValue(true),
    hideAsync: jest.fn().mockResolvedValue(true),
  },
}));

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock settings repository
jest.mock('../src/db/repositories/settings', () => ({
  setOnboarded: jest.fn().mockResolvedValue(undefined),
  isOnboarded: jest.fn().mockResolvedValue(false),
}));

// Mock useLibraryPermission hook
jest.mock('../src/hooks/useLibraryPermission', () => ({
  useLibraryPermission: jest.fn(),
}));

describe('Onboarding and Permission Denied Screen (Task 3.3)', () => {
  const mockRequestPermission = jest.fn();
  const mockRefreshPermission = jest.fn();
  const mockOpenSettings = jest.fn();
  const mockPresentPicker = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();

    // Default permission hook state: undetermined
    (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
      accessPrivileges: undefined,
      isLoading: false,
      requestPermission: mockRequestPermission,
      refreshPermission: mockRefreshPermission,
      openSettings: mockOpenSettings,
      presentPicker: mockPresentPicker,
    });
  });

  const renderWithTheme = async (ui: React.ReactElement) => {
    return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
  };

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  describe('Main Onboarding View', () => {
    it('renders the header with app title and 100% on-device tag', async () => {
      const { getByText } = await renderWithTheme(<OnboardingScreen />);

      expect(getByText('Trip Photo Sorter')).toBeTruthy();
      expect(getByText('100% On-Device')).toBeTruthy();
      expect(
        getByText('Sort and share memorable moments from your getaways in seconds.')
      ).toBeTruthy();
    });

    it('renders all three benefit cards with correct copy', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<OnboardingScreen />);

      // Card 1: Find trips automatically
      expect(getByTestId('benefit-card-1')).toBeTruthy();
      expect(getByText('Find trips automatically')).toBeTruthy();
      expect(
        getByText(
          'Smart clustering identifies your getaways by date and time gap so you never have to search.'
        )
      ).toBeTruthy();

      // Card 2: Group faces on your phone
      expect(getByTestId('benefit-card-2')).toBeTruthy();
      expect(getByText('Group faces on your phone')).toBeTruthy();
      expect(
        getByText(
          'On-device face grouping groups friends together without uploading a single photo anywhere.'
        )
      ).toBeTruthy();

      // Card 3: Share 1 ZIP per friend
      expect(getByTestId('benefit-card-3')).toBeTruthy();
      expect(getByText('Share 1 ZIP per friend')).toBeTruthy();
      expect(
        getByText(
          'Export full-quality photo sets or single ZIP archives directly into your favorite messaging apps.'
        )
      ).toBeTruthy();
    });

    it('renders the "Nothing leaves your phone." privacy guarantee', async () => {
      const { getByText } = await renderWithTheme(<OnboardingScreen />);

      expect(getByText('Nothing leaves your phone.')).toBeTruthy();
      expect(
        getByText(
          'Your gallery is strictly read-only. Faces and trips are analyzed locally without any cloud servers, logins, or tracking.'
        )
      ).toBeTruthy();
    });

    it('renders the "Allow Photo Access" primary action button', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<OnboardingScreen />);

      const button = getByTestId('allow-access-button');
      expect(button).toBeTruthy();
      expect(getByText('Allow Photo Access')).toBeTruthy();
    });
  });

  describe('Permission Request Flow', () => {
    it('calls requestPermission when user taps "Allow Photo Access"', async () => {
      mockRequestPermission.mockResolvedValueOnce({
        status: 'undetermined',
        granted: false,
        canAskAgain: true,
      });

      const { getByTestId } = await renderWithTheme(<OnboardingScreen />);
      const button = getByTestId('allow-access-button');

      await fireEvent.press(button);

      await waitFor(() => {
        expect(mockRequestPermission).toHaveBeenCalledTimes(1);
      });
    });

    it('marks onboarded = 1 and redirects to / on full permission grant', async () => {
      mockRequestPermission.mockResolvedValueOnce({
        status: 'full',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      const { getByTestId } = await renderWithTheme(<OnboardingScreen />);
      const button = getByTestId('allow-access-button');

      await fireEvent.press(button);

      await waitFor(() => {
        expect(settingsRepo.setOnboarded).toHaveBeenCalledWith(true);
        expect(mockReplace).toHaveBeenCalledWith('/');
      });
    });

    it('marks onboarded = 1 and redirects to / on limited permission grant', async () => {
      mockRequestPermission.mockResolvedValueOnce({
        status: 'limited',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });

      const { getByTestId } = await renderWithTheme(<OnboardingScreen />);
      const button = getByTestId('allow-access-button');

      await fireEvent.press(button);

      await waitFor(() => {
        expect(settingsRepo.setOnboarded).toHaveBeenCalledWith(true);
        expect(mockReplace).toHaveBeenCalledWith('/');
      });
    });

    it('auto-redirects if permission is already granted when mounting', async () => {
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'full',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
        isLoading: false,
        requestPermission: mockRequestPermission,
        refreshPermission: mockRefreshPermission,
        openSettings: mockOpenSettings,
        presentPicker: mockPresentPicker,
      });

      await renderWithTheme(<OnboardingScreen />);

      await waitFor(() => {
        expect(settingsRepo.setOnboarded).toHaveBeenCalledWith(true);
        expect(mockReplace).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('Permission Denied View', () => {
    beforeEach(() => {
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'denied',
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
        isLoading: false,
        requestPermission: mockRequestPermission,
        refreshPermission: mockRefreshPermission,
        openSettings: mockOpenSettings,
        presentPicker: mockPresentPicker,
      });
    });

    it('renders the Permission Denied view when status is denied', async () => {
      const { getByTestId, getByText, queryByTestId } = await renderWithTheme(<OnboardingScreen />);

      expect(getByTestId('permission-denied-view')).toBeTruthy();
      expect(getByText('Photo Access Needed')).toBeTruthy();
      expect(
        getByText(
          'Trip Photo Sorter needs access to your photo library to detect trips and group friends\' faces.'
        )
      ).toBeTruthy();
      expect(getByText('Nothing leaves your phone.')).toBeTruthy();

      // Main onboarding cards should not be shown
      expect(queryByTestId('onboarding-main-view')).toBeNull();
      expect(queryByTestId('allow-access-button')).toBeNull();
    });

    it('calls openSettings when "Open Settings" button is pressed', async () => {
      const { getByTestId } = await renderWithTheme(<OnboardingScreen />);
      const settingsButton = getByTestId('open-settings-button');

      await fireEvent.press(settingsButton);

      await waitFor(() => {
        expect(mockOpenSettings).toHaveBeenCalledTimes(1);
      });
    });

    it('calls refreshPermission when "Check Again" button is pressed and handles granted update', async () => {
      mockRefreshPermission.mockResolvedValueOnce({
        status: 'full',
        granted: true,
        canAskAgain: true,
      });

      const { getByTestId } = await renderWithTheme(<OnboardingScreen />);
      const checkAgainButton = getByTestId('check-again-button');

      await fireEvent.press(checkAgainButton);

      expect(mockRefreshPermission).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(settingsRepo.setOnboarded).toHaveBeenCalledWith(true);
        expect(mockReplace).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('Standalone Components & Home Redirection Flow', () => {
    it('renders BenefitCard with custom title and description', async () => {
      const { getByTestId, getByText } = await renderWithTheme(
        <BenefitCard
          testID="custom-benefit-card"
          icon={<React.Fragment />}
          title="Custom Title"
          description="Custom Description"
        />
      );

      expect(getByTestId('custom-benefit-card')).toBeTruthy();
      expect(getByText('Custom Title')).toBeTruthy();
      expect(getByText('Custom Description')).toBeTruthy();
    });

    it('renders PermissionDeniedView standalone with callbacks', async () => {
      const onOpenSettings = jest.fn();
      const onCheckAgain = jest.fn();

      const { getByTestId, getByText } = await renderWithTheme(
        <PermissionDeniedView
          onOpenSettings={onOpenSettings}
          onCheckAgain={onCheckAgain}
          isChecking={false}
        />
      );

      expect(getByTestId('permission-denied-view')).toBeTruthy();
      expect(getByText('Open Settings')).toBeTruthy();
      expect(getByText('Check Again')).toBeTruthy();

      await fireEvent.press(getByTestId('open-settings-button'));
      expect(onOpenSettings).toHaveBeenCalledTimes(1);

      await fireEvent.press(getByTestId('check-again-button'));
      expect(onCheckAgain).toHaveBeenCalledTimes(1);
    });

    it('HomeScreen redirects to /onboarding when user is not onboarded', async () => {
      (settingsRepo.isOnboarded as jest.Mock).mockResolvedValue(false);
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'undetermined',
        granted: false,
        isLoading: false,
        presentPicker: mockPresentPicker,
      });

      await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith('/onboarding');
      });
    });

    it('HomeScreen redirects to /onboarding when permission is denied', async () => {
      (settingsRepo.isOnboarded as jest.Mock).mockResolvedValue(true);
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'denied',
        granted: false,
        isLoading: false,
        presentPicker: mockPresentPicker,
      });

      await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith('/onboarding');
      });
    });

    it('HomeScreen renders limited library banner when access is limited', async () => {
      (settingsRepo.isOnboarded as jest.Mock).mockResolvedValue(true);
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'limited',
        granted: true,
        isLoading: false,
        presentPicker: mockPresentPicker,
      });

      const { getByTestId, getByText } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByTestId('limited-library-banner')).toBeTruthy();
        expect(getByText('Only selected photos visible.')).toBeTruthy();
        expect(getByText('Manage')).toBeTruthy();
      });

      await fireEvent.press(getByText('Manage'));
      expect(mockPresentPicker).toHaveBeenCalledTimes(1);
    });
  });
});
