// src/compact-session/tuning.ts
//
// Shared defaults for condensation tuning knobs. Both render modes
// (structural + bundled) use these when the caller leaves them unset.

/** UTF-8 byte threshold above which a string field gets replaced with a truncation marker. */
export const DEFAULT_MAX_FIELD_BYTES = 500;

/** Number of chars from the original field kept as a preview inside the truncation marker. */
export const DEFAULT_PREVIEW_CHARS = 100;
