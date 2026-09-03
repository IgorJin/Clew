---
id: CLEW-076
title: Docker packaging and deployment operations
status: planned
release: v0.7
priority: P1
size: L
depends_on: [CLEW-075, CLEW-080]
parallel_group: null
owner: null
updated: 2026-09-02
evidence_policy: legacy
---

# CLEW-076 — Docker packaging and deployment operations

## Objective

Package the Controller and Web UI as a reproducible self-hosted Docker deployment paired with one installed local Runner.

## User outcome

A user can deploy Clew Controller/UI with Docker Compose, pair their development machine, run Tasks without privileged host mounts, and preserve history across Controller upgrades.

## Context

The Docker container owns control-plane metadata only. Repositories, native harnesses, credentials, and terminal processes stay on the paired Runner host.

## Scope

- published Controller/UI Docker image;
- documented Docker Compose deployment;
- persistent data volume and migration lifecycle;
- first-run integration of the pairing flow delivered by `CLEW-080`;
- reverse-proxy/TLS and origin configuration guidance;
- backup and restore procedure;
- Controller upgrade and rollback constraints;
- installed Runner package and service guidance;
- network disconnect/reconnect diagnostics;
- deployment acceptance and troubleshooting documentation.

## Out of scope

- Kubernetes manifests;
- cloud-hosted Clew service;
- multi-Runner scheduling;
- mounting host Docker socket or repository roots into Controller;
- team identity/RBAC;
- automatic public ingress or certificate provisioning.

## Deliverables

- Dockerfile/image and Compose example;
- persistent storage migration and backup scripts/documentation;
- pairing integration and deployment diagnostics;
- clean self-hosted acceptance fixture;
- versioned container artifact and deployment acceptance evidence.

## Acceptance criteria

1. A clean Compose deployment starts Controller/UI and persists data.
2. One local Runner pairs and completes a Task through outbound transport.
3. Controller restart and image upgrade preserve complete Task history.
4. Backup/restore into a clean deployment reproduces the same durable state.
5. Runner disconnect/reconnect is recoverable and visible.
6. No host Docker socket, repository mount, or harness credential is required by Controller.
7. Published artifacts and documentation reproduce the deployment without source checkout.

## Verification

- clean Compose acceptance in an isolated environment;
- pair/run/disconnect/reconnect scenario;
- upgrade, backup, restore, and credential-rotation matrix;
- package/image content and secret scan;
- reverse-proxy configuration smoke;
- CI and release-tag checks.

## Dependencies and parallelization

Depends on `CLEW-075` and `CLEW-080`. Documentation and Compose fixtures may be prepared earlier, but release acceptance requires the finished transport and credential lifecycle.

## Risks

- SQLite volume backup while Controller is active requires a safe procedure;
- browser origin/TLS configuration can complicate local pairing;
- container release and npm Runner versions can drift.

## Blockers

Waiting for `CLEW-075` and `CLEW-080`.

## Completion record

Not completed.
