// Configuration constants for algorithms and thresholds
// (Source of truth: docs/04_TRD.md §4)

export const CONFIG = {
  // Face Detection (BlazeFace short-range)
  BLAZEFACE_INPUT_SIZE: 128,
  BLAZEFACE_SCORE_THRESHOLD: 0.6,
  BLAZEFACE_IOU_THRESHOLD: 0.3,
  MIN_FACE_SIZE: 48, // pixels on original image (TRD §4)

  // Face Crop & Preprocessing
  CROP_MARGIN: 0.2, // 20% margin around bounding box (TRD §4)
  MOBILEFACENET_INPUT_SIZE: 112, // 112x112 input tensor

  // Clustering & Assignment
  CLUSTER_DISTANCE: 0.45, // Average linkage cosine distance threshold
  ASSIGN_DISTANCE: 0.5, // Nearest centroid cosine distance threshold
  MIN_CLUSTER_SIZE: 2, // Clusters with < 2 faces go to "Others" (TRD §4)

  // Trip Detection (MVP: time-gap rule only)
  TRIP_GAP_HOURS: 12,
  MIN_TRIP_PHOTOS: 15,
  MIN_TRIP_HOURS: 3,
} as const;
