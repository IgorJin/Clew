---
id: CLEW-081
title: v0.7 self-hosted acceptance and release
status: planned
release: v0.7
priority: P0
size: L
depends_on: [CLEW-075, CLEW-076, CLEW-080]
parallel_group: null
owner: null
updated: 2026-09-02
evidence_policy: v1
---

# CLEW-081 — v0.7 self-hosted acceptance and release

## Objective

Prove that pairing operations and Docker packaging can ship as `v0.7.0` on top of the released v0.6 transport without regressing local-first mode, duplicating native work, or moving host credentials and repositories into the Controller.

## User outcome

A user can upgrade from `v0.6`, deploy Controller/UI with Docker Compose, pair one local Runner, complete Tasks across disconnects and restarts, and recover the durable history from backup.

## Context

`CLEW-075` establishes remote execution semantics, `CLEW-080` closes the operator credential lifecycle, and `CLEW-076` packages the self-hosted topology. This task owns their cross-component migration, installed-artifact, security, and publication gates.

## Scope

- populated `v0.6` to `v0.7` migration fixture;
- local in-process versus paired-Runner parity acceptance;
- Quick, Standard, and Deep flows through the paired Runner;
- disconnect/reconnect at assignment, execution, result upload, and cancellation boundaries;
- Controller and Runner version-skew matrix;
- Docker Compose install, upgrade, backup, restore, and rollback constraints;
- package/image content inspection and secret scan;
- release notes, compatibility, troubleshooting, CI, tag, and publication evidence.

## Out of scope

- multiple active Runners;
- Kubernetes or managed cloud deployment;
- team RBAC;
- remote terminal byte streaming;
- automatic failover to another execution host.

## Deliverables

- migration and parity fixtures;
- self-hosted end-to-end acceptance script;
- disconnect and duplicate-delivery matrix;
- package/image inspection checks;
- `RELEASE-0.7.md` sign-off and release artifacts.

## Acceptance criteria

1. A populated `v0.5` state upgrades losslessly and remains usable in local-first mode.
2. Quick, Standard, and Deep Tasks reach equivalent durable outcomes through local and paired execution.
3. Disconnects and duplicate delivery never create a second logical Run, turn, completion, or uploaded result.
4. Controller restart, Runner restart, and restored backup preserve Task history and pairing truthfully.
5. Controller artifacts contain no repository content, native harness credentials, Runner private credentials, or host mounts.
6. Published npm and container artifacts report compatible versions and reproduce the documented deployment.
7. CI and release-tag checks pass, and known one-Runner and terminal limitations are explicit.

## Acceptance evidence

| Criterion | Automated evidence                    | Logical scenarios                                   | Result  |
| --------- | ------------------------------------- | --------------------------------------------------- | ------- |
| AC-1      | migration and local regression tests  | populated state; clean state; local-first startup   | pending |
| AC-2      | paired acceptance suite               | Quick; Standard; Deep; continuation; verification   | pending |
| AC-3      | transport fault-injection tests       | duplicate; reorder; disconnect at every lease phase | pending |
| AC-4      | restart and backup/restore acceptance | both processes; active lease; restored volume       | pending |
| AC-5      | package/image security inspection     | credentials; repositories; mounts; logs; layers     | pending |
| AC-6      | clean-install and Compose acceptance  | npm Runner; Controller image; version skew          | pending |
| AC-7      | CI/tag workflow and release review    | main; release tag; documented limitations           | pending |

## Verification

- run `npm run check` and installed-package acceptance;
- build and inspect the production Controller image;
- execute the full local/paired parity matrix;
- inject transport faults at every durable lease boundary;
- perform backup/restore and version-skew smokes;
- verify final release artifacts from a clean environment.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Depends on `CLEW-075`, `CLEW-076`, and `CLEW-080`. Release documentation and fixture scaffolding may start earlier, but sign-off waits for the final transport, pairing, and container artifacts.

## Risks

- a green happy path can hide duplicate execution around lease expiry and reconnect;
- npm Runner and Controller image versions can drift;
- backup procedures can capture an inconsistent SQLite state if they bypass the Controller boundary.

## Blockers

Waiting for `CLEW-075`, `CLEW-076`, and `CLEW-080`.

## Completion record

Not completed.
