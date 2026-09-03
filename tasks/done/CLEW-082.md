---
id: CLEW-082
title: Controller/Runner protocol contracts
status: done
release: v0.6
priority: P0
size: M
depends_on: [CLEW-077]
parallel_group: null
owner: null
updated: 2026-09-02
evidence_policy: v1
---

# CLEW-082 — Controller/Runner protocol contracts

## Objective

Freeze the distributed execution contract, identities, compatibility rules, lease state machine, and data-security boundary before Controller and Runner implementations proceed independently.

## User outcome

The first paired Runner release behaves predictably across version skew, disconnects, duplicates, and restarts instead of exposing implementation-specific behavior through an unstable socket protocol.

## Scope

- protocol v1 envelope with message ID, idempotency key, correlation ID, timestamp, direction, and payload version;
- stable Controller, Runner, Task, Stage, Run, attempt, lease, epoch, event, and result identities;
- registration, heartbeat, lease, cancellation, event/result upload, and acknowledgment schemas;
- lease transition table and stale-epoch fencing rules;
- protocol/product/capability compatibility negotiation;
- one-Runner and workspace-mapping contracts;
- pre-shared credential authentication boundary for v0.6;
- transport security rule: plaintext only on loopback, TLS required otherwise;
- bounded payload sizes, redaction allowlist, and forbidden-data matrix;
- unknown-message and forward-compatible field behavior;
- deterministic fixtures for success and every negative transition.

## Out of scope

- WebSocket process implementation;
- pairing-code UX and credential rotation;
- lease persistence or Scheduler changes;
- Docker/TLS deployment guidance;
- multi-Runner selection.

## Deliverables

- versioned JSON schemas and runtime validators;
- protocol and lease-state documentation;
- compatibility matrix and fixtures;
- security/data-ownership allowlist;
- fake Controller and Runner conformance helpers for downstream tests.

## Acceptance criteria

1. Every protocol message validates against one explicit versioned schema and bounded envelope.
2. Lease transitions reject stale epochs, wrong Runner identity, impossible ordering, and post-terminal mutation.
3. Registration rejects incompatible protocol versions before any durable execution mutation.
4. Non-loopback plaintext transport is rejected by contract and tests.
5. Public and persisted payload allowlists exclude credentials, environment values, arbitrary files, prompts, hidden reasoning, and PTY bytes.
6. Duplicate messages share deterministic idempotency semantics, while unknown future fields remain safely ignorable.
7. Controller and Runner fake peers can independently pass the same conformance fixture set.

## Acceptance evidence

| Criterion | Automated evidence             | Logical scenarios                                      | Result |
| --------- | ------------------------------ | ------------------------------------------------------ | ------ |
| AC-1      | `test/runner-protocol.test.js` | message schema; size bounds; malformed envelope        | pass   |
| AC-2      | `test/runner-protocol.test.js` | stale epoch; wrong Runner; reorder; terminal replay    | pass   |
| AC-3      | `test/runner-protocol.test.js` | supported overlap; incompatible; absent capability     | pass   |
| AC-4      | `test/runner-protocol.test.js` | loopback ws; remote ws; remote wss                     | pass   |
| AC-5      | `test/runner-protocol.test.js` | secrets; files; prompt; reasoning; PTY data            | pass   |
| AC-6      | `test/runner-protocol.test.js` | duplicate; unknown field; unknown message              | pass   |
| AC-7      | `test/runner-protocol.test.js` | Controller producer/consumer; Runner producer/consumer | pass   |

## Verification

- validate all positive and negative fixtures through schemas and runtime validators;
- fuzz envelope ordering, identifiers, and payload bounds;
- review every field against Controller/Runner ownership;
- run the task-card and repository quality gates.

## Review record

- Verdict: pass
- Reviewer: v0.6 implementation verification
- Findings: No blocking protocol, fencing, compatibility, transport-security, or data-boundary findings.

## Dependencies and parallelization

Depends only on the released v0.5 control-plane and terminal contracts. Completion unblocks `CLEW-083` and `CLEW-084` in parallel.

## Risks

- an underspecified epoch rule can allow stale results after recovery;
- exposing local workspace paths as Controller authority can violate the security boundary;
- message schemas can accidentally encode current Scheduler implementation details.

## Blockers

None.

## Completion record

Implemented in `src/runner-protocol.js` with a published JSON schema, deterministic fixture, protocol/security documentation, and shared fake Controller/Runner conformance peers. The focused protocol suite passes 7 tests and the full backend regression suite passes 137 tests (133 pass, 4 sandbox-only loopback skips) on 2026-09-02.
