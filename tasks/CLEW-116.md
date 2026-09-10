---
id: CLEW-116
title: Retention policy and prune preview
status: planned
release: unassigned
priority: P1
size: S
depends_on: [CLEW-106, CLEW-113, CLEW-115]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-116 — Retention policy and prune preview

## Objective

Показывать точный список безопасных кандидатов очистки без удаления данных.

## User outcome

До очистки пользователь видит, что можно удалить и сколько места действительно освободится.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Реализовать policy resolver по реальным Task states, возрасту после последней активности, pins, shared refs и recovery dependencies.
- Добавить storage prune --dry-run с plan ID/policy version/cutoff и физически освобождаемыми bytes.
- Сохранить защиту canonical/evidence/user данных после export; активные runs/leases и последние три failed/blocked Runs исключаются.

## Out of scope

Физическое удаление и включённая по умолчанию автоматическая очистка.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. COMPLETED/RELEASED, CANCELLED, FAILED/BLOCKED и READY/WAITING/active состояния следуют разным правилам документа.
2. Shared/pinned/recovery/evidence blobs не попадают в reclaimable bytes; неизвестные типы защищены.
3. Dry-run не меняет Task state и не удаляет данные; plan содержит достаточно версий для повторной проверки при apply.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                        | Logical scenarios                                                | Result  |
| --------- | ----------------------------------------- | ---------------------------------------------------------------- | ------- |
| AC-1      | `test/retention-policy.test.js`, группа 1 | retention clock/state matrix; recent failure; continuation grant | pending |
| AC-2      | `test/retention-policy.test.js`, группа 2 | shared ownership; export pins; unknown event; accepted evidence  | pending |
| AC-3      | `test/retention-policy.test.js`, группа 3 | dry-run CLI; deterministic cutoff; stale plan fixture            | pending |

## Verification

- Реализовать и запустить три группы проверок выше; записать конкретные команды/пути перед переводом в review.
- Запустить существующие проверки затронутых модулей; schema/migration changes проверять на fresh и upgraded store.
- Для stateful paths проверить durable boundaries, повторные запросы и рестарт согласно AC; не заменять эти доказательства одним общим зелёным suite.
- Перед завершением выполнить применимые repository quality gates и независимый review.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Зависит от [CLEW-106](./CLEW-106.md), [CLEW-113](./CLEW-113.md), [CLEW-115](./CLEW-115.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

FAILED и BLOCKED могут возобновляться, поэтому одного terminal label недостаточно.

## Blockers

None.

## Completion record

Not completed.
