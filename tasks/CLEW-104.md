---
id: CLEW-104
title: v0.10 keyboard controls acceptance and release
status: in_progress
release: v0.10
priority: P0
size: M
depends_on: [CLEW-099, CLEW-102, CLEW-103]
parallel_group: null
owner: codex
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-104 — v0.10 keyboard controls acceptance and release

## Objective

Prove and publish the focused v0.10 keyboard-controls release across browser-reserved shortcuts, Task states, embedded/external terminal access, change inspection, accessibility, packaging, and upgrade/regression boundaries.

## User outcome

A clean v0.10 installation provides predictable keyboard-first Task navigation and actions, visible key hints, and honest browser/platform fallbacks without regressing pointer use, terminal input, Task lifecycle, or the existing settings modal.

## Context

CLEW-101–103 introduce a shared keyboard surface over existing UI and daemon actions. Modifier handling and browser-reserved keys cannot be proven by component tests alone. This card owns the real-browser matrix, final release documentation, versioning, package contents, and independent review evidence.

## Scope

- execute the release matrix in supported macOS Safari, Chrome, and Firefox versions, plus the available standalone/PWA surface if supported;
- record whether `Cmd+1…0` reaches Clew in each host and verify the documented fallback wherever it does not;
- exercise zero, fewer than ten, ten, and more than ten Tasks across filters, Projects, ordering updates, refresh, reconnect, and daemon restart;
- exercise Continue across approval, waiting terminal, READY, WAITING_FOR_HUMAN, running, failed/unavailable, and duplicate-input paths;
- exercise internal/external Changes with multiple runs, exact run selection, clean committed worktrees, and unavailable/Runner-local cases;
- exercise embedded/external terminals, multiple active sessions, application switching, xterm input, and Controller/Runner locality;
- perform keyboard-only, VoiceOver, reduced-motion, desktop, and narrow-width acceptance for key hints and shortcut help;
- complete independent counterexample-oriented review, installed-package acceptance, migration/regression checks, version bump, release notes, and publication evidence.

## Out of scope

- plugin extraction for terminal, IDE, or ChangeViewer;
- a desktop wrapper created solely to capture browser-reserved shortcuts;
- new task lifecycle, Git mutation, merge/push, or automatic completion behavior;
- plugin availability/execution wiring for the CLEW-099 settings choice.

## Deliverables

- reproducible v0.10 browser/keyboard/terminal acceptance record;
- resolved review findings for CLEW-099 and CLEW-101–103;
- `RELEASE-0.10.md`, README/package references, version update, changelog, and packaged-artifact verification;
- final quality-gate and publication evidence.

## Acceptance criteria

1. The browser matrix documents actual reserved-key behavior and every supported host has a working, visible path to Tasks 1–10.
2. Numbered navigation and context actions remain correct through filters, state transitions, multiple runs/sessions, reconnect, and daemon restart without duplicate commands.
3. Text inputs, confirmation dialogs, command palette, and xterm preserve expected keyboard behavior while all documented application shortcuts remain reachable.
4. Internal/external Changes and embedded/external terminal flows target exact run/session identities and respect unavailable and Runner-local boundaries.
5. Key hints and shortcut help pass keyboard-only, VoiceOver, contrast, reduced-motion, desktop, narrow-width, blur, and application-switching acceptance.
6. Clean install and upgrade preserve existing Tasks/settings, the package contains current UI/docs, all repository checks pass, and v0.10 release evidence is reproducible.

## Acceptance evidence

| Criterion | Automated evidence and artifact                           | Logical scenarios                                                                                   | Result  |
| --------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| AC-1      | browser smoke record in `RELEASE-0.10.md`                 | Safari; Chrome; Firefox; Cmd reserved/delivered; Option fallback; 1st/10th Task                     | pending |
| AC-2      | full UI suite plus daemon reconnect/restart tests         | filters; Projects; ordering; state changes; multiple runs/sessions; duplicate activation            | pending |
| AC-3      | scope regression suite plus manual xterm flow             | input; textarea; modal; palette; xterm; IME; repeat; click/key equivalence                          | pending |
| AC-4      | UI/backend integration and installed smoke                | exact change run; committed worktree; selected session; external app; unavailable; runner-local     | pending |
| AC-5      | accessibility tests and visual/manual record              | keyboard-only; VoiceOver; contrast; reduced motion; narrow; blur; app switch                        | pending |
| AC-6      | `npm run check`, installed acceptance, package inspection | existing database; saved preferences; current UI bundle; docs; version; changelog; release artifact | pending |

## Verification

- run `npm run check` from a clean supported checkout;
- run `npm run acceptance:installed` against the packed v0.10 artifact;
- complete the documented real-browser and live-terminal matrix;
- upgrade a copied v0.9 data directory and verify Tasks and UI preferences;
- inspect package contents and served `ui/dist` for current keyboard UI and documentation;
- complete independent review before marking any release card done.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Depends on the reviewed settings slice and both post-registry UI work packages. Owns integration, acceptance, versioning, and release artifacts; it does not absorb unfinished implementation from its dependencies.

## Risks

- a browser may reserve the preferred Command-number chord with no reliable page override;
- synthetic keyboard tests can pass while modifier loss or xterm capture fails in a real host;
- a stale production UI bundle can make source tests pass while the installed app lacks the feature.

## Blockers

None.

## Completion record

Not completed.
