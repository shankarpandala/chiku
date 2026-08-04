# Chiku — Prototype v0.1

**The show that hears you.** Chiku is an interactive app for children aged 3–8 (India-first, Telugu + Indian English) where an animated character actually hears the child and talks back. Authored episodes pause at checkpoints where Chiku asks a question, genuinely listens, and responds; a short daily "Call Chiku" mode is a bounded video-call with the character. North-star metric: talk time, not watch time.

This repo holds the **clickable prototype** deliverable from the v0.1 design brief: the 6 product screens (plus TV-stage variants), the character sheet, the mini design system, and the app-icon exploration — ported from the Claude Design canvas into a standalone React app with no design-tool runtime.

## Run it

```sh
npm install
npm run dev
```

Then click through the screens via the left sidebar. Each screen shows a fixed-size device mockup (390×800 phone frame, 16:9 TV frame) beside its design annotations; the step buttons above each frame walk the interaction states (checkpoint states, call states, TV modes). The Parent Dashboard opens by press-and-holding the gate circle for ~2 seconds.

## What's here

| Screen | What it demonstrates |
| --- | --- |
| Kid Home | 5 picture episode cards + one Call Chiku action; zero reading required |
| Episode Player | The checkpoint loop: ask → listening → answered (celebrate) → gentle retry, plus the mic-permission moment |
| Call Chiku | Listening/speaking states, sun-to-moon session meter, warm ending |
| TV Stage | 10-foot layouts of Player and Call, QR pairing card, D-pad focus notes |
| Phone Remote | Giant push-to-talk, picture-chip fallback, grown-up control strip |
| Parent Dashboard | Press-and-hold gate, talk-time stats, transcript, daily limit, language toggle, promises |
| Character Sheet | Chiku the elephant calf: scale tests, 4 emotes, 8 visemes, the listening state |
| Design System | Kid palette, Baloo 2 + Baloo Tammudu 2 type pairing, the 8 components |
| App Icons | 3 options at 180/96/48px |

## Structure

- `src/App.jsx` — the single state machine (screen, checkpoint/call/TV state, gate, language, mouth viseme) and review-shell chrome.
- `src/ChikuFace.jsx` — the character as layered SVG: every emote/viseme is a discrete swappable layer, mouth ready to be driven by TTS timing marks.
- `src/screens/` — one file per screen.
- `src/theme/modernist.css` — the Modernist design system (grown-up chrome), verbatim from the design project.
- `src/theme/global.css` — kid-screen keyframes, focus rings, hover states.
- `src/data/` — palette constants and shared content (answer chips, screen copy).

Two visual languages on purpose: children get the warm Chiku palette with big rounded targets; grown-ups get Modernist (Archivo, zero radius, 2px rules). The switch in typeface and corner radius is itself the signal of whose room you're in.

## Scope note

This is a faithful port of the *design prototype* — a desktop review tool presenting fixed-size device mockups, exactly as designed. The production target in the brief (one responsive PWA across phone/tablet/desktop/TV) is separate follow-up work; no responsive kid-screen layouts were designed in this iteration.
