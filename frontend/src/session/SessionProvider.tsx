import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { updateRetention, type RetentionRecord } from "../game/engine";
import { updateSM2, type SM2Rating, type SM2Record } from "../game/sm2";
import {
  SessionContext,
  emptyStats,
  isPristineStats,
  type SessionApi,
} from "./sessionContext";

/** Provides the session-only, in-memory gameplay state to the app. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const startedAtRef = useRef(Date.now());
  const [stats, setStats] = useState(() => emptyStats(startedAtRef.current));
  const [retention, setRetention] = useState<Map<string, RetentionRecord>>(() => new Map());
  const [sm2Records, setSm2Records] = useState<Map<string, SM2Record>>(() => new Map());
  const [epoch, setEpoch] = useState(0);

  const updateSM2Internal = useCallback((entryId: string, rating: SM2Rating) => {
    const now = Date.now();
    setSm2Records((prev) => {
      const next = new Map(prev);
      const current = next.get(entryId);
      next.set(entryId, updateSM2(current, rating, now));
      return next;
    });
  }, []);

  const recordEntryResult = useCallback(
    (entryId: string, outcome: boolean | "exact" | "typo" | "incorrect") => {
      setRetention((prev) => {
        const next = new Map(prev);
        const current = next.get(entryId);
        next.set(entryId, updateRetention(current, outcome));
        return next;
      });
    },
    [],
  );

  const recordSM2Assessment = useCallback(
    (entryId: string, rating: SM2Rating) => {
      updateSM2Internal(entryId, rating);

      // Tally in session stats
      const isKnown = rating === "good" || rating === "easy";
      setStats((prev) => ({
        ...prev,
        flashcards: {
          known: prev.flashcards.known + (isKnown ? 1 : 0),
          needsPractice: prev.flashcards.needsPractice + (isKnown ? 0 : 1),
        },
      }));

      // Map to Leitner outcome for backward compatibility
      const leitnerOutcome =
        rating === "again" ? false : rating === "hard" ? "typo" : "exact";
      recordEntryResult(entryId, leitnerOutcome);
    },
    [recordEntryResult, updateSM2Internal],
  );

  const recordFlashcardAssessment = useCallback(
    (assessment: "known" | "needsPractice", entryId?: string) => {
      setStats((prev) => ({
        ...prev,
        flashcards: {
          ...prev.flashcards,
          [assessment]: prev.flashcards[assessment] + 1,
        },
      }));
      if (entryId) {
        recordEntryResult(entryId, assessment === "known");
        updateSM2Internal(entryId, assessment === "known" ? "good" : "again");
      }
    },
    [recordEntryResult, updateSM2Internal],
  );

  const recordQuizAnswer = useCallback(
    (correct: boolean, entryId?: string) => {
      setStats((prev) => ({
        ...prev,
        quiz: {
          correct: prev.quiz.correct + (correct ? 1 : 0),
          answered: prev.quiz.answered + 1,
        },
      }));
      if (entryId) {
        recordEntryResult(entryId, correct);
        updateSM2Internal(entryId, correct ? "good" : "again");
      }
    },
    [recordEntryResult, updateSM2Internal],
  );

  const recordTypingAttempt = useCallback(
    (correct: boolean, entryId?: string, outcome?: "exact" | "typo" | "incorrect") => {
      const resolvedOutcome = outcome ?? (correct ? "exact" : "incorrect");
      const isExact = resolvedOutcome === "exact";
      const isTypo = resolvedOutcome === "typo";
      const isIncorrect = resolvedOutcome === "incorrect";

      setStats((prev) => ({
        ...prev,
        typing: {
          correct: prev.typing.correct + (correct ? 1 : 0),
          exact: (prev.typing.exact ?? 0) + (isExact ? 1 : 0),
          typos: (prev.typing.typos ?? 0) + (isTypo ? 1 : 0),
          incorrect: (prev.typing.incorrect ?? 0) + (isIncorrect ? 1 : 0),
          attempted: prev.typing.attempted + 1,
        },
      }));
      if (entryId) {
        recordEntryResult(entryId, resolvedOutcome);
        const sm2Rating: SM2Rating = isExact ? "good" : isTypo ? "hard" : "again";
        updateSM2Internal(entryId, sm2Rating);
      }
    },
    [recordEntryResult, updateSM2Internal],
  );

  const recordMatchAttempt = useCallback((correct: boolean) => {
    setStats((prev) => ({
      ...prev,
      matching: {
        attempts: prev.matching.attempts + 1,
        pairsCompleted: prev.matching.pairsCompleted + (correct ? 1 : 0),
      },
    }));
  }, []);

  const restart = useCallback(() => {
    startedAtRef.current = Date.now();
    setStats(emptyStats(startedAtRef.current));
    setRetention(new Map());
    setSm2Records(new Map());
    setEpoch((value) => value + 1); // remount the active mode so the round restarts
  }, []);

  const value = useMemo<SessionApi>(
    () => ({
      stats,
      retention,
      sm2Records,
      isPristine: isPristineStats(stats),
      epoch,
      recordFlashcardAssessment,
      recordSM2Assessment,
      recordQuizAnswer,
      recordTypingAttempt,
      recordMatchAttempt,
      recordEntryResult,
      restart,
    }),
    [
      stats,
      retention,
      sm2Records,
      epoch,
      recordFlashcardAssessment,
      recordSM2Assessment,
      recordQuizAnswer,
      recordTypingAttempt,
      recordMatchAttempt,
      recordEntryResult,
      restart,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
