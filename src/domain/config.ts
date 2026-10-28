// Configuration constants for algorithms and thresholds
// (Source of truth: docs/04_TRD.md §4)

export const CONFIG = {
  // Face Detection (BlazeFace short-range)
  BLAZEFACE_INPUT_SIZE: 128,
  BLAZEFACE_SCORE_THRESHOLD: 0.5, // 0.5 allows detecting smaller background faces in group photos
  BLAZEFACE_IOU_THRESHOLD: 0.3,
  MIN_FACE_SIZE: 28, // pixels on original image (allows background faces down to 28px)

  // Face Crop & Preprocessing
  CROP_MARGIN: 0.25, // 25% margin around bounding box to capture full face shape
  MOBILEFACENET_INPUT_SIZE: 112, // 112x112 input tensor

  // Face Quality Filter (TRD §4)
  MIN_FACE_CONFIDENCE: 0.5, // Minimum detector confidence
  BLUR_MIN: 35.0, // Minimum Laplacian variance of grey crop (below = blurry)
  YAW_MAX_RAD: 0.8, // ~45.8 degrees maximum yaw angle (beyond = extreme pose)
  LANDMARK_YAW_MAX_RATIO: 0.65, // Max nose-to-eye horizontal asymmetry ratio

  // Clustering & Assignment
  CLUSTER_DISTANCE: 0.32, // Cosine distance threshold (tuned to 0.32 based on real-world iPhone evaluation)
  ASSIGN_DISTANCE: 0.35, // Nearest centroid cosine distance threshold
  MIN_CLUSTER_SIZE: 2, // Clusters with < 2 faces go to "Others" (TRD §4)

  // Trip Detection (MVP: time-gap rule only)
  TRIP_GAP_HOURS: 12,
  MIN_TRIP_PHOTOS: 15,
  MIN_TRIP_HOURS: 3,
} as const;
