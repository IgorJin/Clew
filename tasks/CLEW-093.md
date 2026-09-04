---
id: CLEW-093
title: Task screen v3 and finalization workflow
status: done
release: v0.9
priority: P0
size: XL
depends_on: [CLEW-087, CLEW-088, CLEW-089, CLEW-091, CLEW-092]
parallel_group: null
owner: null
updated: 2026-09-04
evidence_policy: v1
---

# CLEW-093 — Task screen v3 and finalization workflow

## Objective

Перенести экран Task на прототип `clew-task-screen-prototype-v3.html` и связать его с безопасным финальным workflow: Task-level actions, Current Stage, Agent runtime, Finalization Gate, Git integration и раздельные состояния `READY_TO_FINISH`, `MERGED`, `RELEASED`.

## User outcome

Пользователь видит единый экран задачи, понимает текущую стадию и состояние агента, может открыть изменения или IDE из стабильного Task-level блока и завершить работу через context-aware Finalization Gate. Clew не считает задачу завершённой только потому, что агент закончил работу: verification, review, evidence, Git integration и cleanup должны быть согласованы.

## Context

Прототип задаёт ownership-модель:

```text
TASK
├ View changes
├ Open IDE
└ Finish work

STAGE
├ context
├ result
└ stage-specific actions

AGENT
├ open/focus
├ terminal
└ pause/resume
```

`Finish work` не является прямым `task.status = done`. Он открывает детерминированную проверку и выбирает действие по состоянию workspace, verification, review и integration policy.

## Scope

### Implemented in this slice

- Lifecycle enum and transitions now include `READY_TO_FINISH`, `MERGED`, and `RELEASED` while preserving legacy `READY`/`COMPLETED` flows.
- Added a read-only, versioned `FinalizationReport` builder and `task finalization TASK_ID` command.
- Exposed the gate in task snapshots and rendered its checks in the Task UI.
- Added default integration policy (`squash` into `main`, cleanup enabled) and focused unit coverage.
- Added opt-in task Git integration, clean-target preflight, squash/merge/handoff flows, conflict attention StageRuns, cleanup, and explicit release evidence.
- Added Finalization Gate modal, keyboard focus trap, responsive sticky mobile action bar, and strict UI report mapping.

### Workstream A — Task lifecycle

- Добавить `READY_TO_FINISH`, `MERGED`, `RELEASED`.
- Оставить `COMPLETED` для задач без Git-интеграции.
- Добавить миграцию и обратную совместимость для старых `READY`/`COMPLETED`.
- Добавить события `TASK_READY_TO_FINISH`, `TASK_MERGED`, `TASK_RELEASED`.

### Workstream B — Finalization Gate

- Проверять workspace/worktree, dirty/untracked files, commits, verification, acceptance evidence, review blockers, target branch и merge conflicts.
- Возвращать версионируемый `FinalizationReport` с checks, blocking reasons и available actions.
- Не менять Git state при открытии или повторной проверке gate.

### Workstream C — Git integration

- Ввести repository policy:

  ```yaml
  integration:
    default: squash
    target: main
    cleanup_after_merge: true
  ```

- Поддержать squash merge, merge commits, PR и human merge policy.
- Не создавать новый commit для уже чистой ветки.
- Разрешить редактирование commit message.
- После подтверждённой интеграции перевести задачу в `MERGED` и сделать worktree cleanup-eligible.
- При конфликте создавать отдельный Integration StageRun и переводить задачу в Attention/Human wait.

### Workstream D — Task Screen v3

- Использовать прототип как визуальную основу.
- Убрать Git/workspace actions из Agent cards.
- Убрать дублирование Task actions из шапки.
- На desktop оставить постоянный блок справа; на mobile использовать sticky bottom action bar.
- Переименовать primary action в `Finish work`.
- Показывать состояния Before start, Running, Review/Attention, Ready to finish, Merged и Released.
- Добавить Delivery flow, Previous steps, Current Stage context и Finalization modal/sheet.

### Workstream E — Responsive и acceptance

- Проверить ширины от 360px.
- Добавить keyboard navigation, focus trap и reduced-motion поддержку.
- Покрыть сквозные сценарии lifecycle, retry, verification failure, review blocker, dirty workspace, clean branch, conflict и `MERGED → RELEASED`.

## Out of scope

- Автоматическое определение production deployment без CI/CD-интеграции.
- Удаление Task Thread, evidence или diff metadata после cleanup worktree.
- Обязательный cloud PR provider.
- Полная реализация Discuss/Prompt Registry/Skill Resolver; они подключаются через существующие структурированные контракты.

## Deliverables

- Lifecycle schema, migration и transition tests.
- `FinalizationReport` schema, validator, persistence и CLI/API surface.
- Git integration policy, commit/merge/PR operations и conflict handling.
- Обновлённый Task Screen v3, modal/sheet и responsive action bar.
- UI/backend integration fixtures и документация.

## Acceptance criteria

1. Успешная реализация с Git-интеграцией завершается в `READY_TO_FINISH`, а не напрямую в `COMPLETED`.
2. `Finish work` открывает Finalization Gate и показывает code, verification, evidence, review и Git checks.
3. Blocking review, failed verification или незаполненное evidence запрещают интеграцию и объясняют причину.
4. Чистая ветка не получает лишний commit.
5. Dirty workspace позволяет отредактировать commit message и выполнить выбранную integration policy.
6. Default policy — squash merge в `main`; policy можно переопределить на уровне repository/task.
7. Merge conflict не повреждает target branch, создаёт структурированный Attention и отдельный Integration StageRun.
8. Worktree удаляется только после подтверждённой интеграции; Task Thread, evidence и diff metadata сохраняются.
9. `MERGED` и `RELEASED` отображаются как разные состояния; `RELEASED` не устанавливается автоматически без deployment evidence.
10. На desktop Task actions находятся в правом блоке, на mobile — в sticky bottom bar; дублирования в шапке нет.
11. Agent card содержит только session/runtime actions: open/focus, terminal, pause/resume.
12. Старые задачи и задачи без Git-интеграции продолжают работать.

## Acceptance evidence

| Criterion | Automated evidence                                            | Logical scenarios                                         | Result |
| --------- | ------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| AC-1      | `test/domain.test.js`, `test/scheduler.test.js`               | READY_TO_FINISH, COMPLETED without Git, old database      | done   |
| AC-2      | `test/finalization.test.js`, `ui/src/App.test.tsx`            | open/recheck gate, read-only behavior                     | done   |
| AC-3      | `test/finalization.test.js`                                   | failed verification, blocking review, incomplete evidence | done   |
| AC-4      | `test/workspace.test.js`, `test/finalization-service.test.js` | clean branch, already committed agent output              | done   |
| AC-5      | `test/workspace.test.js`, `test/finalization-service.test.js` | dirty/untracked workspace, editable message               | done   |
| AC-6      | `test/workspace.test.js`, service integration tests           | squash, merge commit, PR/human policy                     | done   |
| AC-7      | `test/workspace.test.js`, integration service tests           | changed target branch, conflict recovery, restart         | done   |
| AC-8      | `test/finalization-service.test.js`                           | cleanup after merge, preserved history/evidence           | done   |
| AC-9      | `test/finalization-service.test.js`, `ui/src/App.test.tsx`    | MERGED without RELEASED, explicit Mark released           | done   |
| AC-10     | `ui/src/App.test.tsx`, responsive CSS                         | desktop, 360px mobile, keyboard                           | done   |
| AC-11     | existing Agent/Terminal UI tests                              | worker, architect, reviewer, terminal states              | done   |
| AC-12     | `npm run check`                                               | legacy task, no-Git task, duplicate requests              | done   |

## Verification

- `npm run check`.
- Lifecycle migration and transition matrix.
- Finalization Gate read-only and repeatability tests.
- Git repository fixtures for clean, dirty, untracked, already committed and conflicting branches.
- Duplicate requests, process restart and durable-boundary recovery tests.
- UI tests for all lifecycle states, loading/error/empty states, desktop and 360px mobile.
- Keyboard/focus accessibility smoke.
- Installed package and production UI smoke.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Workstream A is the contract dependency. Workstreams B and C may proceed after lifecycle contracts are accepted. Workstream D depends on A/B/C. Workstream E follows D and owns cross-component acceptance. Git integration must remain the sole owner of commit, merge, PR and cleanup mutations.

## Risks

- Existing `READY`/`COMPLETED` semantics may be relied on by external clients.
- Merge and cleanup operations are destructive enough to require idempotency and explicit confirmation.
- Responsive layout can hide critical actions if the desktop sidebar is simply removed.
- Conflict recovery must not create an unbounded agent retry loop.

## Blockers

None.

## Completion record

- Completed: 2026-09-04
- Verification: `npm run check` — 215 backend tests (205 passed, 10 loopback skips) and 29 UI tests passed.
- Note: PR/human strategies intentionally create an audited integration handoff; external provider/deployment automation remains out of scope.
