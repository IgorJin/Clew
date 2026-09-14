---
id: CLEW-124
title: Read-only scout execution and local result
status: done
release: unassigned
priority: P1
size: M
depends_on: [CLEW-123]
parallel_group: null
owner: codex
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-124 — Read-only scout execution and local result

## Objective

Добавить явный scout run на существующем harness с небольшим локальным JSON-результатом.

## User outcome

Пользователь запускает исследование для Task, видит выбранную revision, preview результата и причины неполноты.

## Context

[Scout v0](../../docs/SCOUT.md) проверяет минимальную карту контекста до фиксации [checkpoints](../../docs/TASK-DATA-LIFECYCLE.md). Дальнейшее расширение scout запланировано отдельно; текущие карточки не определяют архитектуру общей памяти навсегда. Релиз не назначен, v0.10 остаётся текущим мини-релизом.

## Scope

- Добавить CLI запуск/show/cancel scout attempt, используя текущий read-only harness path, timeout и output limits; один репозиторий на execution host.
- Подготовить read-only представление выбранного commit; явно отображать наличие неучтённых dirty changes. Проверять source paths/line ranges; запретить repo writes, install/test execution и сетевые инструменты.
- После redaction/validation атомарно публиковать versioned JSON в state directory, затем Task reference; хранить attempt ID, idempotency key и checksum. Файл пока не требует CLEW-107.

## Out of scope

Собственный agent loop, UI scout, фоновые обновления, persistent cross-task memory и Runner protocol changes.

## Deliverables

- Реализация описанного результата, CLI/schema changes по Scope.
- Автоматические fixtures с конкретным evidence для каждого критерия и обновлённая документация.

## Acceptance criteria

1. Успешный запуск создаёт валидный результат и preview с существующими источниками; исходный checkout, Task Contract, workflow state и unrelated artifacts не изменяются.
2. Read-only/tool restrictions, timeout/cancel, corrupt output и oversized result дают явный failure/partial без публикации полного успешного результата.
3. Повтор запроса и restart вокруг запуска/file publish/reference commit не запускают duplicate attempt и не публикуют dangling reference; interrupted попытка требует явного нового запуска.

## Acceptance evidence

Пути — планируемые тесты; результаты пока не получены.

| Criterion | Automated evidence                       | Logical scenarios                                                             | Result |
| --------- | ---------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| AC-1      | `test/scout-execution.test.js`, группа 1 | CLI/fake harness; commit snapshot; dirty checkout warning; source validation  | pass   |
| AC-2      | `test/scout-execution.test.js`, группа 2 | permission conformance; forbidden write/test/network; timeout; invalid output | pass   |
| AC-3      | `test/scout-execution.test.js`, группа 3 | idempotency fixtures; interrupted run; atomic publish; restart                | pass   |

## Verification

- Выполнены `node --test test/scout-execution.test.js` (7 tests), `npm run lint` и `npm run format:check`.
- Fixtures покрывают CLI/fake, commit snapshot, dirty warning, source validation, forbidden commands, corrupt/oversized output, timeout/cancel, повтор запроса, interruption и recovery файла без reference event.
- `node --test --test-concurrency=1 test/*.test.js` проходит: 245 pass, 10 штатных managed-sandbox skips, 0 fail. Параллельный `npm test` в этом окружении флейкует в существующем `runner-transport.test.js` (shared loopback timing: `undefined.open`/reconnect count); отдельный файл и последовательный backend gate проходят.

## Review record

- Verdict: pass
- Reviewer: Codex counterexample-oriented implementation review, 2026-09-11
- Findings: Проверены read-only snapshot и удаление после завершения, граница state path, строгая валидация источников/checksum, запреты команд, отсутствие публикации при ошибках, idempotency и recovery на границе file/event. Блокирующих замечаний не осталось.

## Dependencies and parallelization

Зависит от завершённой [CLEW-123](./CLEW-123.md). Не зависит от CLEW-105–122. После 123 → 124 → 125 → 126 можно уточнять и реализовывать CLEW-114 → 115; независимые storage задачи могут выполняться рядом.

## Risks

Read-only prompt сам по себе не ограничивает инструменты: runtime capability должна обеспечивать выбранный режим, иначе отказ до запуска.

## Blockers

None.

## Completion record

Read-only Scout execution реализован в `src/scout-runner.js` и подключён к `clew task scout TASK`, `show` и `cancel`. Результат строится из `git archive` выбранной revision во временном frozen snapshot, проходит redaction/runtime validation/source checks, атомарно сохраняется в `.clew/scout/<task>/<context>.json`, затем закрепляется Task event с request/attempt/idempotency/checksum. Повтор опубликованного запроса возвращает тот же результат; interrupted request требует нового ID, а файл без reference event восстанавливается безопасно.

Проверка: format/lint/task gates и UI suite проходят; backend проходит в последовательном режиме (245 pass, 10 sandbox skips); `npm pack --dry-run --json` с task-local npm cache включает runner, schemas, fixtures и эту карточку. Параллельный `npm run check` упирается в существующий flaky `runner-transport` timing test, не связанный со Scout.
