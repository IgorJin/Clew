# Данные задачи, checkpoints и retention

Статус: план реализации, карточки CLEW-105–122. Дата: 2026-09-10. Релиз не назначен; v0.10 остаётся мини-релизом клавиатуры. Численные budgets ниже — стартовые настройки для проверки нагрузочными fixtures, а не измеренные оптимальные значения.

## Зачем это нужно

Clew уже сохраняет Task Contract, планы, Runs, решения оператора, evidence и append-only event log. Это позволяет восстановить состояние после рестарта и объяснить ход работы, но сейчас тот же журнал принимает сырые события harness, параметры инструментов и крупный вывод команд. Размер диагностического потока не ограничен, а чтение Task Thread и replay WebSocket могут разбирать всю историю целиком.

На текущей локальной базе около 48 Tasks и 54 Runs занимают 14 МБ. Примерно 97% базы приходится на `events`; средний payload составляет около 246 КБ на Task и 196 КБ на Run, а самые шумные Tasks уже достигают 1–2 МБ. Это приемлемо для текущего масштаба, но один tool result может добавить сотни килобайт, а ретраи умножают объём.

Цель — сделать рост предсказуемым, не потеряв восстановление, аудит и доказательства результата.

## Инварианты

1. Рестарт Controller или Runner не создаёт повторный Run и не теряет следующий допустимый переход.
2. Task state, планы, решения человека, ревью, принятые revisions и итоговое evidence не зависят от срока хранения diagnostics.
3. Удаление или усечение данных всегда заметно: запись содержит причину, исходный размер, сохранённый размер и checksum, когда он доступен.
4. Секреты редактируются до записи, хеширования, сжатия и внешней доставки.
5. Task Thread и handoff между architect, worker, reviewer и QA не требуют загрузки полного event log.
6. Локальная работа остаётся доступной без внешнего artifact-сервиса.
7. Старые базы обновляются без обязательной немедленной переработки всей истории.

## Четыре класса данных

| Класс                                 | Примеры                                                                                                             | Источник истины                                                 | Политика                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Каноническое состояние                | Task Contract, plan version, Run/Stage state, session reference, operator action, review verdict, accepted revision | SQLite domain tables и канонические события                     | Не удаляется автоматически; экспорт не разрешает удаление                                                |
| Progress checkpoint                   | Текущий этап, попытка, роль, найденные проблемы, evidence refs, revisions зависимостей, следующий шаг               | Версионированный checkpoint с указателем на последнее состояние | Компактный и ограниченный; старые checkpoints можно архивировать после терминального состояния           |
| Evidence и пользовательские artifacts | Отчёт тестов, скриншот, patch, результат QA, входной материал Task Canvas                                           | Content-addressed artifact store и метаданные SQLite            | Хранится по политике Task; значимое для принятого результата evidence защищено от автоматической очистки |
| Diagnostics                           | Raw harness events, tool input/output, progress deltas, transport debug                                             | Не является источником состояния                                | Имеет лимиты, coalescing, TTL и может быть удалено после терминального состояния                         |

`events` остаётся аудитом доменных переходов. Сырые данные исполнения перестают быть обязательной частью каждого event payload.

## Scout и входной контекст задачи

[Scout v0](./SCOUT.md) реализован и проверен до фиксации checkpoint/handoff контракта: CLEW-123 → 124 → 125 → 126 → 114 → 115. Пилот CLEW-126 подтвердил передачу выбранных sections через существующий Execution Brief на трёх fixture-сценариях. Минимальная карта хранится обычным versioned JSON-файлом и использует существующий Execution Brief; ей не требуется новый ArtifactStore.

RepositoryContext описывает изученный код и источники на определённой revision. Checkpoint описывает прогресс конкретной Task и хранит ссылки на выбранные версии RepositoryContext. Ни общая память репозитория, ни её постоянная синхронизация не входят в этот этап. По результатам пилота CLEW-126 уточняются поля контекста, выбор по ролям и проверка устаревания. Последующее расширение scout обозначено в его документе и не блокирует оптимизацию хранения.

## Resumable Progress Artifact

Для передачи контекста между ролями нужен отдельный версионированный checkpoint, а не пересказ всей истории. Он создаётся на каждой durable boundary: утверждение плана, завершение worker attempt, фиксация verification, review verdict, integration и явное решение человека.

Минимальный состав:

- `taskId`, `projectId`, версия Task Contract и плана;
- `sourceCursor` последнего учтённого канонического события;
- workflow state, активные `stageId`, `runId`, attempt и role;
- безопасная session reference и сведения о возможности resume;
- base/current/accepted revisions и revisions зависимостей;
- состояние acceptance criteria и требуемые проверки;
- открытые review/QA findings и уже полученное evidence;
- ссылки на artifacts с типом, checksum и retention class;
- причина остановки и однозначный `nextAction`;
- версия схемы, время создания и checksum checkpoint.

Checkpoint должен укладываться в целевой размер 64 КиБ и иметь жёсткий предел 256 КиБ. Длинные отчёты и вывод команд заменяются ссылками на artifacts. Текущий checkpoint доступен напрямую; его содержимое детерминированно восстанавливается из канонических записей до `sourceCursor`. Указатель обновляется транзакционно с учётом версии: завершение параллельной Stage не может затереть прогресс другой. Для большого DAG используются ссылки на отдельные Stage checkpoints; ограничение размера не разрешает молча обрезать findings, критерии или зависимости.

Architect, worker, reviewer и существующая опциональная QA-stage получают Task Contract, назначение роли, последний применимый checkpoint и только нужные artifacts. Формальная QA-политика остаётся отдельным исследованием. Перед запуском проверяются версия контракта, плана, revision и применимость evidence. Повреждённый или устаревший checkpoint перестраивается; недостающие обязательные факты дают явный отказ запуска. Checkpoint восстанавливает контекст Clew, но не гарантирует восстановление внутреннего состояния native session.

Размер на диске и контекст модели — разные budgets. Для автоматически подбираемого дополнительного контекста предлагается 8 000 токенов, с отдельным резервом под обязательные инструкции, Task Contract, незакрытые findings и ответ модели. Точный подсчёт используется при доступном tokenizer; иначе оценка помечается приблизительной. Обязательные факты нельзя молча обрезать: используются адресуемые секции, а при невозможности их безопасно передать возвращается ошибка. Агент видит, что пропущено и как запросить дополнительные материалы. LLM-summary может быть вспомогательным текстом со ссылками на источники, но не определяет состояние, permissions или verdict.

## Хранилище artifacts

Первый backend — локальная content-addressed директория рядом с state database. Полный blob хранится по SHA-256, а SQLite содержит метаданные и связи с Task/Run/Stage:

- artifact ID, checksum, media type и encoding;
- исходный и сохранённый размер;
- owner Task/Run/Stage и purpose;
- retention class: `canonical`, `evidence`, `user`, `diagnostic`;
- created/last-accessed timestamps;
- признаки redaction, truncation и compression;
- количество или таблица ссылок для безопасного garbage collection.

Запись выполняется потоком во временный файл, затем атомарно переименовывается. Текстовые artifacts сжимаются встроенным Brotli или gzip; уже сжатые форматы не пережимаются. Одинаковые blobs дедуплицируются по checksum. Внешний S3-compatible backend остаётся будущей реализацией `ArtifactStore` из [архитектуры плагинов](./PLUGIN-ARCHITECTURE.md); SQLite и Task state machine при этом не становятся плагинами.

Checksum относится к нормализованным redacted bytes до compression; encoding хранится отдельно. Запись становится доступной только после durable publish файла и фиксации ссылки в SQLite. Сбой между ними может оставить orphan, но не опубликованную ссылку на неполный файл. Дедупликация ограничена одним state directory; каждый владелец имеет отдельную ссылку, а эффективная защита blob равна самой строгой политике всех ссылок. Чтение идёт по проверенному artifact ID и Task/host ownership, не по пути пользователя; возвращаемые состояния различают `available`, `expired`, `missing`, `corrupt` и `host_unavailable`.

Потоковая запись включает ограниченную очередь и backpressure; лимит применяется до буферизации большого вывода. Redaction проверяется на секретах, разделённых между chunks. Скрытые рассуждения и неразрешённые native fields исключаются нормализацией; хранение объекта `raw` целиком не является целью. Для будущих binary uploads нужны отдельные правила обработки: текущая текстовая redaction не обещает очищать скриншоты.

## Ограничение потока событий

Каждый тип события получает класс и size policy до вызова persistence:

1. Redact secrets и нормализовать payload.
2. Оставить обязательные структурные поля и вычислить сериализованный размер.
3. До 32 КиБ хранить payload inline.
4. Более крупное содержимое записать как artifact; в событии оставить preview, checksum, `originalBytes`, `storedBytes`, `artifactId` и признак truncation.
5. Если artifact превысил hard limit, сохранить bounded head/tail preview и явное событие `ARTIFACT_TRUNCATED`; evidence, которому нужна полнота, получает статус `incomplete`, а не ложный `passed`.

Высокочастотные deltas не нужно сохранять по одному. Lifecycle, permissions, errors, tool start/completion и итоговые usage counters сохраняются; повторяющийся progress объединяется по Run и временному окну. PTY bytes и token deltas не попадают в durable storage.

Предлагаемые стартовые значения должны быть конфигурируемыми:

| Ограничение                                           |                   Стартовое значение |
| ----------------------------------------------------- | -----------------------------------: |
| Inline event payload                                  |                               32 КиБ |
| Целевой / максимальный checkpoint                     |                         64 / 256 КиБ |
| Один diagnostic artifact                              |                               16 МиБ |
| Diagnostics одного Run                                |                               32 МиБ |
| Diagnostics одной Task                                |                              128 МиБ |
| Page API                                              | 100 событий и не более 1 МиБ payload |
| Предупреждение / hard limit локального artifact store |                            2 / 5 ГиБ |

Лимит Run или Task сначала отключает новые raw diagnostics, сохраняя lifecycle summary и один `DIAGNOSTIC_BUDGET_EXHAUSTED`. Канонические переходы не отбрасываются. Если канонический payload нарушает собственный контракт, операция завершается явной ошибкой до изменения состояния.

Размеры измеряются по UTF-8 bytes, не по числу символов. Run/Task quota учитывает логический объём diagnostics до compression, включая inline records; общий artifact budget — физические уникальные blobs и зарезервированные временные записи. Дополнительно ограничиваются число событий и очередь записи, чтобы множество маленьких payloads не обходило byte budget. Превью и метаданные тоже входят в лимиты.

Значения 2/5 ГиБ — пороги admission для новых artifacts, а не гарантия размера всей установки. Защищённые evidence и каноническая история могут расти; в отчёте отдельно видны SQLite, WAL, artifacts, временные файлы и reclaimable bytes. Worktrees и native harness sessions учитываются отдельно, Clew не удаляет их этой policy. При превышении порога diagnostics отключаются первыми; запись обязательного artifact, которому нет места, даёт явную ошибку и не публикует успешный результат. При нехватке свободного диска прекращается приём новых запусков; если даже канонический переход нельзя записать, execution останавливается безопасно для последующего recovery, без обещания сохранить запись на физически заполненном диске.

## Retention и очистка

Рекомендуемая политика по умолчанию:

- канонические данные, operator messages, decisions и текущий checkpoint — до явного удаления Task;
- evidence принятого или выпущенного результата — до явного удаления; экспорт не снимает защиту;
- пользовательские artifacts — пока пользователь не удалит или не изменит policy;
- diagnostics успешной завершённой Task — 14 дней;
- diagnostics `FAILED`/`BLOCKED` Task — после 30 дней без новой активности, с защитой трёх последних Runs и всех незакрытых recovery/continuation зависимостей;
- diagnostics активной Task — не очищаются по TTL, но подчиняются quotas.

TTL начинается от завершения/последней активности, а не создания Task. `COMPLETED`/`RELEASED` используют 14 дней; `CANCELLED` — 30 дней. `READY`, `READY_TO_FINISH`, `MERGED`, `WAITING_FOR_HUMAN` и состояния активного исполнения не считаются завершёнными для TTL. `FAILED`/`BLOCKED` допускаются только по отдельному правилу выше, поскольку могут возобновляться. Любой активный Run, lease, pending decision или continuation защищает необходимые ему материалы.

Первый объём предоставляет явную команду очистки; автоматический запуск по расписанию остаётся выключен. Dry-run содержит policy version, cutoff, выбранные references и ожидаемое освобождение уникальных bytes. Перед применением повторно проверяются состояние Task, pins, новые ссылки, активные читатели/писатели и export pins. Под блокировкой новые ссылки на удаляемый blob запрещаются, затем ненужные references отсоединяются транзакционно. Только blob без защищённых ссылок/читателей переносится в quarantine; после grace period (стартово 24 часа) выполняется идемпотентное физическое удаление. Повтор prune и рестарт продолжают тот же журнал операции. До удаления файла повторная проверка обязательна; проверка после удаления уже не защищает от гонки. Неизвестный класс события не допускает автоматическую очистку.

Канонические event IDs и seq сохраняются. Legacy payloads выносятся через версионированные storage references с checksum и audit record, без незаметного переписывания истории. Удалять диагностические строки разрешено только после аудита всех consumers и доказательства rebuild без них. Пропуски seq допустимы; устаревший cursor получает явный resync с согласованным snapshot/cursor.

Для SQLite maintenance выполняется отдельно от prune. `incremental_vacuum` требует режима `auto_vacuum=INCREMENTAL`; существующей базе с NONE может понадобиться отдельное перестроение. Удалённые страницы доступны для повторного использования без уменьшения файла. Полный VACUUM требует проверки места и отсутствия конфликтующей активности, WAL checkpoint — обработки busy readers. Это соответствует [документации SQLite](https://www.sqlite.org/pragma.html#pragma_auto_vacuum).

Полезные команды и UI:

- `clew storage status` — размер SQLite, WAL и artifacts по Project, Task и классу;
- `clew storage prune --dry-run` — предварительный расчёт retention;
- `clew storage prune` — безопасная очистка по policy;
- pin/unpin artifact и policy override на уровне Task;
- предупреждение о soft quota и понятное состояние при hard quota;
- экспорт Task с manifest, checkpoints, выбранным evidence и checksums.

## Ограниченные чтения

Нужно убрать полные выборки из интерактивных путей:

- event API получает `after`, `limit` и `byteLimit`;
- WebSocket replay отправляет bounded batches и продолжает с cursor;
- Task Thread читает собственную paginated projection или канонические события страницами;
- snapshot API возвращает текущие projections и usage summaries без полного event log;
- diagnostic viewer загружает artifact body только по запросу;
- запросы индексируются по `task_id, seq`, `run_id`, классу и времени retention.

Это ограничивает не только диск, но и RAM: процесс больше не должен одновременно `JSON.parse` всей истории большой Task.

Pagination ограничивает выборку в SQL до materialization; большой legacy row получает bounded descriptor и отдельное чтение. WebSocket проверяет очередь отправки, при медленном клиенте останавливает replay или переподключает с cursor. Cursor учитывает и пропущенные непубличные события, чтобы reconnect не перечитывал их бесконечно. UI сохраняет ограниченное число страниц и догружает старые по запросу. Механика потоков и backpressure опирается на [Node.js Streams](https://nodejs.org/api/stream.html).

## Backup и граница Controller/Runner

Экспорт Task и backup всей установки — разные операции. Task export получает фиксированный cursor и временно закрепляет все включённые artifacts; manifest перечисляет checksum и явно отсутствующие/истёкшие материалы. Проверка восстановления выполняется в новой изолированной директории, без перезаписи рабочей базы и автоматического запуска Tasks. Native sessions, worktrees и доверие Runner не восстанавливаются из одного Task manifest.

Backup SQLite использует согласованный snapshot через поддерживаемый backup API либо остановку writers, а не копирование одного live `.sqlite` файла. Manifest и pins связывают snapshot с blobs. [SQLite Online Backup API](https://www.sqlite.org/backup.html) описывает создание согласованной копии; полный deployment backup согласуется с CLEW-076.

Первый объём реализует local filesystem backend на execution host. Ссылки несут host identity; raw artifacts остаются Runner-local, а Controller получает только разрешённые bounded metadata по [протоколу v1](./runner-protocol-v1.md). При отсутствии соответствующей capability применяется текущая bounded projection, а недоступное тело помечается явно. Перенос blob, S3 и новые transport permissions — отдельное расширение, не скрытая часть этих карточек.

## Варианты и выбор

| Средство                        | Польза                                                 | Ограничение                                      | Решение                                   |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------- |
| Большие JSON/BLOB внутри SQLite | Один backup-файл и простые транзакции                  | Page churn, крупный WAL, дорогой replay и vacuum | Только metadata и небольшие payloads      |
| Content-addressed filesystem    | Streaming, dedup, дешёвая очистка, не раздувает SQLite | Нужны manifest, atomic writes и GC               | Основной local artifact backend           |
| Brotli/gzip                     | Сильно сокращает текстовые логи и JSON                 | CPU и отсутствие пользы для уже сжатых файлов    | Асинхронно для подходящих media types     |
| Sampling/coalescing             | Резко снижает шум high-frequency events                | Нельзя применять к lifecycle и evidence          | Только diagnostic deltas                  |
| Materialized checkpoint         | Быстрый resume и handoff с bounded context             | Требует schema versioning и rebuild test         | Канонический resumable artifact           |
| TTL и quota                     | Предсказуемый рост диска                               | Ошибочная классификация может удалить полезное   | Только после разделения классов и dry-run |
| Внешний object store            | Общие artifacts для paired/team deployment             | Сеть, credentials и lifecycle плагина            | Позже через `ArtifactStore` capability    |

## План реализации

### S0. Минимальный scout и пилот контекста

CLEW-123–126: контракт карты → read-only исследование → тонкое подключение к текущим architect/worker briefs → пилот на трёх задачах. Это приоритетный эксперимент для контекста; шаги S1–S3 могут выполняться независимо. Расширенная память scout остаётся последующим направлением.

### S1. Метрики, классификация и budgets

Зафиксировать taxonomy событий, измерять serialized bytes до записи, добавить storage report и конфигурационные defaults. Никакой автоматической очистки на этом шаге.

### S2. Local ArtifactStore

Добавить таблицы metadata/reference, атомарную потоковую запись, checksum, compression, dedup и crash-safe garbage collection. Покрыть partial write, повторную ссылку, повреждённый blob и перенос state directory.

### S3. Bounded event ingestion и replay

Вынести большие raw поля в artifacts, объединить high-frequency diagnostics, добавить per-event/per-run/per-task budgets и bounded HTTP/WebSocket pagination. Канонические события сохраняются полностью в пределах их отдельных схем.

### S4. Progress checkpoints и role handoff

По результатам завершённого пилота CLEW-126 схема checkpoint должна хранить выбранные RepositoryContext IDs/checksums/source revisions/sections отдельным reference-блоком, не смешивая его с progress. Ввести materialized current pointer, rebuild из канонических записей и ссылки на выбранные RepositoryContext/artifacts. Проверить scout → architect → worker → reviewer → QA, retried attempt, continuation, restart и stale session fallback; partial/unknown/omission markers не скрывать, а обычный путь без scout оставить доступным.

### S5. Retention, export и управление пользователем

Добавить policy engine, dry-run, pinning, terminal-state guard, idempotent prune, SQLite maintenance, экспорт manifest и UI usage/cleanup controls.

### S6. Миграция и acceptance

Новые записи сразу используют bounded pipeline. Существующие rows остаются читаемыми; отдельная идемпотентная migration-команда может вынести legacy payloads больше порога в artifacts. Acceptance проверяет обычную, шумную и долгую Task, исчерпание quota, рестарт на каждой durable boundary, повтор prune, backup/restore и local/paired эквивалентность.

Порядок:

```text
S0: 123 → 124 → 125 → 126 ─→ S4
S1 → S2 → S3 ──────────────→ S4
S3 + S4 → S5 → S6
```

S0 выполняется первым экспериментом контекста; S1–S3 от него не зависят. S4 требует завершённых storage зависимостей и выводов scout пилота. Retention нельзя включать до завершения checkpoint/rebuild доказательства: удаляемые diagnostics не должны случайно оставаться источником восстановления.

## Карточки реализации

Storage-карточки CLEW-105–122 остаются `planned`; CLEW-123–126 завершены. Все они имеют размер S/M и `release: unassigned`. В очереди контекста следующим идёт checkpoint/handoff после завершённого scout pilot; независимая storage ветка начинается с CLEW-105. Номер карточки не определяет порядок исполнения.

| Карточка                         | Размер | Результат                                               | Зависимости                  |
| -------------------------------- | ------ | ------------------------------------------------------- | ---------------------------- |
| [CLEW-105](../tasks/CLEW-105.md) | S      | Storage classes and policy contracts                    | —                            |
| [CLEW-106](../tasks/CLEW-106.md) | S      | Storage usage report and counters                       | 105                          |
| [CLEW-107](../tasks/CLEW-107.md) | M      | Local artifact publishing and references                | 105                          |
| [CLEW-108](../tasks/CLEW-108.md) | S      | Compressed artifact bodies and bounded reads            | 107                          |
| [CLEW-109](../tasks/CLEW-109.md) | M      | Normalize and externalize large event payloads          | 105, 107                     |
| [CLEW-110](../tasks/CLEW-110.md) | M      | Diagnostic quotas and write backpressure                | 106, 109                     |
| [CLEW-111](../tasks/CLEW-111.md) | M      | Bounded event queries and HTTP pages                    | 105, 109                     |
| [CLEW-112](../tasks/CLEW-112.md) | M      | WebSocket replay flow control                           | 111                          |
| [CLEW-113](../tasks/CLEW-113.md) | M      | Incremental Task Thread and summary projections         | 111                          |
| [CLEW-114](../tasks/CLEW-114.md) | M      | Versioned progress checkpoints                          | 105, 107, 109, 126           |
| [CLEW-115](../tasks/CLEW-115.md) | M      | Bounded role briefs from checkpoints                    | 108, 114                     |
| [CLEW-116](../tasks/CLEW-116.md) | S      | Retention policy and prune preview                      | 106, 113, 115                |
| [CLEW-117](../tasks/CLEW-117.md) | M      | Apply prune with quarantine and safe garbage collection | 116, 107                     |
| [CLEW-118](../tasks/CLEW-118.md) | S      | SQLite maintenance after retention                      | 117                          |
| [CLEW-119](../tasks/CLEW-119.md) | M      | Task artifact export and restore verification           | 108, 114                     |
| [CLEW-120](../tasks/CLEW-120.md) | M      | Resumable legacy payload migration                      | 109, 111, 119                |
| [CLEW-121](../tasks/CLEW-121.md) | M      | Storage controls and bounded history UI                 | 106, 112, 113, 117           |
| [CLEW-122](../tasks/CLEW-122.md) | M      | Task data lifecycle integration and scale acceptance    | 110, 115, 118, 119, 120, 121 |

Практический порядок небольших поставок:

1. Сначала эксперимент контекста: [123 → 124 → 125 → 126](./SCOUT.md). Независимо: контракты и видимость объёма 105 → 106; локальная запись 105 → 107 → 108.
2. Ограничение роста новых данных: 109 → 110; чтения: 111 → 112 и 113.
3. После пилота 126 и storage зависимостей — восстановление и передача контекста: 114 → 115; затем preview очистки: 116.
4. Очистка и обслуживание: 117 → 118; согласованный export: 119.
5. Перенос legacy данных: 120; UI: 121; интеграционная проверка: 122.

Это группы результатов, не дополнительные большие карточки. Точные зависимости каждой карточки заданы в её frontmatter. Retention остаётся выключен до 113/115/116 и доказательства восстановления без diagnostics.

Рабочие решения для реализации: локальный backend на каждом execution host; transport v1 не расширяется; canonical/evidence/user данные защищены независимо от export; 14/30 дней относятся только к disposable diagnostics; byte/token defaults доступны через конфигурацию и проверяются нагрузочными fixtures. Полный перенос artifacts между хостами, scheduled prune и новые QA-правила остаются будущими расширениями.
