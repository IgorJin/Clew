import { FINDING_SEVERITY, REVIEW_VERDICT, validateReviewResult } from './domain.js';

/** CLEW-128: `CodexReviewer` moved to `src/plugins/codex/role-services.js`.
 * This module keeps the harness-agnostic fake reviewer.
 */

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
