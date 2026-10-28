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

  // Clustering & Assignment (Tuned via Task 2.10 eval harness; PRD §6 targets: Precision >= 90%, Recall >= 80%)
  CLUSTER_DISTANCE: 0.32, // Cosine distance threshold (Eval: Precision 100.0%, Recall 86.2%, F1 92.6%)
  ASSIGN_DISTANCE: 0.35, // Nearest centroid cosine distance threshold (Eval: Precision 100.0%, Recall 86.2%, F1 92.6%)
  MIN_CLUSTER_SIZE: 2, // Clusters with < 2 faces go to "Others" (TRD §4)

  // Trip Detection (MVP: time-gap rule only)
  TRIP_GAP_HOURS: 12,
  MIN_TRIP_PHOTOS: 15,
  MIN_TRIP_HOURS: 3,

  // Free Tier & Monetization (Plan 2.9, TRD §1, PRD US-11, Open Decision D-1 & D-2)
  FREE_SCAN_LIMIT_PER_TRIP: 50, // 50 photos per trip on free tier
  ENABLE_PRO_GATE: false, // Feature flag: default OFF ($0 MVP, everything unlocked)
  PRO_PRICE_USD: '$4.99', // Pro unlock price ($4.99 per PRD §8 D-2)
} as const;
