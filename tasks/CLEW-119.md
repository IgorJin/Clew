---
id: CLEW-119
title: Task artifact export and restore verification
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-108, CLEW-114]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-119 — Task artifact export and restore verification

## Objective

Создавать согласованный Task export и проверять его восстановимость в изолированной директории.

## User outcome

Пользователь получает проверяемый переносимый пакет Task с явным перечнем включённых и недоступных данных.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Фиксировать source cursor и временно pin все включённые blobs; manifest содержит schema/version/checksums и unavailable/expired статусы.
- Экспортировать Task, checkpoints и выбранное evidence потоком; завершать manifest только после проверки bodies, переживать cancelled export и concurrent prune.
- Добавить verify/restore-check в новый target без автозапуска и перезаписи live state; согласовать snapshot/backup notes с CLEW-076.

## Out of scope

Полный deployment restore, восстановление native session/worktree и удаление оригинала после экспорта.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Параллельные новые события/prune не меняют фиксированный экспорт; pins освобождаются после завершения или recovery отмены.
2. Corrupt/missing/Runner-local body явно указан; обязательное отсутствующее evidence не позволяет объявить экспорт полным.
3. Изолированный restore-check подтверждает canonical/checkpoint hashes и references, не меняет исходную БД и не запускает harness.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                   | Logical scenarios                                                    | Result  |
| --------- | ------------------------------------ | -------------------------------------------------------------------- | ------- |
| AC-1      | `test/task-export.test.js`, группа 1 | export snapshot fixture; concurrent append/prune; interrupted export | pending |
| AC-2      | `test/task-export.test.js`, группа 2 | manifest validation; missing checksum; unavailable host              | pending |
| AC-3      | `test/task-export.test.js`, группа 3 | fresh-directory restore check; source unchanged; zero harness calls  | pending |

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

Зависит от [CLEW-108](./CLEW-108.md), [CLEW-114](./CLEW-114.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Копия одного live SQLite файла не гарантирует согласованный backup с WAL и blobs.

## Blockers

None.

## Completion record

Not completed.
