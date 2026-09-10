---
id: CLEW-108
title: Compressed artifact bodies and bounded reads
status: planned
release: unassigned
priority: P1
size: S
depends_on: [CLEW-107]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-108 — Compressed artifact bodies and bounded reads

## Objective

Сократить размер текстовых artifacts и ограничить их чтение и распаковку.

## User outcome

Текстовые artifacts занимают меньше места и открываются без загрузки всего файла в память.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Выбрать один встроенный streaming codec (gzip как простой старт), хранить encoding отдельно от checksum нормализованных несжатых bytes.
- Сжимать только подходящий текст и сохранять несжатый вариант, если compression не даёт выигрыша; ограничить concurrency и временные bytes.
- Добавить чтение preview/body с лимитом декодированных bytes; обработать unsupported encoding, corrupt body и закрытие reader lease.

## Out of scope

Несколько codec-плагинов и автоматический полный rewrite старых blobs.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Одинаковый redacted текст сохраняет идентичность независимо от encoding, round-trip восстанавливает точные bytes.
2. Compression и decode не собирают весь artifact в RAM; tiny/already-compressed данные не увеличиваются из-за обязательного codec.
3. Повреждённый или чрезмерно распаковывающийся blob даёт bounded failure без утечки reader lease.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                      | Logical scenarios                                                    | Result  |
| --------- | --------------------------------------- | -------------------------------------------------------------------- | ------- |
| AC-1      | `test/artifact-codec.test.js`, группа 1 | codec round-trip; Unicode; same checksum; incompressible input       | pending |
| AC-2      | `test/artifact-codec.test.js`, группа 2 | stream/backpressure instrumentation; tiny; encoded formats           | pending |
| AC-3      | `test/artifact-codec.test.js`, группа 3 | truncated gzip; decoded byte cap; cancellation; reader lease release | pending |

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

Зависит от [CLEW-107](./CLEW-107.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Лимит только сжатых bytes не ограничивает память при распаковке.

## Blockers

None.

## Completion record

Not completed.
