import { describe, expect, test } from "vitest";
import {
  calculateEaseFactor,
  calculateStability,
  createInitialSM2Record,
  formatInterval,
  predictRetention,
  previewNextIntervals,
  ratingToGrade,
  updateSM2,
  buildSM2StudyOrder,
  DEFAULT_EASE_FACTOR,
  MIN_EASE_FACTOR,
  MS_PER_DAY,
  TARGET_RETENTION,
  type SM2Record,
} from "./sm2";
import { seededRng } from "./engine";
import type { VocabularyEntry } from "../api/types";

describe("SM-2 ratingToGrade", () => {
  test("maps 4-tier ratings to numeric grades correctly", () => {
    expect(ratingToGrade("again")).toBe(1);
    expect(ratingToGrade("hard")).toBe(3);
    expect(ratingToGrade("good")).toBe(4);
    expect(ratingToGrade("easy")).toBe(5);
  });
});

describe("SM-2 Ease Factor calculation", () => {
  test("maintains ease factor when grade is 4 (good)", () => {
    // Delta for q = 4: 0.1 - (1) * (0.08 + 0.02) = 0.1 - 0.1 = 0
    expect(calculateEaseFactor(2.5, 4)).toBe(2.5);
  });

  test("increases ease factor when grade is 5 (easy)", () => {
    // Delta for q = 5: 0.1 - (0) = +0.10
    expect(calculateEaseFactor(2.5, 5)).toBe(2.6);
  });

  test("decreases ease factor when grade is 3 (hard)", () => {
    // Delta for q = 3: 0.1 - (2) * (0.08 + 0.04) = 0.1 - 0.24 = -0.14
    expect(calculateEaseFactor(2.5, 3)).toBe(2.36);
  });

  test("decreases ease factor more sharply on failure (grade 1 / again)", () => {
    // Delta for q = 1: 0.1 - (4) * (0.08 + 0.08) = 0.1 - 0.64 = -0.54
    expect(calculateEaseFactor(2.5, 1)).toBe(1.96);
  });

  test("never allows ease factor to drop below minimum floor (1.30)", () => {
    expect(calculateEaseFactor(1.4, 0)).toBe(MIN_EASE_FACTOR);
    expect(calculateEaseFactor(1.3, 1)).toBe(MIN_EASE_FACTOR);
  });
});

describe("SM-2 Initial State", () => {
  test("creates fresh record with default parameters", () => {
    const now = 1000000;
    const initial = createInitialSM2Record(now);
    expect(initial.repetition).toBe(0);
    expect(initial.easeFactor).toBe(DEFAULT_EASE_FACTOR);
    expect(initial.interval).toBe(0);
    expect(initial.lastReviewedAt).toBe(now);
    expect(initial.nextReviewAt).toBe(now);
    expect(initial.totalReviews).toBe(0);
    expect(initial.lapses).toBe(0);
  });
});

describe("SM-2 State Transitions and Interval Scheduling", () => {
  const t0 = 1_700_000_000_000;

  test("first review (n=0): assigns initial 1-day interval for Good rating", () => {
    const rec1 = updateSM2(undefined, "good", t0);
    expect(rec1.repetition).toBe(1);
    expect(rec1.interval).toBe(1);
    expect(rec1.nextReviewAt).toBe(t0 + 1 * MS_PER_DAY);
    expect(rec1.easeFactor).toBe(2.5);
    expect(rec1.lapses).toBe(0);
    expect(rec1.totalReviews).toBe(1);
  });

  test("first review (n=0): assigns 2-day bonus interval for Easy rating", () => {
    const rec1 = updateSM2(undefined, "easy", t0);
    expect(rec1.repetition).toBe(1);
    expect(rec1.interval).toBe(2);
    expect(rec1.easeFactor).toBe(2.6);
  });

  test("first review (n=0): assigns 1-day interval for Hard rating", () => {
    const rec1 = updateSM2(undefined, "hard", t0);
    expect(rec1.repetition).toBe(1);
    expect(rec1.interval).toBe(1);
    expect(rec1.easeFactor).toBe(2.36);
  });

  test("second review (n=1): advances to 6-day interval for Good rating", () => {
    const rec1 = updateSM2(undefined, "good", t0);
    const t1 = t0 + 1 * MS_PER_DAY;
    const rec2 = updateSM2(rec1, "good", t1);
    expect(rec2.repetition).toBe(2);
    expect(rec2.interval).toBe(6);
    expect(rec2.nextReviewAt).toBe(t1 + 6 * MS_PER_DAY);
    expect(rec2.easeFactor).toBe(2.5);
  });

  test("second review (n=1): assigns 3-day interval for Hard rating", () => {
    const rec1 = updateSM2(undefined, "good", t0);
    const rec2 = updateSM2(rec1, "hard", t0 + MS_PER_DAY);
    expect(rec2.repetition).toBe(2);
    expect(rec2.interval).toBe(3);
    expect(rec2.easeFactor).toBe(2.36);
  });

  test("second review (n=1): assigns 8-day interval for Easy rating", () => {
    const rec1 = updateSM2(undefined, "good", t0);
    const rec2 = updateSM2(rec1, "easy", t0 + MS_PER_DAY);
    expect(rec2.repetition).toBe(2);
    expect(rec2.interval).toBe(8);
    expect(rec2.easeFactor).toBe(2.6);
  });

  test("subsequent review (n=2): expands interval exponentially using Ease Factor", () => {
    const rec1 = updateSM2(undefined, "good", t0);
    const rec2 = updateSM2(rec1, "good", t0 + 1 * MS_PER_DAY); // interval = 6
    const t2 = t0 + 7 * MS_PER_DAY;
    const rec3 = updateSM2(rec2, "good", t2);

    // Interval should be round(6 * 2.5) = 15 days
    expect(rec3.repetition).toBe(3);
    expect(rec3.interval).toBe(15);
    expect(rec3.easeFactor).toBe(2.5);

    // Fourth review: round(15 * 2.5) = 38 days
    const t3 = t2 + 15 * MS_PER_DAY;
    const rec4 = updateSM2(rec3, "good", t3);
    expect(rec4.repetition).toBe(4);
    expect(rec4.interval).toBe(38);
  });

  test("failure (Again): resets repetition streak to 0, resets interval to 1, and records lapse", () => {
    const rec1 = updateSM2(undefined, "good", t0);
    const rec2 = updateSM2(rec1, "good", t0 + 1 * MS_PER_DAY);
    expect(rec2.repetition).toBe(2);
    expect(rec2.interval).toBe(6);

    // Learner forgets word on review 3
    const tFail = t0 + 7 * MS_PER_DAY;
    const failed = updateSM2(rec2, "again", tFail);
    expect(failed.repetition).toBe(0);
    expect(failed.interval).toBe(1);
    expect(failed.nextReviewAt).toBe(tFail + 1 * MS_PER_DAY);
    expect(failed.lapses).toBe(1);
    expect(failed.easeFactor).toBe(1.96); // 2.5 - 0.54
  });
});

describe("Ebbinghaus Forgetting Curve and Retention Probability", () => {
  const t0 = 1_700_000_000_000;

  test("unreviewed new card has 0% predicted retention", () => {
    const card = createInitialSM2Record(t0);
    expect(predictRetention(card, t0)).toBe(0.0);
  });

  test("immediately after review: retention is 1.0 (100%)", () => {
    const reviewed = updateSM2(undefined, "good", t0);
    expect(predictRetention(reviewed, t0)).toBe(1.0);
  });

  test("at scheduled review date (t = interval): retention is approximately target retention (90%)", () => {
    const reviewed = updateSM2(undefined, "good", t0); // interval = 1 day
    const dueDate = t0 + 1 * MS_PER_DAY;
    const retentionAtDue = predictRetention(reviewed, dueDate);
    // R(I) = exp(-I / S) where S = -I / ln(0.9) => R(I) = exp(ln(0.9)) = 0.90
    expect(retentionAtDue).toBeCloseTo(TARGET_RETENTION, 2);
  });

  test("overdue cards decay exponentially below 90%", () => {
    const reviewed = updateSM2(undefined, "good", t0); // interval = 1 day
    const overdue2Days = t0 + 2 * MS_PER_DAY;
    const overdue5Days = t0 + 5 * MS_PER_DAY;

    const r2 = predictRetention(reviewed, overdue2Days);
    const r5 = predictRetention(reviewed, overdue5Days);

    expect(r2).toBeLessThan(TARGET_RETENTION);
    expect(r5).toBeLessThan(r2);
    expect(r5).toBeGreaterThanOrEqual(0.0);
  });

  test("stability scales with interval", () => {
    const s1 = calculateStability(1);
    const s6 = calculateStability(6);
    const s30 = calculateStability(30);

    expect(s6).toBeGreaterThan(s1);
    expect(s30).toBeGreaterThan(s6);
  });
});

describe("previewNextIntervals", () => {
  test("generates preview intervals for all 4 choices", () => {
    const now = 1_700_000_000_000;
    const initial = updateSM2(undefined, "good", now); // interval = 1, repetition = 1

    const previews = previewNextIntervals(initial, now);
    expect(previews.again).toBe(1);
    expect(previews.hard).toBe(3);
    expect(previews.good).toBe(6);
    expect(previews.easy).toBe(8);
  });
});

describe("formatInterval", () => {
  test("formats day, week, and month intervals into clean strings", () => {
    expect(formatInterval(0)).toBe("< 1 day");
    expect(formatInterval(1)).toBe("1 day");
    expect(formatInterval(6)).toBe("6 days");
    expect(formatInterval(14)).toBe("2 weeks");
    expect(formatInterval(28)).toBe("4 weeks");
    expect(formatInterval(60)).toBe("2 months");
  });
});

describe("buildSM2StudyOrder priority queue", () => {
  const TEST_ENTRIES: VocabularyEntry[] = [
    { id: "e1", source: "e1", target: "t1", alternatives: [], tags: [] },
    { id: "e2", source: "e2", target: "t2", alternatives: [], tags: [] },
    { id: "e3", source: "e3", target: "t3", alternatives: [], tags: [] },
  ];

  test("prioritizes overdue decayed cards ahead of unreviewed and stable cards", () => {
    const now = 1_700_000_000_000;
    const sm2Map = new Map<string, SM2Record>();

    // e1: Overdue by 5 days (lowest retention)
    const e1Record = updateSM2(undefined, "good", now - 6 * MS_PER_DAY);
    sm2Map.set("e1", e1Record);

    // e2: Unreviewed (never seen)
    // not set in map

    // e3: Freshly reviewed 10 minutes ago (high retention > 99%)
    const e3Record = updateSM2(undefined, "good", now - 10 * 60 * 1000);
    sm2Map.set("e3", e3Record);

    const order = buildSM2StudyOrder(TEST_ENTRIES, sm2Map, seededRng(42), now);

    // Priority: e1 (overdue decay) -> e2 (unreviewed) -> e3 (stable)
    expect(order.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });
});
