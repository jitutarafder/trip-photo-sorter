import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import PersonDetailScreen from '../app/person/[id]';
import { ThemeProvider } from '../src/theme';
import * as peopleRepo from '../src/db/repositories/people';
import * as tripsRepo from '../src/db/repositories/trips';
import * as facesRepo from '../src/db/repositories/faces';
import * as manualEditsService from '../src/services/manualEdits';
import * as assignmentService from '../src/services/assignment';
import type { PersonRow, TripRow } from '../src/db/types';

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

let mockPersonIdParam = 'person-1';

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: mockPersonIdParam }),
}));

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock expo-media-library
jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn().mockImplementation((id: string) => {
    return Promise.resolve({
      id,
      uri: `file:///photos/${id}.jpg`,
      localUri: `file:///photos/${id}.jpg`,
    });
  }),
}));

// Mock repositories & services
jest.mock('../src/db/repositories/people', () => ({
  getPersonById: jest.fn(),
  getPeopleByTripId: jest.fn(),
  updatePerson: jest.fn(),
  getPersonPhotosWithExclusions: jest.fn(),
  excludePhotoFromPerson: jest.fn(),
  includePhotoForPerson: jest.fn(),
}));

jest.mock('../src/db/repositories/trips', () => ({
  getTripById: jest.fn(),
}));

jest.mock('../src/db/repositories/faces', () => ({
  getFaceIdsForPersonPhotos: jest.fn(),
}));

jest.mock('../src/services/manualEdits', () => ({
  moveFacesToPerson: jest.fn(),
  removeFacesFromPerson: jest.fn(),
  mergePeople: jest.fn(),
}));

jest.mock('../src/services/assignment', () => ({
  recomputePersonCentroid: jest.fn(),
}));

const mockTrip: TripRow = {
  id: 'trip-1',
  name: 'Sajek Tour',
  start_at: 1700000000000,
  end_at: 1700100000000,
  photo_count: 50,
  cover_photo_id: 'photo-1',
  is_away: 0,
  is_hidden: 0,
  is_user_edited: 0,
  scan_status: 'scanned',
  scanned_count: 50,
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

const mockPerson1: PersonRow = {
  id: 'person-1',
  trip_id: 'trip-1',
  name: 'Rafi',
  is_others: 0,
  cover_face_id: 'face-1',
  centroid: null,
  created_at: 1000,
};

const mockPersonOthers: PersonRow = {
  id: 'person-others',
  trip_id: 'trip-1',
  name: 'Others',
  is_others: 1,
  cover_face_id: null,
  centroid: null,
  created_at: 2000,
};

const mockOtherPeople: PersonRow[] = [
  mockPerson1,
  {
    id: 'person-2',
    trip_id: 'trip-1',
    name: 'Tania',
    is_others: 0,
    cover_face_id: 'face-2',
    centroid: null,
    created_at: 1500,
  },
  mockPersonOthers,
];

const mockPhotos: peopleRepo.PersonPhotoItem[] = [
  {
    id: 'photo-1',
    trip_id: 'trip-1',
    taken_at: 1700000100000,
    modified_at: 1700000100000,
    width: 3000,
    height: 2000,
    lat: null,
    lng: null,
    is_local: 1,
    scan_status: 'done',
    face_count: 1,
    excluded: 0,
    is_person_excluded: 0,
  },
  {
    id: 'photo-2',
    trip_id: 'trip-1',
    taken_at: 1700000200000,
    modified_at: 1700000200000,
    width: 3000,
    height: 2000,
    lat: null,
    lng: null,
    is_local: 1,
    scan_status: 'done',
    face_count: 2,
    excluded: 0,
    is_person_excluded: 1, // Excluded
  },
  {
    id: 'photo-3',
    trip_id: 'trip-1',
    taken_at: 1700000300000,
    modified_at: 1700000300000,
    width: 3000,
    height: 2000,
    lat: null,
    lng: null,
    is_local: 1,
    scan_status: 'done',
    face_count: 1,
    excluded: 0,
    is_person_excluded: 0,
  },
];

const renderWithTheme = async (ui: React.ReactElement) => {
  return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
};

describe('Phase 3 — Task 3.8: Person Detail Screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPersonIdParam = 'person-1';

    (peopleRepo.getPersonById as jest.Mock).mockResolvedValue(mockPerson1);
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue(mockTrip);
    (peopleRepo.getPersonPhotosWithExclusions as jest.Mock).mockResolvedValue(mockPhotos);
    (peopleRepo.getPeopleByTripId as jest.Mock).mockResolvedValue(mockOtherPeople);
    (facesRepo.getFaceIdsForPersonPhotos as jest.Mock).mockResolvedValue(['face-p1']);
  });

  afterEach(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  describe('Header, Navigation & Display', () => {
    it('renders person header with name, photo count, trip name, and back button', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('person-header')).toBeTruthy();
      });

      expect(getByText('Rafi')).toBeTruthy();
      expect(getByText('3 photos · Sajek Tour')).toBeTruthy();
      expect(getByTestId('back-button')).toBeTruthy();
      expect(getByTestId('merge-person-button')).toBeTruthy();
    });

    it('navigates back when Back button is pressed', async () => {
      const { getByTestId } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('back-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('back-button'));
      });

      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });

    it('renders photo grid with 3 photos and shows Excluded badge on excluded photo', async () => {
      const { getByTestId } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('photo-tile-photo-1')).toBeTruthy();
        expect(getByTestId('photo-tile-photo-2')).toBeTruthy();
        expect(getByTestId('photo-tile-photo-3')).toBeTruthy();
      });

      expect(getByTestId('photo-excluded-badge-photo-2')).toBeTruthy();
    });

    it('renders empty error state when person is not found', async () => {
      (peopleRepo.getPersonById as jest.Mock).mockResolvedValueOnce(null);

      const { getByTestId, getByText } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('person-error-state')).toBeTruthy();
      });

      expect(getByText('Person Not Found')).toBeTruthy();
    });

    it('renders Others view with name editing hidden', async () => {
      (peopleRepo.getPersonById as jest.Mock).mockResolvedValueOnce(mockPersonOthers);

      const { getByTestId, queryByTestId, getByText } = await renderWithTheme(
        <PersonDetailScreen />
      );

      await waitFor(() => {
        expect(getByTestId('person-header')).toBeTruthy();
      });

      expect(getByText('Others')).toBeTruthy();
      expect(queryByTestId('person-name-field')).toBeNull();
      expect(queryByTestId('merge-person-button')).toBeNull();
    });
  });

  describe('Name Validation & Updating', () => {
    it('shows inline validation error when typing duplicate name or illegal chars', async () => {
      const { getByTestId, getByText, queryByText } = await renderWithTheme(
        <PersonDetailScreen />
      );

      await waitFor(() => {
        expect(getByTestId('person-name-field')).toBeTruthy();
      });

      // Duplicate name: 'Tania' already exists in trip
      await act(async () => {
        fireEvent.changeText(getByTestId('person-name-field'), 'Tania');
      });
      expect(getByText('Name already used in this trip')).toBeTruthy();

      // Illegal character: '/'
      await act(async () => {
        fireEvent.changeText(getByTestId('person-name-field'), 'Rafi/Test');
      });
      expect(getByText('Name cannot contain /, \\, or :')).toBeTruthy();

      // Valid name: error clears
      await act(async () => {
        fireEvent.changeText(getByTestId('person-name-field'), 'Rafi Ahmed');
      });
      expect(queryByText('Name already used in this trip')).toBeNull();
    });

    it('saves updated name and recomputes centroid on Save press', async () => {
      (peopleRepo.updatePerson as jest.Mock).mockResolvedValueOnce({
        ...mockPerson1,
        name: 'Rafi Ahmed',
      });

      const { getByTestId, getByText } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('person-name-field')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.changeText(getByTestId('person-name-field'), 'Rafi Ahmed');
      });

      await act(async () => {
        fireEvent.press(getByTestId('save-name-button'));
      });

      await waitFor(() => {
        expect(peopleRepo.updatePerson).toHaveBeenCalledWith('person-1', {
          name: 'Rafi Ahmed',
        });
        expect(assignmentService.recomputePersonCentroid).toHaveBeenCalledWith('person-1');
      });

      await waitFor(() => {
        expect(getByTestId('feedback-banner')).toBeTruthy();
        expect(getByText('Name updated to "Rafi Ahmed"')).toBeTruthy();
      });
    });
  });

  describe('Multi-Select & Batch Actions', () => {
    it('toggles photo selection and shows selection action bar', async () => {
      const { getByTestId, getByText, queryByTestId } = await renderWithTheme(
        <PersonDetailScreen />
      );

      await waitFor(() => {
        expect(getByTestId('photo-tile-photo-1')).toBeTruthy();
      });

      expect(queryByTestId('multi-select-bar')).toBeNull();

      // Tap photo 1
      await act(async () => {
        fireEvent.press(getByTestId('photo-tile-photo-1'));
      });

      expect(getByTestId('multi-select-bar')).toBeTruthy();
      expect(getByText('1 selected')).toBeTruthy();

      // Tap photo 3
      await act(async () => {
        fireEvent.press(getByTestId('photo-tile-photo-3'));
      });

      expect(getByText('2 selected')).toBeTruthy();

      // Clear selection button
      await act(async () => {
        fireEvent.press(getByTestId('clear-selection-button'));
      });

      expect(queryByTestId('multi-select-bar')).toBeNull();
    });

    it('selects and deselects all photos via Select All button', async () => {
      const { getByTestId, getByText, queryByTestId } = await renderWithTheme(
        <PersonDetailScreen />
      );

      await waitFor(() => {
        expect(getByTestId('photo-tile-photo-1')).toBeTruthy();
      });

      // Tap photo 1 to show selection bar
      await act(async () => {
        fireEvent.press(getByTestId('photo-tile-photo-1'));
      });

      // Press Select All
      await act(async () => {
        fireEvent.press(getByTestId('select-all-button'));
      });

      expect(getByText('3 selected')).toBeTruthy();

      // Press Deselect All
      await act(async () => {
        fireEvent.press(getByTestId('select-all-button'));
      });

      expect(queryByTestId('multi-select-bar')).toBeNull();
    });

    it('moves selected photos to another person via Move modal', async () => {
      (manualEditsService.moveFacesToPerson as jest.Mock).mockResolvedValueOnce({
        movedCount: 1,
        targetPerson: mockOtherPeople[1], // Tania
        affectedPersonIds: ['person-1'],
      });

      const { getByTestId, getByText } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('photo-tile-photo-1')).toBeTruthy();
      });

      // Select photo 1
      await act(async () => {
        fireEvent.press(getByTestId('photo-tile-photo-1'));
      });

      // Tap Move…
      await act(async () => {
        fireEvent.press(getByTestId('move-selected-button'));
      });

      await waitFor(() => {
        expect(getByTestId('move-modal')).toBeTruthy();
        expect(getByTestId('move-target-person-2')).toBeTruthy();
      });

      // Pick Tania
      await act(async () => {
        fireEvent.press(getByTestId('move-target-person-2'));
      });

      await waitFor(() => {
        expect(facesRepo.getFaceIdsForPersonPhotos).toHaveBeenCalledWith('person-1', ['photo-1']);
        expect(manualEditsService.moveFacesToPerson).toHaveBeenCalledWith(['face-p1'], 'person-2');
      });

      await waitFor(() => {
        expect(getByText('Moved 1 faces to Tania')).toBeTruthy();
      });
    });

    it('removes selected photos to Others bucket', async () => {
      (manualEditsService.removeFacesFromPerson as jest.Mock).mockResolvedValueOnce({
        removedCount: 1,
        othersPerson: mockPersonOthers,
        affectedPersonIds: ['person-1'],
      });

      const { getByTestId, getByText } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('photo-tile-photo-1')).toBeTruthy();
      });

      // Select photo 1
      await act(async () => {
        fireEvent.press(getByTestId('photo-tile-photo-1'));
      });

      // Tap Remove
      await act(async () => {
        fireEvent.press(getByTestId('remove-selected-button'));
      });

      await waitFor(() => {
        expect(facesRepo.getFaceIdsForPersonPhotos).toHaveBeenCalledWith('person-1', ['photo-1']);
        expect(manualEditsService.removeFacesFromPerson).toHaveBeenCalledWith(['face-p1'], 'trip-1');
      });

      await waitFor(() => {
        expect(getByText('Removed 1 faces to Others')).toBeTruthy();
      });
    });

    it('excludes selected photos from export when not currently excluded', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('photo-tile-photo-1')).toBeTruthy();
      });

      // Select photo 1 (is_person_excluded: 0)
      await act(async () => {
        fireEvent.press(getByTestId('photo-tile-photo-1'));
      });

      expect(getByText('Exclude')).toBeTruthy();

      await act(async () => {
        fireEvent.press(getByTestId('exclude-selected-button'));
      });

      await waitFor(() => {
        expect(peopleRepo.excludePhotoFromPerson).toHaveBeenCalledWith('person-1', 'photo-1');
        expect(getByText('Excluded 1 photos from export')).toBeTruthy();
      });
    });

    it('includes selected photos in export when currently excluded', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('photo-tile-photo-2')).toBeTruthy();
      });

      // Select photo 2 only (is_person_excluded: 1)
      await act(async () => {
        fireEvent.press(getByTestId('photo-tile-photo-2'));
      });

      expect(getByText('Include')).toBeTruthy();

      await act(async () => {
        fireEvent.press(getByTestId('exclude-selected-button'));
      });

      await waitFor(() => {
        expect(peopleRepo.includePhotoForPerson).toHaveBeenCalledWith('person-1', 'photo-2');
        expect(getByText('Included 1 photos in export')).toBeTruthy();
      });
    });
  });

  describe('Merge Whole Person Flow', () => {
    it('opens merge modal and merges current person into target person', async () => {
      (manualEditsService.mergePeople as jest.Mock).mockResolvedValueOnce({
        targetPerson: mockOtherPeople[1], // Tania
        mergedFacesCount: 3,
      });

      const { getByTestId } = await renderWithTheme(<PersonDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('merge-person-button')).toBeTruthy();
      });

      // Tap Merge into…
      await act(async () => {
        fireEvent.press(getByTestId('merge-person-button'));
      });

      await waitFor(() => {
        expect(getByTestId('merge-modal')).toBeTruthy();
        expect(getByTestId('merge-target-person-2')).toBeTruthy();
      });

      // Tap target Tania
      await act(async () => {
        fireEvent.press(getByTestId('merge-target-person-2'));
      });

      await waitFor(() => {
        expect(manualEditsService.mergePeople).toHaveBeenCalledWith('person-2', 'person-1');
        expect(mockRouter.replace).toHaveBeenCalledWith({
          pathname: '/person/[id]',
          params: { id: 'person-2' },
        });
      });
    });
  });
});
