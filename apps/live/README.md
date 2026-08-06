# Chiku Live

The realtime surface: Chiku sees you, and you answer with your body. One room, no
router, no network. Camera frames, landmarks and anything derived from them never leave
the device — the CSP in `vite.config.ts` makes that a browser rule rather than a promise.

```sh
corepack pnpm --filter @chiku/live vendor:vision   # once: the on-device model bundles
corepack pnpm dev:live                             # :5175
corepack pnpm --filter @chiku/live typecheck && corepack pnpm --filter @chiku/live test
```

## The round

A visit is **three activities** (`ROUND_LENGTH`), drawn from a pool of eight. The round
length is a number in its own right, not "the size of the pool": growing the pool must
never grow the session, because the session cap is the child's play time (§9.5).

The pool is **discovered**, not listed. Every module in `src/activities/` that exports a
`create…Activity` factory is found by glob; the hand-written part is only the metadata in
`ACTIVITY_SPEC` (`src/activities/index.ts`). A module with a factory and no spec entry is
a build failure in `test/rotation.test.ts` — this app has shipped built-but-unreachable
code in three separate phases, and a hand-maintained array is exactly how.

| Activity | Skill | Band | The child… | Signal |
| --- | --- | --- | --- | --- |
| `wave` | gesture | foundation | waves | wrist oscillation |
| `smile` | face | foundation | smiles | face blendshape |
| `peekaboo` | hide | foundation | hides their face, then pops out | face presence |
| `bigsmall` | size | foundation | makes themselves BIG, then small | wrists vs. face |
| `fingers` | count | middle | holds up N fingers | finger angles |
| `thumbs` | gesture | middle | answers yes/no with a thumb | hand gesture |
| `successor` | count | advanced | shows "one more than N" | finger angles |
| `hunt` | look | advanced | finds a colour through a hand-made window | lens coverage |

**How a round is shaped** — three composition rules, no positional ones:

1. Never two activities from the same **skill**. Counting fingers and "what comes after
   three" are one skill in two hats; so are waving and thumbs-up.
2. At most one **advanced** activity. Two concept games in a three-activity session is a
   session the youngest band cannot play.
3. At least one **foundation** activity, so every round contains something a child can do
   by imitation alone, with no instruction understood at all.

The opener is deliberately *not* reserved for the easy ones: rule 3 already guarantees the
round is playable, and reserving slot one would mean the magic window could only ever
appear third. Selection is a stable sort on one random key per activity, so a constant
test random leaves `ACTIVITY_SPEC` order intact — which is why adding a ninth activity
cannot move the fixture four surface test files are written against.

## What every activity owes a child

Enforced generically over the pool in `test/rotation.test.ts`, so a new activity is held
to all of it the day it lands:

- a **tap answer** — a picture, a numeral or a colour, with a real accessible name — that
  works with the camera off, and is reachable and completable in the running app
  (`test/rotation-surface.test.ts` mounts the surface and plays each one to praise);
- a **spoken answer** in both languages, including the Latin transliterations an en-IN
  recogniser actually returns;
- copy in **both dictionaries**, prompt / retry / tap hint / every choice label;
- a hold the **mercy ladder** can scale, and optionally a demonstration it can play;
- **"no evidence" is unknown, never wrong**: an empty frame must score as `unknown`, so a
  tracker that cannot tell never spends the child's slack.

## The sweep

`test/sweep.test.ts` is the durable fix for the failure that has bitten this app three
phases running — something built, tested, green and unreachable. It fails the build on:

- a key in one dictionary and not the other, or Telugu that is not Telugu;
- a dictionary key nothing in `src/` reaches (literally, or through a template `src/`
  actually builds) — sixteen mercy-ladder lines lived here for two phases;
- a `copyKey`/`optionalCopyKey` lookup for a key the dictionaries do not carry;
- an exported component nobody renders;
- praise buckets that do not resolve to three different families of copy. That one is
  hand-written because no key-coverage test can see it: the effort praise looked up
  `praise.light.1` while the copy said `praise.light.one`, so every bucket silently fell
  back to three generic cheers and the child who found it hard and kept going was never
  praised for it.

## Invariants (§9)

No raw audio or video stored or transmitted. No analytics. No PII. Hard session cap. Every
kid-facing string in both `te` and `en`. Teal means "Chiku is attending to you" and
nothing else — never a decoration, never a progress cue.
