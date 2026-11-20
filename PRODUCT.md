# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One learner (the owner) studying Japanese, for now. The data model and login support a few more
people later, but there is no plan to open it up; design for one person's daily use.

The learner studies with a human teacher in numbered lessons (cards are tagged `lesson-10` …
`lesson-30`) and with Claude acting as a Japanese teacher. Profile (confirmed): early-stage, kana
known, kanji just starting, **after 2+ years of Duolingo that left little lasting retention**.
Exposure hasn't been the problem; durable recall has. Expect the learner to feel they "should
know" words they can't actually produce, and design for that gap rather than around it.

Two clients, two jobs:
- **Claude (main client, over MCP):** runs text and voice lessons, quizzes, and records ratings
  (`session_start` → quiz → `session_end`). It has no UI; tool descriptions and outputs are its interface.
- **The learner in the browser (`/app`, secondary):** short review sessions **on a phone**, typing
  answers, plus occasional browsing and editing of cards.

## Product Purpose

Personal spaced-repetition flashcards built around how Japanese is actually learned: a word has
three faces (kanji, kana reading, meaning), and each direction between them is a separate skill
with its own FSRS schedule. Success means the learner's real recall improves and the teacher
(human or Claude) knows what to work on: due counts that add up, failures that are visible,
history that separates checked answers from unchecked ones.

## Positioning

Unlike generic flashcard apps (one front, one back), every word is a triangle: knowing what 犬
means doesn't mean you can read it, and reading it doesn't mean you can produce it. The schedule,
prompts and stats are per direction. It's also built to be driven by an AI teacher: lessons
logged after the fact, reviews addressed by the word rather than by card id, ratings with past
timestamps.

## Operating Context

- **Phone, short sessions.** The learner types answers on iOS and switches between the Japanese
  and English keyboards. The web can't switch keyboards for them, so the product forgives wrong-
  keyboard input (romaji for kana, IME-completed kanji, "dog" typed as どg) and flags it instead
  of marking it wrong.
- **Lessons first, flashcards second.** Words come from lessons; voice lessons are rated
  afterwards in text mode; the teacher sees the learner's struggles at the start of each session.
- **Practice mode** lets the learner (or a tester) review cards before they are due without
  touching the schedule.

## Capabilities and Constraints

- Notes: `word` (kanji optional, kana, meaning; optional trap note shown after the answer) and
  `basic` (front/back, for sentences and grammar). Default word directions: kanji→kana,
  kanji→meaning, kana→meaning, meaning→kana; per-deck defaults (e.g. reading-only decks).
- Review in the browser: show one face, type the asked faces, server-side checking, suggested
  rating per card (Again/Hard/Good/Easy) that the learner can override.
- Stack: one Cloudflare Worker (D1, KV), no build step for the UI: a single self-contained HTML
  page (`src/ui/app.html`) with inline CSS/JS, no external fonts, scripts or CDNs, strict CSP.
  Japanese text relies on system fonts (Hiragino, Noto Sans JP, Yu Gothic).
- Login: the Worker's own email/password page; sessions by cookie. No third-party identity.
- Constraint: no headless browser runs in the dev VM, so visual checks happen on the owner's
  devices or via shared screenshots.

## Brand Commitments

Name: "flash" (working title, not a brand). No logo, palette or voice commitments.

## Evidence on Hand

- The learner's real deck: ~285 notes imported from Kuliko (kanji-reading list, lesson
  vocabulary, sentences). Personal content: never put it in public examples or the repo.
- Feedback from the Claude teacher's test sessions (counts, prompts, matching), recorded in
  `plan.md`.
- No users beyond the owner, no testimonials, no usage metrics.

## Product Principles

1. **Retention over exposure.** Two years of streak-driven practice didn't stick, so this
   product optimises for durable recall: typed production over recognition, honest grading,
   spaced reviews, no streaks or points that reward showing up over remembering.
2. **Each direction is its own skill.** Never merge or hide per-direction status; show the
   learner exactly which link (reading, meaning, production) is weak.
3. **Forgive the keyboard, not the knowledge.** Input slips (romaji, IME kanji, wrong keyboard)
   are accepted with a visible note; a wrong reading is still wrong.
4. **Honest numbers.** Counts reconcile, unverified answers are marked as such, practice doesn't
   silently change the schedule.
5. **Phone first, seconds per card.** A review should be: see the prompt, type, check, next,
   with the minimum of taps and keyboard switches.
6. **The teacher is the main client.** Anything the browser can do, Claude must be able to do
   over MCP; the UI is a window onto the same data, not a separate product.
