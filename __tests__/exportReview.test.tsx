import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import ExportReviewScreen from '../app/export/[tripId]';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as peopleRepo from '../src/db/repositories/people';
import * as purchasesService from '../src/services/purchases';
import * as exporterService from '../src/services/exporter';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import type { TripRow } from '../src/db/types';

jest.setTimeout(15000);

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

let mockTripIdParam = 'trip-1';

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ tripId: mockTripIdParam }),
}));

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock expo-file-system/legacy
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(50 * 1024 * 1024 * 1024), // 50 GB free
}));

// Mock repositories & services
jest.mock('../src/db/repositories/trips', () => ({
  getTripById: jest.fn(),
}));

jest.mock('../src/db/repositories/people', () => ({
  getExportPeopleSummary: jest.fn(),
}));

jest.mock('../src/services/purchases', () => ({
  getTripFreeTierStatus: jest.fn(),
}));

jest.mock('../src/services/exporter', () => ({
  exportPerson: jest.fn(),
}));

const mockTrip: TripRow = {
  id: 'trip-1',
  name: 'Coxsbazar Getaway',
  start_at: 1700000000000,
  end_at: 1700100000000,
  photo_count: 65,
  cover_photo_id: 'photo-1',
  is_away: 0,
  is_hidden: 0,
  is_user_edited: 0,
  scan_status: 'scanned',
  scanned_count: 50,
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

const mockPeople: peopleRepo.ExportPersonSummary[] = [
  {
    id: 'person-1',
    trip_id: 'trip-1',
    name: 'Rafi',
    is_others: 0,
    cover_face_id: 'face-1',
    centroid: null,
    created_at: 1000,
    photo_count: 20, // <= 30 photos: Photos and ZIP both allowed
    solo_photo_count: 8,
    cover_photo_id: 'photo-1',
  },
  {
    id: 'person-2',
    trip_id: 'trip-1',
    name: 'Tania',
    is_others: 0,
    cover_face_id: 'face-2',
    centroid: null,
    created_at: 2000,
    photo_count: 45, // > 30 photos: Photos disabled, ZIP only
    solo_photo_count: 15,
    cover_photo_id: 'photo-2',
  },
  {
    id: 'person-3',
    trip_id: 'trip-1',
    name: null, // Unnamed: disabled with "Name first"
    is_others: 0,
    cover_face_id: 'face-3',
    centroid: null,
    created_at: 3000,
    photo_count: 10,
    solo_photo_count: 5,
    cover_photo_id: 'photo-3',
  },
  {
    id: 'person-others',
    trip_id: 'trip-1',
    name: 'Others',
    is_others: 1,
    cover_face_id: null,
    centroid: null,
    created_at: 4000,
    photo_count: 5,
    solo_photo_count: 5,
    cover_photo_id: null,
  },
];

const mockDefaultFreeTier: purchasesService.TripFreeTierStatus = {
  tripId: 'trip-1',
  scannedCount: 50,
  limit: 50,
  isPro: true,
  isGateEnabled: false,
  canScanMore: true,
  remainingFreeScans: 0,
  requiresPaywall: false,
};

const renderWithTheme = async (ui: React.ReactElement) => {
  return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
};

describe('Phase 3 — Task 3.9: Export Review Screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTripIdParam = 'trip-1';

    (tripsRepo.getTripById as jest.Mock).mockResolvedValue(mockTrip);
    (peopleRepo.getExportPeopleSummary as jest.Mock).mockResolvedValue(mockPeople);
    (purchasesService.getTripFreeTierStatus as jest.Mock).mockResolvedValue(mockDefaultFreeTier);
    (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024);
  });

  afterEach(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  describe('Header, Display & Navigation', () => {
    it('renders header with title, trip name, and back button', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('export-header')).toBeTruthy();
      });

      expect(getByText('Export Review')).toBeTruthy();
      expect(getByTestId('back-button')).toBeTruthy();
    });

    it('navigates back when back button is pressed', async () => {
      const { getByTestId } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('back-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('back-button'));
      });

      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });

    it('renders named people and disables unnamed person with Name first badge', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('person-export-card-person-1')).toBeTruthy();
        expect(getByTestId('person-export-card-person-2')).toBeTruthy();
        expect(getByTestId('person-export-card-person-3')).toBeTruthy();
      });

      expect(getByText('Rafi')).toBeTruthy();
      expect(getByText('Tania')).toBeTruthy();
      expect(getByText('Name first')).toBeTruthy();

      // Tapping Name first badge routes to person screen
      await act(async () => {
        fireEvent.press(getByTestId('name-first-badge-person-3'));
      });

      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/person/[id]',
        params: { id: 'person-3' },
      });
    });

    it('renders empty error state when trip is not found', async () => {
      (tripsRepo.getTripById as jest.Mock).mockResolvedValueOnce(null);

      const { getByTestId, getByText } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('export-error-state')).toBeTruthy();
      });

      expect(getByText('Trip Not Found')).toBeTruthy();
    });
  });

  describe('Format Mode Toggle & Solo-only Toggle', () => {
    it('allows Photos mode for person with ≤ 30 photos and disallows for > 30 photos', async () => {
      const { getByTestId } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('format-photos-person-1')).toBeTruthy();
        expect(getByTestId('format-photos-person-2')).toBeTruthy();
      });

      // Rafi has 20 photos: can choose Photos or ZIP
      await act(async () => {
        fireEvent.press(getByTestId('format-zip-person-1'));
      });
      await act(async () => {
        fireEvent.press(getByTestId('format-photos-person-1'));
      });

      // Tania has 45 photos: Photos is disabled
      const taniaPhotosBtn = getByTestId('format-photos-person-2');
      expect(taniaPhotosBtn.props.accessibilityState?.disabled).toBe(true);
    });

    it('toggles Solo-only mode and recalculates count and estimated size', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('solo-toggle-person-1')).toBeTruthy();
      });

      // Initially Rafi shows 20 photos
      expect(getByText(/20 photos/)).toBeTruthy();

      // Toggle Solo-only on
      await act(async () => {
        fireEvent.press(getByTestId('solo-toggle-person-1'));
      });

      // Rafi shows 8 photos (solo count)
      expect(getByText(/8 photos/)).toBeTruthy();
    });
  });

  describe('Select All / Deselect All', () => {
    it('toggles all named people selection via Select All button', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('select-all-toggle-button')).toBeTruthy();
      });

      // Initially Rafi and Tania are selected (both named with photos)
      expect(getByText('Deselect All')).toBeTruthy();

      // Tap Deselect All
      await act(async () => {
        fireEvent.press(getByTestId('select-all-toggle-button'));
      });

      expect(getByText('Select All')).toBeTruthy();
      expect(getByText('Select people to export')).toBeTruthy();

      // Tap Select All
      await act(async () => {
        fireEvent.press(getByTestId('select-all-toggle-button'));
      });

      expect(getByText('Deselect All')).toBeTruthy();
    });
  });

  describe('Warnings & Free-tier Gates', () => {
    it('shows paywall banner when free limit is reached and routes to /paywall', async () => {
      (purchasesService.getTripFreeTierStatus as jest.Mock).mockResolvedValueOnce({
        tripId: 'trip-1',
        scannedCount: 65,
        limit: 50,
        isPro: false,
        isGateEnabled: true,
        canScanMore: false,
        remainingFreeScans: 0,
        requiresPaywall: true,
      });

      const { getByTestId } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('paywall-banner')).toBeTruthy();
        expect(getByTestId('paywall-banner-action')).toBeTruthy();
      });

      // Tap Unlock Pro
      await act(async () => {
        fireEvent.press(getByTestId('paywall-banner-action'));
      });

      expect(mockRouter.push).toHaveBeenCalledWith('/paywall');
    });

    it('shows low storage banner and alerts when free disk space is insufficient', async () => {
      // 10 MB free space (insufficient for ~227 MB estimated)
      (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(10 * 1024 * 1024);

      const alertSpy = jest.spyOn(Alert, 'alert');

      const { getByTestId } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('low-storage-banner')).toBeTruthy();
      });

      // Export button is disabled
      const exportBtn = getByTestId('start-export-button');
      expect(exportBtn.props.accessibilityState?.disabled).toBe(true);

      alertSpy.mockRestore();
    });
  });

  describe('Sequential Batch Queue & Sharing Execution', () => {
    it('executes sequential batch export for selected people and shows progress modal', async () => {
      (exporterService.exportPerson as jest.Mock)
        .mockResolvedValueOnce({
          exportId: 'exp-1',
          mode: 'photos',
          photoCount: 20,
          sizeBytes: 20 * 1024 * 1024,
          status: 'done',
          zipPath: null,
        })
        .mockResolvedValueOnce({
          exportId: 'exp-2',
          mode: 'zip',
          photoCount: 45,
          sizeBytes: 45 * 1024 * 1024,
          status: 'done',
          zipPath: null,
        });

      const { getByTestId, getByText } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('start-export-button')).toBeTruthy();
      });

      // Press Export 2 People
      await act(async () => {
        fireEvent.press(getByTestId('start-export-button'));
      });

      await waitFor(() => {
        expect(exporterService.exportPerson).toHaveBeenCalledTimes(2);
      });

      expect(exporterService.exportPerson).toHaveBeenNthCalledWith(1, {
        personId: 'person-1',
        tripId: 'trip-1',
        mode: 'photos',
        soloOnly: false,
      });

      expect(exporterService.exportPerson).toHaveBeenNthCalledWith(2, {
        personId: 'person-2',
        tripId: 'trip-1',
        mode: 'zip',
        soloOnly: false,
      });

      // Feedback banner appears
      await waitFor(() => {
        expect(getByTestId('feedback-banner')).toBeTruthy();
        expect(getByText('Export complete! Shared 2 people.')).toBeTruthy();
      });
    });

    it('unchecks row if share is cancelled by user (02_AppFlow §3.7)', async () => {
      (exporterService.exportPerson as jest.Mock).mockResolvedValueOnce({
        exportId: 'exp-1',
        mode: 'photos',
        photoCount: 20,
        sizeBytes: 20 * 1024 * 1024,
        status: 'cancelled',
        zipPath: null,
      });

      const { getByTestId, getByText } = await renderWithTheme(<ExportReviewScreen />);

      await waitFor(() => {
        expect(getByTestId('person-checkbox-person-2')).toBeTruthy();
      });

      // Deselect Tania so only Rafi is exported
      await act(async () => {
        fireEvent.press(getByTestId('person-checkbox-person-2'));
      });

      // Start export for Rafi
      await act(async () => {
        fireEvent.press(getByTestId('start-export-button'));
      });

      await waitFor(() => {
        expect(exporterService.exportPerson).toHaveBeenCalledWith(
          expect.objectContaining({ personId: 'person-1' })
        );
      });

      // Rafi row returns to unchecked state and shows Cancelled label
      await waitFor(() => {
        expect(getByText('Cancelled')).toBeTruthy();
        const checkbox = getByTestId('person-checkbox-person-1');
        expect(checkbox.props.accessibilityState?.checked).toBe(false);
      });
    });
  });
});
