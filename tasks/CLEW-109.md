---
id: CLEW-109
title: Normalize and externalize large event payloads
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-105, CLEW-107]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-109 — Normalize and externalize large event payloads

## Objective

Перевести новые harness/tool записи на bounded summaries и ссылки на большие тела.

## User outcome

Шумный инструмент не раздувает каждое событие; результат и ограничения полноты остаются объяснимыми.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить общий persistence boundary после извлечения канонических facts; разрешённые поля каждого harness нормализуются, hidden reasoning исключается.
- Inline payload ограничить 32 КиБ вместе с preview/metadata; большие разрешённые поля выносить в artifact; редактировать секреты до hash и записи.
- Сохранить каноническое evidence с revision/exit status и отдельной completeness; использовать mixed-format readers для старых событий. Raw Runner content остаётся на execution host.

## Out of scope

Quota policy, legacy rewrite и новый QA verdict.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Один большой tool output не копируется повторно в HARNESS/tool/verification events; каждый новый inline payload укладывается в контракт.
2. Секреты, включая разделённые chunks, и запрещённые native поля не оказываются в blob, preview или checksum input; случай усечения виден.
3. Quick/Standard/Deep сохраняют те же решения и provenance; потеря необязательных logs не меняет passed command, отсутствие обязательного evidence не становится pass.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                     | Logical scenarios                                                   | Result  |
| --------- | -------------------------------------- | ------------------------------------------------------------------- | ------- |
| AC-1      | `test/event-storage.test.js`, группа 1 | adapter fixtures; duplicate tool evidence; inline UTF-8 byte bounds | pending |
| AC-2      | `test/event-storage.test.js`, группа 2 | redaction stream boundaries; excluded fields; truncated preview     | pending |
| AC-3      | `test/event-storage.test.js`, группа 3 | profile regression; required vs optional evidence; paired allowlist | pending |

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

Зависит от [CLEW-105](./CLEW-105.md), [CLEW-107](./CLEW-107.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Изменение payload shape может нарушить скрытый consumer, поэтому используется реестр CLEW-105.

## Blockers

None.

## Completion record

Not completed.
