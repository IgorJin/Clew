---
id: CLEW-133
title: '[plugins][release] Conformance без live-smoke и доки'
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-130, CLEW-131, CLEW-132]
parallel_group: null
owner: null
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-133 — [plugins][release] Conformance без live-smoke и доки

## Objective

Собрать эпик в проверяемый релиз-гейт: общий conformance-набор для Codex/OpenCode из fixtures, без обязательного live smoke, плюс доки и удаление старых фабрик.

## User outcome

Четвёртый runtime (в будущем) добавляется без правок scheduler/ролей/UI — это проверяется структурно, а не словами.

## Context

Финальный шаг эпика. По требованию: live smoke внешних CLI не гоняем; marketplace, Claude, метрики/логи, workflow-конструктор — вне объёма и фиксируются как deferred в доках.

## Scope

- `harness-conformance` как контрактный набор для bundled runtime: quick/standard/deep; worker/architect/reviewer/qa где capability заявлена; start/resume/interrupt/approval; missing binary/login; unsupported model; invalid structured output; truncated JSON/SSE; timeout; дубли событий/usage; рестарт до/после checkpoint; incompatible/disabled plugin; один writer; local/paired + stale lease epoch. Неподдержанное — явный отказ до исполнения.
- Удаление старых фабрик только после перехода local/paired/role/session потребителей; совместимые CLI-алиасы можно держать дольше.
- Доки: новая конфигурация `agents.*` + host connections, миграция со старых флагов, deferred-список (Claude, marketplace, metrics/logs, workflow-конструктор), совместимость версий.
- Релизные ворота эпика фиксируются здесь и гоняются на fixtures.

## Out of scope

- Новые runtime и новые extension points; это acceptance, не разработка.

## Deliverables

- Зелёный conformance на fixtures + доки + чистка фабрик + release notes эпика.

## Acceptance criteria

1. Conformance проходит для Codex и OpenCode без live CLI; каждая строка матрицы маппится на тест.
2. Греп-гейт: ноль прямых runtime-импортов в scheduler/ролях/control-service; ноль чтений `codexBin/openCodeUrl` в обход resolver.
3. Доки описывают новую конфигурацию, миграцию и явный deferred-список; старые флаги либо маппятся с диагностикой, либо отклоняются с объяснением.
4. Общие репо-гейты зелёные; live smoke не требуется и его отсутствие задокументировано как решение эпика.

## Acceptance evidence

| Criterion | Automated evidence                | Logical scenarios                       | Result  |
| --------- | --------------------------------- | --------------------------------------- | ------- |
| AC-1      | conformance matrix run (fixtures) | full matrix above                       | pending |
| AC-2      | grep-gate CI                      | forbidden imports/config reads          | pending |
| AC-3      | docs diff + config-matrix test    | new config; legacy flags; deferred list | pending |
| AC-4      | quality gates log                 | lint/test/build                         | pending |

## Verification

- Прогнать матрицу + gates, приложить логи; live smoke не гонять.
- Независимый review всего эпика.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Зависит от `130, 131, 132`. Последний в эпике.

## Risks

- Conformance на fixtures пропустит native-нюанс; принято как решение эпика, фиксируем в доках.

## Blockers

None.

## Completion record

Not completed.
