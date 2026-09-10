---
id: CLEW-120
title: Resumable legacy payload migration
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-109, CLEW-111, CLEW-119]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-120 — Resumable legacy payload migration

## Objective

Уменьшать legacy payloads отдельной возобновляемой migration с проверкой эквивалентности.

## User outcome

Пользователь может постепенно уменьшить старую историю и продолжить перенос после прерывания.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить dry-run и bounded batch conversion больших redacted payloads в storage references без смены event IDs/seq.
- До apply требовать проверяемую backup-копию migration target; сохранять checksum и версию исходного представления, compatibility reader и journal cursor.
- Сравнивать logical canonical facts/projections до и после; сбой обработки одного row не должен повреждать остальную историю.

## Out of scope

Обязательный полный rewrite при старте приложения или незаметное изменение семантики старых событий.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Mixed legacy/new база читается одинаково, seq/event identity и canonical/recovery digests сохраняются.
2. Остановка после publish и до/после row commit, повтор команды и low disk дают идемпотентное продолжение без dangling refs.
3. Dry-run не пишет данные; backup проверяется до изменения, а unsupported/corrupt row остаётся исходным и отражается в отчёте.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                         | Logical scenarios                                           | Result  |
| --------- | ------------------------------------------ | ----------------------------------------------------------- | ------- |
| AC-1      | `test/storage-migration.test.js`, группа 1 | legacy upgrade fixtures; mixed readers; before/after digest | pending |
| AC-2      | `test/storage-migration.test.js`, группа 2 | migration fault injection; duplicate run; disk exhaustion   | pending |
| AC-3      | `test/storage-migration.test.js`, группа 3 | dry-run; backup validation; corrupt/unsupported row         | pending |

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

Зависит от [CLEW-109](./CLEW-109.md), [CLEW-111](./CLEW-111.md), [CLEW-119](./CLEW-119.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Storage migration должна быть аудируемой, хотя бизнес-содержимое event остаётся неизменным.

## Blockers

None.

## Completion record

Not completed.
