import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { createPerson, getPeopleByTripId, getPersonById, type PersonWithDetails } from '../src/db/repositories/people';
import type { TripRow, PersonRow } from '../src/db/types';
import { validatePersonName } from '../src/domain/assignment';
import { sanitizeFilename, buildExportZipFilename } from '../src/services/exporter';
import PersonDetailScreen from '../app/person/[id]';
import PeopleScreen from '../app/trip/[id]/people';
import { ThemeProvider } from '../src/theme';
import * as peopleRepo from '../src/db/repositories/people';
import * as tripsRepo from '../src/db/repositories/trips';
import * as facesRepo from '../src/db/repositories/faces';

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

let mockCurrentId = 'person-names-1';
let mockTripIdParam = 'trip-names-1';

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({
    id: mockCurrentId,
    tripId: mockTripIdParam,
  }),
}));

// Mock safe-area
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock expo-media-library
jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn().mockImplementation((id: string) =>
    Promise.resolve({
      id,
      uri: `file:///photos/${id}.jpg`,
      localUri: `file:///photos/${id}.jpg`,
    })
  ),
}));

describe('Task 4.7: Duplicate, Invalid, Long, and Emoji Person Names', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTripIdParam = 'trip-names-1';
    mockCurrentId = 'person-names-1';

    db = await openDb(':memory:');
    await runMigrations(db);
  });

  describe('1. Duplicate Names Validation & Database Integrity', () => {
    it('rejects exact and case-insensitive duplicate names within the same trip', () => {
      const existingNames = ['Rafi', 'Tania', 'Sakib'];

      // Exact duplicate
      const exact = validatePersonName('Rafi', existingNames);
      expect(exact.valid).toBe(false);
      expect(exact.error).toBe('Name already used in this trip');

      // Case-insensitive duplicate (lower / upper / mixed case)
      const lower = validatePersonName('rafi', existingNames);
      expect(lower.valid).toBe(false);
      expect(lower.error).toBe('Name already used in this trip');

      const upper = validatePersonName('TANIA', existingNames);
      expect(upper.valid).toBe(false);
      expect(upper.error).toBe('Name already used in this trip');

      // Untrimmed duplicate
      const padded = validatePersonName('   Sakib   ', existingNames);
      expect(padded.valid).toBe(false);
      expect(padded.error).toBe('Name already used in this trip');

      // Unique name in the same trip is valid
      const unique = validatePersonName('Farhan', existingNames);
      expect(unique.valid).toBe(true);
      expect(unique.trimmedName).toBe('Farhan');
    });

    it('allows identical names across different trips (people are scoped per trip)', async () => {
      const tripA = await createTrip({ id: 'trip-a', name: 'Trip A', start_at: 1000, end_at: 2000 }, db);
      const tripB = await createTrip({ id: 'trip-b', name: 'Trip B', start_at: 3000, end_at: 4000 }, db);

      // Create person named 'Rafi' in Trip A
      const personA = await createPerson({ id: 'p-a1', trip_id: tripA.id, name: 'Rafi' }, db);
      expect(personA.name).toBe('Rafi');

      // Create person named 'Rafi' in Trip B
      const personB = await createPerson({ id: 'p-b1', trip_id: tripB.id, name: 'Rafi' }, db);
      expect(personB.name).toBe('Rafi');

      // Both people exist with the same name in their respective trips
      const peopleA = await getPeopleByTripId(tripA.id, db);
      const peopleB = await getPeopleByTripId(tripB.id, db);
      expect(peopleA.some((p) => p.name === 'Rafi')).toBe(true);
      expect(peopleB.some((p) => p.name === 'Rafi')).toBe(true);
    });

    it('SQLite UNIQUE(trip_id, name) constraint blocks duplicate insertion at database layer', async () => {
      const trip = await createTrip({ id: 'trip-unique-db', name: 'DB Trip', start_at: 1000, end_at: 2000 }, db);

      await createPerson({ id: 'p-1', trip_id: trip.id, name: 'Tanvir' }, db);

      // Attempting to insert a duplicate name in the same trip throws SQLite constraint error
      await expect(
        createPerson({ id: 'p-2', trip_id: trip.id, name: 'Tanvir' }, db)
      ).rejects.toThrow();
    });

    it('allows keeping the same name when updating an existing person', () => {
      // When a person is named 'Rafi', otherNames excludes 'Rafi'
      const otherNames = ['Tania', 'Sakib'];
      const result = validatePersonName('Rafi', otherNames);
      expect(result.valid).toBe(true);
      expect(result.trimmedName).toBe('Rafi');
    });
  });

  describe('2. Invalid Characters, Empty Strings, and Control Characters', () => {
    it('rejects empty strings and whitespace-only strings', () => {
      expect(validatePersonName('').valid).toBe(false);
      expect(validatePersonName('').error).toBe('Name cannot be empty');

      expect(validatePersonName('   ').valid).toBe(false);
      expect(validatePersonName('   ').error).toBe('Name cannot be empty');

      expect(validatePersonName('\t  \n').valid).toBe(false);
      expect(validatePersonName('\t  \n').error).toBe('Name cannot be empty');
    });

    it('rejects forbidden filesystem characters (/, \\, :)', () => {
      const slash = validatePersonName('Rafi/Ahmed');
      expect(slash.valid).toBe(false);
      expect(slash.error).toBe('Name cannot contain /, \\, or :');

      const backslash = validatePersonName('C:\\Users\\Rafi');
      expect(backslash.valid).toBe(false);
      expect(backslash.error).toBe('Name cannot contain /, \\, or :');

      const colon = validatePersonName('Rafi:Special');
      expect(colon.valid).toBe(false);
      expect(colon.error).toBe('Name cannot contain /, \\, or :');
    });

    it('rejects control characters and embedded newlines', () => {
      const newline = validatePersonName('Rafi\nAhmed');
      expect(newline.valid).toBe(false);
      expect(newline.error).toBe('Name cannot contain control characters or newlines');

      const carriageReturn = validatePersonName('Rafi\rAhmed');
      expect(carriageReturn.valid).toBe(false);
      expect(carriageReturn.error).toBe('Name cannot contain control characters or newlines');

      const tab = validatePersonName('Rafi\tAhmed');
      expect(tab.valid).toBe(false);
      expect(tab.error).toBe('Name cannot contain control characters or newlines');

      const nullChar = validatePersonName('Rafi\u0000Ahmed');
      expect(nullChar.valid).toBe(false);
      expect(nullChar.error).toBe('Name cannot contain control characters or newlines');
    });

    it('sanitizeFilename cleans forbidden characters and falls back to Unnamed if all stripped', () => {
      // Strips / \ : * ? " < > |
      expect(sanitizeFilename('Rafi/Ahmed:*?"<>|')).toBe('RafiAhmed');

      // String with only illegal characters falls back to fallback
      expect(sanitizeFilename('///:::***???')).toBe('Unnamed');
      expect(sanitizeFilename('///:::***???', 'Person')).toBe('Person');

      // Valid filename creation for ZIP
      expect(buildExportZipFilename('Coxsbazar/Trip', 'Rafi:Ahmed')).toBe('CoxsbazarTrip_RafiAhmed.zip');
    });
  });

  describe('3. Name Length Boundaries (1 to 40 characters)', () => {
    it('accepts names with exactly 1 character and exactly 40 characters', () => {
      const singleChar = validatePersonName('A');
      expect(singleChar.valid).toBe(true);
      expect(singleChar.trimmedName).toBe('A');

      const exactly40 = 'A'.repeat(40);
      const res40 = validatePersonName(exactly40);
      expect(res40.valid).toBe(true);
      expect(res40.trimmedName).toBe(exactly40);
    });

    it('rejects names with 41 or more characters', () => {
      const tooLong41 = 'A'.repeat(41);
      const res41 = validatePersonName(tooLong41);
      expect(res41.valid).toBe(false);
      expect(res41.error).toBe('Name must be 40 characters or fewer');

      const tooLong100 = 'A'.repeat(100);
      const res100 = validatePersonName(tooLong100);
      expect(res100.valid).toBe(false);
      expect(res100.error).toBe('Name must be 40 characters or fewer');
    });

    it('trims leading and trailing spaces before measuring length', () => {
      const padded40 = '   ' + 'B'.repeat(40) + '   ';
      const res = validatePersonName(padded40);
      expect(res.valid).toBe(true);
      expect(res.trimmedName).toBe('B'.repeat(40));
    });

    it('sanitizeFilename caps names at 40 code points without corrupting Unicode surrogates', () => {
      const longName = 'C'.repeat(60);
      expect(sanitizeFilename(longName)).toBe('C'.repeat(40));

      // 39 characters + 1 emoji (2 code units, 1 code point)
      const emojiName = 'A'.repeat(39) + '🚀';
      const sanitized = sanitizeFilename(emojiName);
      expect(sanitized).toBe('A'.repeat(39) + '🚀');
      expect(Array.from(sanitized).length).toBe(40);
    });
  });

  describe('4. Emoji, Non-Latin, and Special Characters in Person Names', () => {
    it('accepts emoji-only names and mixed text+emoji names', () => {
      const emojiOnly = validatePersonName('👑');
      expect(emojiOnly.valid).toBe(true);
      expect(emojiOnly.trimmedName).toBe('👑');

      const emojiMultiple = validatePersonName('😎🚀🎉');
      expect(emojiMultiple.valid).toBe(true);
      expect(emojiMultiple.trimmedName).toBe('😎🚀🎉');

      const mixed = validatePersonName('Sakib 🚀');
      expect(mixed.valid).toBe(true);
      expect(mixed.trimmedName).toBe('Sakib 🚀');

      const decorated = validatePersonName('🌟 Star Player 🌟');
      expect(decorated.valid).toBe(true);
      expect(decorated.trimmedName).toBe('🌟 Star Player 🌟');
    });

    it('handles complex emojis with skin tones and zero-width joiners (ZWJ)', () => {
      const complexEmoji = validatePersonName('Sarah 👩🏽‍🦰');
      expect(complexEmoji.valid).toBe(true);
      expect(complexEmoji.trimmedName).toBe('Sarah 👩🏽‍🦰');

      const family = validatePersonName('Team 👨‍👩‍👧');
      expect(family.valid).toBe(true);
      expect(family.trimmedName).toBe('Team 👨‍👩‍👧');
    });

    it('accepts international and non-Latin character sets (Bangla, Japanese, Arabic, Accents)', () => {
      // Bangla
      const bangla = validatePersonName('রফিক আহমেদ');
      expect(bangla.valid).toBe(true);
      expect(bangla.trimmedName).toBe('রফিক আহমেদ');

      // Japanese
      const japanese = validatePersonName('田中 太郎');
      expect(japanese.valid).toBe(true);
      expect(japanese.trimmedName).toBe('田中 太郎');

      // Arabic
      const arabic = validatePersonName('عمر بن الخطاب');
      expect(arabic.valid).toBe(true);
      expect(arabic.trimmedName).toBe('عمر بن الخطاب');

      // European accents & punctuation
      const accented = validatePersonName("Jean-Luc O'Connor");
      expect(accented.valid).toBe(true);
      expect(accented.trimmedName).toBe("Jean-Luc O'Connor");
    });

    it('persists and retrieves emoji and international names in SQLite with full fidelity', async () => {
      const trip = await createTrip({ id: 'trip-emoji', name: 'Emoji Trip', start_at: 1000, end_at: 2000 }, db);

      const emojiPerson = await createPerson({ id: 'p-em-1', trip_id: trip.id, name: 'Sakib 🚀' }, db);
      const banglaPerson = await createPerson({ id: 'p-bn-1', trip_id: trip.id, name: 'রফিক 🌸' }, db);

      const retrievedEmoji = await getPersonById(emojiPerson.id, db);
      expect(retrievedEmoji?.name).toBe('Sakib 🚀');

      const retrievedBangla = await getPersonById(banglaPerson.id, db);
      expect(retrievedBangla?.name).toBe('রফিক 🌸');

      // Standard ZIP filenames keep emojis intact
      expect(buildExportZipFilename(trip.name, retrievedEmoji!.name!)).toBe('Emoji Trip_Sakib 🚀.zip');
      expect(buildExportZipFilename(trip.name, retrievedBangla!.name!)).toBe('Emoji Trip_রফিক 🌸.zip');
    });
  });

  describe('5. UI Validation in PersonDetailScreen and PeopleScreen', () => {
    it('PersonDetailScreen shows inline validation error for duplicate and invalid names', async () => {
      mockCurrentId = 'p-detail-test';

      const mockPerson: PersonRow = {
        id: 'p-detail-test',
        trip_id: 'trip-ui-test',
        name: 'Rafi',
        is_others: 0,
        cover_face_id: null,
        centroid: null,
        created_at: 1000,
      };

      const mockTrip: TripRow = {
        id: 'trip-ui-test',
        name: 'Sylhet Tour',
        start_at: 1000,
        end_at: 2000,
        photo_count: 5,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 5,
        created_at: 1000,
        updated_at: 1000,
      };

      const mockOtherPerson: PersonRow = {
        id: 'p-other-test',
        trip_id: 'trip-ui-test',
        name: 'Tania',
        is_others: 0,
        cover_face_id: null,
        centroid: null,
        created_at: 1000,
      };

      mockCurrentId = 'person-names-1';
      mockTripIdParam = 'trip-names-1';

      jest.spyOn(peopleRepo, 'getPersonById').mockResolvedValue(mockPerson);
      jest.spyOn(tripsRepo, 'getTripById').mockResolvedValue(mockTrip);
      jest.spyOn(peopleRepo, 'getPeopleByTripId').mockResolvedValue([mockPerson, mockOtherPerson]);
      jest.spyOn(peopleRepo, 'getPersonPhotosWithExclusions').mockResolvedValue([]);

      const screen = await render(
        <ThemeProvider>
          <PersonDetailScreen />
        </ThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('person-name-field')).toBeTruthy();
      });

      // 1. Duplicate name error ('Tania' already exists)
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('person-name-field'), 'Tania');
      });
      expect(screen.getByText('Name already used in this trip')).toBeTruthy();
      expect(screen.getByTestId('save-name-button').props.accessibilityState?.disabled).toBe(true);

      // 2. Case-insensitive duplicate error ('tania')
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('person-name-field'), '  tania  ');
      });
      expect(screen.getByText('Name already used in this trip')).toBeTruthy();

      // 3. Illegal character error ('/')
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('person-name-field'), 'Rafi/Ahmed');
      });
      expect(screen.getByText('Name cannot contain /, \\, or :')).toBeTruthy();

      // 4. Valid emoji name ('Rafi 🚀') -> error clears, save button enabled
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('person-name-field'), 'Rafi 🚀');
      });
      expect(screen.queryByText('Name already used in this trip')).toBeNull();
      expect(screen.queryByText('Name cannot contain /, \\, or :')).toBeNull();
      expect(screen.getByTestId('save-name-button').props.accessibilityState?.disabled).toBe(false);
    });

    it('PeopleScreen naming sheet validates duplicate, illegal, and emoji names', async () => {
      mockCurrentId = 'trip-people-sheet-test';
      mockTripIdParam = 'trip-people-sheet-test';

      const mockTrip: TripRow = {
        id: 'trip-people-sheet-test',
        name: 'Bandarban Tour',
        start_at: 1000,
        end_at: 2000,
        photo_count: 10,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 10,
        created_at: 1000,
        updated_at: 1000,
      };

      const mockNamedPerson: PersonWithDetails = {
        id: 'p-existing-1',
        trip_id: 'trip-people-sheet-test',
        name: 'Hassan',
        is_others: 0,
        cover_face_id: null,
        centroid: null,
        created_at: 1000,
        photo_count: 5,
        cover_photo_id: null,
        cover_bbox_x: null,
        cover_bbox_y: null,
        cover_bbox_w: null,
        cover_bbox_h: null,
      };

      const mockUnnamedPerson: PersonWithDetails = {
        id: 'p-unnamed-1',
        trip_id: 'trip-people-sheet-test',
        name: null,
        is_others: 0,
        cover_face_id: null,
        centroid: null,
        created_at: 1000,
        photo_count: 3,
        cover_photo_id: null,
        cover_bbox_x: null,
        cover_bbox_y: null,
        cover_bbox_w: null,
        cover_bbox_h: null,
      };

      jest.spyOn(tripsRepo, 'getTripById').mockResolvedValue(mockTrip);
      jest.spyOn(peopleRepo, 'getPeopleWithDetails').mockResolvedValue([mockNamedPerson, mockUnnamedPerson]);
      jest.spyOn(facesRepo, 'getClearestFacesForPerson').mockResolvedValue([]);

      const screen = await render(
        <ThemeProvider>
          <PeopleScreen />
        </ThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('person-bubble-p-unnamed-1')).toBeTruthy();
      });

      // Tap unnamed bubble to open naming sheet
      await act(async () => {
        fireEvent.press(screen.getByTestId('person-bubble-p-unnamed-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('naming-sheet')).toBeTruthy();
      });

      const nameInput = screen.getByTestId('person-name-input');

      // 1. Typing duplicate name ('Hassan') -> inline error
      await act(async () => {
        fireEvent.changeText(nameInput, 'hassan');
      });
      expect(screen.getByText('Name already used in this trip')).toBeTruthy();
      expect(screen.getByTestId('save-name-button').props.accessibilityState?.disabled).toBe(true);

      // 2. Typing invalid characters ('C:\\Users') -> inline error
      await act(async () => {
        fireEvent.changeText(nameInput, 'User\\Test');
      });
      expect(screen.getByText('Name cannot contain /, \\, or :')).toBeTruthy();

      // 3. Typing valid emoji name ('Hassan 🌟') -> error clears, save button enabled
      await act(async () => {
        fireEvent.changeText(nameInput, 'Kamal 🌟');
      });
      expect(screen.queryByText('Name already used in this trip')).toBeNull();
      expect(screen.queryByText('Name cannot contain /, \\, or :')).toBeNull();
      expect(screen.getByTestId('save-name-button').props.accessibilityState?.disabled).toBe(false);
    });
  });
});

