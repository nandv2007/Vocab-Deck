/**
 * SuperMemo SM-2 Spaced Repetition Algorithm & Ebbinghaus Forgetting Curve Engine.
 *
 * Implements the mathematical SM-2 spaced repetition algorithm designed by Dr. Piotr Woźniak,
 * combined with Hermann Ebbinghaus's exponential forgetting curve model:
 *
 * 1. Recall Quality Grades:
 *    - Grade 5: Perfect response, immediate recall (Easy)
 *    - Grade 4: Correct response after hesitation (Good)
 *    - Grade 3: Correct response with serious difficulty (Hard)
 *    - Grade 2: Incorrect response; correct answer seemed easy to recall
 *    - Grade 1: Incorrect response; familiar upon seeing the answer (Again)
 *    - Grade 0: Complete blackout
 *
 * 2. Ease Factor (EF) Update:
 *    EF' = max(1.3, EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
 *
 * 3. Interval Calculation:
 *    If q < 3 (failure / lapse):
 *      repetition = 0
 *      interval = 1 day
 *    If q >= 3 (success):
 *      If repetition = 0: interval = 1 day
 *      If repetition = 1: interval = 6 days (adjusted for Hard/Easy)
 *      If repetition >= 2: interval = round(previous_interval * EF)
 *      repetition = repetition + 1
 *
 * 4. Ebbinghaus Forgetting Curve:
 *    R(t) = exp(-t / S)
 *    Where R(t) in [0.0, 1.0] is the predicted retention probability after elapsed time t,
 *    and S is memory stability derived from interval and target retention (default 90%).
 *
 * Rules:
 * - Pure algorithmic TypeScript, zero external dependencies.
 * - 100% in-memory session semantics.
 * - Seamless backward compatibility with classic Leitner box outcomes and typing typo verdicts.
 */

import type { VocabularyEntry } from "../api/types";
import type { Rng } from "./rng";
import { shuffle } from "./rng";

/**
 * Recall grade representing learner response quality.
 * Numeric scale 0 to 5, or 4-tier pedagogical rating (again, hard, good, easy).
 */
export type SM2Rating = "again" | "hard" | "good" | "easy";

export type SM2Grade = 0 | 1 | 2 | 3 | 4 | 5;

/** Maps a 4-tier rating to the standard SM-2 0-5 numerical grade. */
export function ratingToGrade(rating: SM2Rating): SM2Grade {
  switch (rating) {
    case "again":
      return 1;
    case "hard":
      return 3;
    case "good":
      return 4;
    case "easy":
      return 5;
  }
}

/** Standard target retention rate at scheduled review date (90%). */
export const TARGET_RETENTION = 0.9;

/** Milliseconds in a 24-hour day. */
export const MS_PER_DAY = 86_400_000;

/** Default starting Ease Factor. */
export const DEFAULT_EASE_FACTOR = 2.5;

/** Minimum Ease Factor floor to prevent interval stagnation. */
export const MIN_EASE_FACTOR = 1.3;

export interface SM2Record {
  /** Number of consecutive successful reviews (grade >= 3). */
  repetition: number;
  /** Current Ease Factor (>= 1.3). Default 2.5. */
  easeFactor: number;
  /** Scheduled inter-repetition interval in days. */
  interval: number;
  /** Timestamp (ms) of the most recent review. */
  lastReviewedAt: number;
  /** Timestamp (ms) when the card is next due for review. */
  nextReviewAt: number;
  /** Estimated memory stability in days. */
  stability: number;
  /** Total number of reviews performed on this card. */
  totalReviews: number;
  /** Number of lapses (times recall failed after having been learned). */
  lapses: number;
}

/**
 * Creates a default, unlearned SM-2 record for a new card.
 */
export function createInitialSM2Record(now: number = Date.now()): SM2Record {
  return {
    repetition: 0,
    easeFactor: DEFAULT_EASE_FACTOR,
    interval: 0,
    lastReviewedAt: now,
    nextReviewAt: now,
    stability: 0.5,
    totalReviews: 0,
    lapses: 0,
  };
}

/**
 * Calculates updated Ease Factor according to the SM-2 formula.
 */
export function calculateEaseFactor(currentEF: number, grade: SM2Grade): number {
  const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);
  const nextEF = currentEF + delta;
  return Math.max(MIN_EASE_FACTOR, Math.round(nextEF * 100) / 100);
}

/**
 * Calculates memory stability S (in days) such that R(interval) = TARGET_RETENTION.
 * R(t) = exp(-t / S) => S = -interval / ln(TARGET_RETENTION)
 */
export function calculateStability(intervalDays: number): number {
  if (intervalDays <= 0) return 0.5;
  const factor = -1 / Math.log(TARGET_RETENTION); // ~9.491
  return Math.max(0.5, Math.round(intervalDays * factor * 10) / 10);
}

/**
 * Predicts the current retention probability R(t) in [0.0, 1.0] according to
 * Ebbinghaus's exponential forgetting curve model:
 *
 *   R(t) = exp(-elapsedDays / stability)
 *
 * A brand new card has R = 0.0; a just-reviewed card has R = 1.0.
 */
export function predictRetention(record: SM2Record, now: number = Date.now()): number {
  if (record.totalReviews === 0) return 0.0;
  const elapsedMs = Math.max(0, now - record.lastReviewedAt);
  const elapsedDays = elapsedMs / MS_PER_DAY;
  const stability = Math.max(0.1, record.stability);
  const retention = Math.exp(-elapsedDays / stability);
  return Math.min(1.0, Math.max(0.0, retention));
}

/**
 * Pure state transition function implementing SuperMemo SM-2 review logic.
 *
 * @param current Current SM-2 state of the card (or undefined if new)
 * @param grade Recall quality grade (0 to 5) or rating string
 * @param now Current timestamp in ms
 * @returns Updated immutable SM2Record
 */
export function updateSM2(
  current: SM2Record | undefined,
  gradeInput: SM2Grade | SM2Rating,
  now: number = Date.now(),
): SM2Record {
  const grade: SM2Grade =
    typeof gradeInput === "string" ? ratingToGrade(gradeInput) : gradeInput;

  const prev = current ?? createInitialSM2Record(now);
  const totalReviews = prev.totalReviews + 1;
  const newEF = calculateEaseFactor(prev.easeFactor, grade);

  let nextRepetition: number;
  let nextInterval: number;
  let nextLapses = prev.lapses;

  if (grade < 3) {
    // Failure / lapse: reset repetition count and schedule for immediate tomorrow review
    nextRepetition = 0;
    nextInterval = 1;
    if (prev.repetition > 0) {
      nextLapses += 1;
    }
  } else {
    // Successful recall: advance repetition streak and compute interval
    if (prev.repetition === 0) {
      nextInterval = grade === 3 ? 1 : grade === 5 ? 2 : 1;
    } else if (prev.repetition === 1) {
      // Second consecutive recall: differentiate interval by grade
      nextInterval = grade === 3 ? 3 : grade === 5 ? 8 : 6;
    } else {
      // General interval expansion
      let modifier = newEF;
      if (grade === 3) modifier = Math.max(1.1, newEF * 0.85); // Hard penalty
      if (grade === 5) modifier = newEF * 1.3; // Easy bonus
      nextInterval = Math.max(prev.interval + 1, Math.round(prev.interval * modifier));
    }
    nextRepetition = prev.repetition + 1;
  }

  const stability = calculateStability(nextInterval);
  const nextReviewAt = now + nextInterval * MS_PER_DAY;

  return {
    repetition: nextRepetition,
    easeFactor: newEF,
    interval: nextInterval,
    lastReviewedAt: now,
    nextReviewAt,
    stability,
    totalReviews,
    lapses: nextLapses,
  };
}

/**
 * Previews the next interval in days for each of the 4 standard rating choices.
 * Allows UI buttons to display helpful interval previews (e.g., "1d", "6d", "14d").
 */
export function previewNextIntervals(
  record: SM2Record | undefined,
  now: number = Date.now(),
): Record<SM2Rating, number> {
  return {
    again: updateSM2(record, "again", now).interval,
    hard: updateSM2(record, "hard", now).interval,
    good: updateSM2(record, "good", now).interval,
    easy: updateSM2(record, "easy", now).interval,
  };
}

/**
 * Human-readable format for interval strings (e.g. "< 1 day", "1 day", "6 days", "2.5 weeks").
 */
export function formatInterval(days: number): string {
  if (days <= 0) return "< 1 day";
  if (days === 1) return "1 day";
  if (days < 14) return `${days} days`;
  if (days < 60) {
    const weeks = Math.round((days / 7) * 10) / 10;
    return `${weeks} weeks`;
  }
  const months = Math.round((days / 30) * 10) / 10;
  return `${months} months`;
}

/**
 * Builds an adaptive study order prioritized by memory decay and overdue reviews:
 * 1. Overdue cards whose predicted retention has decayed below 90% (most urgent first).
 * 2. Unreviewed / new cards (shuffled to maintain variety).
 * 3. Currently stable cards whose retention >= 90% (least urgent).
 */
export function buildSM2StudyOrder(
  entries: readonly VocabularyEntry[],
  sm2Map: ReadonlyMap<string, SM2Record>,
  rng: Rng,
  now: number = Date.now(),
): VocabularyEntry[] {
  const overdueOrDecaying: { entry: VocabularyEntry; retention: number }[] = [];
  const unreviewed: VocabularyEntry[] = [];
  const stable: { entry: VocabularyEntry; retention: number }[] = [];

  for (const entry of entries) {
    const record = sm2Map.get(entry.id);
    if (!record || record.totalReviews === 0) {
      unreviewed.push(entry);
    } else {
      const retention = predictRetention(record, now);
      if (retention < TARGET_RETENTION || now >= record.nextReviewAt) {
        overdueOrDecaying.push({ entry, retention });
      } else {
        stable.push({ entry, retention });
      }
    }
  }

  // Sort overdue items ascending by retention (lowest retention = highest danger of forgetting)
  overdueOrDecaying.sort((a, b) => a.retention - b.retention);

  // Stable items sorted ascending by retention as well
  stable.sort((a, b) => a.retention - b.retention);

  return [
    ...overdueOrDecaying.map((item) => item.entry),
    ...shuffle(unreviewed, rng),
    ...stable.map((item) => item.entry),
  ];
}
