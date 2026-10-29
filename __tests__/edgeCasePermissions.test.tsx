import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';
import { ThemeProvider } from '../src/theme';
import OnboardingScreen from '../app/onboarding';
import HomeScreen from '../app/index';
import ScanProgressModal from '../app/trip/[id]/scan';
import * as libraryService from '../src/services/library';
import * as libraryHooks from '../src/hooks/useLibraryPermission';
import * as tripRepo from '../src/db/repositories/trips';
import * as photoRepo from '../src/db/repositories/photos';
import * as settingsRepo from '../src/db/repositories/settings';
import { getDatabase, closeDatabase } from '../src/db/client';
import {
  scanTripFaces,
  isPermissionRevokedError,
  defaultPhotoUriResolver,
} from '../src/services/faceScan';

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'trip-perm-edge-1' }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

// Mock safe-area
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock keep-awake
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
}));

// Mock useLibraryPermission hook at the hook level
jest.mock('../src/hooks/useLibraryPermission', () => ({
  useLibraryPermission: jest.fn(),
}));

describe('Task 4.1: Permission Edge-Case Tests', () => {
  let db: any;

  beforeAll(async () => {
    db = await getDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const renderWithTheme = async (ui: React.ReactElement) => {
    return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
  };

  describe('1. Limited Access Edge Cases', () => {
    it('maps iOS 14+ limited access correctly', () => {
      const response: Pick<
        MediaLibrary.PermissionResponse,
        'status' | 'granted' | 'canAskAgain' | 'accessPrivileges'
      > = {
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      };

      const mapped = libraryService.mapPermissionResponse(response);
      expect(mapped.status).toBe('limited');
      expect(mapped.granted).toBe(true);
      expect(mapped.accessPrivileges).toBe('limited');
    });

    it('renders limited access warning banner on Home and allows presenting picker', async () => {
      const mockPresentPicker = jest.fn();
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'limited',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
        isLoading: false,
        requestPermission: jest.fn(),
        refreshPermission: jest.fn(),
        openSettings: jest.fn(),
        presentPicker: mockPresentPicker,
      });

      jest.spyOn(settingsRepo, 'isOnboarded').mockResolvedValue(true);
      jest.spyOn(tripRepo, 'getAllTrips').mockResolvedValue([
        {
          id: 'trip-1',
          name: 'Weekend Getaway',
          start_at: 1700000000000,
          end_at: 1700100000000,
          photo_count: 24,
          cover_photo_id: null,
          is_away: 0,
          is_hidden: 0,
          is_user_edited: 0,
          scan_status: 'not_scanned',
          scanned_count: 0,
          created_at: 1700000000000,
          updated_at: 1700000000000,
        },
      ]);

      const { getByTestId, getByText } = await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(getByTestId('limited-library-banner')).toBeTruthy();
      });

      expect(getByText(/Only selected photos visible/i)).toBeTruthy();

      const manageBtn = getByText('Manage');
      fireEvent.press(manageBtn);
      expect(mockPresentPicker).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Revoked Permission Mid-Scan', () => {
    it('detects permission revocation errors correctly via isPermissionRevokedError', () => {
      expect(isPermissionRevokedError(new Error('Photo library permission not granted'))).toBe(true);
      expect(isPermissionRevokedError(new Error('User denied access to photos'))).toBe(true);
      expect(isPermissionRevokedError(new Error('Access unauthorized or restricted'))).toBe(true);
      expect(isPermissionRevokedError(new Error('File corrupt'))).toBe(false);
      expect(isPermissionRevokedError(null)).toBe(false);
    });

    it('pauses scan gracefully when permission is revoked mid-scan and preserves pending status', async () => {
      const tripId = 'trip-perm-revoked-1';
      await tripRepo.createTrip(
        {
          id: tripId,
          name: 'Revocation Test Trip',
          start_at: 1700000000000,
          end_at: 1700100000000,
          photo_count: 2,
          scan_status: 'scanning',
        },
        db
      );

      await photoRepo.upsertPhotos(
        [
          {
            id: 'photo-rev-1',
            trip_id: tripId,
            taken_at: 1700000010000,
            modified_at: 1700000010000,
            width: 1000,
            height: 1000,
            lat: null,
            lng: null,
            is_local: 1,
            scan_status: 'pending',
            face_count: 0,
            excluded: 0,
          },
          {
            id: 'photo-rev-2',
            trip_id: tripId,
            taken_at: 1700000020000,
            modified_at: 1700000020000,
            width: 1000,
            height: 1000,
            lat: null,
            lng: null,
            is_local: 1,
            scan_status: 'pending',
            face_count: 0,
            excluded: 0,
          },
        ],
        db
      );

      let callCount = 0;
      const mockUriResolver = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return 'file:///photo-1.jpg';
        }
        // Permission revoked on second photo
        throw new Error('Photo library permission not granted');
      });

      const mockDetector = {
        detectFaces: jest.fn().mockResolvedValue([]),
      };

      const result = await scanTripFaces(tripId, {
        db,
        concurrency: 1,
        photoUriResolver: mockUriResolver,
        detector: mockDetector,
        autoCluster: false,
      });

      // Status must transition to paused with error recorded
      expect(result.status).toBe('paused');
      expect(result.scannedCount).toBe(1);
      expect(result.error?.message).toMatch(/permission not granted/i);

      // Verify trip table scan_status was updated to paused
      const updatedTrip = await tripRepo.getTripById(tripId, db);
      expect(updatedTrip?.scan_status).toBe('paused');

      // Verify second photo remains pending (not marked failed!)
      const pendingPhotos = await photoRepo.getPendingPhotosByTripId(tripId, undefined, db);
      expect(pendingPhotos.length).toBe(1);
      expect(pendingPhotos[0].id).toBe('photo-rev-2');
    });

    it('defaultPhotoUriResolver rethrows permission errors so faceScan can pause', async () => {
      jest.spyOn(MediaLibrary, 'getAssetInfoAsync').mockRejectedValueOnce(new Error('User denied access to photo library'));

      await expect(defaultPhotoUriResolver('photo-perm-err')).rejects.toThrow(/User denied access/i);
    });

    it('pauses immediately if photo library permission is denied prior to starting scan', async () => {
      const tripId = 'trip-perm-denied-start';
      await tripRepo.createTrip(
        {
          id: tripId,
          name: 'Denied Start Trip',
          start_at: 1700000000000,
          end_at: 1700100000000,
          photo_count: 1,
          scan_status: 'not_scanned',
        },
        db
      );

      await photoRepo.upsertPhotos(
        [
          {
            id: 'photo-denied-1',
            trip_id: tripId,
            taken_at: 1700000010000,
            modified_at: 1700000010000,
            width: 1000,
            height: 1000,
            lat: null,
            lng: null,
            is_local: 1,
            scan_status: 'pending',
            face_count: 0,
            excluded: 0,
          },
        ],
        db
      );

      jest.spyOn(libraryService, 'getLibraryPermissionStatus').mockResolvedValueOnce({
        status: 'denied',
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      });

      const result = await scanTripFaces(tripId, { db });
      expect(result.status).toBe('paused');
      expect(result.error?.message).toMatch(/permission not granted/i);

      const trip = await tripRepo.getTripById(tripId, db);
      expect(trip?.scan_status).toBe('paused');
    });

    it('renders permission-revoked-banner in scan modal when permission is revoked', async () => {
      const mockOpenSettings = jest.fn();
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'denied',
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
        isLoading: false,
        requestPermission: jest.fn(),
        refreshPermission: jest.fn(),
        openSettings: mockOpenSettings,
        presentPicker: jest.fn(),
      });

      // Mock useFaceScan to return paused with permission error
      jest.spyOn(require('../src/services/faceScan'), 'useFaceScan').mockReturnValue({
        isScanning: false,
        isPaused: true,
        progress: { current: 1, total: 3, facesFound: 2 },
        error: new Error('Photo library permission not granted'),
        startScan: jest.fn(),
        resumeScan: jest.fn(),
        cancelScan: jest.fn(),
        pauseScan: jest.fn(),
      });

      jest.spyOn(tripRepo, 'getTripById').mockResolvedValue({
        id: 'trip-perm-edge-1',
        name: 'Test Trip',
        start_at: 1700000000000,
        end_at: 1700100000000,
        photo_count: 3,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'paused',
        scanned_count: 1,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      });

      const { getByTestId, getByText } = await renderWithTheme(<ScanProgressModal />);

      await waitFor(() => {
        expect(getByTestId('scan-paused-view')).toBeTruthy();
      });

      expect(getByTestId('permission-revoked-banner')).toBeTruthy();
      expect(getByText(/Access to your photo library was revoked/i)).toBeTruthy();

      const openSettingsBtn = getByText('Open Settings');
      fireEvent.press(openSettingsBtn);
      expect(mockOpenSettings).toHaveBeenCalled();
    });
  });

  describe('3. Denied → Settings → Return Flow', () => {
    it('redirects from Home to Onboarding when permission status is denied', async () => {
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'denied',
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
        isLoading: false,
        requestPermission: jest.fn(),
        refreshPermission: jest.fn(),
        openSettings: jest.fn(),
        presentPicker: jest.fn(),
      });

      jest.spyOn(settingsRepo, 'isOnboarded').mockResolvedValue(true);

      await renderWithTheme(<HomeScreen />);

      await waitFor(() => {
        expect(mockRouter.replace).toHaveBeenCalledWith('/onboarding');
      });
    });

    it('renders PermissionDeniedView on Onboarding and opens iOS settings on button press', async () => {
      const mockOpenSettings = jest.fn();
      (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
        status: 'denied',
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
        isLoading: false,
        requestPermission: jest.fn(),
        refreshPermission: jest.fn(),
        openSettings: mockOpenSettings,
        presentPicker: jest.fn(),
      });

      const { getByTestId, getByText } = await renderWithTheme(<OnboardingScreen />);

      expect(getByTestId('permission-denied-view')).toBeTruthy();
      expect(getByText('Photo Access Needed')).toBeTruthy();

      const openSettingsBtn = getByTestId('open-settings-button');
      fireEvent.press(openSettingsBtn);

      expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    });

    it('refreshes permission on AppState transition to active when returning from Settings', async () => {
      let appStateListener: ((state: AppStateStatus) => void) | undefined;
      jest.spyOn(AppState, 'addEventListener').mockImplementation((type: string, listener: any) => {
        if (type === 'change') {
          appStateListener = listener;
        }
        return { remove: jest.fn() } as any;
      });

      const getPermissionsSpy = jest
        .spyOn(MediaLibrary, 'getPermissionsAsync')
        .mockResolvedValueOnce({
          status: MediaLibrary.PermissionStatus.DENIED,
          granted: false,
          canAskAgain: false,
          accessPrivileges: 'none',
        } as MediaLibrary.PermissionResponse)
        .mockResolvedValueOnce({
          status: MediaLibrary.PermissionStatus.GRANTED,
          granted: true,
          canAskAgain: true,
          accessPrivileges: 'all',
        } as MediaLibrary.PermissionResponse);

      // Use the actual useLibraryPermission hook implementation
      const actualLibrary = jest.requireActual('../src/services/library');
      let hookResult: any;
      function TestComponent() {
        hookResult = actualLibrary.useLibraryPermission({ autoRefreshOnActive: true });
        return null;
      }

      await renderWithTheme(<TestComponent />);

      await waitFor(() => {
        expect(hookResult.status).toBe('denied');
      });

      // Simulate user returning from iOS Settings (AppState -> 'active')
      expect(appStateListener).toBeDefined();
      appStateListener!('active');

      await waitFor(() => {
        expect(hookResult.status).toBe('full');
        expect(hookResult.granted).toBe(true);
      });

      expect(getPermissionsSpy).toHaveBeenCalledTimes(2);
    });

    it('automatically navigates to / upon permission grant when returning from Settings', async () => {
      jest.spyOn(settingsRepo, 'setOnboarded').mockResolvedValue();

      // Start with denied
      let currentStatus: libraryService.LibraryPermissionStatus = 'denied';
      let currentGranted = false;

      (libraryHooks.useLibraryPermission as jest.Mock).mockImplementation(() => ({
        status: currentStatus,
        granted: currentGranted,
        canAskAgain: true,
        accessPrivileges: currentGranted ? ('all' as const) : ('none' as const),
        isLoading: false,
        requestPermission: jest.fn(),
        refreshPermission: jest.fn(),
        openSettings: jest.fn(),
        presentPicker: jest.fn(),
      }));

      const screen = await renderWithTheme(<OnboardingScreen />);
      expect(mockRouter.replace).not.toHaveBeenCalled();
      screen.unmount();

      // Simulate re-granting permission in Settings and re-rendering
      currentStatus = 'full';
      currentGranted = true;

      await renderWithTheme(<OnboardingScreen />);

      await waitFor(() => {
        expect(mockRouter.replace).toHaveBeenCalledWith('/');
      });
    });
  });
});
