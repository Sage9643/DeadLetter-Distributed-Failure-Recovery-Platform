// How long a job may remain in PROCESSING before it's considered
// orphaned (its worker likely crashed without reaching a terminal
// state) and therefore eligible to be reclaimed by another delivery.
//
// This threshold must be comfortably longer than any realistic
// processing duration to avoid reclaiming a job that is still being
// legitimately, actively processed -- which would reintroduce the
// exact concurrent-duplicate-processing race this phase prevents.
export const STALE_PROCESSING_THRESHOLD_SECONDS = 60;