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
export function replay(
  createdAt: number,
  reviews: ReadonlyArray<{ rating: number; reviewed_at: number }>,
  initial?: SchedState | null,
): SchedState {
  const sorted = [...reviews].sort((a, b) => a.reviewed_at - b.reviewed_at);
  if (initial) {
    // Imported schedule: it already accounts for everything up to its last_review.
    const from = initial.last_review ?? -Infinity;
    let s = initial;
    for (const r of sorted) if (r.reviewed_at >= from) s = applyReview(s, r.rating, r.reviewed_at);
    return s;
  }
  const start = Math.min(createdAt, sorted[0]?.reviewed_at ?? createdAt);
  let s = emptyState(start);
  for (const r of sorted) s = applyReview(s, r.rating, r.reviewed_at);
  return s;
}

/** A schedule imported from another tool (all times epoch ms). */
export interface ScheduleInput {
  state?: string | number;
  due: number;
  stability?: number;
  difficulty?: number;
  last_review?: number;
  reps?: number;
  lapses?: number;
}

const STATE_BY_NAME: Record<string, number> = { new: State.New, learning: State.Learning, review: State.Review, relearning: State.Relearning };

/**
 * Turn an imported schedule into a card state. Defaults: state review, last_review = due - stability
 * (else due, at most now), stability = the interval from last_review to due (at least 0.1 day), difficulty 5, reps 1, lapses 0.
 * Throws an Error with a readable message on bad values.
 */
export function importedState(s: ScheduleInput, now: number): SchedState {
  const state = s.state == null ? State.Review : typeof s.state === "number" ? s.state : STATE_BY_NAME[String(s.state).toLowerCase()];
  if (state == null || ![0, 1, 2, 3].includes(state)) throw new Error(`unknown state "${s.state}" (new|learning|review|relearning)`);
  if (!Number.isFinite(s.due)) throw new Error("due is required (ISO time)");
  if (state === State.New) return { ...emptyState(now), due: s.due };
  const last = s.last_review ?? Math.min(now, s.stability != null ? s.due - s.stability * 86_400_000 : s.due);
  if (!Number.isFinite(last)) throw new Error("bad last_review");
  if (last > now + 5 * 60_000) throw new Error("last_review is in the future");
  const interval = Math.max(0, (s.due - last) / 86_400_000);
  const stability = s.stability ?? Math.max(0.1, interval);
  const difficulty = s.difficulty ?? 5;
  if (!(stability > 0)) throw new Error("stability must be > 0 (days)");
  if (!(difficulty >= 1 && difficulty <= 10)) throw new Error("difficulty must be between 1 and 10");
  return {
    due: s.due,
    stability,
    difficulty,
    elapsed_days: 0,
    scheduled_days: Math.round(interval),
    learning_steps: 0,
    reps: s.reps ?? 1,
    lapses: s.lapses ?? 0,
    state,
    last_review: last,
  };
}

/** Probability of recall right now (0..1), or null for a never-reviewed card. */
export function retrievability(s: SchedState, now: number): number | null {
  if (s.state === State.New || s.last_review == null) return null;
  return scheduler.get_retrievability(toCard(s), new Date(now), false);
}
