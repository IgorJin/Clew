---
id: CLEW-099
title: Settings modal with Agent chapter (UI only, no availability checks)
status: in_review
release: v0.10
priority: P1
size: S
depends_on: []
parallel_group: null
owner: null
updated: 2026-09-09
evidence_policy: v1
---

# CLEW-099 — Settings modal with Agent chapter (UI only, no availability checks)

## Objective

Add a gear-icon settings entry point to the Web UI that opens a modal with chapters, starting with an `Agent` chapter where the operator can pick one of three agent connections — Codex CLI, Claude CLI, OpenCode CLI. This card delivers the modal surface only: no availability or authorization checks, no diagnostics wiring, no backend calls. The choice is stored as a local UI preference and is visibly marked as not verified and not yet applied to execution.

## User outcome

The operator clicks the gear icon, opens the settings modal, switches to the `Agent` chapter, and chooses one of the three agent connections. The choice persists across reloads. The modal honestly states that availability is not verified in this slice and that execution behavior is unchanged.

## Context

[`docs/PLUGIN-ARCHITECTURE.md`](../docs/PLUGIN-ARCHITECTURE.md) defines `AgentRuntime` plugins (Codex, OpenCode, Claude Code) and requires the UI to be built from a safe connection projection without implying equal capabilities. This card is the first UI-only step toward that settings surface: modal shell, chapters navigation, and the `Agent` chapter with three selectable entries. Availability checks, backend persistence, and execution wiring are explicitly deferred to a follow-up card.

## Scope

- gear icon button in the top bar (`aria-label="Settings"`) that opens the settings modal;
- modal with chapters navigation; `Agent` is the first implemented chapter (chapter infrastructure must allow adding further chapters without rework);
- `Agent` chapter lists exactly three selectable connections: Codex CLI, Claude CLI, OpenCode CLI;
- selecting a connection stores it as a local UI preference (same localStorage mechanism as existing UI preferences) and the selection survives reload;
- the chapter carries an explicit notice: availability is not verified and the selection does not change execution yet;
- the modal makes zero backend/API calls and behaves identically with fixtures, with a connected daemon, and with a disconnected daemon;
- UI tests for the modal, chapters, selection, and persistence.

## Out of scope

- any availability, login, version, or capability checks (no doctor wiring, no recheck actions, no statuses);
- backend persistence, API contracts, or execution wiring for the selection (follow-up card);
- entering, displaying, or storing API keys, tokens, or any other secrets; OAuth flows;
- changing which runtime executes roles or how models are routed (CLEW-062 behavior is unchanged);
- P1 registry/contracts, Runner protocol v2, the Claude adapter itself (P3), telemetry/pricing/viewer/notification plugins;
- sound, OS notifications, or toasts.

## Deliverables

- gear button in the top bar and settings modal with chapters navigation;
- `Agent` chapter with three selectable connection entries and the not-verified notice;
- local-preference persistence for the selection;
- short documentation paragraph (settings surface and its UI-only limits) in `docs/UI.md` or a settings note referenced from it;
- UI tests covering the acceptance criteria.

## Acceptance criteria

1. The gear icon opens the settings modal with chapters; the `Agent` chapter is selectable; `Escape` closes the modal and focus returns to the gear button.
2. The `Agent` chapter shows Codex CLI, Claude CLI, and OpenCode CLI entries — no more, no fewer.
3. Selecting a connection marks it selected and persists the choice across reload via the local UI preference; no backend or API call is issued on select or on modal open.
4. The chapter visibly states that availability is not verified and that the selection does not change execution; no status, badge, or wording implies a connection was checked or works.
5. The modal renders and behaves identically without a daemon, with a connected daemon, and with a disconnected daemon.
6. No secret (token, key, credential fragment) appears in the UI, fixtures, snapshots, or test output.

## Acceptance evidence

| Criterion | Automated evidence | Logical scenarios | Result |
| --------- | ------------------ | ----------------- | ------ |
| AC-1 | `ui/src/App.test.tsx` (settings modal open/chapters/Esc/focus) | open via gear; Agent select; Esc close; focus return | pass |
| AC-2 | `ui/src/App.test.tsx` (three connections) | exactly Codex/Claude/OpenCode entries | pass |
| AC-3 | `ui/src/App.test.tsx` (selection persists, no calls) | select each entry; reload restores; fetch/WebSocket call count is zero | pass |
| AC-4 | `ui/src/App.test.tsx` (not-verified notice) | notice text present; no status/check wording anywhere in the chapter | pass |
| AC-5 | `ui/src/App.test.tsx` (daemon-independent) | no-daemon, connected, and disconnected renders are equivalent | pass |
| AC-6 | `ui/src/App.test.tsx` (no secrets) | fixtures and snapshots contain no credential-like strings | pass |

## Verification

- run the UI suite for the modal, chapters, selection, and persistence;
- run the full release quality gate (backend tests, UI tests, lint) before `done`;
- verify via test doubles that opening the modal and selecting a connection issues no network calls;
- verify selection survives reload and Reset-free private-mode storage failure does not break the modal.

## Review record

- Verdict: pass
- Reviewer: counterexample-oriented review, 2026-09-09
- Findings: One issue found and fixed during review: the committed production bundle `ui/dist` (served by the daemon) had gone stale relative to `ui/src`; `npm run build --prefix ui` was re-run and the new bundle verified to contain the settings modal. Two non-blocking UX notes were then also addressed: (1) the modal now traps Tab focus (pattern matches `FinalizationGate`); (2) the Escape handler moved to a document-capture listener with `stopPropagation`, so an open settings modal closes without also closing the command palette underneath. Remaining accepted trade-offs, consistent with repo precedent (CLEW-098 review): (3) in private-browsing mode the selection lives only until the modal unmounts — the documented `writePreference` trade-off; (4) the checkmark icon next to "Selected" marks selection state, not readiness — acceptable because the chapter notice explicitly disclaims verification. AC-1 through AC-6 hold: 60/60 UI tests (including a focus-trap test), backend suite green, eslint and `tsc --noEmit` clean. `done` still requires merge to `main`.

## Dependencies and parallelization

No dependency on undone work: pure UI following the fixture-first pattern from CLEW-071 (done) and the existing localStorage preference mechanism in `ui/src/App.tsx`. Adjacent reference: `docs/PLUGIN-ARCHITECTURE.md` (the future settings surface; this card must not invent status or registry APIs). Follow-up card (not this one): backend persistence, doctor-style availability checks, and execution wiring of the selection.

## Risks

- implying the selection takes effect (requires the explicit not-verified / not-applied notice and no status-like visuals);
- implying equal capabilities across the three CLIs (requires neutral entry descriptions, no checkmarks suggesting readiness);
- scope creep pulling diagnostics or API work into this card (any check or backend call belongs to the follow-up).

## Blockers

None.

## Completion record

Not completed.

Release assignment (`v0.10`) is provisional: no `v0.10` section exists in `ROADMAP.md` yet. This card is the plugin-settings UI slice and may be reassigned when the plugin stages are scheduled.
