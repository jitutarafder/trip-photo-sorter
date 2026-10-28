import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import HomeScreen from '../app/index';
import { TripCard } from '../src/components/trips/TripCard';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as settingsRepo from '../src/db/repositories/settings';
import * as libraryHooks from '../src/hooks/useLibraryPermission';
import * as libraryService from '../src/services/library';
import * as tripService from '../src/services/tripService';
import type { TripRow } from '../src/db/types';

// Mock expo-router
const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) => {
      const HeaderRight = options?.headerRight;
      return HeaderRight ? <>{HeaderRight()}</> : null;
    },
  },
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

// Mock expo-media-library
jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn().mockResolvedValue({
    id: 'asset-1',
    uri: 'file:///var/mobile/photo.jpg',
    localUri: 'file:///var/mobile/photo.jpg',
  }),
  PermissionStatus: {
    GRANTED: 'granted',
    DENIED: 'denied',
    UNDETERMINED: 'undetermined',
  },
}));

// Mock repositories and services
jest.mock('../src/db/repositories/settings', () => ({
  isOnboarded: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/db/repositories/trips', () => ({
  getAllTrips: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/library', () => {
  const actual = jest.requireActual('../src/services/library');
  return {
    ...actual,
    syncLibrary: jest.fn().mockResolvedValue({ syncedCount: 0, batchesCount: 0 }),
  };
});

jest.mock('../src/services/tripService', () => ({
  detectAndPersistTrips: jest.fn().mockResolvedValue({ detectedCount: 0, trips: [] }),
}));

jest.mock('../src/hooks/useLibraryPermission', () => ({
  useLibraryPermission: jest.fn(),
}));

const sampleTrip: TripRow = {
  id: 'trip-1',
  name: 'Trip · Oct 24, 2026',
  start_at: 1792800000000,
  end_at: 1792886400000,
  photo_count: 24,
  cover_photo_id: 'cover-1',
  is_away: 0,
  is_hidden: 0,
  is_user_edited: 0,
  scan_status: 'scanned',
  scanned_count: 24,
  created_at: 1792886400000,
  updated_at: 1792886400000,
};

describe('Home (Trips) Screen & TripCard (Task 3.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (settingsRepo.isOnboarded as jest.Mock).mockResolvedValue(true);
    (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
      status: 'full',
      granted: true,
      isLoading: false,
      presentPicker: jest.fn(),
    });
    (tripsRepo.getAllTrips as jest.Mock).mockResolvedValue([]);
    (libraryService.syncLibrary as jest.Mock).mockResolvedValue({ syncedCount: 0, batchesCount: 0 });
    (tripService.detectAndPersistTrips as jest.Mock).mockResolvedValue({ detectedCount: 0, trips: [] });
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const renderWithTheme = async (ui: React.ReactElement) => {
    return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
  };

  describe('TripCard Component', () => {
    it('renders trip details: name, date range, and photo count', async () => {
      const { getByText } = await renderWithTheme(<TripCard trip={sampleTrip} />);

      expect(getByText('Trip · Oct 24, 2026')).toBeTruthy();
      expect(getByText('24 photos')).toBeTruthy();
    });

    it('renders scan status badge for scanned, scanning, clustering, paused, and failed', async () => {
      const scannedResult = await renderWithTheme(<TripCard trip={sampleTrip} />);
      expect(scannedResult.getByTestId('scan-badge-scanned')).toBeTruthy();

      const scanningTrip = { ...sampleTrip, id: 't2', scan_status: 'scanning' as const };
      const scanningResult = await renderWithTheme(<TripCard trip={scanningTrip} />);
      expect(scanningResult.getByTestId('scan-badge-scanning')).toBeTruthy();

      const clusteringTrip = { ...sampleTrip, id: 't3', scan_status: 'clustering' as const };
      const clusteringResult = await renderWithTheme(<TripCard trip={clusteringTrip} />);
      expect(clusteringResult.getByTestId('scan-badge-clustering')).toBeTruthy();

      const pausedTrip = { ...sampleTrip, id: 't4', scan_status: 'paused' as const };
      const pausedResult = await renderWithTheme(<TripCard trip={pausedTrip} />);
      expect(pausedResult.getByTestId('scan-badge-paused')).toBeTruthy();

      const failedTrip = { ...sampleTrip, id: 't5', scan_status: 'failed' as const };
      const failedResult = await renderWithTheme(<TripCard trip={failedTrip} />);
      expect(failedResult.getByTestId('scan-badge-failed')).toBeTruthy();

      const notScannedTrip = { ...sampleTrip, id: 't6', scan_status: 'not_scanned' as const };
      const notScannedResult = await renderWithTheme(<TripCard trip={notScannedTrip} />);
      expect(notScannedResult.getByTestId('scan-badge-not_scanned')).toBeTruthy();
    });

    it('handles press event and invokes onPress with trip data', async () => {
      const onPressMock = jest.fn();
      const { getByTestId } = await renderWithTheme(
        <TripCard trip={sampleTrip} onPress={onPressMock} />
      );

      const card = getByTestId('trip-card-trip-1');
      await fireEvent.press(card);

      expect(onPressMock).toHaveBeenCalledWith(sampleTrip);
    });

    it('renders fallback cover when trip has no cover_photo_id', async () => {
      const noCoverTrip = { ...sampleTrip, id: 't7', cover_photo_id: null };
      const { getByTestId } = await renderWithTheme(<TripCard trip={noCoverTrip} />);

      expect(getByTestId('trip-card-fallback-cover')).toBeTruthy();
    });
  });

  describe('HomeScreen Component', () => {
    it('renders empty state when no trips are detected', async () => {
      (tripsRepo.getAllTrips as jest.Mock).mockResolvedValue([]);

      const { getByTestId, getByText } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByTestId('home-empty-trips-state')).toBeTruthy();
        expect(getByText('No trips found yet')).toBeTruthy();
        expect(getByText('Rescan library')).toBeTruthy();
      });
    });

    it('triggers rescan when "Rescan library" action is tapped in empty state', async () => {
      (tripsRepo.getAllTrips as jest.Mock).mockResolvedValue([]);

      const { getByText } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByText('Rescan library')).toBeTruthy();
      });

      await fireEvent.press(getByText('Rescan library'));

      await waitFor(() => {
        expect(libraryService.syncLibrary).toHaveBeenCalledWith({ forceFullSync: true });
        expect(tripService.detectAndPersistTrips).toHaveBeenCalled();
      });
    });

    it('renders error state when trip loading fails and allows retry', async () => {
      (tripsRepo.getAllTrips as jest.Mock).mockRejectedValueOnce(new Error('Database lock error'));

      const { getByTestId, getByText } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByTestId('home-error-empty-state')).toBeTruthy();
        expect(getByText("Couldn't load trips")).toBeTruthy();
        expect(getByText('Database lock error')).toBeTruthy();
        expect(getByText('Retry')).toBeTruthy();
      });

      // Prepare successful response for retry
      (tripsRepo.getAllTrips as jest.Mock).mockResolvedValueOnce([sampleTrip]);
      await fireEvent.press(getByText('Retry'));

      await waitFor(() => {
        expect(libraryService.syncLibrary).toHaveBeenCalled();
      });
    });

    it('renders FlashList of trips when trips exist in database', async () => {
      const tripsList = [
        sampleTrip,
        {
          ...sampleTrip,
          id: 'trip-2',
          name: 'Trip · Sep 10, 2026',
          start_at: 1789000000000,
          end_at: 1789086400000,
          photo_count: 15,
        },
      ];
      (tripsRepo.getAllTrips as jest.Mock).mockResolvedValue(tripsList);

      const { getByTestId, getByText } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByTestId('trips-flash-list')).toBeTruthy();
        expect(getByText('Trip · Oct 24, 2026')).toBeTruthy();
        expect(getByText('Trip · Sep 10, 2026')).toBeTruthy();
      });
    });

    it('navigates to /trip/[id] when a trip card is pressed', async () => {
      (tripsRepo.getAllTrips as jest.Mock).mockResolvedValue([sampleTrip]);

      const { getByTestId } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByTestId('trip-card-trip-1')).toBeTruthy();
      });

      await fireEvent.press(getByTestId('trip-card-trip-1'));

      expect(mockRouter.push).toHaveBeenCalledWith('/trip/trip-1');
    });

    it('navigates to /settings when the header gear button is pressed', async () => {
      const { getByTestId } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByTestId('header-settings-button')).toBeTruthy();
      });

      await fireEvent.press(getByTestId('header-settings-button'));

      expect(mockRouter.push).toHaveBeenCalledWith('/settings');
    });
  });
});
