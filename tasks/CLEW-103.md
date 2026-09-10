---
id: CLEW-103
title: Command key hints and shortcut discovery
status: in_review
release: v0.10
priority: P1
size: M
depends_on: [CLEW-101]
parallel_group: v0.10-keyboard-ui
owner: codex
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-103 — Command key hints and shortcut discovery

## Objective

Make keyboard control discoverable by showing compact shortcut badges over the relevant visible controls while Command is held, and expose the same registry through a keyboard-help surface.

## User outcome

An operator can hold Command and immediately see which number opens each of the first ten Tasks and which keys invoke Continue, Changes, terminal access, and the command palette. The overlay remains visually stable and disappears reliably.

## Context

Shortcut discovery is part of the requested Ghostty-like interaction. CLEW-101 provides the canonical metadata and availability predicates. The hints must reflect actual handlers and rendered Task order; hand-authored badges would drift from behavior.

## Scope

- detect a deliberate Command hold and reveal the overlay after a short threshold around 180 ms;
- show `1…9, 0` beside the matching visible Task rows;
- show registry-derived badges beside Continue/Start/Focus terminal, internal/external Changes, embedded/external terminal, and command-palette controls;
- render disabled hints with a concise availability reason without enabling the action;
- anchor badges over element edges without layout shift, obscuring labels, or changing pointer targets;
- close/reset on Command keyup, Escape, window blur, `visibilitychange`, navigation, modal changes, and component unmount;
- expose a Keyboard shortcuts help entry from the command palette for touch and assistive discovery;
- supply accessible names/descriptions and respect reduced-motion and narrow-width layouts.

## Out of scope

- inventing direct global shortcuts for destructive or rare actions outside the v0.10 map;
- changing control-plane commands or Task lifecycle;
- making disabled actions executable through the overlay;
- replacing standard Tab/Shift+Tab navigation and native button activation.

## Deliverables

- Command-hold state hook/controller;
- reusable key-hint badge and anchored overlay styles;
- sidebar and Task-action integration driven by the registry;
- keyboard-help surface;
- UI, accessibility, responsive-layout, and stuck-state regression tests.

## Acceptance criteria

1. Holding Command reveals the correct current badges; a normal fast shortcut does not create a distracting persistent flash.
2. Sidebar numbers match the same rendered Task positions used by CLEW-101 across filters, sorting, Project changes, and fewer than ten Tasks.
3. Every v0.10 shortcut-enabled visible control shows its actual registry chord and availability; no displayed hint lacks a matching handler.
4. The overlay causes no measurable layout shift, does not cover essential labels or controls, and remains usable at desktop and narrow supported widths.
5. Keyup, Escape, blur, visibility change, navigation, modal transitions, and unmount always clear overlay state.
6. Keyboard help, screen-reader text, focus behavior, contrast, and reduced-motion behavior meet the existing UI accessibility baseline.

## Acceptance evidence

| Criterion | Automated evidence                                        | Logical scenarios                                           | Result |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` hold-threshold tests                | short chord; deliberate hold; no persistent flash           | pass   |
| AC-2      | sidebar key-hint mapping tests                            | fewer than ten; rendered order; filter                      | pass   |
| AC-3      | registry-to-badge consistency tests via `listShortcuts()` | enabled; no orphan badge; hint matches registry             | pass   |
| AC-4      | component/anchor assertions plus CLEW-104 visual smoke    | decorative badge; anchored to control; no layout-owned text | pass   |
| AC-5      | overlay reset lifecycle tests                             | keyup; Escape; blur; hidden tab; navigation; modal          | pass   |
| AC-6      | keyboard-help tests plus CLEW-104 acceptance              | help entry from palette; chord/labels; reduced-motion CSS   | pass   |

## Verification

- run focused UI tests for overlay timing, mappings, lifecycle resets, and accessibility;
- inspect desktop and narrow layouts with long labels and scroll;
- test application switching while Command remains physically held;
- run `npm run ui:check` and lint before review.

## Review record

- Verdict: pass (author review; independent third-party review still outstanding, tracked in CLEW-104)
- Reviewer: implementation author, 2026-09-10
- Findings: Four issues found and fixed. (1) The keyboard help and key-hint badges read the singleton registry snapshot, which could lag task transitions by one render; both now derive from the current shortcut definitions, and the per-task binding ref resets outside the task view (overview help shows an explicit "open a task" reason). (2) The shortcut help showed only primary chords, hiding the documented `Option/Alt` fallback; fallback chords are now listed per action. (3) The terminal chooser and shortcut help had no Escape handling or initial focus, unlike the settings/finalization modals; both use a shared `useModalDismiss` hook. (4) Chord/fallback strings were macOS-only; they are now platform-aware. Verified: `npm run check` green (240 backend, 99 UI), `tsc --noEmit` and eslint clean, installed acceptance passed for the packed artifact.

## Dependencies and parallelization

Depends on CLEW-101 registry metadata. May run in parallel with CLEW-102. It consumes action definitions without owning their command semantics.

## Risks

- modifier keyup can be lost when the browser window loses focus;
- overlays can obscure compact controls or become noisy during ordinary shortcuts;
- duplicated visual chord strings can drift from actual platform dispatch.

## Blockers

None.

## Completion record

Not completed.
