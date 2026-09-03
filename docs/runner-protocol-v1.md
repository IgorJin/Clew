# Controller/Runner protocol v1

Protocol v1 connects one configured Runner to one Controller over an authenticated outbound WebSocket. `ws://` is valid only for loopback endpoints; every non-loopback connection requires `wss://`. The pre-shared credential is HTTP upgrade material and is never part of a protocol envelope, database record, diagnostic payload, or log field.

Each message has a bounded envelope containing `messageId`, `idempotencyKey`, `correlationId`, timestamp, direction, message kind, and payload version. Consumers ignore unknown envelope and payload fields after validating known required fields. Unknown message kinds and unsupported versions are rejected before durable execution state changes.

## Delivery and identity

Delivery is at least once. A producer retains a durable outbound message until the peer acknowledges its `messageId`. A consumer records the tuple of direction, kind, and `idempotencyKey` before repeating an acknowledgment. Duplicate delivery repeats the prior acknowledgment and must not repeat a local action.

Task, Stage, Run, attempt, Runner, lease, epoch, event, and result identities are stable. Lease epoch is a fencing token: a message from another Runner or epoch cannot mutate the canonical lease.

## Lease state machine

The normal path is `offered -> accepted -> running -> completed|failed|cancelled`. An accepted or running lease may enter `recovering` after ambiguous transport or process loss. Recovery may return to `running` for the same Runner and epoch, or end terminally. Disconnect never changes a lease back to available and v0.6 never automatically reassigns ambiguous work.

Terminal leases are immutable. Reordered transitions, stale epochs, wrong Runner identities, and post-terminal events/results are rejected while duplicate messages return their previously recorded outcome.

## Compatibility

Registration precedes lease mutation. Controller and Runner select the highest shared protocol version, verify required capabilities, and require matching product major/minor versions. Patch versions within the same release line are compatible; invalid or different release lines are rejected before Runner registration mutates Controller state.

## Data boundary

Allowed transport data is limited to stable identities, capability names, logical workspace IDs, the bounded public Task contract needed for execution, normalized lifecycle summaries, revision IDs, bounded plans/reviews/evidence, and aggregate usage. Harness-generated prompts and hidden reasoning are never transported. Credentials, environment values, host paths, arbitrary file contents, raw native output, repository archives, and PTY bytes are forbidden. Terminal capability is projected as `runner_local_terminal`; terminal traffic remains on the Runner host.

For Standard and Deep execution, review is performed on the Runner and returned as a bounded structured verdict. For Deep execution, the architecture operation is also leased to the Runner; Controller persists and gates the returned plan, schedules its DAG stages, records logical dependency integration in the mapped Runner workspace, and retains final lifecycle authority.
