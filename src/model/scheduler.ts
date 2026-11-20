import { createEmptyCard, fsrs, type Card, type Grade, Rating, State } from "ts-fsrs";

// FSRS card state as stored in the `cards` table (times in epoch ms).
export interface SchedState {
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: number | null;
}

export const RATINGS = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy } as const;
export type RatingName = keyof typeof RATINGS;
export const RATING_NAMES: Record<number, RatingName> = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
export const STATE_NAMES: Record<number, string> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

const scheduler = fsrs({ enable_fuzz: true, enable_short_term: true });

function toCard(s: SchedState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as State,
    last_review: s.last_review == null ? undefined : new Date(s.last_review),
  };
}

function fromCard(c: Card): SchedState {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? c.last_review.getTime() : null,
  };
}

export function emptyState(createdAt: number): SchedState {
  return fromCard(createEmptyCard(new Date(createdAt)));
}

/** Apply one review on top of the current state. */
export function applyReview(s: SchedState, rating: number, at: number): SchedState {
  return fromCard(scheduler.next(toCard(s), new Date(at), rating as Grade).card);
}

/**
 * Rebuild a card's state from its full history. Used when a review arrives
 * with a timestamp earlier than the card's last review (e.g. ratings from a
 * lesson entered the next day, after a self-review already happened).
 */
export function replay(createdAt: number, reviews: ReadonlyArray<{ rating: number; reviewed_at: number }>): SchedState {
  const sorted = [...reviews].sort((a, b) => a.reviewed_at - b.reviewed_at);
  const start = Math.min(createdAt, sorted[0]?.reviewed_at ?? createdAt);
  let s = emptyState(start);
  for (const r of sorted) s = applyReview(s, r.rating, r.reviewed_at);
  return s;
}

/** Probability of recall right now (0..1), or null for a never-reviewed card. */
export function retrievability(s: SchedState, now: number): number | null {
  if (s.state === State.New || s.last_review == null) return null;
  return scheduler.get_retrievability(toCard(s), new Date(now), false);
}
