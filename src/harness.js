import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  APPROVAL_DECISION,
  HARNESS_EVENT_TYPE,
  HarnessInterruptedError,
} from './harness-events.js';

export {
  APPROVAL_DECISION,
  HARNESS_EVENT_TYPE,
  HarnessInterruptedError,
  HarnessTimeoutError,
  TURN_STATUS,
} from './harness-events.js';

/** CLEW-127 plugin migration facade.
 *
 * `FakeHarness`, `CodexHarness`, and `OpenCodeHarness` below stay the
 * implementations until CLEW-128/129 move them behind the AgentRuntime port
 * from `src/plugins/`. New code must resolve executors through the plugin
 * registry in the composition root instead of branching on harness names
 * here. Legacy harness names map to plugin IDs below; the factories
 * themselves are not removed by this card.
 */
export const LEGACY_HARNESS_PLUGIN_IDS = Object.freeze({
  codex: 'clew.runtime.codex',
  opencode: 'clew.runtime.opencode',
  fake: 'clew.runtime.fake',
});

/** CLEW-129: OpenCode adapter implementation lives in
 * `src/plugins/opencode/harness.js` (re-exported below as a compatibility
 * facade; new code must resolve the `clew.runtime.opencode` plugin through
 * the registry instead). */
export { OpenCodeHarness } from './plugins/opencode/harness.js';

/** CLEW-128: Codex turn/approval helpers and protocol implementation live in
 * `src/plugins/codex/harness.js`. They are re-exported below as a
 * compatibility facade; new code must resolve the `clew.runtime.codex`
 * plugin through the registry instead. */

function waitForDelay(delayMs, signal, harnessName) {
  if (!delayMs) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener('abort', interrupt);
      resolve();
    };
    const interrupt = () => {
      clearTimeout(timer);
      reject(new HarnessInterruptedError(harnessName));
    };
    const timer = setTimeout(complete, delayMs);

    signal?.addEventListener('abort', interrupt, { once: true });
  });
}

export class FakeHarness {
  constructor({
    delayMs = 0,
    events = [],
    failures = [],
    approval = null,
    verification = null,
    skippedChecks = [],
    usage = null,
  } = {}) {
    this.delayMs = delayMs;
    this.events = events;
    this.failures = failures;
    this.approval = approval;
    this.verification = verification;
    this.skippedChecks = skippedChecks;
    this.usage = usage;
    this.runCount = 0;
  }

  async run({
    task,
    stageId,
    cwd,
    onEvent,
    signal,
    resumeSessionId = null,
    onApproval = () => APPROVAL_DECISION.DECLINE,
  }) {
    this.runCount += 1;
    const sessionId = resumeSessionId ?? `fake-${task.id}-${stageId}-${this.runCount}`;

    if (signal?.aborted) throw new HarnessInterruptedError('Fake harness');
    onEvent({
      type: resumeSessionId
        ? HARNESS_EVENT_TYPE.SESSION_RESUMED
        : HARNESS_EVENT_TYPE.SESSION_STARTED,
      sessionId,
      stageId,
    });
    onEvent({ type: HARNESS_EVENT_TYPE.TURN_STARTED, sessionId });
    try {
      await waitForDelay(this.delayMs, signal, 'Fake harness');
    } catch (error) {
      onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED, sessionId });
      throw error;
    }
    if (this.approval) {
      onEvent({
        type: HARNESS_EVENT_TYPE.APPROVAL_REQUIRED,
        sessionId,
        approvalId: this.approval.id,
        method: this.approval.method,
        params: this.approval.params ?? {},
      });
      const decision = await onApproval(this.approval);

      onEvent({
        type: HARNESS_EVENT_TYPE.APPROVAL_DECIDED,
        sessionId,
        approvalId: this.approval.id,
        decision,
      });
      if (![APPROVAL_DECISION.ACCEPT, APPROVAL_DECISION.ACCEPT_FOR_SESSION].includes(decision))
        throw new Error('Fake harness approval was declined');
    }
    for (const event of this.events) onEvent({ ...event, sessionId });
    const scriptedFailure = this.failures[this.runCount - 1];

    if (scriptedFailure) {
      onEvent({
        type: HARNESS_EVENT_TYPE.HARNESS_FAILED,
        sessionId,
        error: scriptedFailure.message,
      });
      throw scriptedFailure;
    }
    const evidenceDir = join(cwd, '.clew-runs');

    mkdirSync(evidenceDir, { recursive: true });
    appendFileSync(join(evidenceDir, `${stageId}.log`), `${task.id}/${stageId}\n`);
    onEvent({
      type: HARNESS_EVENT_TYPE.TOOL_COMPLETED,
      sessionId,
      tool: 'fixture-write',
      exitCode: 0,
    });
    onEvent({
      type: HARNESS_EVENT_TYPE.VERIFICATION_DETECTED,
      sessionId,
      command: 'clew fixture verification',
      result: 'passed',
    });
    onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_COMPLETED, sessionId });

    const verification = this.verification ?? [
      { type: 'targeted', result: 'passed', command: 'clew fixture verification' },
    ];

    return {
      sessionId,
      verification,
      rationale: 'Deterministic fake harness completed its scripted verification',
      skippedChecks: this.skippedChecks,
      usage: this.usage,
    };
  }
}

export class ExternalHarnessUnavailable {
  constructor(name) {
    this.name = name;
  }
  async run() {
    const error = new Error(
      `${this.name} adapter is not configured yet; run with --harness fake or configure the native ${this.name} server`,
    );

    error.code = 'EXTERNAL_HARNESS_UNAVAILABLE';
    throw error;
  }
}

export { CodexHarness, codexLaunchError } from './plugins/codex/harness.js';
