---
id: CLEW-107
title: Local artifact publishing and references
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-105]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-107 — Local artifact publishing and references

## Objective

Добавить локальную адресуемую по checksum запись blobs и отдельные ссылки владельцев.

## User outcome

Результаты инструментов доступны после рестарта по стабильным ссылкам без копирования одинаковых файлов.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить metadata/reference migration, интерфейс put/open/stat и scoped artifact IDs в state directory.
- Публиковать redacted bytes через bounded stream, temporary file и durable rename до commit ссылки; повторная запись дедуплицируется.
- Проверять Task/host ownership, path escape/symlink и concurrency; предусмотреть reference pins, reader leases и deletion state для последующего GC.

## Out of scope

Compression, пользовательские binary uploads, S3 и физическая очистка orphan.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Два владельца одинакового содержимого используют один blob и независимые references; чтение не выходит из разрешённого state directory.
2. Crash до/после publish и commit ссылки не оставляет видимого partial blob; повтор операции идемпотентен, orphan распознаётся.
3. Удаляемый blob нельзя получить новым reference, pin или reader lease без атомарного восстановления доступного состояния; missing/corrupt различаются.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                      | Logical scenarios                                                          | Result  |
| --------- | --------------------------------------- | -------------------------------------------------------------------------- | ------- |
| AC-1      | `test/artifact-store.test.js`, группа 1 | artifact-store fixtures; duplicate content; wrong task; traversal; symlink | pending |
| AC-2      | `test/artifact-store.test.js`, группа 2 | fault injection at temp/publish/reference commit; reopen; retry            | pending |
| AC-3      | `test/artifact-store.test.js`, группа 3 | concurrent publish/pin/read/deletion-state tests; checksum failure         | pending |

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

Зависит от [CLEW-105](./CLEW-105.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Filesystem и SQLite не имеют общей транзакции; публикация ссылки раньше файла нарушит durability.

## Blockers

None.

## Completion record

Not completed.
