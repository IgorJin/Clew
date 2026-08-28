---
id: CLEW-042
title: Optional OpenTelemetry tracing
status: done
release: v0.3
priority: P1
size: L
depends_on: [CLEW-066]
parallel_group: null
owner: null
updated: 2026-08-28
---

# CLEW-042 — Optional OpenTelemetry tracing

## Objective

Expose a correlated diagnostic trace of Clew's durable lifecycle without making telemetry part of task correctness or a required runtime dependency.

## User outcome

A developer can opt into OTLP tracing, inspect Task/Run lifecycle spans in a compatible backend, and diagnose disabled or unavailable telemetry without changing execution results.

## Delivered scope

- no-op-safe observer boundary on durable Store events;
- optional official OpenTelemetry runtime installed under `.clew/telemetry`;
- `clew telemetry install` and `clew telemetry status`;
- persisted Task and Run trace correlation;
- allowlisted lifecycle attributes with secret redaction;
- bounded export and shutdown behavior;
- collector/runtime failures isolated from Task state;
- migration 010 and versioned telemetry schema;
- documentation and automated tests.

## Out of scope

- custom OTLP encoding;
- metrics and log exporters;
- raw prompts, completions, source, environment, or tool payload export;
- making Phoenix or another collector mandatory.

## Acceptance criteria

1. Disabled telemetry is a no-op.
2. Missing optional runtime is reported without failing execution.
3. Durable lifecycle events produce correlated spans when enabled.
4. Exporter failure cannot alter Task state or accepted revision.
5. Secret and raw-content boundaries are enforced.

## Verification

- Full project check passed on implementation.
- Optional runtime smoke reached a fake local OTLP collector.

## Dependencies and parallelization

Completed before usage accounting because trace correlation is reused by v0.3 result visibility.

## Risks

- External collectors and OpenTelemetry packages evolve independently of Clew.

## Blockers

None.

## Completion record

- Implementation commit: `3be38cd`.
- Merge commit: `18f385a`.
