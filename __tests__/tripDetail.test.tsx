import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import TripDetailScreen from '../app/trip/[id]/index';
import { PhotoTile } from '../src/components/photos/PhotoTile';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as photosRepo from '../src/db/repositories/photos';
import * as tripService from '../src/services/tripService';
import * as purchasesService from '../src/services/purchases';
import * as MediaLibrary from 'expo-media-library';
import type { TripRow, PhotoRow } from '../src/db/types';

// Mock expo-router
const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  back: jest.fn(),
};

let mockTripIdParam = 'trip-1';

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: mockTripIdParam }),
  Stack: {
    Screen: () => null,
  },
}));

// Mock expo-media-library
jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn().mockImplementation((id: string) => {
    if (id === 'broken-asset') {
      return Promise.reject(new Error('Asset not found'));
    }
    return Promise.resolve({
      id,
      uri: `file:///var/mobile/${id}.jpg`,
      localUri: `file:///var/mobile/${id}.jpg`,
    });
  }),
}));

// Mock repositories and services
jest.mock('../src/db/repositories/trips', () => ({
  getTripById: jest.fn(),
  updateTrip: jest.fn(),
  getAllTrips: jest.fn(),
  mergeTrips: jest.fn(),
}));

jest.mock('../src/db/repositories/photos', () => ({
  getPhotosByTripId: jest.fn(),
}));

jest.mock('../src/services/tripService', () => ({
  adjustTripDates: jest.fn(),
}));

jest.mock('../src/services/purchases', () => {
  const actual = jest.requireActual('../src/services/purchases');
  return {
    ...actual,
    useTripFreeTier: jest.fn(),
  };
});

const sampleTrip: TripRow = {
  id: 'trip-1',
  name: 'Trip · Oct 24, 2026',
  start_at: 1792800000000,
  end_at: 1792886400000,
  photo_count: 3,
  cover_photo_id: 'photo-1',
  is_away: 0,
  is_hidden: 0,
  is_user_edited: 0,
  scan_status: 'not_scanned',
  scanned_count: 0,
  created_at: 1792800000000,
  updated_at: 1792800000000,
};

const samplePhotos: PhotoRow[] = [
  {
    id: 'photo-1',
    trip_id: 'trip-1',
    taken_at: 1792800000000,
    modified_at: 1792800000000,
    width: 3000,
    height: 2000,
    lat: null,
    lng: null,
    is_local: 1,
    scan_status: 'pending',
    face_count: 0,
    excluded: 0,
  },
  {
    id: 'photo-2',
    trip_id: 'trip-1',
    taken_at: 1792810000000,
    modified_at: 1792810000000,
    width: 3000,
    height: 2000,
    lat: null,
    lng: null,
    is_local: 1,
    scan_status: 'pending',
    face_count: 0,
    excluded: 0,
  },
  {
    id: 'photo-3',
    trip_id: 'trip-1',
    taken_at: 1792820000000,
    modified_at: 1792820000000,
    width: 3000,
    height: 2000,
    lat: null,
    lng: null,
    is_local: 1,
    scan_status: 'pending',
    face_count: 0,
    excluded: 0,
  },
];

const renderWithTheme = async (ui: React.ReactElement) => {
  return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
};

describe('PhotoTile Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  it('renders image when direct uri is provided', async () => {
    const { getByTestId } = await renderWithTheme(
      <PhotoTile photoId="photo-1" uri="file:///test/direct.jpg" />
    );

    const img = getByTestId('photo-image-photo-1');
    expect(img.props.source).toEqual({ uri: 'file:///test/direct.jpg' });
  });

  it('resolves image uri via MediaLibrary and renders', async () => {
    const { getByTestId } = await renderWithTheme(<PhotoTile photoId="photo-1" />);

    await waitFor(() => {
      expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('photo-1');
      expect(getByTestId('photo-image-photo-1')).toBeTruthy();
    });
  });

  it('displays broken icon on asset loading failure', async () => {
    const { getByTestId } = await renderWithTheme(<PhotoTile photoId="broken-asset" />);

    await waitFor(() => {
      expect(getByTestId('photo-tile-broken-broken-asset')).toBeTruthy();
    });
  });

  it('shows selected border and check badge when selected is true', async () => {
    const { getByTestId } = await renderWithTheme(
      <PhotoTile photoId="photo-1" uri="file:///test/1.jpg" selected={true} />
    );

    expect(getByTestId('photo-tile-selected-photo-1')).toBeTruthy();
  });

  it('calls onPress when clicked', async () => {
    const onPressMock = jest.fn();
    const { getByTestId } = await renderWithTheme(
      <PhotoTile photoId="photo-1" uri="file:///test/1.jpg" onPress={onPressMock} />
    );

    await fireEvent.press(getByTestId('photo-tile-photo-1'));
    expect(onPressMock).toHaveBeenCalledTimes(1);
  });
});

describe('TripDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTripIdParam = 'trip-1';
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue({ ...sampleTrip });
    (photosRepo.getPhotosByTripId as jest.Mock).mockResolvedValue([...samplePhotos]);
    (purchasesService.useTripFreeTier as jest.Mock).mockReturnValue({
      status: {
        tripId: 'trip-1',
        scannedCount: 0,
        limit: 50,
        isPro: true,
        isGateEnabled: false,
        canScanMore: true,
        remainingFreeScans: Infinity,
        requiresPaywall: false,
      },
      isLoading: false,
      error: null,
      refresh: jest.fn(),
    });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  it('renders loading state initially while trip is loading', async () => {
    (tripsRepo.getTripById as jest.Mock).mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    const { getByTestId } = await renderWithTheme(<TripDetailScreen />);
    expect(getByTestId('trip-detail-loading')).toBeTruthy();
  });

  it('renders error state when trip does not exist', async () => {
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue(null);

    const { getByTestId, findByText } = await renderWithTheme(<TripDetailScreen />);
    expect(await findByText('Trip not found')).toBeTruthy();
    expect(getByTestId('trip-retry-button')).toBeTruthy();
  });

  it('renders trip details, date range, and 3-column photo grid', async () => {
    const { findByText, getByTestId } = await renderWithTheme(<TripDetailScreen />);

    expect(await findByText(sampleTrip.name)).toBeTruthy();
    expect(getByTestId('trip-photo-grid')).toBeTruthy();
    expect(getByTestId('trip-photo-photo-1')).toBeTruthy();
    expect(getByTestId('trip-photo-photo-2')).toBeTruthy();
    expect(getByTestId('trip-photo-photo-3')).toBeTruthy();
  });

  it('handles primary button for not_scanned: Scan faces', async () => {
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      scan_status: 'not_scanned',
    });

    const { findByText, getByTestId } = await renderWithTheme(<TripDetailScreen />);

    expect(await findByText('Scan faces')).toBeTruthy();
    await fireEvent.press(getByTestId('trip-primary-button'));
    expect(mockRouter.push).toHaveBeenCalledWith('/trip/trip-1/scan');
  });

  it('handles primary button for paused: Resume scan', async () => {
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      scan_status: 'paused',
    });

    const { findByText, getByTestId } = await renderWithTheme(<TripDetailScreen />);

    expect(await findByText('Resume scan')).toBeTruthy();
    await fireEvent.press(getByTestId('trip-primary-button'));
    expect(mockRouter.push).toHaveBeenCalledWith('/trip/trip-1/scan');
  });

  it('handles primary button for scanned: View people', async () => {
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      scan_status: 'scanned',
    });

    const { findByText, getByTestId } = await renderWithTheme(<TripDetailScreen />);

    expect(await findByText('View people')).toBeTruthy();
    await fireEvent.press(getByTestId('trip-primary-button'));
    expect(mockRouter.push).toHaveBeenCalledWith('/trip/trip-1/people');
  });

  it('displays free-tier gate banner when photo_count > 50 and not Pro', async () => {
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      photo_count: 85,
    });
    (purchasesService.useTripFreeTier as jest.Mock).mockReturnValue({
      status: {
        tripId: 'trip-1',
        scannedCount: 20,
        limit: 50,
        isPro: false,
        isGateEnabled: true,
        canScanMore: true,
        remainingFreeScans: 30,
        requiresPaywall: false,
      },
      isLoading: false,
      error: null,
      refresh: jest.fn(),
    });

    const { findByText, getByTestId } = await renderWithTheme(<TripDetailScreen />);

    expect(await findByText('Free scans first 50 photos. Unlock Pro.')).toBeTruthy();
    await fireEvent.press(getByTestId('free-limit-banner-action'));
    expect(mockRouter.push).toHaveBeenCalledWith('/paywall');
  });

  it('displays empty state when trip has 0 photos', async () => {
    (photosRepo.getPhotosByTripId as jest.Mock).mockResolvedValue([]);

    const { findByText, getByTestId } = await renderWithTheme(<TripDetailScreen />);

    expect(await findByText('No photos in this range')).toBeTruthy();
    expect(getByTestId('empty-photos-state')).toBeTruthy();
  });

  it('opens and closes overflow menu', async () => {
    const { getByTestId, queryByTestId, findByText } = await renderWithTheme(
      <TripDetailScreen />
    );

    await findByText(sampleTrip.name);
    await fireEvent.press(getByTestId('overflow-menu-button'));

    expect(getByTestId('menu-action-rename')).toBeTruthy();
    expect(getByTestId('menu-action-merge')).toBeTruthy();
    expect(getByTestId('menu-action-adjust-dates')).toBeTruthy();
    expect(getByTestId('menu-action-hide')).toBeTruthy();

    await fireEvent.press(getByTestId('overflow-menu-overlay'));
    expect(queryByTestId('menu-action-rename')).toBeNull();
  });

  it('renames trip via inline header tap or menu', async () => {
    (tripsRepo.updateTrip as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      name: 'Summer Vacation 2026',
      is_user_edited: 1,
    });

    const { getByTestId, findByText } = await renderWithTheme(<TripDetailScreen />);

    await findByText(sampleTrip.name);
    await fireEvent.press(getByTestId('trip-name-pressable'));

    expect(getByTestId('rename-input')).toBeTruthy();
    await act(async () => {
      fireEvent.changeText(getByTestId('rename-input'), 'Summer Vacation 2026');
    });
    await fireEvent.press(getByTestId('rename-save-button'));

    await waitFor(() => {
      expect(tripsRepo.updateTrip).toHaveBeenCalledWith('trip-1', {
        name: 'Summer Vacation 2026',
        is_user_edited: 1,
      });
    });
  });

  it('adjusts trip dates via adjust dates dialog', async () => {
    (tripService.adjustTripDates as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      start_at: 1792800000000,
      end_at: 1793000000000,
      photo_count: 5,
      is_user_edited: 1,
    });

    const { getByTestId, findByText } = await renderWithTheme(<TripDetailScreen />);

    await findByText(sampleTrip.name);
    await fireEvent.press(getByTestId('overflow-menu-button'));
    await fireEvent.press(getByTestId('menu-action-adjust-dates'));

    expect(getByTestId('start-date-input')).toBeTruthy();
    expect(getByTestId('end-date-input')).toBeTruthy();

    await act(async () => {
      fireEvent.changeText(getByTestId('start-date-input'), '2026-10-24');
      fireEvent.changeText(getByTestId('end-date-input'), '2026-10-26');
    });
    await fireEvent.press(getByTestId('adjust-dates-save-button'));

    await waitFor(() => {
      expect(tripService.adjustTripDates).toHaveBeenCalled();
    });
  });

  it('merges with another trip via merge modal', async () => {
    const candidateTrip: TripRow = {
      id: 'trip-2',
      name: 'Trip · Oct 25, 2026',
      start_at: 1792886400000,
      end_at: 1792972800000,
      photo_count: 10,
      cover_photo_id: 'photo-4',
      is_away: 0,
      is_hidden: 0,
      is_user_edited: 0,
      scan_status: 'not_scanned',
      scanned_count: 0,
      created_at: 1792886400000,
      updated_at: 1792886400000,
    };

    (tripsRepo.getAllTrips as jest.Mock).mockResolvedValue([sampleTrip, candidateTrip]);
    (tripsRepo.mergeTrips as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      photo_count: 13,
      name: 'Merged Trip',
    });

    const { getByTestId, findByText } = await renderWithTheme(<TripDetailScreen />);

    await findByText(sampleTrip.name);
    await fireEvent.press(getByTestId('overflow-menu-button'));
    await fireEvent.press(getByTestId('menu-action-merge'));

    expect(await findByText(candidateTrip.name)).toBeTruthy();
    await fireEvent.press(getByTestId(`merge-candidate-${candidateTrip.id}`));
    await fireEvent.press(getByTestId('merge-confirm-button'));

    await waitFor(() => {
      expect(tripsRepo.mergeTrips).toHaveBeenCalledWith('trip-1', 'trip-2');
    });
  });

  it('hides trip and navigates back to Home', async () => {
    (tripsRepo.updateTrip as jest.Mock).mockResolvedValue({
      ...sampleTrip,
      is_hidden: 1,
      is_user_edited: 1,
    });

    const { getByTestId, findByText } = await renderWithTheme(<TripDetailScreen />);

    await findByText(sampleTrip.name);
    await fireEvent.press(getByTestId('overflow-menu-button'));
    await fireEvent.press(getByTestId('menu-action-hide'));

    expect(await findByText('Hide this trip?')).toBeTruthy();
    await fireEvent.press(getByTestId('hide-confirm-button'));

    await waitFor(() => {
      expect(tripsRepo.updateTrip).toHaveBeenCalledWith('trip-1', {
        is_hidden: 1,
        is_user_edited: 1,
      });
      expect(mockRouter.back).toHaveBeenCalled();
    });
  });
});
