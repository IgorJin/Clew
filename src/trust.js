import { createHash } from 'node:crypto';
import { platform, release, arch, version } from 'node:os';
import { redactSecrets } from './security.js';

export const EVIDENCE_TRUST = Object.freeze({
  REUSABLE: 'reusable',
  STALE: 'stale',
  SKIPPED: 'skipped',
  UNTRUSTED: 'untrusted',
});
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}
export function verificationEnvironment({ command, cwd, config = {}, revision, runtime = {} }) {
  const normalized = stable(
    redactSecrets({
      platform: { name: platform(), release: release(), arch: arch() },
      runtime: { node: version(), ...runtime },
      command: command ?? null,
      config,
      workspace: cwd,
      revision,
    }),
  );

  return {
    ...normalized,
    fingerprint: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}
export function evaluateEvidence(
  evidence,
  { revision, environment, policy = {}, now = new Date() } = {},
) {
  if (!evidence || evidence.result !== 'passed')
    return { status: EVIDENCE_TRUST.UNTRUSTED, reusable: false, reason: 'evidence did not pass' };
  if (!evidence.environmentFingerprint || !evidence.revision)
    return {
      status: EVIDENCE_TRUST.UNTRUSTED,
      reusable: false,
      reason: 'missing revision or environment fingerprint',
    };
  if (revision && evidence.revision !== revision)
    return { status: EVIDENCE_TRUST.STALE, reusable: false, reason: 'revision changed' };
  if (environment && evidence.environmentFingerprint !== environment.fingerprint)
    return { status: EVIDENCE_TRUST.STALE, reusable: false, reason: 'environment changed' };
  if (policy.fingerprint && evidence.policyFingerprint !== policy.fingerprint)
    return { status: EVIDENCE_TRUST.STALE, reusable: false, reason: 'verification policy changed' };
  const endedAt = Date.parse(evidence.endedAt ?? evidence.endTime ?? evidence.at ?? '');

  if (
    !Number.isFinite(endedAt) ||
    now.getTime() - endedAt > Number(policy.maxEvidenceAgeMs ?? 24 * 60 * 60 * 1000)
  )
    return {
      status: EVIDENCE_TRUST.STALE,
      reusable: false,
      reason: 'evidence exceeded configured age',
    };

  return {
    status: EVIDENCE_TRUST.REUSABLE,
    reusable: true,
    reason: 'same revision, environment, policy, and age',
  };
}
export function evaluateEvidenceSet(evidence = [], context = {}) {
  const evaluated = evidence.map((item) => ({ ...item, trust: evaluateEvidence(item, context) }));

  return {
    evidence: evaluated,
    reusable: evaluated.some((item) => item.trust.reusable),
    evaluated,
  };
}
