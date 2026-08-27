export class FakeReviewer {
  async review({ task, evidence, revision }) {
    const verdict = process.env.CLEW_FAKE_REVIEW === 'request_changes' ? 'request_changes' : 'pass';
    return {
      verdict,
      findings:
        verdict === 'pass'
          ? []
          : [
              {
                severity: 'blocking',
                criterion: task.acceptance[0].id,
                reason: 'Fixture reviewer requested changes',
                evidence: 'CLEW_FAKE_REVIEW=request_changes',
                target: 'implementation',
              },
            ],
      evidence,
      revision,
    };
  }
}
