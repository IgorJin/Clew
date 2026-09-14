---
id: CLEW-115
title: Bounded role briefs from checkpoints
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

# CLEW-115 — Bounded role briefs from checkpoints

## Objective

Использовать checkpoints для передачи релевантного контекста между существующими ролями.

## User outcome

Следующая роль получает нужные факты и незакрытые замечания, включая запуск с новой native session.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Собирать Execution Brief из применимого checkpoint, обязательного контракта и выбранных evidence refs; добавить bounded artifact resolver на execution host.
- Заменить тонкое подключение scout из CLEW-125 общим сборщиком по выводам завершённого [CLEW-126](./done/CLEW-126.md), сохранив явный выбор/отказ, context IDs, checksums, source revisions, selected sections и freshness. Различать repository context и накопленный progress; не включать всю карту автоматически каждой роли.
- Проверять revision, plan version, evidence freshness; отдельно ограничить автоматически включаемый контекст по приблизительному token estimate с явными omissions. Для partial context не скрывать unknowns/omissions, а recommended checks не считать выполненным evidence.
- Проверить resume и fresh-session fallback для architect/worker/reviewer/integration/optional QA; сохранить allowlist Runner v1 и explicit unavailable remote bodies.

## Out of scope

Новый agent runtime, general-purpose RAG и обещание точного tokenizer для всех моделей.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Каждая роль получает обязательные constraints/findings и релевантные dependencies; пропущенные optional artifacts доступны по ссылке и не скрыты. Проверенный сценарий scout v0 → architect/worker работает через новый сборщик без потери provenance; запуск без scout остаётся доступен.
2. Stale revision, новый plan и native session fallback не повторно используют устаревшее evidence или неверные permissions; mandatory overflow не обрезается молча.
3. После удаления diagnostic bodies Quick/Standard/Deep и явная continuation сохраняют корректное поведение; paired path не передаёт raw output.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                          | Logical scenarios                                                             | Result  |
| --------- | ------------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| AC-1      | `test/checkpoint-handoff.test.js`, группа 1 | role brief fixtures; required findings; token budget; omitted body resolution | pending |
| AC-2      | `test/checkpoint-handoff.test.js`, группа 2 | revision/plan mismatch; stale session; mandatory overflow                     | pending |
| AC-3      | `test/checkpoint-handoff.test.js`, группа 3 | profile continuation/recovery; no diagnostics; paired allowlist               | pending |

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

Зависит от [CLEW-108](./CLEW-108.md), [CLEW-114](./CLEW-114.md); через 114 обязательно завершение scout пилота [CLEW-126](./done/CLEW-126.md). Все должны быть done до ready. Используется уточнённый по пилоту контракт; общая память репозитория и автоматическое повторное исследование остаются вне Scope.

## Risks

Bytes и tokens не взаимозаменяемы; приблизительный budget должен быть помечен.

## Blockers

None.

## Completion record

Not completed.
