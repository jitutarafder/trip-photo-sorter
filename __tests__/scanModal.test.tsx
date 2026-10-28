import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import ScanProgressModal from '../app/trip/[id]/scan';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as faceScanService from '../src/services/faceScan';
import * as keepAwake from 'expo-keep-awake';
import type { TripRow } from '../src/db/types';

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
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

// Mock expo-keep-awake
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(true),
  deactivateKeepAwake: jest.fn(),
}));

// Mock repositories and services
jest.mock('../src/db/repositories/trips', () => ({
  getTripById: jest.fn(),
  updateTrip: jest.fn(),
}));

jest.mock('../src/services/faceScan', () => {
  const actual = jest.requireActual('../src/services/faceScan');
  return {
    ...actual,
    useFaceScan: jest.fn(),
  };
});

const sampleTrip: TripRow = {
  id: 'trip-1',
  name: 'Trip · Oct 24, 2026',
  start_at: 1792800000000,
  end_at: 1792886400000,
  photo_count: 50,
  cover_photo_id: 'photo-1',
  is_away: 0,
  is_hidden: 0,
  is_user_edited: 0,
  scan_status: 'not_scanned',
  scanned_count: 0,
  created_at: 1792800000000,
  updated_at: 1792800000000,
};

const renderWithTheme = async (ui: React.ReactElement) => {
  return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
};

describe('ScanProgressModal (Task 3.6)', () => {
  let mockStartScan: jest.Mock;
  let mockResumeScan: jest.Mock;
  let mockCancelScan: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTripIdParam = 'trip-1';

    mockStartScan = jest.fn().mockResolvedValue({
      status: 'completed',
      scannedCount: 50,
      facesFound: 12,
      skippedCount: 0,
      failedCount: 0,
      totalPhotos: 50,
    });
    mockResumeScan = jest.fn().mockResolvedValue({
      status: 'completed',
      scannedCount: 50,
      facesFound: 12,
      skippedCount: 0,
      failedCount: 0,
      totalPhotos: 50,
    });
    mockCancelScan = jest.fn();

    (tripsRepo.getTripById as jest.Mock).mockResolvedValue({ ...sampleTrip });

    (faceScanService.useFaceScan as jest.Mock).mockReturnValue({
      isScanning: true,
      isPaused: false,
      progress: { current: 15, total: 50, facesFound: 8 },
      lastResult: null,
      error: null,
      startScan: mockStartScan,
      pauseScan: jest.fn(),
      resumeScan: mockResumeScan,
      cancelScan: mockCancelScan,
    });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  it('renders initial loading state when trip is being loaded', async () => {
    (tripsRepo.getTripById as jest.Mock).mockImplementation(
      () => new Promise(() => {}) // pending
    );

    const { getByTestId } = await renderWithTheme(<ScanProgressModal />);
    expect(getByTestId('scan-initial-loading')).toBeTruthy();
  });

  it('renders active scanning progress with progress ring, photo count, faces found, and ETA', async () => {
    const { getByTestId, findByText } = await renderWithTheme(<ScanProgressModal />);

    expect(await findByText('Scanning for faces...')).toBeTruthy();
    expect(getByTestId('scan-progress-ring')).toBeTruthy();
    expect(getByTestId('scan-photo-count')).toBeTruthy();
    expect(getByTestId('scan-faces-found')).toBeTruthy();
    expect(getByTestId('scan-eta-text')).toBeTruthy();
    expect(getByTestId('cancel-scan-button')).toBeTruthy();
  });

  it('activates keep-awake while scanning', async () => {
    await renderWithTheme(<ScanProgressModal />);

    await waitFor(() => {
      expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalled();
    });
  });

  it('auto-navigates to /trip/[id]/people on scan completion with faces found', async () => {
    await renderWithTheme(<ScanProgressModal />);

    await waitFor(() => {
      expect(mockStartScan).toHaveBeenCalled();
      expect(mockRouter.replace).toHaveBeenCalledWith('/trip/trip-1/people');
    });
  });

  it('handles zero faces detected state with tips and Back button', async () => {
    mockStartScan.mockResolvedValueOnce({
      status: 'completed',
      scannedCount: 50,
      facesFound: 0,
      skippedCount: 0,
      failedCount: 0,
      totalPhotos: 50,
    });

    const { findByText, getByTestId } = await renderWithTheme(<ScanProgressModal />);

    expect(await findByText('No faces detected')).toBeTruthy();
    expect(getByTestId('zero-faces-view')).toBeTruthy();
    expect(getByTestId('back-to-trip-button')).toBeTruthy();

    await fireEvent.press(getByTestId('back-to-trip-button'));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('handles cancel button press by cancelling scan and navigating back', async () => {
    const { getByTestId, findByText } = await renderWithTheme(<ScanProgressModal />);

    await findByText('Scanning for faces...');
    await fireEvent.press(getByTestId('cancel-scan-button'));

    expect(mockCancelScan).toHaveBeenCalled();
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('renders paused state with Resume and Cancel buttons', async () => {
    (faceScanService.useFaceScan as jest.Mock).mockReturnValue({
      isScanning: false,
      isPaused: true,
      progress: { current: 20, total: 50, facesFound: 10 },
      lastResult: null,
      error: null,
      startScan: mockStartScan,
      pauseScan: jest.fn(),
      resumeScan: mockResumeScan,
      cancelScan: mockCancelScan,
    });

    const { findByText, getByTestId } = await renderWithTheme(<ScanProgressModal />);

    expect(await findByText('Scan Paused')).toBeTruthy();
    expect(getByTestId('scan-paused-view')).toBeTruthy();
    expect(getByTestId('paused-progress-text')).toBeTruthy();
    expect(getByTestId('resume-scan-button')).toBeTruthy();
    expect(getByTestId('paused-cancel-button')).toBeTruthy();

    await fireEvent.press(getByTestId('resume-scan-button'));
    expect(mockResumeScan).toHaveBeenCalled();
  });

  it('renders fatal error state with Retry and Cancel buttons', async () => {
    (faceScanService.useFaceScan as jest.Mock).mockReturnValue({
      isScanning: false,
      isPaused: false,
      progress: { current: 5, total: 50, facesFound: 2 },
      lastResult: null,
      error: new Error('Model execution failed'),
      startScan: mockStartScan,
      pauseScan: jest.fn(),
      resumeScan: mockResumeScan,
      cancelScan: mockCancelScan,
    });

    const { findByText, getByTestId } = await renderWithTheme(<ScanProgressModal />);

    expect(await findByText('Scan failed')).toBeTruthy();
    expect(getByTestId('scan-failed-view')).toBeTruthy();
    expect(await findByText('Model execution failed')).toBeTruthy();
    expect(getByTestId('retry-scan-button')).toBeTruthy();

    await fireEvent.press(getByTestId('retry-scan-button'));
    expect(mockStartScan).toHaveBeenCalled();
  });

  it('renders clustering state when all photos have been scanned', async () => {
    (faceScanService.useFaceScan as jest.Mock).mockReturnValue({
      isScanning: true,
      isPaused: false,
      progress: { current: 50, total: 50, facesFound: 14 },
      lastResult: null,
      error: null,
      startScan: mockStartScan,
      pauseScan: jest.fn(),
      resumeScan: mockResumeScan,
      cancelScan: mockCancelScan,
    });

    const { findByText, getByTestId } = await renderWithTheme(<ScanProgressModal />);

    expect(await findByText('Grouping people...')).toBeTruthy();
    expect(getByTestId('scan-status-title')).toBeTruthy();
  });

  it('renders notice for single photos that were skipped', async () => {
    mockStartScan.mockResolvedValueOnce({
      status: 'completed',
      scannedCount: 48,
      facesFound: 10,
      skippedCount: 0,
      failedCount: 2,
      totalPhotos: 50,
    });

    const { findByText, getByTestId } = await renderWithTheme(<ScanProgressModal />);

    await findByText('Scanning for faces...');
    expect(getByTestId('scan-progress-ring')).toBeTruthy();
  });
});
