/** Codex role services for CLEW-128.
 *
 * `CodexArchitect` and `CodexReviewer` moved verbatim from
 * `src/architect.js` / `src/review.js`. They wrap a harness-style Codex
 * executor; the plugin factories below bind them to a resolved
 * `CodexAgentRuntime` without touching model routing (CLEW-130 keeps the
 * existing environment-variable fallback).
 */

import { FINDING_SEVERITY, REVIEW_VERDICT, validateReviewResult } from '../../domain.js';
import { EXECUTION_ROLE, prepareExecutionBrief } from '../../execution-brief.js';
import { PLAN_OUTPUT_SCHEMA } from '../../architect.js';

export class CodexArchitect {
  constructor(harness) {
    this.harness = harness;
  }

  async createPlan({ task, executionBrief = null, cwd }) {
    executionBrief ??= prepareExecutionBrief({
      task,
      role: EXECUTION_ROLE.ARCHITECT,
      stageId: 'architect',
      assignmentGoal:
        'Produce an implementation DAG. Every stage must feed one terminal integration stage with kind=integration.',
      readOnly: true,
    });
    const result = await this.harness.run({
      task,
      executionBrief,
      cwd,
      model: process.env.CLEW_ARCHITECT_MODEL,
      readOnly: true,
      outputSchema: PLAN_OUTPUT_SCHEMA,
      onEvent: () => {},
    });
    const plan = result.output?.output ?? result.output;

    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.stages))
      throw new Error(`Codex architect did not return a structured plan: ${JSON.stringify(plan)}`);

    return result.sessionId ? { plan, sessionId: result.sessionId } : plan;
  }
}

export class CodexReviewer {
  constructor(harness) {
    this.harness = harness;
  }

  async review({ task, evidence, revision, cwd }) {
    const executionBrief = prepareExecutionBrief({
      task,
      role: EXECUTION_ROLE.REVIEWER,
      stageId: 'review',
      assignmentGoal: `Review revision ${revision} against the Task Contract`,
      evidence,
      revision,
      readOnly: true,
    });
    const result = await this.harness.run({
      task,
      executionBrief,
      cwd,
      model: process.env.CLEW_REVIEW_MODEL,
      readOnly: true,
      outputSchema: {
        type: 'object',
        properties: {
          verdict: { enum: Object.values(REVIEW_VERDICT) },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { enum: Object.values(FINDING_SEVERITY) },
                criterion: { type: 'string' },
                reason: { type: 'string' },
                evidence: { type: ['string', 'null'] },
                target: { type: ['string', 'null'] },
              },
              required: ['severity', 'criterion', 'reason', 'evidence', 'target'],
              additionalProperties: false,
            },
          },
        },
        required: ['verdict', 'findings'],
        additionalProperties: false,
      },
      onEvent: () => {},
    });
    const report = result.output?.output ?? result.output;

    try {
      return validateReviewResult({
        ...report,
        revision,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      });
    } catch {
      return {
        verdict: REVIEW_VERDICT.NEEDS_HUMAN,
        findings: [],
        reason: 'Codex did not return a valid review report',
        revision,
      };
    }
  }
}

export function createCodexArchitect(adapter, { model = null } = {}) {
  return new CodexArchitect(adapter.asLegacyHarness(model == null ? {} : { model }));
}

export function createCodexReviewer(adapter, { model = null } = {}) {
  return new CodexReviewer(adapter.asLegacyHarness(model == null ? {} : { model }));
}
