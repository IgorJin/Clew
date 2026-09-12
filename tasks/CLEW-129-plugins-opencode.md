---
id: CLEW-129
title: '[plugins][opencode] Вынос OpenCode runtime за AgentRuntime'
status: in_review
release: unassigned
priority: P1
size: M
depends_on: [CLEW-127]
parallel_group: plugins-runtime
owner: null
updated: 2026-09-12
evidence_policy: v1
---

# CLEW-129 — [plugins][opencode] Вынос OpenCode runtime за AgentRuntime

## Objective

Вынести существующий OpenCode (server API + SSE) за `AgentRuntime` без смены worker-поведения; проверить заявленные ограничения/structured output.

## User outcome

OpenCode worker продолжает работать, но как один из registry-runtime с явными capabilities, без `openCodeUrl`-хардкода в сервисах.

## Context

Зеркально `128`, для `OpenCodeHarness`: фабрики в scheduler/runner-execution, `openCodeUrl`/`openCodeBin` в config/control-service/cli. Шаг `P2` из [`docs/PLUGIN-ARCHITECTURE.md`](../docs/PLUGIN-ARCHITECTURE.md).

## Scope

- Модуль `clew.runtime.opencode`: run, interrupt, approval/userInput (только заявленные), structured-output/native-or-extract с проверкой, usage-нормализация, `listModels` если подключение позволяет.
- Capability-декларация честная: что не поддерживает endpoint — заявлено как unsupported, запуск с такой политикой отклоняется до исполнения (read-only через prompt не подделываем).
- Удаление хардкода `openCodeUrl/openCodeBin` из сервисов; host-конфиг + legacy-маппинг `CLEW_OPENCODE_URL/BIN`, `--opencode-url` с диагностикой.
- Conformance через fixtures + неполный JSON/SSE, timeout, дубли — без live smoke.

## Out of scope

- Codex (`128`); Claude — вне эпика; routing/doctor (`130`); persistence (`131`).

## Deliverables

- Плагин OpenCode + manifest + регистрация; fixtures server/SSE; legacy-маппинг.

## Acceptance criteria

1. OpenCode worker flow сохранён по fixtures; неподдержанные role/policy комбинации — явный отказ до исполнения.
2. Сервисы не читают `openCodeUrl/openCodeBin` напрямую; всё через connection resolver.
3. Structured output не поддерживается endpoint-ом: явный отказ `UNSUPPORTED_CAPABILITY` до исполнения (ноль обращений к серверу), без fake-подмены; невалидный результат поддержанного runtime идёт в существующую ветку ошибка/needs-human. Роли reviewer/architect на opencode-connection отклоняются при wiring-е (поправка review 2026-09-12).
4. Неполный JSON/SSE, timeout, дубли событий/usage обрабатываются без порчи run и двойного учёта.

## Acceptance evidence

| Criterion | Automated evidence                                                                                           | Logical scenarios                                         | Result |
| --------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------ |
| AC-1      | `test/harness-conformance.test.js` без изменений (19/19 через facade) + `test/plugins-opencode.test.js` гр.1 | worker flow; unsupported role/policy refusal              | pass   |
| AC-2      | grep-gate + `test/plugins-opencode.test.js` гр.2                                                             | прямые чтения openCodeUrl отсутствуют; resolver injection | pass   |
| AC-3      | `test/plugins-opencode.test.js` гр.3                                                                         | structured output refused, never fabricated               | pass   |
| AC-4      | `test/plugins-opencode.test.js` гр.4                                                                         | truncated JSON/SSE; timeout; duplicates; abort            | pass   |

Проверено (rerun review 2026-09-12): `node --test test/plugins-opencode.test.js` — 16/16; полный сьют `npm test` — 304/304; `npm run tasks:check` — 68/68; `npm run format:check` и `npm run lint` — чисто. Live smoke не гонялся по решению эпика.

## Verification

- Группы выше + регресс затронутых модулей; live smoke не требуется.
- Quality gates + review.

## Review record

- Verdict: pass (review agent 2026-09-12; owner может оспорить)
- Reviewer: opencode (independent counterexample review)
- Findings: review 2026-09-12:
  1. **Исправлено (было medium):** reviewer/architect, маршрутизированные на opencode-connection, молча оборачивались в `CodexReviewer/CodexArchitect` поверх `OpenCodeHarness` (обход adapter-level отказа). Деградация была честной (invalid report → needs-human), но не «явный отказ до исполнения» по AC-1. Добавлен `assertCodexRoleAdapter` в `resolveCodexReviewer/Architect` + тест.
  2. **Исправлено (minor, gap в покрытии):** foreign-resume отказ был реализован в opencode-адаптере, но тест был только для codex — добавлен `foreign sessions never resume across runtimes` (ноль вызовов endpoint).
  3. Verbatim-перенос подтверждён повторным diff против git HEAD (`VERBATIM-OK`); conformance 19/19 через facade; grep-гейты (импорты `plugins/opencode`, биндинг `OpenCodeHarness`, чтения `openCodeUrl` вне legacy-моста) — чисто.
  4. AC-3 текст приведён в соответствие с реализацией (отказ capability вместо needs-human для structured output).
  5. Тесты герметичны: doctor/probe больше не ходят в реальную сеть (`openCodeUrl: 'not-a-url'` в serviceWith).
     Self-review implementer (до независимого review): пункты 1–7 ниже сохранены.
- Findings (self-review implementer):
  1. Перенос проверен как verbatim (`OC-IDENTICAL` по HEAD); conformance 19/19 через facade.
  2. Дефект тестового стаба (сессия `sess_1` против событий `sess_s`, фильтр `isSessionEvent` всё отбрасывал) — пойман тестами, исправлен выводом session id из фикстуры.
  3. `resolve()` синхронен — в тесте был `assert.rejects` вместо `assert.throws`; исправлено.
  4. Честная граница: `output.structured`, `models.list`, `reconcile/inspect`, `surface.open/attach`, `execution.interactive` НЕ заявлены; `outputSchema` отклоняется до исполнения (`UNSUPPORTED_CAPABILITY`, ноль вызовов endpoint) — подмены fake-ответом нет. `listModels`/`prepareSurface` намеренно отсутствуют (optional-методы).
  5. `readOnly` пробрасывается в harness как раньше (prompt-level), capability не заявляется — как у Codex.
  6. Truncated JSON → `failed/protocol`; `EXTERNAL_HARNESS_UNAVAILABLE` с auth-признаками → `authentication`, иначе `execution-failure`.
  7. Дубли событий: завершение без краха, usage из финального idle (без удвоения); текстовые дубли конкатенируются как раньше — зафиксировано тестом, без изменения поведения ядра.

## Dependencies and parallelization

Зависит от `127` (реализация готова, verdict pending). Параллельна с `128` (готова, verdict pending). Блокирует `130`.

Решения по скоупу (зафиксированы реализацией):

- Legacy-ветки сохранены как fallback через `plugins/legacy.js`; удаление — в `CLEW-133`. Прод не тронут.
- Продакшн-wiring (`--connection`, doctor, `openCodeBin`-probe) — в `CLEW-130`; диагностика legacy-маппинга ссылается на `openCodeUrl`-источник.
- `normalizeUsage` выделен в общий `src/plugins/normalize-usage.js` (используют оба runtime); рефакторинг Codex-адаптера покрыт его сьютом 16/16.
- SSE-протокол зафиксирован фикстурами `fixtures/plugins/opencode-sse-{complete,truncated}.json`, чанкование по 7 байт гоняет буферизацию парсера.

## Dependencies and parallelization

Зависит от `127`, параллельна с `128`, блокирует `130`.

## Risks

- Разные OpenCode endpoint-версии; фиксировать поддерживаемую в manifest + probe.

## Blockers

None.

## Completion record

Not completed.
