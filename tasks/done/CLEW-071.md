---
id: CLEW-071
title: Preact Web UI
status: done
release: v0.4
priority: P1
size: L
depends_on: [CLEW-068]
parallel_group: v0.4-control-plane
owner: null
updated: 2026-08-28
evidence_policy: legacy
---

# CLEW-071 — Preact Web UI

## Objective

Create a focused Task-oriented local Web UI using the stable v0.4 API fixtures while backend runtime and projection work proceed independently.

## User outcome

A developer can see Tasks, current attention, causal execution history, reviewer findings, result state, and operator actions without querying SQLite or reading raw JSON.

## Context

The UI is introduced together with Task Thread. It complements native terminals rather than embedding or replacing them.

## Technology

- Preact;
- TypeScript;
- Vite;
- client-side application;
- production assets served by the local daemon;
- fixture-backed development mode.

## Scope

- isolated `ui/` workspace and build pipeline;
- typed client generated or validated from `CLEW-068` schemas;
- local bearer-token bootstrap without exposing it in URLs or logs;
- Task list with state and attention indicators;
- Task detail with contract, plan, Stages, Runs, attempts, revisions, and structured summaries;
- curated Task Thread and optional diagnostic event view;
- reviewer findings and automatic-attempt exhaustion explanation;
- result inspection and explicit operator completion;
- Continue and Open Session actions against stable contracts;
- loading, empty, disconnected, reconnecting, failed, `READY`, and `WAITING_FOR_HUMAN` states;
- WebSocket updates with cursor reconnect;
- accessible keyboard navigation and responsive layout.

## Out of scope

- embedded terminal emulator;
- full native chat transcript;
- formal QA/evidence dashboard;
- remote multi-user authentication or RBAC;
- server-side rendering;
- general analytics dashboard.

## Deliverables

- Preact/TypeScript/Vite application;
- fixture development server and visual states;
- production asset bundle;
- API/WebSocket client;
- UI unit/component tests and end-to-end smoke;
- user documentation.

## Acceptance criteria

1. All required screens develop and test against `CLEW-068` fixtures without a daemon.
2. Final integration consumes `CLEW-070` output without schema changes.
3. Reload and reconnect preserve selected Task and Thread ordering.
4. Operator actions require confirmation and show resulting durable state.
5. Disconnected and incompatible-daemon states are explicit.
6. The UI never renders raw secrets, native prompt streams, or arbitrary HTML from events.
7. Production assets can be served by `CLEW-069` from the installed package.

## Verification

- TypeScript check, lint, unit/component tests, and production build;
- fixture-state visual review at desktop and narrow widths;
- API contract tests;
- end-to-end Task list → Thread → Complete/Continue smoke;
- XSS/redaction and reconnect negative cases.

## Dependencies and parallelization

Starts after `CLEW-068` and runs fixture-first in parallel with `CLEW-069`, `070`, `072`, and `073`. Final integration consumes daemon and Thread APIs but must not require contract changes.

Primary ownership: `ui/` and static build integration contract. Avoid backend domain changes.

## Risks

- introducing a second toolchain increases package and CI complexity;
- local token bootstrap needs a browser-safe flow;
- an overly broad dashboard would dilute the Task Thread outcome.

## Blockers

Waiting for `CLEW-068` API and fixture contracts.

## Completion record

- Implementation: fixture-first Preact UI with typed API/WebSocket client, daemon-backed task/thread/history views, redacted operator actions, responsive accessible states, production assets, and UI tests.
- Verification: `npm run ui:check` passed on 2026-08-28; production assets are served and inspected through the CLEW-074 installed-package acceptance.
