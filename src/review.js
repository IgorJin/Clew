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

export class CodexReviewer {
  constructor(harness) {
    this.harness = harness;
  }

  async review({ task, evidence, revision }) {
    const result = await this.harness.run({
      task: {
        ...task,
        title: `Review: ${task.title}`,
        goal: `${task.goal}\n\nReview revision ${revision}. Evidence: ${JSON.stringify(evidence)}`,
      },
      cwd: process.cwd(),
      model: process.env.CLEW_REVIEW_MODEL || 'sol',
      readOnly: true,
      outputSchema: {
        type: 'object',
        properties: {
          verdict: { enum: ['pass', 'request_changes', 'needs_human'] },
          findings: { type: 'array' },
        },
        required: ['verdict', 'findings'],
      },
      onEvent: () => {},
    });
    const report = result.output?.output ?? result.output;

    if (!report || !['pass', 'request_changes', 'needs_human'].includes(report.verdict))
      return {
        verdict: 'needs_human',
        findings: [],
        reason: 'Codex did not return a valid review report',
        revision,
      };

    return { ...report, revision };
  }
}
