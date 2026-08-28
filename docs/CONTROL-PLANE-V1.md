# Clew local control plane v1

This document freezes the contracts introduced by `CLEW-068`. The daemon and clients may add fields, but they must not change the meaning of the fields below without incrementing the protocol version.

## HTTP API

All endpoints are loopback-only and use the `application/json` media type. Every request and response uses `api-envelope.v1.schema.json`:

```json
{
  "version": 1,
  "requestId": "req-123",
  "kind": "query",
  "name": "task.show",
  "payload": { "taskId": "TASK-1" }
}
```

Commands mutate durable state and return a response envelope with the same `requestId`. Queries are read-only. Errors use `api-error.v1.schema.json` and contain a stable machine-readable `code`, a safe human-readable `message`, and `retryable`; details are optional and must not contain credentials or native chat content.

The client sends `Authorization: Bearer <token>`. The token is generated for the local daemon and stored in the daemon state directory, never in project config or API fixtures. Missing, malformed, or invalid credentials return an error without disclosing the expected token or token path.

## WebSocket stream

The WebSocket endpoint emits `ws-event.v1` records. `cursor` is a strictly increasing durable stream position; reconnecting clients send `after=<cursor>` and receive events with a greater cursor. Replayed events keep their original `eventId` and cursor, so clients must deduplicate by `eventId`.

The server retains a bounded replay window. A cursor of `0` requests the oldest available event. If `after` is older than `oldestCursor - 1`, the server returns `CURSOR_EXPIRED` and the client must resync from a fresh query. A cursor ahead of the newest event is invalid. Ordering is by cursor, not wall-clock time.

## Task Thread and redaction

`thread-item.v1` is a causal read model. Each item points to one durable source through `source`; it is not a copy of a native session transcript. `thread-page.v1` uses `nextCursor` and `hasMore` for pagination. Public fixtures and API projections contain summaries, identifiers, statuses, and operator decisions only. Prompts, completions, tool arguments/results, environment values, bearer tokens, and repository contents are excluded; `redacted: true` marks a deliberately shortened item.

## Continuation and Session Surface

Continuation grants preserve `taskId`, and when applicable `stageId`, `runId`, and `sessionId`. The `expectedRevision` prevents applying an operator decision to a newer result, and `expiresAt` bounds its lifetime. Review exhaustion is a human handoff, not an implicit completion.

`SessionSurface` is capability-based. An open-session request names the task, role, harness, and optional existing identity. The result must return the same task/run identity and the native `sessionId`; a resume operation never silently creates a new session. Unsupported capabilities are omitted rather than inferred.

## Persistence and compatibility

Migration 012 adds `operator_messages`, `continuation_grants`, and `completion_overrides`. It is additive and leaves all v0.3 tables and records untouched. Unknown JSON fields are preserved by runtime validators and ignored by v1 consumers. Unknown enum values and protocol versions are rejected so a client cannot mistake a future state for a known one.
