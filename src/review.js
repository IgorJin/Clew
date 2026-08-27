import { FINDING_SEVERITY, REVIEW_VERDICT, validateReviewResult } from './domain.js';

export class FakeReviewer {
  async review({ task, evidence, revision }) {
    const verdict =
      process.env.CLEW_FAKE_REVIEW === REVIEW_VERDICT.REQUEST_CHANGES
        ? REVIEW_VERDICT.REQUEST_CHANGES
        : REVIEW_VERDICT.PASS;

    return validateReviewResult({
      verdict,
      findings:
        verdict === REVIEW_VERDICT.PASS
          ? []
          : [
              {
                severity: FINDING_SEVERITY.BLOCKING,
                criterion: task.acceptance[0].id,
                reason: 'Fixture reviewer requested changes',
                evidence: 'CLEW_FAKE_REVIEW=request_changes',
                target: 'implementation',
              },
            ],
      evidence,
      revision,
    });
  }
}

export class CodexReviewer {
  constructor(harness) {
    this.harness = harness;
  }

  async review({ task, evidence, revision, cwd }) {
    const result = await this.harness.run({
      task: {
        ...task,
        title: `Review: ${task.title}`,
        goal: `${task.goal}\n\nReview revision ${revision}. Evidence: ${JSON.stringify(evidence)}`,
      },
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
      return validateReviewResult({ ...report, revision });
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
