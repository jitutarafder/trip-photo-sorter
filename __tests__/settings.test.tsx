import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import SettingsScreen from '../app/settings';
import { ThemeProvider } from '../src/theme';
import * as libraryHooks from '../src/hooks/useLibraryPermission';
import * as libraryService from '../src/services/library';
import * as purchasesService from '../src/services/purchases';
import * as tripPersistence from '../src/services/tripService';
import * as appDataService from '../src/services/appData';

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock library hooks & services
jest.mock('../src/hooks/useLibraryPermission', () => ({
  useLibraryPermission: jest.fn(),
}));

jest.mock('../src/services/library', () => {
  const actual = jest.requireActual('../src/services/library');
  return {
    ...actual,
    syncLibrary: jest.fn(),
    getLastLibrarySync: jest.fn(),
  };
});

// Mock purchases service
jest.mock('../src/services/purchases', () => {
  const actual = jest.requireActual('../src/services/purchases');
  return {
    ...actual,
    useProStatus: jest.fn(),
  };
});

// Mock trip service
jest.mock('../src/services/tripService', () => ({
  detectAndPersistTrips: jest.fn(),
}));

// Mock appData service
jest.mock('../src/services/appData', () => ({
  resetAllAppData: jest.fn(),
}));

describe('Settings Screen (Task 3.11)', () => {
  const mockOpenSettings = jest.fn();
  const mockPresentPicker = jest.fn();
  const mockRefreshPermission = jest.fn();

  const mockUnlockPro = jest.fn();
  const mockRestorePurchases = jest.fn();
  const mockRefreshPro = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default permission mock
    (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
      status: 'full',
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'all',
      isLoading: false,
      openSettings: mockOpenSettings,
      presentPicker: mockPresentPicker,
      refreshPermission: mockRefreshPermission,
      requestPermission: jest.fn(),
    });

    // Default Pro status mock
    (purchasesService.useProStatus as jest.Mock).mockReturnValue({
      isPro: true,
      isPurchased: false,
      isGateEnabled: false,
      isLoading: false,
      error: null,
      unlockPro: mockUnlockPro.mockResolvedValue(true),
      restorePurchases: mockRestorePurchases.mockResolvedValue(true),
      refresh: mockRefreshPro.mockResolvedValue(undefined),
    });

    // Default library service mocks
    (libraryService.getLastLibrarySync as jest.Mock).mockResolvedValue(1700000000000);
    (libraryService.syncLibrary as jest.Mock).mockResolvedValue({
      syncedCount: 42,
      batchesCount: 1,
      lastSyncAt: 1700000000000,
      isIncremental: false,
    });

    (tripPersistence.detectAndPersistTrips as jest.Mock).mockResolvedValue([]);
    (appDataService.resetAllAppData as jest.Mock).mockResolvedValue({
      tablesReset: true,
      exportsCleared: true,
    });
  });

  const renderScreen = async () => {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(
        <ThemeProvider colorScheme="dark">
          <SettingsScreen />
        </ThemeProvider>
      );
    });
    return result!;
  };

  it('renders all main sections and version info', async () => {
    const { getByTestId, getByText } = await renderScreen();

    expect(getByTestId('settings-screen')).toBeTruthy();
    expect(getByTestId('settings-permission-card')).toBeTruthy();
    expect(getByTestId('settings-sync-card')).toBeTruthy();
    expect(getByTestId('settings-purchases-card')).toBeTruthy();
    expect(getByTestId('settings-privacy-card')).toBeTruthy();
    expect(getByTestId('settings-danger-card')).toBeTruthy();

    expect(getByText('Trip Photo Sorter')).toBeTruthy();
    expect(getByText(/Version 1.0.0/i)).toBeTruthy();
  });

  describe('Permission Status & Management', () => {
    it('displays FULL ACCESS badge when granted and opens iOS settings', async () => {
      const { getByTestId, getByText } = await renderScreen();

      expect(getByText('FULL ACCESS')).toBeTruthy();
      const openSettingsBtn = getByTestId('settings-open-settings-button');
      fireEvent.press(openSettingsBtn);

      expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    });

    it('displays LIMITED ACCESS badge and allows selecting more photos', async () => {
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'limited',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
        isLoading: false,
        openSettings: mockOpenSettings,
        presentPicker: mockPresentPicker.mockResolvedValue(undefined),
        refreshPermission: mockRefreshPermission,
      });

      const { getByTestId, getByText } = await renderScreen();

      expect(getByText('LIMITED ACCESS')).toBeTruthy();
      const selectMoreBtn = getByTestId('settings-select-more-photos-button');
      expect(selectMoreBtn).toBeTruthy();

      await act(async () => {
        fireEvent.press(selectMoreBtn);
      });

      expect(mockPresentPicker).toHaveBeenCalledTimes(1);
    });

    it('displays DENIED badge when photo access is denied', async () => {
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'denied',
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
        isLoading: false,
        openSettings: mockOpenSettings,
        presentPicker: mockPresentPicker,
        refreshPermission: mockRefreshPermission,
      });

      const { getByText } = await renderScreen();
      expect(getByText('DENIED')).toBeTruthy();
    });
  });

  describe('Library Re-sync', () => {
    it('executes library re-sync and updates trips on press', async () => {
      const { getByTestId, getByText } = await renderScreen();

      const resyncBtn = getByTestId('settings-resync-button');
      await act(async () => {
        fireEvent.press(resyncBtn);
      });

      expect(libraryService.syncLibrary).toHaveBeenCalledWith({ forceFullSync: true });
      expect(tripPersistence.detectAndPersistTrips).toHaveBeenCalled();
      expect(getByText(/Successfully synchronized 42 photos/i)).toBeTruthy();
    });

    it('handles sync error and displays error banner', async () => {
      (libraryService.syncLibrary as jest.Mock).mockRejectedValue(new Error('Permission revoked or disk error'));

      const { getByTestId, getByText } = await renderScreen();
      const resyncBtn = getByTestId('settings-resync-button');

      await act(async () => {
        fireEvent.press(resyncBtn);
      });

      expect(getByText(/Permission revoked or disk error/i)).toBeTruthy();
    });
  });

  describe('Purchases & Pro Status', () => {
    it('navigates to /paywall when View Pro Details is tapped', async () => {
      const { getByTestId } = await renderScreen();

      const viewProBtn = getByTestId('settings-view-pro-button');
      fireEvent.press(viewProBtn);

      expect(mockRouter.push).toHaveBeenCalledWith('/paywall');
    });

    it('triggers restorePurchases and displays feedback', async () => {
      mockRestorePurchases.mockResolvedValue(true);

      const { getByTestId, getByText } = await renderScreen();
      const restoreBtn = getByTestId('settings-restore-purchase-button');

      await act(async () => {
        fireEvent.press(restoreBtn);
      });

      expect(mockRestorePurchases).toHaveBeenCalledTimes(1);
      expect(getByText(/Your Pro lifetime purchase has been restored successfully/i)).toBeTruthy();
    });

    it('displays info message when no previous purchases are found', async () => {
      mockRestorePurchases.mockResolvedValue(false);

      const { getByTestId, getByText } = await renderScreen();
      const restoreBtn = getByTestId('settings-restore-purchase-button');

      await act(async () => {
        fireEvent.press(restoreBtn);
      });

      expect(mockRestorePurchases).toHaveBeenCalledTimes(1);
      expect(getByText(/No previous Pro purchases were found/i)).toBeTruthy();
    });
  });

  describe('Privacy Statement', () => {
    it('renders on-device privacy points', async () => {
      const { getByText } = await renderScreen();

      expect(getByText(/Nothing leaves your phone/i)).toBeTruthy();
      expect(getByText(/100% On-Device AI/i)).toBeTruthy();
      expect(getByText(/Read-Only Gallery/i)).toBeTruthy();
      expect(getByText(/Zero Trash/i)).toBeTruthy();
      expect(getByText(/No Cloud Accounts/i)).toBeTruthy();
    });
  });

  describe('Reset All App Data (Danger Zone)', () => {
    let alertSpy: jest.SpyInstance;

    beforeAll(() => {
      alertSpy = jest.spyOn(Alert, 'alert');
    });

    afterAll(() => {
      alertSpy.mockRestore();
    });

    beforeEach(() => {
      alertSpy.mockClear();
    });

    it('shows confirmation dialog on tap and cancels without resetting', async () => {
      const { getByTestId } = await renderScreen();
      const resetBtn = getByTestId('settings-reset-data-button');

      fireEvent.press(resetBtn);

      expect(alertSpy).toHaveBeenCalledWith(
        'Reset All App Data?',
        expect.stringContaining('This will delete all detected trips'),
        expect.any(Array)
      );

      // Tap Cancel button (index 0)
      const buttons = alertSpy.mock.calls[0][2]!;
      const cancelButton = buttons[0];
      expect(cancelButton.text).toBe('Cancel');

      expect(appDataService.resetAllAppData).not.toHaveBeenCalled();
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    it('handles reset error gracefully', async () => {
      (appDataService.resetAllAppData as jest.Mock).mockRejectedValueOnce(new Error('SQLite locked'));

      const { getByTestId, getByText } = await renderScreen();
      const resetBtn = getByTestId('settings-reset-data-button');

      fireEvent.press(resetBtn);

      const buttons = alertSpy.mock.calls[0][2]!;
      const confirmButton = buttons[1];

      void confirmButton.onPress!();

      await waitFor(() => {
        expect(getByText(/SQLite locked/i)).toBeTruthy();
      });
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    it('executes resetAllAppData and navigates to /onboarding upon confirmation', async () => {
      const { getByTestId } = await renderScreen();
      const resetBtn = getByTestId('settings-reset-data-button');

      fireEvent.press(resetBtn);

      // Confirm reset action (index 1)
      const buttons = alertSpy.mock.calls[0][2]!;
      const confirmButton = buttons[1];
      expect(confirmButton.text).toBe('Reset Everything');

      void confirmButton.onPress!();

      await waitFor(() => {
        expect(appDataService.resetAllAppData).toHaveBeenCalledTimes(1);
        expect(mockRouter.replace).toHaveBeenCalledWith('/onboarding');
      });
    });
  });
});
