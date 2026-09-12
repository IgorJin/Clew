/** Shared harness vocabulary for CLEW-128.
 *
 * Event types, approval decisions, turn statuses, and harness errors are
 * used by every runtime plugin and by the core. They live in this
 * dependency-free leaf module so plugins can import them without creating
 * an import cycle with `src/harness.js` (which re-exports everything
 * below as a compatibility facade).
 */

export const HARNESS_EVENT_TYPE = Object.freeze({
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_RESUMED: 'SESSION_RESUMED',
  TURN_STARTED: 'TURN_STARTED',
  TOOL_STARTED: 'TOOL_STARTED',
  TOOL_COMPLETED: 'TOOL_COMPLETED',
  VERIFICATION_DETECTED: 'VERIFICATION_DETECTED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_DECIDED: 'APPROVAL_DECIDED',
  INTERRUPT_REQUESTED: 'INTERRUPT_REQUESTED',
  HARNESS_COMPLETED: 'HARNESS_COMPLETED',
  HARNESS_INTERRUPTED: 'HARNESS_INTERRUPTED',
  HARNESS_TIMED_OUT: 'HARNESS_TIMED_OUT',
  HARNESS_FAILED: 'HARNESS_FAILED',
  HARNESS_EVENT: 'HARNESS_EVENT',
  HARNESS_OUTPUT: 'HARNESS_OUTPUT',
  TURN_RUNNING: 'TURN_RUNNING',
  TURN_COMPLETED: 'TURN_COMPLETED',
  TURN_WAITING: 'TURN_WAITING',
  TURN_FAILED: 'TURN_FAILED',
  TURN_INTERRUPTED: 'TURN_INTERRUPTED',
});

export const APPROVAL_DECISION = Object.freeze({
  ACCEPT: 'accept',
  ACCEPT_FOR_SESSION: 'acceptForSession',
  DECLINE: 'decline',
  CANCEL: 'cancel',
});

export const TURN_STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  IN_PROGRESS: 'inProgress',
});

export class HarnessInterruptedError extends Error {
  constructor(harnessName) {
    super(`${harnessName} execution was interrupted`);
    this.name = 'HarnessInterruptedError';
    this.code = 'HARNESS_INTERRUPTED';
  }
}

export class HarnessTimeoutError extends Error {
  constructor(harnessName) {
    super(`${harnessName} execution timed out`);
    this.name = 'HarnessTimeoutError';
    this.code = 'HARNESS_TIMED_OUT';
  }
}
