---
id: CLEW-130
title: '[plugins][routing] Роль-подключение-модель, doctor, safe-проекция'
status: in_review
release: unassigned
priority: P1
size: M
depends_on: [CLEW-128, CLEW-129]
parallel_group: null
owner: null
updated: 2026-09-12
evidence_policy: v1
---

# CLEW-130 — [plugins][routing] Роль-подключение-модель, doctor, safe-проекция

## Objective

Ввести единое `роль → connection → модель` поверх Codex/OpenCode из `128/129`, общий doctor и безопасную UI/CLI-проекцию без workflow-конструктора.

## User outcome

`worker/architect/reviewer/qa` явно указывают connection (+ модель или default runtime); недоступный runtime — понятный отказ с причиной, а не молчаливый fallback.

## Context

Сейчас модели лежат в `models.*`, harness выбирается флагами/хардкодом, diagnostics раздельны. Целевая схема — раздел 6 предложения. `CLEW-099` остаётся UI-only референсом; execution wiring выбора — здесь, но без конструктора workflow.

## Scope

- Приоритет: явный override запуска/стадии → настройка роли → профиль/default; в пределах уровня flags → env → project → user → defaults, в рамках host policy. `model: null` = default runtime; унаследованная модель на другой connection молча не переносится.
- Конфликт старого `--harness` с новым `--connection` — ошибка с объяснением; `models.*` маппятся в legacy connections с диагностикой. Захардкоженная Codex-модель reviewer (`gpt-5.6-luna` в `DEFAULT_CONFIG`) уходит из ядра в defaults Codex-connection; ядро не знает имён моделей конкретных runtime.
- `doctor`: общий каркас + `probe` внутри плагина (binary/endpoint, версия, auth без её изменения, capabilities, модели). Совместный `--connection`+`--harness` конфликт тоже здесь.
- Safe-проекция для UI/CLI: id, plugin, enabled, статус (`disabled/unconfigured/ready/unavailable/incompatible`), capabilities — без секретов и без исполнения кода плагина во frontend. Без workflow-конструктора и без изменения `CLEW-099` сверх проекции.
- Session refs включают runtime/connection/host/native id и не переносятся между Codex и OpenCode.

## Out of scope

- Claude; marketplace; workflow-конструктор и UX сборки блоков (другой релиз).
- Binding persistence (`131`); метрики/логи.

## Deliverables

- Role resolver + config migration + doctor + проекция + доки precedence.

## Acceptance criteria

1. Для каждой роли резолвится ровно один connection + модель/default; недоступная модель не подменяется молча.
2. `--harness` + `--connection` вместе — явная ошибка; legacy `models.*/codexBin/openCode*` дают диагностику миграции без смены поведения по умолчанию; в ядре (`DEFAULT_CONFIG` и сервисы) не остаётся имён моделей конкретных runtime. Binaries/endpoints (`codexBin/openCodeBin/openCodeUrl`) остаются host-level legacy-настройкой с маппингом в connections до `CLEW-133`/P6 (поправка review 2026-09-12, см. Review record).
3. `doctor` показывает причину недоступности требуемого режима; auth не меняется.
4. UI/CLI видят только safe-проекцию: секреты, paths, credentials отсутствуют.

## Acceptance evidence

| Criterion | Automated evidence                                      | Logical scenarios                                     | Result |
| --------- | ------------------------------------------------------- | ----------------------------------------------------- | ------ |
| AC-1      | `test/plugins-routing.test.js` гр.1                     | role override; profile default; unknown model refusal | pass   |
| AC-2      | `test/plugins-routing.test.js` гр.2                     | harness+connection conflict; legacy map diagnostics   | pass   |
| AC-3      | `test/plugins-routing.test.js` гр.3                     | missing binary; logged-out; incompatible version      | pass   |
| AC-4      | `test/plugins-routing.test.js` гр.4 + snapshot проекции | secrets redacted; no host paths in projection         | pass   |

Проверено (rerun review 2026-09-12): `node --test test/plugins-routing.test.js` — 14/14; полный сьют `npm test` — 304/304 (240 baseline + 17 + 16 + 16 + 14 + обновлённые config/doctor); `npm run tasks:check` — 68/68; `npm run format:check` и `npm run lint` — чисто. CLI doctor вручную: `doctor`, `doctor --harness codex`, `doctor --connection opencode-default` (см. cli.test.js). Live smoke не гонялся по решению эпика.

## Verification

- Группы выше + CLI doctor вручную на fixtures; live smoke не требуется.
- Переключение connection применяется только к новым runs; активные не мигрируют.
- Quality gates + review.

## Review record

- Verdict: pass (review agent 2026-09-12; owner может оспорить)
- Reviewer: opencode (independent counterexample review)
- Findings: review 2026-09-12:
  1. **Исправлено (medium):** reviewer/architect на opencode-connection не отклонялись до исполнения — добавлен `assertCodexRoleAdapter` (тест в `plugins-routing` гр.1). Касается связки 129+130.
  2. **Исправлено (minor):** doctor не отдавал migration-диагностики (только `connections list`) — добавлено поле `diagnostics` в результат doctor + тест.
  3. **Зафиксировано (acceptance gap → поправка AC-2):** binaries/endpoints остаются в `DEFAULT_CONFIG`/host-конфиге (legacy `codexBin/openCodeBin/openCodeUrl`); их удаление требует переноса doctor/session/terminal-поверхностей (P6/`CLEW-133`). AC-2 сужен до имён моделей; отклонение задокументировано, не замалчивается.
  4. **Зафиксировано (legacy, deferred):** project-level `.clew.json` по-прежнему может задать верхнеуровневый `codexBin/openCodeUrl` (документированное legacy-поведение, покрыто существующим config-тестом); новые секции `agents/plugins/connections` от этого защищены (`HOST_FIELD_PATTERN`). Полное закрытие — в `CLEW-133`.
  5. Контрпримеры подтверждены тестами/probe: `run --connection ghost` → `PLUGIN_HOST_POLICY_DENIED` до исполнения; `session open --connection` → явный отказ; legacy reviewer default применяется только к codex-connection (`gpt-5.6-luna`), opencode → `null`; flag-precedence (`--connection`+`--worker-model`) корректна; env-префиксы (`CLEW_REVIEW_CONNECTION`) маппятся верно; grep-гейты (`gpt-5.6-luna` вне legacy, прямые plugin-импорты) — чисто.
  6. **Исправлено (minor):** тесты doctor/probe могли ходить в реальную сеть при работающем OpenCode-сервере на 4096 — `serviceWith` переведён на `not-a-url`.
  7. Косметика: дублирующий импорт из `plugins/legacy.js` в control-service объединён.
     Self-review implementer (до независимого review): пункты 1–7 ниже сохранены.
- Findings (self-review implementer):
  1. `pickSource` возвращал `'defaults'`, проверки ждали `'default'` — ломались все run с `--harness`. Поймано сьютом, унифицировано на `'default'`.
  2. Конфликт флагов должен проверяться ДО membership-валидации (иначе `--harness codex --connection x` давал `unknown connection` вместо actionable conflict) — добавлен `assertRunFlagExclusivity` в run/retry/continue; в doctor проверка raw-флагов уже была первой.
  3. Латентный баг 128/129: на resolver-пути reviewer/architect теряли настроенную модель (connection default вместо role model). Исправлено model-keyed `asLegacyHarness` + явным `model` в role-фабриках; connection default сохраняется при `model: null`.
  4. Legacy reviewer default `gpt-5.6-luna` сохранён для Codex-пути через `legacyDefaultModel` (только reviewer + codex plugin); из `DEFAULT_CONFIG` и сервисов имя удалено (gate-тест).
  5. Binaries (`codexBin/openCodeBin/openCodeUrl`) оставлены в host-конфиге сознательно: их удаление из ядра требует переноса doctor/session/terminal (P6-поверхности). Зафиксировано в карточке и `PLUGIN-DI.md`, не замалчивается.
  6. Doctor-выход несовместим со старым (`connection:<id>` вместо `codex-cli/...`); cli.test.js переписан, поведение `ok` при optional preserved.
  7. Session refs несут `{runtime, connection, host, nativeSessionId}`; чужой runtime при resume — явная ошибка в обоих адаптерах. Durable binding — в `131`.

## Dependencies and parallelization

Зависит от `128, 129`. Блокирует `131, 133`.

## Risks

- Одинаковые имена настроек модели с разной семантикой у Codex/OpenCode; фиксировать в capability.

## Blockers

None.

## Completion record

Not completed.
