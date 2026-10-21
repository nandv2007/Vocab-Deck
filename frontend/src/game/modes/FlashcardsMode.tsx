import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayableDeck, VocabularyEntry } from "../../api/types";
import {
  buildAdaptiveFlashcardOrder,
  buildFlashcardOrder,
  buildMistakeReviewOrder,
} from "../engine";
import {
  buildSM2StudyOrder,
  formatInterval,
  predictRetention,
  previewNextIntervals,
  type SM2Rating,
} from "../sm2";
import { parseBoundedCount } from "../roundSize";
import { useSessionSeed } from "../useSessionSeed";
import { rise, useAnimationRegistry } from "../../lib/motion";
import { useSession } from "../../session/useSession";
import { languageName } from "../../lang/display";
import { nativeScript } from "../translationDisplay";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { ProgressBar } from "../../components/ProgressBar";
import { RoundSizeField } from "../../components/RoundSizeField";

export const AUTO_REVEAL_MS = 3000;
/** Most cards a single flashcard round can contain (full 50-entry deck). */
export const MAX_ROUND = 50;

/**
 * Flashcards: show the source word, reveal the translation (automatically or on
 * demand), then self-assess. Supports standard shuffle or Leitner spaced-repetition
 * prioritization, keyboard shortcuts (Space to reveal, 1/2 or arrows to assess),
 * and targeted review of missed words.
 */
export function FlashcardsMode({ deck, seed }: { deck: PlayableDeck; seed?: number }) {
  const { recordFlashcardAssessment, recordSM2Assessment, retention, sm2Records } = useSession();
  const register = useAnimationRegistry();
  const { rng, reshuffle } = useSessionSeed(seed);
  const [useAdaptive, setUseAdaptive] = useState(false);
  const [ratingMode, setRatingMode] = useState<"classic" | "sm2">("classic");
  const [reviewQueue, setReviewQueue] = useState<VocabularyEntry[] | null>(null);

  const fullOrder = useMemo(() => {
    if (useAdaptive) {
      if (ratingMode === "sm2") {
        return buildSM2StudyOrder(deck.entries, sm2Records, rng);
      }
      return buildAdaptiveFlashcardOrder(deck.entries, retention, rng);
    }
    return buildFlashcardOrder(deck.entries, rng);
    // Stable order during a round; reshuffle() rebuilds when starting a new round or changing size
  }, [deck.entries, rng, useAdaptive, ratingMode]);

  const [roundSize, setRoundSize] = useState(() => Math.min(fullOrder.length, MAX_ROUND));
  const [sizeInput, setSizeInput] = useState(() => String(Math.min(fullOrder.length, MAX_ROUND)));
  const maxRound = Math.min(fullOrder.length, MAX_ROUND);

  const order = useMemo(() => {
    if (reviewQueue !== null) return reviewQueue;
    return fullOrder.slice(0, Math.min(roundSize, maxRound));
  }, [fullOrder, reviewQueue, roundSize, maxRound]);

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [roundAssessments, setRoundAssessments] = useState<
    Map<string, { entry: VocabularyEntry; assessment: "known" | "needsPractice" }>
  >(() => new Map());

  const timerRef = useRef<number | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Unmount cleanup (also fires on mode switches).
  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (revealed || finished) return;
    timerRef.current = window.setTimeout(() => setRevealed(true), AUTO_REVEAL_MS);
    return clearTimer;
  }, [index, revealed, finished, clearTimer]);

  useEffect(() => {
    if (finished) register(rise(summaryRef.current));
  }, [finished, register]);

  const changeRoundSize = useCallback(
    (next: number) => {
      clearTimer();
      setRoundSize(next);
      setSizeInput(String(next));
      setReviewQueue(null);
      setRoundAssessments(new Map());
      reshuffle();
      setIndex(0);
      setRevealed(false);
      setFinished(false);
    },
    [clearTimer, reshuffle],
  );

  /** Accept only whole numbers inside the deck's range; otherwise revert. */
  const commitRoundSize = useCallback(
    (raw: string) => {
      const parsed = parseBoundedCount(raw, maxRound);
      if (parsed === null) {
        setSizeInput(String(Math.min(roundSize, maxRound)));
        return;
      }
      if (parsed !== roundSize) changeRoundSize(parsed);
      else setSizeInput(String(parsed));
    },
    [changeRoundSize, maxRound, roundSize],
  );

  const advance = useCallback(() => {
    clearTimer();
    if (index + 1 >= order.length) {
      setFinished(true);
      return;
    }
    setIndex(index + 1);
    setRevealed(false);
  }, [clearTimer, index, order.length]);

  const assess = useCallback(
    (assessment: "known" | "needsPractice") => {
      const currentEntry = order[index];
      if (currentEntry) {
        recordFlashcardAssessment(assessment, currentEntry.id);
        setRoundAssessments((prev) => {
          const next = new Map(prev);
          next.set(currentEntry.id, { entry: currentEntry, assessment });
          return next;
        });
      }
      advance();
    },
    [advance, index, order, recordFlashcardAssessment],
  );

  const assessSM2 = useCallback(
    (rating: SM2Rating) => {
      const currentEntry = order[index];
      if (currentEntry) {
        recordSM2Assessment(currentEntry.id, rating);
        const legacyAssessment = rating === "again" ? "needsPractice" : "known";
        setRoundAssessments((prev) => {
          const next = new Map(prev);
          next.set(currentEntry.id, { entry: currentEntry, assessment: legacyAssessment });
          return next;
        });
      }
      advance();
    },
    [advance, index, order, recordSM2Assessment],
  );

  // Keyboard navigation: Space/Enter reveals; in classic mode: 1/Left = needsPractice, 2/Right = known;
  // in SM-2 mode: 1 = again, 2 = hard, 3 = good, 4 = easy
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (finished) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      if (!revealed) {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          clearTimer();
          setRevealed(true);
        }
      } else {
        if (ratingMode === "sm2") {
          if (event.key === "1" || event.key === "ArrowLeft") {
            event.preventDefault();
            assessSM2("again");
          } else if (event.key === "2") {
            event.preventDefault();
            assessSM2("hard");
          } else if (event.key === "3" || event.key === "ArrowRight") {
            event.preventDefault();
            assessSM2("good");
          } else if (event.key === "4") {
            event.preventDefault();
            assessSM2("easy");
          }
        } else {
          if (event.key === "1" || event.key === "ArrowLeft") {
            event.preventDefault();
            assess("needsPractice");
          } else if (event.key === "2" || event.key === "ArrowRight") {
            event.preventDefault();
            assess("known");
          }
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assess, assessSM2, clearTimer, finished, ratingMode, revealed]);

  const restart = useCallback(() => {
    clearTimer();
    reshuffle();
    setReviewQueue(null);
    setRoundAssessments(new Map());
    setIndex(0);
    setRevealed(false);
    setFinished(false);
  }, [clearTimer, reshuffle]);

  const missedEntries = useMemo(
    () =>
      Array.from(roundAssessments.values())
        .filter((item) => item.assessment === "needsPractice")
        .map((item) => item.entry),
    [roundAssessments],
  );

  const knownCount = useMemo(
    () =>
      Array.from(roundAssessments.values()).filter((item) => item.assessment === "known").length,
    [roundAssessments],
  );

  const sm2Summary = useMemo(() => {
    let totalRet = 0;
    let reviewedCount = 0;
    let dueSoon = 0;
    let mastered = 0;
    for (const e of deck.entries) {
      const rec = sm2Records.get(e.id);
      if (rec && rec.totalReviews > 0) {
        reviewedCount += 1;
        const ret = predictRetention(rec);
        totalRet += ret;
        if (rec.interval <= 1 || ret < 0.9) dueSoon += 1;
        if (rec.repetition >= 2 && rec.interval >= 6) mastered += 1;
      }
    }
    const avgRetention = reviewedCount > 0 ? Math.round((totalRet / reviewedCount) * 100) : 100;
    return { avgRetention, dueSoon, mastered, reviewedCount };
  }, [deck.entries, sm2Records]);

  const startMistakeReview = useCallback(() => {
    if (missedEntries.length === 0) return;
    clearTimer();
    const reviewOrder = buildMistakeReviewOrder(missedEntries, rng);
    setReviewQueue(reviewOrder);
    setRoundAssessments(new Map());
    setIndex(0);
    setRevealed(false);
    setFinished(false);
  }, [clearTimer, missedEntries, rng]);

  if (finished) {
    return (
      <div ref={summaryRef}>
        <Panel className="stack summary">
          <h3>{reviewQueue ? "Review round finished" : "Deck finished"}</h3>
          <p className="muted">
            You reviewed all {order.length} cards: {knownCount} marked known
            {missedEntries.length > 0 ? `, ${missedEntries.length} needing practice` : ""}.
          </p>

          <div className="sm2-retention-panel stack-tight">
            <span className="label">SuperMemo SM-2 & Forgetting Curve Memory Stability</span>
            <div className="review-stats-grid">
              <div className="review-stat-card">
                <span className="label">Retention Rate</span>
                <div className="review-stat-count">{sm2Summary.avgRetention}%</div>
              </div>
              <div className="review-stat-card">
                <span className="label">Due Soon</span>
                <div className="review-stat-count">{sm2Summary.dueSoon}</div>
              </div>
              <div className="review-stat-card">
                <span className="label">Mastered</span>
                <div className="review-stat-count">{sm2Summary.mastered}</div>
              </div>
            </div>
          </div>

          {missedEntries.length > 0 ? (
            <div className="stack-tight mistake-section">
              <span className="label">Words needing practice ({missedEntries.length}):</span>
              <ul className="mistake-list">
                {missedEntries.map((e) => (
                  <li key={e.id} className="mistake-item">
                    <span className="mistake-word">
                      <strong>{e.source}</strong> → {e.target}
                    </span>
                    {nativeScript(e).length > 0 ? (
                      <span className="faint mistake-native">({nativeScript(e).join(", ")})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="notice notice-pill">
              Outstanding! All reviewed cards were marked as known.
            </p>
          )}

          <div className="row">
            {missedEntries.length > 0 ? (
              <Button variant="primary" onClick={startMistakeReview}>
                Review Missed Words ({missedEntries.length})
              </Button>
            ) : null}
            <Button
              variant={missedEntries.length > 0 ? "secondary" : "primary"}
              onClick={restart}
            >
              {reviewQueue ? "Back to full deck" : "Study again"}
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  const entry = order[index];
  const currentSM2Record = entry ? sm2Records.get(entry.id) : undefined;
  const intervalPreviews = previewNextIntervals(currentSM2Record);

  return (
    <div className="stack">
      <div className="row row-space round-controls">
        <span className="label">
          {reviewQueue ? "Reviewing card" : "Card"} {index + 1} of {order.length}
        </span>
        <div className="row round-control-group">
          {!reviewQueue ? (
            <button
              type="button"
              className={`mode-order-button${useAdaptive ? " is-active" : ""}`}
              onClick={() => {
                setUseAdaptive((prev) => !prev);
                reshuffle();
                setIndex(0);
                setRevealed(false);
                setRoundAssessments(new Map());
              }}
              title="Prioritize low-retention vocabulary using Leitner spaced repetition"
            >
              {useAdaptive ? "Spaced Repetition" : "Random Order"}
            </button>
          ) : null}
          {!reviewQueue ? (
            <button
              type="button"
              className={`mode-order-button sm2-rating-toggle${ratingMode === "sm2" ? " is-active" : ""}`}
              onClick={() => setRatingMode((prev) => (prev === "classic" ? "sm2" : "classic"))}
              title="Toggle between Classic (2-button) and SuperMemo SM-2 (4-button) assessment"
            >
              {ratingMode === "sm2" ? "Rating: SM-2" : "Rating: Classic"}
            </button>
          ) : null}
          {!reviewQueue ? (
            <RoundSizeField
              id="flashcard-round-size"
              label="Cards this round"
              max={maxRound}
              value={sizeInput}
              onChange={setSizeInput}
              onCommit={commitRoundSize}
            />
          ) : null}
        </div>
        <ProgressBar value={index} max={order.length} label={`${index} reviewed`} />
      </div>

      <Panel className={`stack flashcard flashcard-flip${revealed ? " is-revealed" : ""}`}>
        <div className="flashcard-flipper">
          <div className="flashcard-face flashcard-face-front" aria-hidden="true">
            <span className="label">{languageName(deck.sourceLanguage)}</span>
            <p className="flashcard-word lang-text" lang={deck.sourceLanguage}>
              {entry.source}
            </p>
            <p className="faint">The translation appears automatically after 3 seconds, or press Space.</p>
          </div>
          <div className="flashcard-face flashcard-face-back" aria-hidden="true">
            <span className="label">{languageName(deck.targetLanguage)}</span>
            <p className="flashcard-word flashcard-translation lang-text" lang={deck.targetLanguage}>
              {entry.target}
            </p>
            {nativeScript(entry).length > 0 ? (
              <p className="flashcard-native lang-text" lang="ja">
                {nativeScript(entry).join(" · ")}
              </p>
            ) : null}
            {entry.alternatives.length > 0 ? (
              <p className="faint">Also accepted: {entry.alternatives.join(", ")}</p>
            ) : null}
          </div>
        </div>
        {/* Screen-reader announcement; the visual faces are decorative here. */}
        <p className="sr-only" role="status">
          {revealed
            ? `Translation of ${entry.source}: ${entry.target}${
                nativeScript(entry).length > 0 ? ` (${nativeScript(entry).join(", ")})` : ""
              }.`
            : `Card showing ${entry.source}. Translation hidden.`}
        </p>
      </Panel>

      {revealed ? (
        ratingMode === "sm2" ? (
          <div className="row flashcard-actions sm2-actions">
            <Button
              variant="danger-outline"
              onClick={() => assessSM2("again")}
              title="Press 1 or Arrow Left"
            >
              Again <span className="sm2-interval-badge">({formatInterval(intervalPreviews.again)})</span>{" "}
              <span aria-hidden="true" className="kbd-hint">[1]</span>
            </Button>
            <Button
              variant="secondary"
              onClick={() => assessSM2("hard")}
              title="Press 2"
            >
              Hard <span className="sm2-interval-badge">({formatInterval(intervalPreviews.hard)})</span>{" "}
              <span aria-hidden="true" className="kbd-hint">[2]</span>
            </Button>
            <Button
              variant="primary"
              onClick={() => assessSM2("good")}
              title="Press 3 or Arrow Right"
            >
              Good <span className="sm2-interval-badge">({formatInterval(intervalPreviews.good)})</span>{" "}
              <span aria-hidden="true" className="kbd-hint">[3]</span>
            </Button>
            <Button
              variant="primary"
              onClick={() => assessSM2("easy")}
              title="Press 4"
            >
              Easy <span className="sm2-interval-badge">({formatInterval(intervalPreviews.easy)})</span>{" "}
              <span aria-hidden="true" className="kbd-hint">[4]</span>
            </Button>
          </div>
        ) : (
          <div className="row flashcard-actions">
            <Button variant="primary" onClick={() => assess("known")} title="Press 2 or Arrow Right">
              Known <span aria-hidden="true" className="kbd-hint">[2]</span>
            </Button>
            <Button
              variant="danger-outline"
              onClick={() => assess("needsPractice")}
              title="Press 1 or Arrow Left"
            >
              Needs practice <span aria-hidden="true" className="kbd-hint">[1]</span>
            </Button>
          </div>
        )
      ) : (
        <Button
          variant="primary"
          onClick={() => {
            clearTimer();
            setRevealed(true);
          }}
          title="Press Space"
        >
          Reveal translation <span aria-hidden="true" className="kbd-hint">[Space]</span>
        </Button>
      )}
    </div>
  );
}
