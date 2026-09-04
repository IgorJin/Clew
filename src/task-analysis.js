export const TASK_KIND = Object.freeze({
  FEATURE: 'feature',
  BUG: 'bug',
  REFACTOR: 'refactor',
  MAINTENANCE: 'maintenance',
  INVESTIGATION: 'investigation',
});

function taskText(task) {
  return [task.title, task.goal, task.description, ...(task.tags ?? [])]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function detectKind(text) {
  if (
    /(?<![\p{L}\p{N}_])(bug|error|broken|crash|failure|regression|500|баг|ошиб|падает)(?![\p{L}\p{N}_])/iu.test(
      text,
    )
  )
    return { value: TASK_KIND.BUG, confidence: 0.86 };
  if (
    /(?<![\p{L}\p{N}_])(investigat|research|analy[sz]|spike|исслед|разобраться|проанализ)/iu.test(
      text,
    )
  )
    return { value: TASK_KIND.INVESTIGATION, confidence: 0.82 };
  if (/(?<![\p{L}\p{N}_])(refactor|cleanup|restructur|рефактор)(?![\p{L}\p{N}_])/iu.test(text))
    return { value: TASK_KIND.REFACTOR, confidence: 0.84 };
  if (
    /(?<![\p{L}\p{N}_])(maintenan|upgrade|dependency|dependencies|chore|обновить зависим)/iu.test(
      text,
    )
  )
    return { value: TASK_KIND.MAINTENANCE, confidence: 0.78 };

  return { value: TASK_KIND.FEATURE, confidence: 0.62 };
}

function specificAcceptance(task) {
  if (!Array.isArray(task.acceptance) || !task.acceptance.length) return false;
  const goal = task.goal?.trim().toLowerCase();

  return task.acceptance.some((item) => {
    const criterion = (typeof item === 'string' ? item : item?.criterion)?.trim().toLowerCase();

    return criterion && criterion.length >= 12 && criterion !== goal;
  });
}

export function analyzeTask(task) {
  if (!task || typeof task !== 'object') throw new Error('task analysis requires a Task contract');
  const text = taskText(task);
  const kind = detectKind(text);
  const checks = [];
  const addCheck = (id, passed, weight, summary) => checks.push({ id, passed, weight, summary });

  addCheck('goal', Boolean(task.goal?.trim()), 25, 'Goal is present');
  addCheck(
    'acceptance',
    specificAcceptance(task),
    30,
    'Acceptance criteria are distinct and testable',
  );
  addCheck('repository', Boolean(task.base_ref?.trim()), 15, 'Repository base is known');
  addCheck(
    'scope',
    Boolean(task.goal?.trim()) && task.goal.trim().length <= 2_000,
    10,
    'Scope is bounded',
  );
  if (kind.value === TASK_KIND.BUG)
    addCheck(
      'reproduction',
      /(?<![\p{L}\p{N}_])(repro|steps|when|failing test|воспроиз|шаги|тест)(?![\p{L}\p{N}_])/iu.test(
        text,
      ),
      20,
      'Bug reproduction is described',
    );
  else addCheck('intent', true, 20, 'Task intent is classifiable');
  const score = checks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0);
  const unresolved = checks.filter((check) => !check.passed).map((check) => check.summary);
  const deepSignals = [
    task.risk === 'high',
    /(?<![\p{L}\p{N}_])(security|auth|permission|migration|cross[- ]repo|distributed|payment|безопас|миграц|авториза)/iu.test(
      text,
    ),
  ];
  const recommendedProfile = deepSignals.some(Boolean)
    ? 'deep'
    : score >= 85 && task.risk === 'low'
      ? 'quick'
      : 'standard';
  const action =
    kind.value === TASK_KIND.BUG &&
    checks.some((check) => check.id === 'reproduction' && !check.passed)
      ? 'investigate'
      : checks.some((check) => check.id === 'acceptance' && !check.passed) || score < 70
        ? 'shape'
        : recommendedProfile === 'deep'
          ? 'plan'
          : 'start';
  const reasons = [];

  if (recommendedProfile === 'deep') reasons.push('High-risk or architecture-sensitive change');
  else if (recommendedProfile === 'quick') reasons.push('Clear, bounded, low-risk task');
  else reasons.push('Independent review is appropriate for the current uncertainty and risk');
  if (unresolved.length) reasons.push(`${unresolved.length} readiness check(s) unresolved`);

  return {
    version: 1,
    kind,
    readiness: { score, readyToStart: score >= 70, checks, unresolved },
    recommendation: { action, profile: recommendedProfile, reasons },
  };
}
