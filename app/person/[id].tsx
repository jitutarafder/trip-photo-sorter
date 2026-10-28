import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import {
  ArrowLeft,
  Users,
  UserMinus,
  ArrowRightLeft,
  EyeOff,
  Eye,
  GitMerge,
  X,
  CheckSquare,
  Square,
} from 'lucide-react-native';
import { useTheme } from '../../src/hooks/useTheme';
import {
  getPersonById,
  getPeopleByTripId,
  updatePerson,
  getPersonPhotosWithExclusions,
  excludePhotoFromPerson,
  includePhotoForPerson,
  type PersonPhotoItem,
} from '../../src/db/repositories/people';
import { getTripById } from '../../src/db/repositories/trips';
import { getFaceIdsForPersonPhotos } from '../../src/db/repositories/faces';
import type { PersonRow, TripRow } from '../../src/db/types';
import { PhotoTile } from '../../src/components/photos/PhotoTile';
import { Button, TextField, Banner, EmptyState } from '../../src/components/ui';
import { validatePersonName } from '../../src/domain/assignment';
import { recomputePersonCentroid } from '../../src/services/assignment';
import {
  moveFacesToPerson,
  removeFacesFromPerson,
  mergePeople,
} from '../../src/services/manualEdits';

export default function PersonDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, tokens } = useTheme();
  const { width: windowWidth } = useWindowDimensions();

  const [person, setPerson] = useState<PersonRow | null>(null);
  const [trip, setTrip] = useState<TripRow | null>(null);
  const [photos, setPhotos] = useState<PersonPhotoItem[]>([]);
  const [otherPeople, setOtherPeople] = useState<PersonRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Editable Name state
  const [nameInput, setNameInput] = useState<string>('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSavingName, setIsSavingName] = useState<boolean>(false);

  // Multi-select state
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const isSelectMode = selectedPhotoIds.size > 0;

  // Move To Modal state
  const [isMoveModalOpen, setIsMoveModalOpen] = useState<boolean>(false);

  // Merge Whole Person Modal state
  const [isMergeModalOpen, setIsMergeModalOpen] = useState<boolean>(false);

  // Toast / Feedback message
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  // Grid calculation: 3 columns, 2px gap, 16px screen padding
  const numColumns = 3;
  const itemSize = useMemo(() => {
    const totalPadding = 32; // 16px on each side
    const totalGaps = (numColumns - 1) * 2;
    return Math.floor((windowWidth - totalPadding - totalGaps) / numColumns);
  }, [windowWidth]);

  // Load data
  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const personData = await getPersonById(id);
      if (!personData) {
        setError('Person not found');
        setIsLoading(false);
        return;
      }

      setPerson(personData);
      setNameInput(personData.name || '');

      const [tripData, photosData, tripPeople] = await Promise.all([
        getTripById(personData.trip_id),
        getPersonPhotosWithExclusions(id),
        getPeopleByTripId(personData.trip_id),
      ]);

      setTrip(tripData);
      setPhotos(photosData);
      setOtherPeople(tripPeople.filter((p) => p.id !== id && !p.is_others));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load person';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Existing names in trip for uniqueness check
  const otherNames = useMemo(() => {
    return otherPeople.map((p) => p.name);
  }, [otherPeople]);

  // Name input change handler
  const handleNameChange = (text: string) => {
    setNameInput(text);
    if (text.trim().length > 0) {
      const result = validatePersonName(text, otherNames);
      setNameError(result.valid ? null : result.error ?? 'Invalid name');
    } else {
      setNameError(null);
    }
  };

  // Save Name handler
  const handleSaveName = async () => {
    if (!person || person.is_others) return;
    const trimmed = nameInput.trim();
    if (trimmed === (person.name || '')) {
      setNameError(null);
      return;
    }

    const validation = validatePersonName(trimmed, otherNames);
    if (!validation.valid) {
      setNameError(validation.error ?? 'Invalid name');
      return;
    }

    try {
      setIsSavingName(true);
      await updatePerson(person.id, { name: validation.trimmedName });
      await recomputePersonCentroid(person.id);
      setPerson((prev) => prev ? { ...prev, name: validation.trimmedName } : null);
      setNameError(null);
      setFeedbackMessage(`Name updated to "${validation.trimmedName}"`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save name';
      setNameError(msg);
    } finally {
      setIsSavingName(false);
    }
  };

  // Toggle single photo selection
  const handleTogglePhoto = (photoId: string) => {
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
  };

  // Select all / deselect all
  const handleSelectAllToggle = () => {
    if (selectedPhotoIds.size === photos.length) {
      setSelectedPhotoIds(new Set());
    } else {
      setSelectedPhotoIds(new Set(photos.map((p) => p.id)));
    }
  };

  // Move selected photos to target person
  const handleMoveToTarget = async (targetPersonId: string) => {
    if (!person || selectedPhotoIds.size === 0) return;
    const selectedArray = Array.from(selectedPhotoIds);

    try {
      const faceIds = await getFaceIdsForPersonPhotos(person.id, selectedArray);
      const res = await moveFacesToPerson(faceIds, targetPersonId);

      setIsMoveModalOpen(false);
      setSelectedPhotoIds(new Set());
      await loadData();
      setFeedbackMessage(`Moved ${res.movedCount} faces to ${res.targetPerson.name || 'person'}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to move photos';
      setFeedbackMessage(msg);
    }
  };

  // Remove selected photos to "Others"
  const handleRemoveToOthers = async () => {
    if (!person || selectedPhotoIds.size === 0) return;
    const selectedArray = Array.from(selectedPhotoIds);

    try {
      const faceIds = await getFaceIdsForPersonPhotos(person.id, selectedArray);
      const res = await removeFacesFromPerson(faceIds, person.trip_id);

      setSelectedPhotoIds(new Set());
      await loadData();
      setFeedbackMessage(`Removed ${res.removedCount} faces to Others`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to remove photos';
      setFeedbackMessage(msg);
    }
  };

  // Exclude / Include selected photos for this person
  const handleToggleExclude = async () => {
    if (!person || selectedPhotoIds.size === 0) return;
    const selectedArray = Array.from(selectedPhotoIds);
    const selectedPhotos = photos.filter((p) => selectedPhotoIds.has(p.id));

    // If any selected is not excluded -> exclude all; otherwise include all
    const shouldExclude = selectedPhotos.some((p) => p.is_person_excluded === 0);

    try {
      if (shouldExclude) {
        for (const pid of selectedArray) {
          await excludePhotoFromPerson(person.id, pid);
        }
        setFeedbackMessage(`Excluded ${selectedArray.length} photos from export`);
      } else {
        for (const pid of selectedArray) {
          await includePhotoForPerson(person.id, pid);
        }
        setFeedbackMessage(`Included ${selectedArray.length} photos in export`);
      }

      setSelectedPhotoIds(new Set());
      await loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update exclusion';
      setFeedbackMessage(msg);
    }
  };

  // Merge this whole person into target person
  const handleMergePersonInto = async (targetPersonId: string) => {
    if (!person) return;

    try {
      await mergePeople(targetPersonId, person.id);
      setIsMergeModalOpen(false);
      router.replace({
        pathname: '/person/[id]',
        params: { id: targetPersonId },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Merge failed';
      setFeedbackMessage(msg);
    }
  };

  // Calculate whether selected photos have any non-excluded items
  const hasNonExcludedSelected = useMemo(() => {
    return photos.some(
      (p) => selectedPhotoIds.has(p.id) && p.is_person_excluded === 0
    );
  }, [photos, selectedPhotoIds]);

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !person) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
        <View style={styles.errorContainer}>
          <EmptyState
            testID="person-error-state"
            title="Person Not Found"
            body={error ?? 'Could not find the requested person.'}
            actionTitle="Back"
            onActionPress={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  const isOthers = person.is_others === 1;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View
        testID="person-header"
        style={[styles.header, { borderBottomColor: colors.border }]}
      >
        <View style={styles.headerLeft}>
          <Pressable
            testID="back-button"
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <ArrowLeft size={22} color={colors.text} />
          </Pressable>
          <View style={styles.headerTitleCol}>
            <Text
              numberOfLines={1}
              style={[tokens.typography.heading, { color: colors.text }]}
            >
              {isOthers ? 'Others' : person.name || 'Unnamed Person'}
            </Text>
            <Text
              style={[tokens.typography.micro, { color: colors.textMuted }]}
            >
              {photos.length} photos · {trip?.name ?? 'Trip'}
            </Text>
          </View>
        </View>

        {/* Header Actions */}
        <View style={styles.headerActions}>
          {!isOthers && otherPeople.length > 0 && (
            <Button
              testID="merge-person-button"
              title="Merge into…"
              variant="ghost"
              size="sm"
              icon={<GitMerge size={16} color={colors.primary} />}
              onPress={() => setIsMergeModalOpen(true)}
            />
          )}
        </View>
      </View>

      {/* Editable Name Section (Disabled for Others) */}
      {!isOthers && (
        <View style={styles.nameSection}>
          <View style={styles.nameRow}>
            <View style={styles.nameInputCol}>
              <TextField
                testID="person-name-field"
                label="Person's Name"
                placeholder="Name this person"
                value={nameInput}
                onChangeText={handleNameChange}
                error={nameError ?? undefined}
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={handleSaveName}
              />
            </View>
            <Button
              testID="save-name-button"
              title="Save"
              variant="primary"
              size="md"
              disabled={
                Boolean(nameError) ||
                nameInput.trim().length === 0 ||
                nameInput.trim() === (person.name || '') ||
                isSavingName
              }
              loading={isSavingName}
              onPress={handleSaveName}
              style={styles.saveNameBtn}
            />
          </View>
        </View>
      )}

      {/* Feedback Banner */}
      {feedbackMessage && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="feedback-banner"
            variant="success"
            message={feedbackMessage}
            onDismiss={() => setFeedbackMessage(null)}
          />
        </View>
      )}

      {/* Multi-Select Action Bar (shown when photos selected) */}
      {isSelectMode && (
        <View
          testID="multi-select-bar"
          style={[
            styles.selectionBar,
            { backgroundColor: colors.surface, borderBottomColor: colors.border },
          ]}
        >
          <View style={styles.selectionBarLeft}>
            <Pressable
              testID="select-all-button"
              accessibilityRole="button"
              accessibilityLabel="Select All Toggle"
              onPress={handleSelectAllToggle}
              style={styles.selectToggleBtn}
            >
              {selectedPhotoIds.size === photos.length ? (
                <CheckSquare size={18} color={colors.primary} />
              ) : (
                <Square size={18} color={colors.textMuted} />
              )}
            </Pressable>
            <Text
              testID="selection-count-text"
              style={[tokens.typography.caption, { color: colors.text, fontWeight: '600' }]}
            >
              {selectedPhotoIds.size} selected
            </Text>
          </View>

          <View style={styles.selectionBarActions}>
            {/* Move to another person */}
            {otherPeople.length > 0 && (
              <Button
                testID="move-selected-button"
                title="Move…"
                variant="ghost"
                size="sm"
                icon={<ArrowRightLeft size={14} color={colors.primary} />}
                onPress={() => setIsMoveModalOpen(true)}
              />
            )}

            {/* Remove from person (-> Others) */}
            {!isOthers && (
              <Button
                testID="remove-selected-button"
                title="Remove"
                variant="ghost"
                size="sm"
                icon={<UserMinus size={14} color={colors.danger} />}
                onPress={handleRemoveToOthers}
              />
            )}

            {/* Exclude / Include for export */}
            {!isOthers && (
              <Button
                testID="exclude-selected-button"
                title={hasNonExcludedSelected ? 'Exclude' : 'Include'}
                variant="ghost"
                size="sm"
                icon={
                  hasNonExcludedSelected ? (
                    <EyeOff size={14} color={colors.warning} />
                  ) : (
                    <Eye size={14} color={colors.success} />
                  )
                }
                onPress={handleToggleExclude}
              />
            )}

            {/* Clear selection */}
            <Pressable
              testID="clear-selection-button"
              accessibilityRole="button"
              accessibilityLabel="Cancel selection"
              onPress={() => setSelectedPhotoIds(new Set())}
              style={styles.clearSelectionBtn}
            >
              <X size={18} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>
      )}

      {/* Photos Grid */}
      {photos.length === 0 ? (
        <View style={styles.emptyContainer}>
          <EmptyState
            testID="photos-empty-state"
            title="No photos for this person"
            body="This person does not have any assigned photos."
            actionTitle="Back"
            onActionPress={() => router.back()}
          />
        </View>
      ) : (
        <View style={styles.gridContainer}>
          <FlashList
            testID="person-photo-grid"
            data={photos}
            numColumns={numColumns}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.gridContent}
            renderItem={({ item }) => {
              const isSelected = selectedPhotoIds.has(item.id);
              const isExcluded = item.is_person_excluded === 1;

              return (
                <View style={[styles.tileWrapper, { width: itemSize, height: itemSize }]}>
                  <PhotoTile
                    photoId={item.id}
                    selected={isSelected}
                    onPress={() => {
                      if (isSelectMode) {
                        handleTogglePhoto(item.id);
                      } else {
                        // In non-select mode, tapping also selects to initiate batch edits
                        handleTogglePhoto(item.id);
                      }
                    }}
                    onLongPress={() => handleTogglePhoto(item.id)}
                    style={[
                      styles.photoTile,
                      isExcluded && styles.excludedPhotoTile,
                    ]}
                  />

                  {/* Excluded from export badge */}
                  {isExcluded && (
                    <View
                      testID={`photo-excluded-badge-${item.id}`}
                      style={[
                        styles.excludedBadge,
                        { backgroundColor: colors.overlay },
                      ]}
                    >
                      <EyeOff size={10} color={colors.warning} />
                      <Text
                        style={[
                          tokens.typography.micro,
                          { color: colors.warning, marginLeft: 2 },
                        ]}
                      >
                        Excluded
                      </Text>
                    </View>
                  )}
                </View>
              );
            }}
          />
        </View>
      )}

      {/* Move Faces Modal */}
      <Modal
        visible={isMoveModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsMoveModalOpen(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => setIsMoveModalOpen(false)}
        >
          <Pressable
            testID="move-modal"
            style={[styles.modalSheet, { backgroundColor: colors.surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalSheetHeader}>
              <Text
                style={[tokens.typography.heading, { color: colors.text }]}
              >
                Move {selectedPhotoIds.size} photos to…
              </Text>
              <Pressable
                testID="close-move-modal-button"
                onPress={() => setIsMoveModalOpen(false)}
                style={styles.modalCloseBtn}
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>

            <ScrollView style={styles.modalList}>
              {otherPeople.map((target) => (
                <Pressable
                  key={target.id}
                  testID={`move-target-${target.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Move to ${target.name || 'Unnamed'}`}
                  onPress={() => handleMoveToTarget(target.id)}
                  style={({ pressed }) => [
                    styles.modalListItem,
                    { borderBottomColor: colors.border },
                    pressed && { backgroundColor: colors.surfaceAlt },
                  ]}
                >
                  <Users size={18} color={colors.primary} />
                  <Text
                    style={[
                      tokens.typography.bodyStrong,
                      { color: colors.text, marginLeft: 12 },
                    ]}
                  >
                    {target.name || 'Unnamed Person'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Merge Whole Person Modal */}
      <Modal
        visible={isMergeModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsMergeModalOpen(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => setIsMergeModalOpen(false)}
        >
          <Pressable
            testID="merge-modal"
            style={[styles.modalSheet, { backgroundColor: colors.surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalSheetHeader}>
              <Text
                style={[tokens.typography.heading, { color: colors.text }]}
              >
                Merge {person.name || 'this person'} into…
              </Text>
              <Pressable
                testID="close-merge-modal-button"
                onPress={() => setIsMergeModalOpen(false)}
                style={styles.modalCloseBtn}
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>

            <ScrollView style={styles.modalList}>
              {otherPeople.map((target) => (
                <Pressable
                  key={target.id}
                  testID={`merge-target-${target.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Merge into ${target.name || 'Unnamed'}`}
                  onPress={() => handleMergePersonInto(target.id)}
                  style={({ pressed }) => [
                    styles.modalListItem,
                    { borderBottomColor: colors.border },
                    pressed && { backgroundColor: colors.surfaceAlt },
                  ]}
                >
                  <GitMerge size={18} color={colors.primary} />
                  <Text
                    style={[
                      tokens.typography.bodyStrong,
                      { color: colors.text, marginLeft: 12 },
                    ]}
                  >
                    {target.name || 'Unnamed Person'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerTitleCol: {
    marginLeft: 12,
    flex: 1,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nameSection: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  nameInputCol: {
    flex: 1,
  },
  saveNameBtn: {
    marginTop: 24,
    minHeight: 44,
  },
  bannerWrapper: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  selectionBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  selectToggleBtn: {
    padding: 6,
  },
  selectionBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  clearSelectionBtn: {
    padding: 8,
    marginLeft: 4,
  },
  gridContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  gridContent: {
    paddingBottom: 24,
  },
  tileWrapper: {
    position: 'relative',
    margin: 1,
  },
  photoTile: {
    width: '100%',
    height: '100%',
  },
  excludedPhotoTile: {
    opacity: 0.6,
  },
  excludedBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 36,
    maxHeight: '60%',
  },
  modalSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  modalCloseBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalList: {
    flexGrow: 0,
  },
  modalListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
