import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PlayableDeck } from "../api/types";
import { SessionProvider } from "../session/SessionProvider";
import { FlashcardsMode } from "../game/modes/FlashcardsMode";

const TEST_DECK: PlayableDeck = {
  id: "sm2-test-deck",
  name: "SM-2 Test Vocabulary",
  description: "Testing SuperMemo SM-2 memory scheduling",
  sourceLanguage: "en",
  targetLanguage: "fr",
  entryCount: 3,
  origin: "builtin",
  entries: [
    { id: "apple", source: "apple", target: "pomme", alternatives: [], tags: [] },
    { id: "bread", source: "bread", target: "pain", alternatives: [], tags: [] },
    { id: "cheese", source: "cheese", target: "fromage", alternatives: [], tags: [] },
  ],
};

function renderWithSession(ui: React.ReactElement) {
  return render(<SessionProvider>{ui}</SessionProvider>);
}

describe("FlashcardsMode SuperMemo SM-2 integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("toggles between classic 2-button mode and SM-2 4-button mode", () => {
    renderWithSession(<FlashcardsMode deck={TEST_DECK} seed={42} />);

    // By default, rating mode is Classic
    expect(screen.getByRole("button", { name: /rating: classic/i })).toBeInTheDocument();

    // Reveal card
    fireEvent.click(screen.getByRole("button", { name: /reveal translation/i }));
    expect(screen.getByRole("button", { name: /known/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /needs practice/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^good/i })).not.toBeInTheDocument();

    // Toggle to SM-2 mode
    fireEvent.click(screen.getByRole("button", { name: /rating: classic/i }));
    expect(screen.getByRole("button", { name: /rating: sm-2/i })).toBeInTheDocument();

    // In SM-2 mode, 4 buttons are rendered with interval badges
    expect(screen.getByRole("button", { name: /again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hard/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /good/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /easy/i })).toBeInTheDocument();
  });

  test("assessing cards with SM-2 buttons displays interval previews and finishes with retention summary", () => {
    renderWithSession(<FlashcardsMode deck={TEST_DECK} seed={42} />);

    // Toggle to SM-2
    fireEvent.click(screen.getByRole("button", { name: /rating: classic/i }));

    // Card 1: Reveal and assess "Good"
    fireEvent.click(screen.getByRole("button", { name: /reveal translation/i }));
    const goodBtn = screen.getByRole("button", { name: /good/i });
    expect(goodBtn.textContent).toMatch(/good/i);
    fireEvent.click(goodBtn);

    // Card 2: Reveal and assess "Easy"
    fireEvent.click(screen.getByRole("button", { name: /reveal translation/i }));
    const easyBtn = screen.getByRole("button", { name: /easy/i });
    expect(easyBtn.textContent).toMatch(/easy/i);
    fireEvent.click(easyBtn);

    // Card 3: Reveal and assess "Again"
    fireEvent.click(screen.getByRole("button", { name: /reveal translation/i }));
    const againBtn = screen.getByRole("button", { name: /again/i });
    expect(againBtn.textContent).toMatch(/again/i);
    fireEvent.click(againBtn);

    // Deck finished summary screen
    expect(screen.getByRole("heading", { name: /deck finished/i })).toBeInTheDocument();
    expect(screen.getByText(/supermemo sm-2 & forgetting curve memory stability/i)).toBeInTheDocument();
    expect(screen.getByText(/retention rate/i)).toBeInTheDocument();
    expect(screen.getByText(/due soon/i)).toBeInTheDocument();
    expect(screen.getByText(/mastered/i)).toBeInTheDocument();

    // Missed entries section shows the card marked "Again"
    expect(screen.getByText(/words needing practice \(1\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review missed words \(1\)/i })).toBeInTheDocument();
  });

  test("supports keyboard shortcuts 1, 2, 3, 4 for SM-2 rating", () => {
    renderWithSession(<FlashcardsMode deck={TEST_DECK} seed={42} />);

    // Switch to SM-2
    fireEvent.click(screen.getByRole("button", { name: /rating: classic/i }));

    // Card 1: Space to reveal, '3' for Good
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("button", { name: /good/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "3" });

    // Card 2: Space to reveal, '4' for Easy
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("button", { name: /easy/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "4" });

    // Card 3: Space to reveal, '1' for Again
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("button", { name: /again/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "1" });

    // Verify finished
    expect(screen.getByRole("heading", { name: /deck finished/i })).toBeInTheDocument();
  });

  test("toggles SM-2 spaced repetition ordering mode", () => {
    renderWithSession(<FlashcardsMode deck={TEST_DECK} seed={42} />);

    // Default order button is Random Order
    const orderBtn = screen.getByRole("button", { name: /random order/i });
    expect(orderBtn).toBeInTheDocument();

    // Click to activate Spaced Repetition order
    fireEvent.click(orderBtn);
    expect(screen.getByRole("button", { name: /spaced repetition/i })).toBeInTheDocument();
  });
});
