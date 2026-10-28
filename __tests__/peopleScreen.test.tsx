import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import PeopleScreen from '../app/trip/[id]/people';
import { PersonBubble } from '../src/components/people/PersonBubble';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as peopleRepo from '../src/db/repositories/people';
import * as facesRepo from '../src/db/repositories/faces';
import * as assignmentService from '../src/services/assignment';
import * as manualEditsService from '../src/services/manualEdits';
import * as faceThumbnailService from '../src/services/faceThumbnail';
import type { TripRow, FaceRow } from '../src/db/types';

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
      width: 1000,
      height: 1000,
    });
  }),
}));

// Mock expo-image-manipulator
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({
    uri: 'file:///cache/cropped_face.jpg',
  }),
  SaveFormat: {
    JPEG: 'jpeg',
  },
}));

// Mock repositories & services
jest.mock('../src/db/repositories/trips', () => ({
  getTripById: jest.fn(),
}));

jest.mock('../src/db/repositories/people', () => ({
  getPeopleWithDetails: jest.fn(),
}));

jest.mock('../src/db/repositories/faces', () => ({
  getClearestFacesForPerson: jest.fn(),
}));

jest.mock('../src/services/assignment', () => ({
  nameAndAssignPerson: jest.fn(),
}));

jest.mock('../src/services/manualEdits', () => ({
  mergePeople: jest.fn(),
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

const mockPeople: peopleRepo.PersonWithDetails[] = [
  {
    id: 'person-1',
    trip_id: 'trip-1',
    name: 'Rafi',
    is_others: 0,
    cover_face_id: 'face-1',
    centroid: null,
    created_at: 1000,
    photo_count: 24,
    cover_photo_id: 'photo-1',
    cover_bbox_x: 0.2,
    cover_bbox_y: 0.2,
    cover_bbox_w: 0.3,
    cover_bbox_h: 0.3,
  },
  {
    id: 'person-2',
    trip_id: 'trip-1',
    name: null, // Unnamed
    is_others: 0,
    cover_face_id: 'face-2',
    centroid: null,
    created_at: 2000,
    photo_count: 15,
    cover_photo_id: 'photo-2',
    cover_bbox_x: 0.3,
    cover_bbox_y: 0.3,
    cover_bbox_w: 0.25,
    cover_bbox_h: 0.25,
  },
  {
    id: 'person-3',
    trip_id: 'trip-1',
    name: null, // Unnamed 2
    is_others: 0,
    cover_face_id: 'face-3',
    centroid: null,
    created_at: 3000,
    photo_count: 8,
    cover_photo_id: 'photo-3',
    cover_bbox_x: 0.4,
    cover_bbox_y: 0.4,
    cover_bbox_w: 0.2,
    cover_bbox_h: 0.2,
  },
  {
    id: 'person-others',
    trip_id: 'trip-1',
    name: 'Others',
    is_others: 1,
    cover_face_id: null,
    centroid: null,
    created_at: 4000,
    photo_count: 3,
    cover_photo_id: null,
    cover_bbox_x: null,
    cover_bbox_y: null,
    cover_bbox_w: null,
    cover_bbox_h: null,
  },
];

const mockFaces: FaceRow[] = [
  {
    id: 'face-2a',
    photo_id: 'photo-2',
    person_id: 'person-2',
    assignment: 'auto',
    bbox_x: 0.3,
    bbox_y: 0.3,
    bbox_w: 0.2,
    bbox_h: 0.2,
    quality: 0.95,
    quality_ok: 1,
    blur: 65,
    embedding: new Uint8Array(128),
  },
  {
    id: 'face-2b',
    photo_id: 'photo-5',
    person_id: 'person-2',
    assignment: 'auto',
    bbox_x: 0.4,
    bbox_y: 0.4,
    bbox_w: 0.2,
    bbox_h: 0.2,
    quality: 0.88,
    quality_ok: 1,
    blur: 52,
    embedding: new Uint8Array(128),
  },
];

const renderWithTheme = async (ui: React.ReactElement) => {
  return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
};

describe('Phase 3 — Task 3.7: People Screen & Naming Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    faceThumbnailService.clearFaceThumbnailCache();
    mockTripIdParam = 'trip-1';
    (tripsRepo.getTripById as jest.Mock).mockResolvedValue(mockTrip);
    (peopleRepo.getPeopleWithDetails as jest.Mock).mockResolvedValue(mockPeople);
    (facesRepo.getClearestFacesForPerson as jest.Mock).mockResolvedValue(mockFaces);
  });

  afterEach(async () => {
    // Flush microtasks
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  describe('PersonBubble Component', () => {
    it('renders named person with correct name and photo count badge', async () => {
      const onPress = jest.fn();
      const { getByTestId, getByText } = await renderWithTheme(
        <PersonBubble
          person={mockPeople[0]}
          onPress={onPress}
        />
      );

      expect(getByText('Rafi')).toBeTruthy();
      expect(getByText('24')).toBeTruthy();

      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-1'));
      });
      expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('renders unnamed person with Unnamed text and dashed avatar styling', async () => {
      const { getByTestId, getByText } = await renderWithTheme(
        <PersonBubble
          person={mockPeople[1]}
        />
      );

      expect(getByText('Unnamed')).toBeTruthy();
      expect(getByText('15')).toBeTruthy();
      const avatar = getByTestId('person-bubble-person-2-avatar');
      expect(avatar.props.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            borderStyle: 'dashed',
          }),
        ])
      );
    });

    it('renders Others person with Others label, count badge, and icon', async () => {
      const { getByTestId, getByText } = await renderWithTheme(
        <PersonBubble
          person={mockPeople[3]}
        />
      );

      expect(getByText('Others')).toBeTruthy();
      expect(getByText('3')).toBeTruthy();
      expect(getByTestId('person-bubble-person-others')).toBeTruthy();
    });

    it('renders selected state in merge mode with checkmark badge', async () => {
      const { getByTestId } = await renderWithTheme(
        <PersonBubble
          person={mockPeople[0]}
          selected={true}
          isMergeMode={true}
        />
      );

      expect(getByTestId('person-bubble-person-1-selected-badge')).toBeTruthy();
    });

    it('triggers onLongPress callback when long-pressed', async () => {
      const onLongPress = jest.fn();
      const { getByTestId } = await renderWithTheme(
        <PersonBubble
          person={mockPeople[0]}
          onLongPress={onLongPress}
        />
      );

      await act(async () => {
        fireEvent(getByTestId('person-bubble-person-1'), 'longPress');
      });
      expect(onLongPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('PeopleScreen Grid & Header', () => {
    it('renders header with trip name, member count, and action buttons', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByText('Sajek Tour — People')).toBeTruthy();
      });

      expect(getByText('1 named · 4 detected')).toBeTruthy();
      expect(getByTestId('back-button')).toBeTruthy();
      expect(getByTestId('export-button')).toBeTruthy();
      expect(getByTestId('enter-merge-button')).toBeTruthy();
    });

    it('navigates back when back button is pressed', async () => {
      const { getByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('back-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('back-button'));
      });
      expect(mockRouter.back).toHaveBeenCalled();
    });

    it('navigates to /export/[tripId] when Export button is pressed', async () => {
      const { getByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('export-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('export-button'));
      });

      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/export/[tripId]',
        params: { tripId: 'trip-1' },
      });
    });

    it('renders all people in plain grid sorted with Others last', async () => {
      const { getByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('people-grid')).toBeTruthy();
      });

      expect(getByTestId('person-bubble-person-1')).toBeTruthy();
      expect(getByTestId('person-bubble-person-2')).toBeTruthy();
      expect(getByTestId('person-bubble-person-3')).toBeTruthy();
      expect(getByTestId('person-bubble-person-others')).toBeTruthy();
    });

    it('renders empty state when no people exist', async () => {
      (peopleRepo.getPeopleWithDetails as jest.Mock).mockResolvedValueOnce([]);

      const { getByTestId, getByText } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('people-empty-state')).toBeTruthy();
      });

      expect(getByText('No faces detected')).toBeTruthy();
    });

    it('navigates to /person/[id] when a named person is tapped', async () => {
      const { getByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-1')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-1'));
      });

      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/person/[id]',
        params: { id: 'person-1' },
      });
    });

    it('navigates to /person/[id] when Others is tapped', async () => {
      const { getByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-others')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-others'));
      });

      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/person/[id]',
        params: { id: 'person-others' },
      });
    });
  });

  describe('Naming Flow Sheet & Face Re-assignment', () => {
    it('opens naming sheet when an unnamed person is tapped', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-2')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-2'));
      });

      await waitFor(() => {
        expect(getByTestId('naming-sheet')).toBeTruthy();
        expect(getByText('Name Person')).toBeTruthy();
      });

      expect(facesRepo.getClearestFacesForPerson).toHaveBeenCalledWith('person-2', 8);
      expect(getByTestId('face-choice-face-2a')).toBeTruthy();
      expect(getByTestId('face-choice-face-2b')).toBeTruthy();
    });

    it('allows picking a representative clear face crop', async () => {
      const { getByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-2')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-2'));
      });

      await waitFor(() => {
        expect(getByTestId('face-choice-face-2b')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('face-choice-face-2b'));
      });
    });

    it('shows validation errors for invalid or duplicate names', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-2')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-2'));
      });

      await waitFor(() => {
        expect(getByTestId('person-name-input')).toBeTruthy();
      });

      // Duplicate name: 'Rafi' already exists
      await act(async () => {
        fireEvent.changeText(getByTestId('person-name-input'), 'Rafi');
      });
      expect(getByText('Name already used in this trip')).toBeTruthy();

      // Illegal characters: / \ :
      await act(async () => {
        fireEvent.changeText(getByTestId('person-name-input'), 'Alex/Sam');
      });
      expect(getByText('Name cannot contain /, \\, or :')).toBeTruthy();
    });

    it('calls nameAndAssignPerson on submit and displays "+n photos added to {Name}" toast', async () => {
      (assignmentService.nameAndAssignPerson as jest.Mock).mockResolvedValueOnce({
        person: {
          ...mockPeople[1],
          name: 'Tania',
        },
        centroid: new Float32Array([0.1, 0.2]),
        addedToThisPersonCount: 7,
        totalReassigned: 7,
        totalFacesInPerson: 22,
      });

      const { getByTestId, getByText } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-2')).toBeTruthy();
      });

      // Tap unnamed person to open naming sheet
      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-2'));
      });

      await waitFor(() => {
        expect(getByTestId('person-name-input')).toBeTruthy();
      });

      // Type valid name
      await act(async () => {
        fireEvent.changeText(getByTestId('person-name-input'), 'Tania');
      });

      // Tap Save & Assign
      await act(async () => {
        fireEvent.press(getByTestId('save-name-button'));
      });

      await waitFor(() => {
        expect(assignmentService.nameAndAssignPerson).toHaveBeenCalledWith(
          'trip-1',
          'person-2',
          'Tania',
          expect.objectContaining({
            pickedFaceId: 'face-2a',
          })
        );
      });

      // Verify feedback banner shows "+7 photos added to Tania"
      await waitFor(() => {
        expect(getByTestId('feedback-banner')).toBeTruthy();
        expect(getByText('+7 photos added to Tania')).toBeTruthy();
      });
    });

    it('closes naming sheet when close button is pressed without saving', async () => {
      const { getByTestId, queryByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-2')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-2'));
      });

      await waitFor(() => {
        expect(getByTestId('close-naming-sheet-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('close-naming-sheet-button'));
      });

      await waitFor(() => {
        expect(queryByTestId('naming-sheet')).toBeNull();
      });
      expect(assignmentService.nameAndAssignPerson).not.toHaveBeenCalled();
    });
  });

  describe('Merge Mode', () => {
    it('enters merge mode via long press and allows selecting 2 people', async () => {
      const { getByTestId, getByText } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('person-bubble-person-2')).toBeTruthy();
      });

      // Long press person-2
      await act(async () => {
        fireEvent(getByTestId('person-bubble-person-2'), 'longPress');
      });

      // Mode banner appears
      expect(getByTestId('merge-instructions-banner')).toBeTruthy();
      expect(getByTestId('cancel-merge-button')).toBeTruthy();
      expect(getByTestId('confirm-merge-button')).toBeTruthy();

      // Person 2 is selected
      expect(getByTestId('person-bubble-person-2-selected-badge')).toBeTruthy();

      // Select Person 3
      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-3'));
      });

      expect(getByTestId('person-bubble-person-3-selected-badge')).toBeTruthy();
      expect(getByText('Merge (2)')).toBeTruthy();
    });

    it('merges 2 selected people when Merge is pressed', async () => {
      (manualEditsService.mergePeople as jest.Mock).mockResolvedValueOnce({
        targetPerson: mockPeople[0],
        mergedFacesCount: 15,
      });

      const { getByTestId, getByText } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('enter-merge-button')).toBeTruthy();
      });

      // Enter merge mode via button
      await act(async () => {
        fireEvent.press(getByTestId('enter-merge-button'));
      });

      // Select person-1 and person-2
      await act(async () => {
        fireEvent.press(getByTestId('person-bubble-person-1'));
        fireEvent.press(getByTestId('person-bubble-person-2'));
      });

      // Press Merge
      await act(async () => {
        fireEvent.press(getByTestId('confirm-merge-button'));
      });

      await waitFor(() => {
        expect(manualEditsService.mergePeople).toHaveBeenCalledWith(
          'person-1',
          'person-2'
        );
      });

      // Mode exits and feedback shows
      await waitFor(() => {
        expect(getByText('Merged into Rafi')).toBeTruthy();
      });
    });

    it('exits merge mode when Cancel is pressed', async () => {
      const { getByTestId, queryByTestId } = await renderWithTheme(<PeopleScreen />);

      await waitFor(() => {
        expect(getByTestId('enter-merge-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId('enter-merge-button'));
      });

      expect(getByTestId('cancel-merge-button')).toBeTruthy();

      await act(async () => {
        fireEvent.press(getByTestId('cancel-merge-button'));
      });

      expect(queryByTestId('cancel-merge-button')).toBeNull();
      expect(queryByTestId('merge-instructions-banner')).toBeNull();
    });
  });
});
