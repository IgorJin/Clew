# CLEW-126 — Scout v0 pilot report

Дата пилота: 2026-09-12. Статус: завершён. Release assignment: unassigned.

## Что проверено

Пилот использует три изолированных Git-репозитория из `test/scout-pilot.test.js`. В каждом сценарии настоящий `ScoutRunner` строит карту из frozen `git archive`, публикует её в `.clew/scout/<task>/<context>.json`, после чего настоящий `Scheduler` готовит и передаёт Execution Brief consumer-у. Для повторяемости сам scout и worker используют детерминированный fixture adapter; это не live-provider benchmark и не доказательство ускорения модели.

| Сценарий            | Task                 | Context ID                       | Revision                                   | Consumer           | Выбранные sections                                           | Context bytes / token estimate | Scout duration |
| ------------------- | -------------------- | -------------------------------- | ------------------------------------------ | ------------------ | ------------------------------------------------------------ | -----------------------------: | -------------: |
| local bug fix       | `PILOT-LOCAL-FIX`    | `scout-cce67f34890c3825de3afe0f` | `f386f56856eded86003abd1c6ab29d2239442259` | worker             | components, checks, observations                             |                    1 436 / 359 |       127.3 ms |
| cross-module change | `PILOT-CROSS-MODULE` | `scout-8c00c85a50513575d3b22dfd` | `4fbac90004c6907da6dd5184ee5019551e9e822c` | worker             | components, relationships, checks, observations              |                    1 979 / 495 |        77.2 ms |
| ambiguous scope     | `PILOT-AMBIGUOUS`    | `scout-e6f77a3096934c62a57b3039` | `067a8798631dce6f92cdad3946154975cb9bb024` | architect → worker | components, relationships, observations, unknowns, omissions |                    2 365 / 592 |        75.9 ms |

В сохранённых картах checksum был соответственно `25166c0aadc1428748a4c86823ec2c5c115f9dd1bf0e680bebb5b96dc31bee32`, `8d4a0b33cd3b67123ee75685641a88f6c2eedbf7d328676c5325eb935560bca3` и `3c0cc8338068241266d530f5439a517f971dca061e921d770840a02644d4e6c6`. Checksum включает `generatedAt`, поэтому новый запуск того же сценария может получить другой checksum при сохранении stable context ID.

Provider usage для fixture adapter недоступен и намеренно записан как `null`; значения не подменялись оценкой токенов. Token estimate — только `ceil(selected-context UTF-8 bytes / 4)`, приблизительный ориентир для будущего bounded brief budget.

## Наблюдения по сценариям

### Локальное исправление

- Полезны `components` и адресная рекомендация `checks`: worker сразу получил модуль, тест и подходящую проверку.
- `observations` поддерживает объяснение связи, но для маленькой локальной задачи не добавляет много сигнала.
- Не хватало dependency revision; это не добавляется в RepositoryContext v1 — источник истины для такого прогресса должен быть в checkpoint/evidence contract.
- Неверных сведений не обнаружено.

### Изменение между модулями

- `relationships` оказался самым полезным полем: worker получил source-backed связь orders → billing, а не только список файлов.
- `components` и тестовая ссылка позволили сохранить provenance на обеих сторонах границы.
- `checks` остаются рекомендацией и не превращаются в evidence выполненного `npm test`.
- Runtime dependency version не была установлена; её не следует выдавать за факт карты и нужно хранить в отдельном artifact/checkpoint при наличии.

### Неоднозначная область

- `unknowns` и `omissions` были фактически переданы и architect, и worker; partial status не потерялся.
- `relationships` помогли перечислить варианты границы, но inferred ownership не стал Task Contract или разрешением на изменение.
- Карта не смогла установить validated ownership decision; это ожидаемое ограничение, а не ошибка producer-а.
- Неверных сведений не обнаружено. Автоматически добавлять «уверенный» scope или dependency graph не следует.

## Уточнённый контракт

Сохраняем в RepositoryContext v1:

- Task/project identity и contract fingerprint;
- repository revision и scope;
- source-backed `components` и `relationships`;
- `checks` только с `kind: recommended`;
- раздельные `observations`, `unknowns` и `omissions`;
- context ID, checksum, status и source revision в provenance/Run.

Изменяем правила потребления:

- consumer выбирает sections явно, а выбранные sections и checksum фиксируются на Run;
- partial карта должна передавать `unknowns` и `omissions`, если сценарий зависит от неполноты исследования;
- checks никогда не считаются выполненными проверками;
- RepositoryContext не смешивается с накопленным progress: checkpoint хранит ссылки `contextId/checksum/source revision/sections`, а не копию карты;
- approximate token estimate и provider usage — отдельные метаданные, не поля доказательства результата.

Этот контракт является входом для [CLEW-114](../tasks/CLEW-114.md) и [CLEW-115](../tasks/CLEW-115.md). Новая общая память, автоматический refresh и передача карты через Runner остаются вне пилота.

## Ограничения и verification

Пилот проверяет полезность и provenance на трёх репрезентативных fixture-сценариях, но не даёт universal benchmark, SLA или live-model quality result. Реальное provider usage и latency следует измерять отдельным live acceptance run, когда появится согласованный harness budget.

Criterion-specific evidence:

```text
node --test --test-concurrency=1 test/scout-pilot.test.js
```

Полный affected regression и repository gates записываются в completion record карточки `CLEW-126`.
