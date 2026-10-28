import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  Image,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Check, X, Layers, Share2, Sparkles } from 'lucide-react-native';
import { useTheme } from '../../../src/hooks/useTheme';
import { getTripById } from '../../../src/db/repositories/trips';
import {
  getPeopleWithDetails,
  type PersonWithDetails,
} from '../../../src/db/repositories/people';
import {
  getClearestFacesForPerson,
} from '../../../src/db/repositories/faces';
import type { FaceRow, TripRow } from '../../../src/db/types';
import { PersonBubble } from '../../../src/components/people/PersonBubble';
import { Button, TextField, Banner, EmptyState } from '../../../src/components/ui';
import { nameAndAssignPerson } from '../../../src/services/assignment';
import { mergePeople } from '../../../src/services/manualEdits';
import { validatePersonName } from '../../../src/domain/assignment';
import { getFaceThumbnail } from '../../../src/services/faceThumbnail';

interface ClearFaceItem {
  face: FaceRow;
  uri: string | null;
}

export default function PeopleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, tokens } = useTheme();

  const [trip, setTrip] = useState<TripRow | null>(null);
  const [people, setPeople] = useState<PersonWithDetails[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Merge Mode state
  const [isMergeMode, setIsMergeMode] = useState<boolean>(false);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [isMerging, setIsMerging] = useState<boolean>(false);

  // Toast / Banner feedback state
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  // Naming Flow Modal state
  const [isNamingOpen, setIsNamingOpen] = useState<boolean>(false);
  const [namingPerson, setNamingPerson] = useState<PersonWithDetails | null>(null);
  const [clearestFaces, setClearestFaces] = useState<ClearFaceItem[]>([]);
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState<string>('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSubmittingName, setIsSubmittingName] = useState<boolean>(false);

  // Load trip and people data
  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const [tripData, peopleData] = await Promise.all([
        getTripById(id),
        getPeopleWithDetails(id),
      ]);
      setTrip(tripData);
      setPeople(peopleData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load people';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Existing person names in trip for uniqueness check
  const existingNames = useMemo(() => {
    return people
      .filter((p) => p.id !== namingPerson?.id)
      .map((p) => p.name);
  }, [people, namingPerson?.id]);

  // Open naming flow for an unnamed person
  const handleOpenNaming = useCallback(async (person: PersonWithDetails) => {
    setNamingPerson(person);
    setNameInput(person.name || '');
    setNameError(null);
    setSelectedFaceId(person.cover_face_id || null);
    setIsNamingOpen(true);

    try {
      const faces = await getClearestFacesForPerson(person.id, 8);
      // Resolve face crop thumbnails for each clear face
      const faceItems = await Promise.all(
        faces.map(async (f) => {
          const uri = await getFaceThumbnail({
            faceId: f.id,
            photoId: f.photo_id,
            bbox_x: f.bbox_x,
            bbox_y: f.bbox_y,
            bbox_w: f.bbox_w,
            bbox_h: f.bbox_h,
          });
          return { face: f, uri };
        })
      );
      setClearestFaces(faceItems);

      // Pre-select cover_face_id if in list, otherwise default to first face
      if (faces.length > 0) {
        const hasCover = faces.some((f) => f.id === person.cover_face_id);
        if (!hasCover) {
          setSelectedFaceId(faces[0].id);
        }
      }
    } catch {
      setClearestFaces([]);
    }
  }, []);

  // Handle Name Input change with live validation
  const handleNameChange = (text: string) => {
    setNameInput(text);
    if (text.trim().length > 0) {
      const result = validatePersonName(text, existingNames);
      setNameError(result.valid ? null : result.error ?? 'Invalid name');
    } else {
      setNameError(null);
    }
  };

  // Submit person name + clear face assignment
  const handleSubmitName = async () => {
    if (!id || !namingPerson) return;
    const validation = validatePersonName(nameInput, existingNames);
    if (!validation.valid) {
      setNameError(validation.error ?? 'Invalid name');
      return;
    }

    try {
      setIsSubmittingName(true);
      const res = await nameAndAssignPerson(
        id,
        namingPerson.id,
        validation.trimmedName,
        { pickedFaceId: selectedFaceId ?? undefined }
      );

      setIsNamingOpen(false);
      setNamingPerson(null);
      await loadData();

      // Show toast/banner: "+n photos added to Name"
      const addedCount = res.addedToThisPersonCount;
      const countLabel = addedCount === 1 ? '1 photo' : `${addedCount} photos`;
      setFeedbackMessage(`+${countLabel} added to ${res.person.name}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save name';
      setNameError(msg);
    } finally {
      setIsSubmittingName(false);
    }
  };

  // Bubble press handler
  const handleBubblePress = (person: PersonWithDetails) => {
    if (isMergeMode) {
      // "Others" bucket cannot be merged
      if (person.is_others) return;

      setSelectedPersonIds((prev) => {
        if (prev.includes(person.id)) {
          return prev.filter((pid) => pid !== person.id);
        }
        if (prev.length < 2) {
          return [...prev, person.id];
        }
        // If 2 already selected, replace the second one
        return [prev[0], person.id];
      });
      return;
    }

    // Normal mode:
    // If unnamed: open Naming Sheet
    if (!person.is_others && (!person.name || person.name.trim().length === 0)) {
      handleOpenNaming(person);
      return;
    }

    // If named or Others: navigate to Person Detail screen
    router.push({
      pathname: '/person/[id]',
      params: { id: person.id },
    });
  };

  // Bubble long press handler: trigger Merge Mode
  const handleBubbleLongPress = (person: PersonWithDetails) => {
    if (person.is_others) return;
    setIsMergeMode(true);
    setSelectedPersonIds([person.id]);
  };

  // Merge selected people
  const handleMergePeople = async () => {
    if (selectedPersonIds.length !== 2) return;
    const [idA, idB] = selectedPersonIds;
    const personA = people.find((p) => p.id === idA);
    const personB = people.find((p) => p.id === idB);
    if (!personA || !personB) return;

    // Pick target: named person takes priority; otherwise person with more photos
    let target = personA;
    let source = personB;
    if (!personA.name && personB.name) {
      target = personB;
      source = personA;
    } else if (personA.name && personB.name) {
      if ((personB.photo_count ?? 0) > (personA.photo_count ?? 0)) {
        target = personB;
        source = personA;
      }
    }

    try {
      setIsMerging(true);
      await mergePeople(target.id, source.id);
      setIsMergeMode(false);
      setSelectedPersonIds([]);
      await loadData();
      setFeedbackMessage(`Merged into ${target.name || 'person'}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Merge failed';
      setFeedbackMessage(msg);
    } finally {
      setIsMerging(false);
    }
  };

  // Export action handler
  const handleExport = () => {
    if (!id) return;
    router.push({
      pathname: '/export/[tripId]',
      params: { tripId: id },
    });
  };

  const namedCount = useMemo(() => {
    return people.filter((p) => !p.is_others && p.name && p.name.trim().length > 0).length;
  }, [people]);

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View
        testID="people-header"
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
              {trip?.name ? `${trip.name} — People` : 'People'}
            </Text>
            <Text
              style={[tokens.typography.micro, { color: colors.textMuted }]}
            >
              {namedCount} named · {people.length} detected
            </Text>
          </View>
        </View>

        {/* Header Actions */}
        <View style={styles.headerActions}>
          {isMergeMode ? (
            <>
              <Button
                testID="cancel-merge-button"
                title="Cancel"
                variant="ghost"
                size="sm"
                onPress={() => {
                  setIsMergeMode(false);
                  setSelectedPersonIds([]);
                }}
              />
              <Button
                testID="confirm-merge-button"
                title={selectedPersonIds.length === 2 ? 'Merge (2)' : 'Merge'}
                variant="primary"
                size="sm"
                disabled={selectedPersonIds.length !== 2 || isMerging}
                loading={isMerging}
                onPress={handleMergePeople}
              />
            </>
          ) : (
            <>
              {people.filter((p) => !p.is_others).length >= 2 && (
                <Pressable
                  testID="enter-merge-button"
                  accessibilityRole="button"
                  accessibilityLabel="Merge People"
                  onPress={() => setIsMergeMode(true)}
                  style={({ pressed }) => [
                    styles.iconButton,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Layers size={20} color={colors.textMuted} />
                </Pressable>
              )}
              <Button
                testID="export-button"
                title="Export"
                variant="primary"
                size="sm"
                icon={<Share2 size={16} color={colors.onPrimary} />}
                onPress={handleExport}
              />
            </>
          )}
        </View>
      </View>

      {/* Mode / Feedback Banners */}
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

      {isMergeMode && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="merge-instructions-banner"
            variant="info"
            message="Select 2 people to merge them into one."
          />
        </View>
      )}

      {error && (
        <View style={styles.bannerWrapper}>
          <Banner
            testID="error-banner"
            variant="error"
            message={error}
            onDismiss={() => setError(null)}
          />
        </View>
      )}

      {/* Content */}
      {people.length === 0 ? (
        <View style={styles.emptyContainer}>
          <EmptyState
            testID="people-empty-state"
            title="No faces detected"
            body="No faces were detected in this trip's photos. Check that photos are clear and well-lit."
            actionTitle="Back to Trip"
            onActionPress={() => router.back()}
          />
        </View>
      ) : (
        <ScrollView
          testID="people-scroll-view"
          contentContainerStyle={styles.scrollContent}
        >
          {/* Plain Grid of Person Bubbles (02_AppFlow §3.5) */}
          <View testID="people-grid" style={styles.grid}>
            {people.map((person) => {
              const isSelected = selectedPersonIds.includes(person.id);
              return (
                <View key={person.id} style={styles.bubbleCol}>
                  <PersonBubble
                    person={person}
                    selected={isSelected}
                    isMergeMode={isMergeMode}
                    onPress={() => handleBubblePress(person)}
                    onLongPress={() => handleBubbleLongPress(person)}
                  />
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}

      {/* Naming Flow Bottom Sheet / Modal */}
      <Modal
        visible={isNamingOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsNamingOpen(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => setIsNamingOpen(false)}
        >
          <Pressable
            testID="naming-sheet"
            style={[styles.sheetContent, { backgroundColor: colors.surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            {/* Sheet Header */}
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleRow}>
                <Sparkles size={20} color={colors.primary} />
                <Text
                  style={[
                    tokens.typography.heading,
                    { color: colors.text, marginLeft: 8 },
                  ]}
                >
                  Name Person
                </Text>
              </View>
              <Pressable
                testID="close-naming-sheet-button"
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => setIsNamingOpen(false)}
                style={({ pressed }) => [
                  styles.sheetCloseButton,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>

            <Text
              style={[
                tokens.typography.caption,
                { color: colors.textMuted, marginBottom: 12 },
              ]}
            >
              Pick a clear face crop and name this person. Other matching photos will be automatically assigned.
            </Text>

            {/* Clear Faces Selector */}
            {clearestFaces.length > 0 && (
              <View style={styles.facesSection}>
                <Text
                  style={[
                    tokens.typography.micro,
                    { color: colors.textMuted, marginBottom: 8, textTransform: 'uppercase' },
                  ]}
                >
                  Representative Photo
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.facesScroll}
                >
                  {clearestFaces.map((item) => {
                    const isPicked = selectedFaceId === item.face.id;
                    return (
                      <Pressable
                        key={item.face.id}
                        testID={`face-choice-${item.face.id}`}
                        accessibilityRole="button"
                        accessibilityLabel="Select face"
                        onPress={() => setSelectedFaceId(item.face.id)}
                        style={[
                          styles.faceChoice,
                          {
                            borderColor: isPicked ? colors.primary : colors.border,
                            borderWidth: isPicked ? 2.5 : 1,
                            backgroundColor: colors.surfaceAlt,
                          },
                        ]}
                      >
                        {item.uri ? (
                          <Image
                            source={{ uri: item.uri }}
                            style={styles.faceChoiceImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={styles.facePlaceholder} />
                        )}
                        {isPicked && (
                          <View
                            style={[
                              styles.facePickedBadge,
                              { backgroundColor: colors.primary },
                            ]}
                          >
                            <Check size={10} color={colors.onPrimary} strokeWidth={3} />
                          </View>
                        )}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            {/* Name Input Field */}
            <View style={styles.inputSection}>
              <TextField
                testID="person-name-input"
                label="Person's name"
                placeholder="e.g. Rafi"
                value={nameInput}
                onChangeText={handleNameChange}
                error={nameError ?? undefined}
                autoFocus
                maxLength={40}
              />
            </View>

            {/* Save & Assign Action Button */}
            <View style={styles.sheetActions}>
              <Button
                testID="save-name-button"
                title="Save & Assign"
                variant="primary"
                disabled={
                  nameInput.trim().length === 0 ||
                  Boolean(nameError) ||
                  isSubmittingName
                }
                loading={isSubmittingName}
                onPress={handleSubmitName}
              />
            </View>
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
  bannerWrapper: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  bubbleCol: {
    width: '33.33%',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sheetCloseButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  facesSection: {
    marginVertical: 12,
  },
  facesScroll: {
    gap: 10,
    paddingVertical: 4,
  },
  faceChoice: {
    width: 60,
    height: 60,
    borderRadius: 30,
    overflow: 'hidden',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceChoiceImage: {
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  facePlaceholder: {
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  facePickedBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputSection: {
    marginVertical: 12,
  },
  sheetActions: {
    marginTop: 8,
  },
});
