# Техническое ТЗ: разработка VPN-платформы

## Document authority

Этот документ является источником истины для:

- стека, структуры репозитория и границ приложений;
- backend-модулей, API, auth/session, validation и authorization;
- транзакций, concurrency, idempotency, transactional outbox и очередей;
- application-level security invariants, logging и тестирования;
- Definition of Done разработки.

Этот документ не является источником истины для:

- цены тарифа, длительности, числа устройств, UX оплаты и MVP scope — см. `vpn-service-tz.md`;
- deployment topology, lifecycle нод, health checks, бэкапов и DR — см. `vpn-technical-spec.md`;
- истории решений — см. `vpn-project-journal.md`.

Отвечает на вопрос: **как требования должны быть реализованы в кодовой базе?**

Изменяемые продуктовые параметры (цена, срок, device limit) читаются из данных тарифа, а не копируются сюда как константы.

## 1. Цель этого документа

Определить единый стек, структуру репозитория, правила разработки и запреты для создания VPN-платформы: кабинета пользователя, админки, Telegram-бота, API, фоновых задач и управления VPN-нодами.

Это не инструкция по обходу сетевых ограничений. Конкретные параметры Xray/VLESS и настройка VPN-нод живут в отдельном защищённом инфраструктурном контуре и не должны попадать в frontend, публичный API или Git как secret material. Что можно версионировать в Git: `vpn-technical-spec.md`, раздел [6](vpn-technical-spec.md#6-автоматизация-инфраструктуры).

## 2. Зафиксированный стек

| Зона | Выбор | Зачем |
|---|---|---|
| Язык | TypeScript (strict) | Один язык для frontend, backend, бота и workers |
| Runtime | Node.js LTS | Поддерживаемая среда для всех сервисов |
| Монорепозиторий | pnpm workspaces | Простая общая структура без ранней сложности |
| Web | Next.js + React | Кабинет и админка в одном приложении |
| UI | Tailwind CSS + shadcn/ui | Быстрая консистентная адаптивная UI-система |
| Клиентские данные | TanStack Query | Серверное состояние, кэш и повторные запросы |
| Локальное UI-состояние | Zustand, только при необходимости | Модалки, фильтры, временное состояние; не источник данных сервера |
| Формы и схемы | React Hook Form + Zod | Типизация и единая валидация на границе данных |
| Backend | NestJS + Fastify | Модули, DI, guards, jobs, быстрый HTTP-слой |
| API | REST + OpenAPI | Понятный контракт для web, bot и admin |
| База | PostgreSQL | Транзакции для платежей и подписок |
| ORM и миграции | Prisma | Типобезопасные запросы и контролируемые миграции |
| Очередь и кеш | Redis + BullMQ | Надёжные фоновые задачи и повторные попытки |
| Telegram | Telegraf | Бот и обработка команд/webhook |
| Тесты | Vitest + Supertest + Playwright | unit, API-интеграция и ключевые E2E-сценарии |
| Логи | Pino | Структурированные JSON-логи с маскированием |
| Контейнеры | Docker + Docker Compose | Одинаковые dev/staging/production окружения |
| CI | GitHub Actions | Проверки до слияния и сборка контейнеров |

## 3. Структура репозитория

```text
vpn-platform/
├── apps/
│   ├── web/                # Next.js: кабинет пользователя и /admin
│   ├── api/                # NestJS: REST API, webhook-и, OpenAPI
│   ├── bot/                # Telegraf: команды и уведомления
│   ├── worker/             # BullMQ consumers: платежи, ноды, уведомления
│   └── node-agent/         # отдельный pull/apply/ack процесс на VPN-ноде
├── packages/
│   ├── contracts/          # Zod-схемы и типы API без бизнес-логики
│   ├── config/             # общие eslint/tsconfig/prettier настройки
│   ├── orchestration-store/# общие PostgreSQL stores и access predicates
│   └── safe-logger/        # fail-safe структурированные логи без секретов
├── prisma/                 # schema.prisma и миграции
├── infra/                  # Docker Compose, шаблоны окружений, IaC позднее
├── docs/                   # актуальные ТЗ и журнал
├── .github/workflows/
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

### Границы приложений

- `web` не обращается к базе, Redis, платёжному провайдеру или VPN-нодам напрямую.
- `api` владеет синхронными application use cases, пользовательским HTTP API и внешними webhook-ами.
- `bot` не меняет подписку сам: вызывает API по внутреннему контракту или ставит команду в очередь.
- `worker` не имеет HTTP-роутов для пользователей; он выполняет идемпотентную доставку и bounded maintenance через общие PostgreSQL stores, не принимая самостоятельных решений о праве доступа.
- `node-agent` работает на VPN-ноде, ходит исходящим HTTPS pull/ack к control plane и не является пользовательским HTTP API.
- `contracts` не импортирует NestJS, React, Prisma и инфраструктурные библиотеки.

## 4. Модули backend-а

```text
apps/api/src/modules/
├── auth/             # Telegram-вход, сессии, роли, 2FA админов
├── users/            # профиль, статус, устройства
├── plans/            # тарифы и device_limit из данных, не из констант кода
├── billing/          # заказы, платежи, webhook, возвраты
├── subscriptions/    # сроки доступа и subscription URL
├── devices/          # выпуск, отзыв и перевыпуск ссылки устройства
├── nodes/            # реестр нод, состояние, capacity
├── orchestration/    # desired state, sync jobs, подтверждение версий
├── admin/            # административные use cases, audit log
├── notifications/    # Telegram-сообщения и шаблоны
├── health/           # readiness/liveness, status
└── common/           # guard, error format, logger, config
```

Это целевая карта модулей, не текущий путь. Код живёт в `apps/api/src/`. Сейчас есть `auth`, `cabinet`, `orchestration`, `subscription-access`, `node-agent`, `health` и связанные сервисы. Отдельных модулей `plans`, `billing`, `admin`, `users` нет.

Каждый модуль содержит контроллер, application/service слой, DTO/Zod-схемы, репозиторий или Prisma-адаптер и тесты. Контроллеры остаются тонкими: не содержат транзакций и бизнес-решений.

## 5. API и авторизация

Продуктовый вход без отдельной регистрации: `vpn-service-tz.md`, разделы [1](vpn-service-tz.md#1-цель) и [3](vpn-service-tz.md#покупка).

### Пользователь

- Telegram — первичный идентификатор.
- Браузер не является доверенной стороной. Telegram identity принимается только после серверной проверки подписи `initData`. Telegram ID из параметров браузера без этой проверки отклоняется.
- Бот открывает кабинет через bot-mediated pre-launch context. Публичный `POST /auth/challenge` запрещён: он позволял attacker-first replay.
- Вход требует заранее созданную `AuthChallenge`: Telegram-подписанный `start_param` идентифицирует запись, отдельный 256-битный секрет живёт в HttpOnly cookie исходного браузера. Без обоих значений API возвращает общий `401` и не ставит session cookie.
- Production issuer challenge ещё не подключён; пока он отсутствует, публичный self-service challenge не добавлять. История: `vpn-project-journal.md`.
- Login/retry линеаризуются `SELECT … FOR UPDATE` pre-launch записи; сроки challenge и freshness Telegram proof считаются по PostgreSQL `clock_timestamp()`. Все криптографические, freshness и binding-отказы возвращают один и тот же публичный `401 Telegram login is invalid` без `Set-Cookie`.
- Повтор того же подписанного Telegram payload возвращает ту же сессию. Retry дополнительно сверяет `User.telegramUserId` владельца связанной сессии с ID из заново проверенного `initData`.
- После входа создаётся cookie-сессия: `HttpOnly`, `SameSite=Strict`, `Secure` в production, с ротацией и отзывом. В базе хранится только HMAC-отпечаток непрозрачного секрета. Auth/session secrets не кладутся в `localStorage`, URL, frontend variables или JSON-ответы.
- `POST /auth/logout` идемпотентен: при точном trusted `Origin` отзывает текущую `UserSession` и возвращает удаляющую cookie; отсутствующий или отличный Origin отклоняется до session mutation.
- Subscription URL устройства — отдельный bearer-секрет и не является сессией кабинета.

### Администратор

- Роль `admin` выдаётся только вручную через защищённую процедуру.
- Для админки обязательны отдельная сессия, 2FA и audit log.
- Операции с платежами, сроком подписки, отзывом устройства и нодами требуют явного подтверждения действия в UI.
- Критичные admin actions аудитируются; пользователь не получает доступ к чужим ресурсам.

### Основные endpoint-ы

| Группа | Примеры |
|---|---|
| Auth | `POST /auth/telegram`, `POST /auth/logout`, `GET /auth/me` |
| Plans | `GET /plans` |
| Orders / billing | `POST /orders`, `GET /orders/:id`, `POST /webhooks/payment-provider` |
| Subscription | `GET /subscription`, `POST /subscription/renew` |
| Devices | `GET /devices`, `POST /devices`, `POST /devices/:id/revoke`, `POST /devices/:id/rotate` |
| Cabinet | `GET /cabinet/overview`, `POST /cabinet/devices`, `POST /cabinet/devices/:deviceId/revoke` |
| Subscription feed | `GET /sub/:opaque-token` |
| Node agent | `GET /node-agent/v1/configuration`, `POST /node-agent/v1/acknowledgements`, `POST /node-agent/v1/heartbeats` |
| Admin | `/admin/users`, `/admin/payments`, `/admin/plans`, `/admin/nodes`, `/admin/audit-log` |
| Health | `GET /health/live`, `GET /health/ready` |

Все изменяющие состояние endpoint-ы требуют схему валидации, авторизацию, проверку роли/владельца ресурса и при необходимости idempotency key.

## 6. Данные, транзакции и outbox

- PostgreSQL — единственный источник правды для пользователей, платежей, устройств, подписок и состояния нод.
- Prisma-миграция обязательна для любого изменения схемы; миграции не редактируются после попадания в production.
- Деньги и сроки хранятся точно: сумма — в минимальных единицах валюты, время — UTC.
- У каждого платежа, webhook-события и sync job — уникальный внешний/идемпотентный ключ.
- Минимальные инварианты схемы: `users.telegram_id` уникален; у платежа уникален `provider_payment_id`; у заказа есть `idempotency_key`; subscription token и session secret хранятся только как хеш; у устройства есть статус и `revoked_at`; у ноды — desired/applied config version. Продуктовый состав сущностей: `vpn-service-tz.md`, раздел [5](vpn-service-tz.md#5-бизнес-сущности).

### Transactional outbox

Подтверждение платежа и продление подписки, а также аналогичные state-changing orchestration use cases (выдача/отзыв устройства, активация route), выполняются так:

В одной PostgreSQL-транзакции:

- изменение payment state (если операция платёжная);
- изменение subscription / grant / desired-state;
- audit entry;
- запись outbox event.

Корректность этой транзакции не зависит от обращения к Redis. Redis не является участником DB-транзакции.

После commit:

- worker читает зафиксированный outbox event;
- создаёт/доставляет соответствующую BullMQ job.

Потеря связи с Redis после commit не откатывает платёж и подписку: доставка повторяется из outbox. Worker захватывает событие через PostgreSQL lease (`FOR UPDATE SKIP LOCKED`); публикация в BullMQ идемпотентна по `OutboxEvent.id`.

Постановкой нового node access grant владеет отдельный application use case `NodeAccessGrantScheduler`: advisory locks, проверка идемпотентности, блокировки device/node, повышение desired version и создание grant, sync job, outbox и audit выполняются внутри одной прежней PostgreSQL-транзакции. `OrchestrationService.scheduleNodeAccessGrant()` остаётся совместимым внутренним фасадом и только делегирует этот use case; SQL, порядок блокировок и публичные contracts этим разделением не меняются. Infrastructure regression test вызывает реальную ошибку внешнего ключа на финальной записи audit и подтверждает откат повышения версии, grant, sync job и outbox.

Изменениями lifecycle ноды `disable`/`quarantine` владеет отдельный application use case `NodeLifecycleManager`, а отзывом VPN-доступа устройства — `DeviceAccessRevoker`. Прежние внутренние методы `OrchestrationService.disableNode()`, `quarantineNode()` и `revokeDeviceAccess()` остаются тонким совместимым фасадом. Полные PostgreSQL-транзакции перенесены без изменения SQL, advisory locks, `FOR UPDATE`, порядка блокировок, идемпотентности и записей version/grant/job/outbox/audit. Статусная матрица сохраняется: disable разрешён из `HEALTHY`/`DRAINING` и идемпотентен для `DISABLED`; emergency quarantine разрешён из `HEALTHY`/`DRAINING`/`DISABLED` и идемпотентен для `QUARANTINED`; `PROVISIONING`/`DELETED` отклоняются. Device revoke создаёт обычный access-control sync только для `HEALTHY`/`DRAINING`/`DISABLED`, а на `PROVISIONING`/`QUARANTINED`/`DELETED` отзывает локальную grant-запись без новой sync job. Публичные API/contracts этим разделением не меняются.

PostgreSQL lease/retry state machine для `NodeSyncJob` и `OutboxEvent` имеет одну реализацию в общем внутреннем пакете `@vpn-platform/orchestration-store`. Production worker использует эти stores для claim, completion, retry, reclaim, DB-clock lease boundaries, attempt limits и fencing по owner/token. Локальные bootstrap/harness и infrastructure tests восстанавливают типизированную команду из authoritative job row и вызывают те же production stores; отдельного API lease-path в `OrchestrationService` нет. Схема и defaults `ORCHESTRATION_LEASE_DURATION_MS`/`ORCHESTRATION_MAX_ATTEMPTS` принадлежат store/worker boundary и не дублируются в API startup environment validation. Имена настроек, SQL, таблицы, статусы и публичные API/contracts этим разделением не меняются.

BullMQ хранит только ограниченную транспортную history уже завершённых задач: completed jobs — до 7 дней и максимум 10 000 записей, failed jobs — до 30 дней и максимум 10 000 записей. Оба ограничения настраиваются валидируемыми worker environment values; нулевые окна и лимиты запрещены. BullMQ применяет age cleanup лениво при следующем завершении задачи с тем же terminal outcome: completed очищает completed history, failed — failed history. Count cap ограничивает рост terminal history. Waiting, delayed и active jobs retention не затрагивает. `OutboxEvent`, `NodeSyncJob`, `NodeConfigAcknowledgement` и audit остаются authoritative в PostgreSQL и этой политикой не удаляются; повторная доставка после eviction BullMQ job повторно проверяет terminal state и не создаёт второе authoritative действие.

### Device assignment, entitlement и expiry

Канонические application-понятия разделены и не подменяют друг друга:

- `effectiveSubscriptionStatus` равен `ACTIVE` только при persisted `status = ACTIVE` и `expiresAt > dbNow`; равенство означает expiry, а `PENDING`, `EXPIRED` и `CANCELLED` имеют приоритет над датой;
- `hasEntitlement` требует `Device.status = ACTIVE` и эффективную активную подписку;
- `isGrantConverged` требует `NodeAccessGrant.status = ACTIVE`, неистёкший `expiresAt` и равенство его `appliedVersion = desiredVersion`;
- `isRouteReady` дополнительно требует `Node.status = HEALTHY`, подтверждённую node version, активные endpoint/profile и route activation, уже применённую нодой.

Эти predicates принадлежат одной domain policy и одной табличной test matrix. SQL может выражать их непосредственно через PostgreSQL, но feed, кабинет, issuance, renewal и reconciliation не определяют независимые варианты семантики. Внутри state-changing транзакции `dbNow` читается один раз через `clock_timestamp()` после требуемых locks и используется всеми проверками этой операции.

Выпуск устройства сериализуется существующим user advisory lock. В одной PostgreSQL-транзакции он блокирует subscription/plan и выбранные `HEALTHY`-ноды, повторно проверяет `hasEntitlement` и device limit, создаёт Device и desired `NodeAccessGrant` для каждой такой ноды, повышает их `desiredConfigVersion`, создаёт связанные `NodeSyncJob`, outbox и audit. Нужна хотя бы одна `HEALTHY`-нода; иначе транзакция откатывается без Device, token, grant или занятого slot. Route/profile availability не участвует в grant assignment. Commit не ждёт node-agent acknowledgement и не означает route readiness.

Grant lifecycle не является вторым источником delivery truth. Новый grant записывается как `PENDING` с `desiredVersion > appliedVersion`; verified acknowledgement одной транзакцией продвигает applied version и при первом apply переводит его в `ACTIVE`. Состояние `PENDING` с уже применённой desired version запрещено, но последующий renewal уже `ACTIVE` grant закономерно оставляет status `ACTIVE` при временном version gap. Readiness никогда не выводится из status без проверки versions. Renewal не меняет identity или credential: обновляет `expiresAt`, повышает node/grant desired version и временно делает маршрут not-ready до нового acknowledgement. Естественный expiry не переводит grant в `REVOKED`: entitlement становится false по времени, а credential исключается из serving state. `REVOKED` с `revokedAt` зарезервирован для явного отзыва и не восстанавливается renewal/reconciliation. Отмена конкретной фактически действующей подписки одной PostgreSQL-транзакцией записывает `Subscription.CANCELLED`, `cancelledAt`, `REVOKED` для её текущих grants, монотонные node/grant versions, sync/outbox и audit. Идемпотентный повтор не создаёт новых writes. Историческая `CANCELLED`-строка сама по себе не является новым revoke intent для более поздней подписки того же пользователя.

Expiry worker и renewal используют `SELECT ... FOR UPDATE` одной строки Subscription, после lock повторно читают status/`expiresAt` и единый `dbNow`. Worker bounded batch-ами materializes `ACTIVE → EXPIRED` и создаёт audit и per-node sync/outbox только если subscription всё ещё фактически истекла; продлённая конкурентно подписка даёт no-op. До выбора grants expiry-транзакция вычисляет effective replacement entitlement пользователя. Если действующей замены нет, каждый неотозванный grant нормализуется к истёкшему сроку независимо от собственного более позднего `expiresAt`; если замена есть, grants приводятся к её authoritative `expiresAt`, а не к сроку старой подписки. Ошибка одной subscription/node transaction учитывается отдельно и не отменяет уже завершённые элементы batch. Подтверждённый до expiry платёж продлевает от прежнего `expiresAt`, после expiry — от проверенного immutable provider success timestamp; если провайдер не даёт надёжного timestamp, один раз сохраняется PostgreSQL-время первой успешной серверной верификации. Provider payment ID и факт применения платежа идемпотентны, поэтому replay webhook не продлевает срок повторно.

Reconciliation запускается при переходе ноды в `HEALTHY` и периодически как repair loop. Она заново строит expected state только из текущего PostgreSQL snapshot: создаёт отсутствующие grants и обновляет устаревшие сроки/versions, но не выводит новый revoke intent из истории статусов подписок. Уже сохранённый `REVOKED` остаётся authoritative и при terminal `FAILED` либо отсутствии живой delivery получает новую монотонную node/grant version и delivery operation. Аналогичный version-gap repair выполняется для остальных grants. Естественный expiry сохраняет grant и синхронизирует его deadline, не подменяя expiry явным revoke. Старые события не воспроизводятся как бизнес-решения. Переход в `DRAINING` или обычный `DISABLED` сам по себе не отзывает существующие grants; `QUARANTINED` выполняет emergency revoke-all, `DELETED` не участвует. Repair, который изменил desired state, получает audit; no-op scan — нет.

PostgreSQL остаётся единственным authoritative desired state. Outbox доставляется at-least-once, а outbox consumers, sync jobs, webhook-и и acknowledgement идемпотентны. Порядок применения задаёт существующая монотонная `Node.desiredConfigVersion`; новая глобальная subscription/device revision не вводится. Reconciliation создаёт только новую node version из актуального snapshot и не может восстановить старое состояние поверх более нового.

Публичная граница различает причины: отсутствующий entitlement получает общий `401`, а действующий entitlement без единого ready route — `503`. `200` с пустым feed не используется для инфраструктурной недоступности. Кабинет вычисляет фактический `EXPIRED` немедленно, не ожидая materialization worker. Предоставление нового маршрута и convergence могут быть eventual; прекращение истёкшего или отозванного доступа всегда fail-closed.

## 7. Очереди и фоновые задачи

| Очередь | Задачи |
|---|---|
| `billing` | сверка pending-платежа, обработка webhook, возврат |
| `node-sync` | выдача/отзыв устройства, применение версии конфигурации |
| `health-checks` | проверки нод, capacity, создание алертов |
| `notifications` | оплата, окончание срока, аварийные сообщения |
| `maintenance` | очистка истёкших сессий, токенов, технических данных |

Правила любой задачи: идемпотентность, ограниченное число повторов с задержкой, structured log, dead-letter/failed state, ручной повтор из админки только с audit log.

Expiry materialization и reconciliation работают bounded batches с keyset cursor и wrap-around, поэтому постоянно ошибающийся ранний candidate не блокирует последующие элементы. Единственный application lifecycle path возврата `DRAINING`/`DISABLED → HEALTHY` сначала автоматически запускает reconciliation. Если desired state изменился, он возвращает `RECONCILIATION_REQUIRED` и не меняет status; после delivery и verified ACK повторный вызов выполняет настоящий transition и audit. Периодический repair дополнительно запускается строго раз в минуту; `ACCESS_MAINTENANCE_INTERVAL_MS` принимает только `60000`, а целевой срок создания недостающего desired grant — до одной минуты. Expiry delivery каждой ноды атомарна и изолирована: ошибка одной ноды не откатывает уже созданные operations для остальных, committed issuance/renewal либо materialized status.

`NodeSyncJob.SUCCEEDED` означает, что durable desired-state команда принята control plane и доступна pull API. Data plane считается применённым только после отдельного `NodeConfigAcknowledgement`.

Если route-specific `NodeSyncJob` найден, resource и `targetVersion` совпали, статус ещё не terminal, но matching `activationVersion` отсутствует после предшествующей активации той же version (`lastActivationVersion >= targetVersion`), worker завершает job как `FAILED` с кодом `ROUTE_ACTIVATION_CLOSED`. Это терминальное закрытие, не временная недоступность: `process()` не бросает retryable ошибку, повторный claim той же команды тоже terminal. Идемпотентный повтор publish с теми же keys возвращает исходную операцию и не реактивирует route. Новый rollout требует новой пары idempotency keys и version выше `lastActivationVersion` и `appliedConfigVersion`. Grant jobs этим правилом не затрагиваются: отсутствие grant не закрывает живой PENDING grant, а mismatch resource по-прежнему terminal. Production `publishConnectionRoute` назначает activation до worker claim; job без когда-либо назначенной activation не помечается `ROUTE_ACTIVATION_CLOSED`.

## 8. Правила работы с нодами на уровне приложения

Инфраструктурный lifecycle, probes, availability-состояния и Emergency Mode: `vpn-technical-spec.md`, раздел [7](vpn-technical-spec.md#7-ноды-и-оркестратор).

- API хранит желаемое состояние, node agent подтверждает применённую версию.
- Входящий `POST /node-agent/v1/acknowledgements` использует строгий versioned contract: разрешены только `nodeSyncJobId`, `targetVersion` и `snapshotHash`, а missing, invalid и любые дополнительные поля отклоняются с `400` до аутентификации и изменения состояния. OpenAPI request schema выводится из того же Zod-контракта; расширение payload требует согласованного изменения contracts/OpenAPI и порядка rollout «сначала API, затем node agents» либо новой версии endpoint.
- `nodeId` acknowledgement определяется только аутентифицированной node credential и не принимается из body; отдельный `result` не передаётся, потому что acknowledgement означает только verified success, а ошибка не подтверждается. `targetVersion` не может уменьшить applied version. Exact replay того же pending job/version/hash после потерянного ответа не выполняет reload, но повторно отправляет тот же идемпотентный ACK. Меньшая version и same-version с другим hash отклоняются. Recovery полного snapshot, который control plane уже считает подтверждённым и для которого нет pending acknowledgement, выполняет verified reconcile без нового ACK.
- Node agent получает только минимальные данные, нужные для применения доступа конкретных устройств; не получает платежи и Telegram-профили.
- Каждая команда ноде подписывается сервисным ключом, имеет короткий срок действия и идентификатор версии.
- Нода применяет команду идемпотентно, подтверждает результат и умеет откатиться к предыдущей подтверждённой версии.
- `NODE_AGENT_MODE` по умолчанию `simulation` (локальный state-file, без Xray). Режим `local-xray` применяет тот же `NodeAgentConfigurationSnapshot` к локальному Xray: активные grants с credential и неистёкшим `expires_at` получают inbound/user; revoked и expired остаются без доступа. Идемпотентный replay той же desired version не ломает serving и не даёт ложный collision. Ошибка или частичный apply не приводит к acknowledgement, пока durability barrier не успешен.
- `simulation` и `local-xray` запрещены при `NODE_ENV=production`: это не боевые adapters. Production VPS использует `NODE_AGENT_MODE=xray` (запрещён вне production): тот же `NodeAgentConfigurationSnapshot`, template `infra/xray-production/config.template.json`, reload через `NODE_AGENT_XRAY_RELOAD_COMMAND` после записи runtime-конфига. Успешный exit reload-команды сам по себе не является apply barrier: node-agent через container-local Xray Handler API сверяет фактически загруженный VLESS access list с ожидаемым и только после точного совпадения сохраняет applied state и отправляет acknowledgement. Недоступный API или старый/частичный serving state оставляет прежнюю durable version без acknowledgement; повтор той же desired version снова выполняет reload, а уже подтверждённый replay не делает лишний reload. Handler API слушает только loopback внутри Xray-контейнера и не публикуется на host/network. Production runtime-файл создаётся с mode `0640` в setgid-каталоге группы контейнера Xray: node-agent сохраняет атомарную запись, Xray получает только чтение, остальные локальные пользователи не получают доступ. UUID, VPN credentials и runtime access list живут только в защищённом state ноды, не в Git, не в логах и не в audit.
- Selective fail-closed обязателен для production access-control. При исправном durable state недоступность control plane не выключает VPN: нода продолжает последнюю подтверждённую конфигурацию и локально применяет `expires_at`. State проверяется каждые 10 секунд: schema, snapshot hash, связь persisted version со snapshot и порядок `previous < current`; missing, unreadable или любой corrupt state немедленно останавливает Xray serving и старый runtime не считается разрешением. Полный snapshot с `desiredConfigVersion = appliedConfigVersion` восстанавливает runtime и durable state после serving verification без нового acknowledgement. Любая ошибка temp write, rename или fsync после recovery повторно останавливает Xray, даже если reload уже возобновил serving; local loop не имеет права возобновить serving, пока повторный file/directory fsync не подтвердит durability. Snapshot без matching command при несовпадающих desired/applied versions не применяется и не подтверждается. Полученный `REVOKED` с `revokedAt` сначала атомарно и durably фиксируется в защищённом stop-only sidecar рядом с основным state и только затем останавливает Xray; marker содержит только format/target version, deadline и grant IDs, переживает restart агента и блокирует local resume даже при missing/unreadable основном state. Ошибка записи marker всё равно переводит serving в fail-closed и возвращает ошибку. Latch удаляется только после matching full snapshot, successful apply/read-back и durability barrier. Outcome `waiting-for-command`, local expiry и failed control-plane apply повторяются с security-интервалом до 10 секунд. Production Xray poll ограничен 60 секундами независимо от большего configured interval. Для `expires_at` и `revokedAt` действует общий пятиминутный deadline с 120-секундным fail-closed reserve; безопасный serving возобновляется только после успешного apply, read-back и durability barrier.
- Локальный прототип двух заменяемых localhost Xray-нод (`infra/xray-local/`, harness `pnpm xray:local:harness`) воспроизводит сценарий Happ → один subscription URL → disable одной ноды без смены ключа. Общий production bootstrap сохраняет совместимый Finland harness `pnpm vpn-fi:bootstrap` (`vpn-fi-1`, `var/vpn-fi-01`) и предоставляет независимый Amsterdam harness `pnpm vpn-eu:bootstrap` (`vpn-eu-1`, `var/vpn-nl-01`); compose выбирает state через `VPN_NODE_STATE_DIRECTORY`, runbook — `infra/vpn-node/README.md`; grant/route выдаются на то же устройство, что local harness. Идемпотентный повтор с теми же TLS/display не переписывает immutable public config, а изменение требует новой версии profile. Default reload использует полный Compose restart Xray и корректный относительный путь из `apps/node-agent`. Это не Platform VPS и не публичный admin API. Feature gate `SUBSCRIPTION_FEED_RENDERING_ENABLED` по умолчанию выключен и включается явно в local env. Обычный `disableNode` исключает ноду из feed и не отзывает grants; `quarantineNode` этим не подменяется. Happ 3.1.0 на Windows импортировал live URL (`Local A` и `Local B`); после `disable a` та же подписка без нового URL оставила только `Local B`; оператор подключился к `Local B` (VLESS/TLS/TCP, скорость в Happ). Renderer выпускает VLESS/TLS/TCP/HAPP без `allowInsecure`; в production этот параметр не включать. Для самоподписанного localhost-TLS оператор может явно разрешить недоверенный сертификат в Happ только для localhost-профиля. Local-only флаг feed под `allowInsecure` не добавлялся. Скорость в Happ доказывает сессию к localhost inbound, не системный VPN. Amsterdam server-side data plane применил и подтвердил desired version через закрытый HTTPS/SSH канал; отдельный Happ consumer-тест подтвердил удалённый VLESS/TCP/TLS/TUN и смену внешнего IP. Finland остаётся во внешней миграции; iOS/HTTPS пользовательского subscription origin не закрыт. Кабинет control-plane (overview, выпуск, revoke) уже есть; это не этап 2 и не оплата.
- Amsterdam consumer-тест на Happ 3.1.0/Windows подтвердил полный VLESS/TCP/TLS/TUN маршрут и выход через публичный адрес ноды. При диагностике учитывать глобально выбранный в Happ routing ruleset: сторонний `globalProxy=false` ruleset может принудительно отправлять `geosite:ip-detect` и unmatched traffic в `direct`, поэтому неизменившийся IP сам по себе не доказывает отказ профиля. Встроенный `Default` с `globalProxy=true` подтвердил туннель. Засвеченный consumer UUID был отозван через device/grant lifecycle; replacement device получил новый grant, а node-agent подтвердил новую desired/applied version. Секреты и URL в Git/журнал не попадают.
- API вне production может слушать HTTP на `localhost`/`127.0.0.1`. Production startup отклоняет `http:` для `SUBSCRIPTION_FEED_BASE_URL` и `CABINET_ORIGIN`; оба публичных origin обязательны и используют `https:`. Development/test сохраняют localhost HTTP для локального harness. Happ на iOS отклоняет HTTP subscription URL, в том числе loopback («небезопасная схема http запрещена»). Неверный token даёт HTTP 401; Windows Happ показывает это как «узел запрашивает аутентификацию». Пользовательский subscription URL для iOS и для production — HTTPS. Это не новый формат Happ.
- Node-agent pull/ack/heartbeat принимаются от `healthy`, `draining`, доступных `disabled` и аварийных `quarantined`-нод с действующей credential. Новая выдача/assignment (`scheduleNodeAccessGrant`, subscription feed, route activation) остаётся только для `HEALTHY`. Обычный access-control sync (revoke устройства, `expires_at`, credential revocation) идёт на `healthy`, `draining` и доступные `disabled`. `deleted` и `provisioning` в sync и agent-auth не участвуют. Возврат в `HEALTHY` при `desiredConfigVersion > appliedConfigVersion` отклоняется, пока pending updates не reconciled.
- Аварийная операция `quarantineNode` переводит ноду в `QUARANTINED`, в одной транзакции отзывает все живые grants и ставит один emergency sync job (если grants были), чтобы агент получил snapshot без доступа. Это не обычный набор assignment jobs и не availability-состояние `QUARANTINED` у endpoint/profile. Прямой переход в `QUARANTINED` при живых grants отклоняется PostgreSQL. Admin HTTP для quarantine в этот этап не входил.
- Обычный `disabled` исключает ресурс из новой выдачи subscription feed и не является командой отзыва уже выданного VPN-доступа. Пока node agent доступен, disabled-нода остаётся в access-control synchronization и получает security-critical updates: revoke устройства, уменьшение/истечение `expires_at`, credential revocation. Принудительное прекращение serving / revoke-all выполняется только аварийной операцией `quarantined`. `draining` не обрывает существующий VPN немедленно. `deleted` в синхронизации не участвует. Продуктовые правила: `vpn-service-tz.md`, раздел [3](vpn-service-tz.md#замена-ноды); lifecycle и sync: `vpn-technical-spec.md`, раздел [7](vpn-technical-spec.md#7-ноды-и-оркестратор).
- Истёкший или отозванный доступ блокируется локально не позднее чем через 5 минут на `healthy`, `draining` и доступных `disabled`-нодах, которые ещё способны принимать существующие VPN-подключения. Для локального expiry или полученного revoke при исчерпании безопасного retry budget применяется selective fail-closed всей Xray-ноды, а не продолжение старого access list. Успех force-stop подтверждается отдельной проверкой отсутствия running Xray containers по точным Compose labels. Недоступная нода копит pending updates и не возвращается в serving state, пока они не reconciled. Нода не считает subscription URL источником разрешения подключаться.
- Секреты нод, пользовательские VPN credentials и transport parameters не логируются и не коммитятся.
- Доменная модель разделяет физическую `Node`, заменяемый `Endpoint` и версионируемый `ConnectionProfile`. Нельзя закреплять инвариант «одна нода = один IP = один профиль» в бизнес-логике.
- Пользователь, подписка, платёж и устройство не зависят от конкретного protocol/transport.
- Heartbeat агента не считается доказательством доступности VPN из пользовательской сети.
- Внешние probe results — недоверенный вход: обязательны аутентификация источника, схема, timestamp/freshness, replay-защита, rate limit и ограничение кардинальности меток.
- Staged rollout, rollback, quarantine, ручной override и Emergency Mode — команды control plane с idempotency key, наблюдаемым статусом и append-only audit event.
- Сырые пользовательские IP, содержимое трафика и пользовательские VPN credentials в probes/метрики не попадают.

## 9. Правила frontend-а

- Разделы `/cabinet` и `/admin` живут в одном Next.js-приложении, но имеют раздельные layouts, guards и навигацию.
- Все данные сервера запрашиваются через API и TanStack Query; Zustand не дублирует состояние пользователя, платежа или подписки.
- Корневой client provider создаёт отдельный `QueryClient` на экземпляр приложения, а не module-level singleton, способный разделить cache между запросами или пользователями. Cabinet overview и безопасные auth outcome хранятся под единым query key; автоматические retry/refetch on focus/reconnect отключены, чтобы не повторять Telegram sign-in скрыто. Обновление выполняется явно после issue/revoke.
- Device mutations сбрасывают и повторно загружают cabinet query после подтверждённого результата. `401` revoke повторно проходит тот же auth/query flow, `404` считается уже достигнутым revoke outcome, а остальные ошибки остаются видимыми. Idempotency key выпуска сохраняется для повтора того же неизменённого input и заменяется при изменении формы.
- Route-level `page.tsx` кабинета остаётся тонким client container: связывает cabinet query с локальным состоянием одноразового URL, но не содержит разметку subscription/device flows. Loading/auth/error/ready states, overview, issue form, revoke confirmation и URL dialog разделены по presentation-компонентам; server-state decisions остаются только в query/mutation hooks.
- Никаких optimistic updates для платежей, продления, отзыва устройства и управления нодами.
- Экран после возврата от оплаты показывает «Проверяем оплату» и опрашивает API; не активирует доступ по URL-параметру. Продуктовое правило return URL: `vpn-service-tz.md`, раздел [6](vpn-service-tz.md#6-платёжный-контур-обязательные-правила).
- URL устройства показывается только после явного действия пользователя, копируется одной кнопкой и не попадает в историю браузера, аналитику, `localStorage` или клиентские логи.
- Результат issue с полным subscription URL передаётся непосредственно в локальное состояние dialog и не становится data query/mutation cache. Mutation возвращает в TanStack Query только `undefined`; закрытие dialog удаляет последнюю UI-ссылку на URL.
- Админские действия имеют статус выполнения, идентификатор операции и понятную ошибку; не «молча» меняют данные.

## 10. Application-level security invariants

Единственный канонический список application-level security rules. Продуктовые следствия (отзыв ссылки, device limit как поле тарифа): `vpn-service-tz.md`. Эксплуатационные следствия (бэкапы, SSH, сеть): `vpn-technical-spec.md`.

1. Браузер не является доверенной стороной.
2. Telegram identity принимается только после серверной проверки подписи.
3. Frontend не получает прямой доступ к PostgreSQL, Redis, payment provider или node agent.
4. Auth/session secrets не хранятся в небезопасном клиентском storage (`localStorage`, frontend env, URL).
5. Subscription URL является bearer secret; в базе хранится только хеш токена.
6. Полные subscription URL, платёжные данные, секреты, содержимое трафика, raw IP/port metadata и прямые UUID/ID не логируются. API, worker, node-agent и bot используют общий safe Pino factory; API передаёт тот же wrapped logger в `pinoHttp.logger`, поэтому request-scoped `PinoLogger.assign()` и все child bindings проходят единую sanitization policy. HTTP request при прямой передаче и на любом уровне вложенности сохраняет только method; явный `res`/`response` или структурно подтверждённый HTTP response — только status code, но обычная operational-запись с одним `statusCode` не сворачивается; raw `Error` — только type. Secret families включают auth/session/bearer/challenge/prelaunch с credential suffixes, включая verifier, nonce, proof, fingerprint, hash, value и material; 32-byte base64url credentials и чувствительные значения маскируются единым pre-serialization pass и Pino redact policy. Ошибка чтения throwing getter/Proxy, включая bindings `child()`, приводит к одному минимальному безопасному record без исходных данных и дублированных JSON-ключей. Разрешены только необходимые технические агрегаты, enum outcomes, boolean и безопасные counters; новый независимый полный проход sanitization без пересмотра performance budget не добавляется.
7. Secrets не коммитятся и не попадают в frontend variables.
8. Payment return URL, скриншот оплаты и клиентский флаг ничего не активируют.
9. Payment/webhook processing идемпотентен: повтор не продлевает подписку дважды.
10. State-changing endpoints имеют validation и authorization; пользователь не получает доступ к чужим ресурсам.
11. Административные действия требуют RBAC; критичные admin actions аудитируются. Audit log append-only.
12. Внешние входы валидируются Zod/DTO: API, webhook, Telegram update, node callback, probe results.
13. CSRF-защита обязательна для cookie-аутентифицированных изменяющих запросов. Один общий trusted-Origin guard проверяет точное совпадение `CABINET_ORIGIN` для logout, выпуска и отзыва устройства; отсутствующий, чужой и same-site sibling Origin отклоняются.
14. Rate limiting обязателен на auth, создание заказов, webhook-и и subscription endpoint. При недоступности Redis subscription feed не обходит лимит.
15. Выдача или продление доступа без audit log запрещены.
16. Платежи, пользователи, audit log и ноды не удаляются физически без утверждённой процедуры хранения/удаления данных.
17. Микросервисы, Kubernetes, GraphQL и собственные мобильные приложения в MVP запрещены без отдельного решения в журнале.

### Обязательные инженерные практики

- TypeScript strict; ESLint, Prettier и pre-commit проверки.
- Workspace-пакеты, импортируемые во время typecheck до шага сборки, публикуют type entrypoint, доступный из чистого checkout; runtime entrypoint и production build остаются отдельными.
- Перед параллельным workspace test runtime entrypoints внутренних пакетов собираются отдельным root pretest-шагом; сами тесты не подменяются и не пропускаются.
- Миграции, тесты и OpenAPI обновляются вместе с изменением API.
- В CI: typecheck, lint, unit/integration tests, build; E2E — перед staging/production релизом.
- API infrastructure integration scenarios разделены по доменам auth, orchestration, cabinet и feed; каждый suite должен независимо запускаться в собственной случайной disposable PostgreSQL schema и Redis namespace, а manifest фиксирует полный состав сценариев.
- Хардкод тарифов, device_limit, доменов, API-ключей, токенов и ID нод запрещён.

## 11. Обязательные тестовые сценарии

1. Повторное нажатие «Оплатить» не создаёт второй платёж.
2. Повторный webhook не продлевает подписку дважды.
3. Возврат на `return_url` без webhook не выдаёт доступ.
4. Подтверждённый платёж продлевает срок и ставит sync jobs на ноды. Outbox event пишется в той же PostgreSQL-транзакции; BullMQ job появляется после commit.
5. Отзыв одного устройства отключает только его и не затрагивает другие.
6. Истёкшая подписка блокирует доступ не позднее 5 минут на `healthy`, `draining` и доступных `disabled`-нодах, которые ещё принимают существующие VPN-подключения.
7. Нода, не подтвердившая версию, видна в админке и задача повторяется.
8. Обычный пользователь не может вызвать admin endpoint или увидеть данные другого пользователя.
9. Полный subscription URL отсутствует в API-ошибках и логах.
10. Восстановление PostgreSQL из бэкапа проходит на тестовом окружении.
11. Отказ одного profile, IP family, provider/ASN или региона исключает только затронутые маршруты и не меняет subscription URL.
12. Кратковременный отказ и потеря одного probe не приводят к удалению VPS; проверяются quarantine, cooldown и устойчивое восстановление.
13. Staged rollout останавливается и откатывается при ухудшении заданных клиентских SLI.
14. Emergency Mode активирует независимый резерв, перестраивает выдачу и создаёт алерт/audit event без выпуска нового пользовательского секрета.
15. Выпуск устройства атомарно создаёт grants/jobs/outbox для всех `HEALTHY`-нод; replay и конкурентный выпуск не занимают второй slot, а отсутствие `HEALTHY`-нод или поздняя ошибка полностью откатывают operation scope.
16. `HEALTHY`-нода без ready route получает grant, но feed возвращает `503`, пока нет ни одного подтверждённого маршрута; истёкший entitlement получает общий `401`.
17. Граница `expiresAt = dbNow`, отставшая materialization, конкурентные expiry/renewal и повтор webhook проверяются по одному PostgreSQL clock/lock policy и не продлевают срок дважды.
18. Reconciliation покрывает event-driven и periodic repair, не отзывает grants только из-за `DRAINING`/`DISABLED`, не воспроизводит старую version и оставляет частично применённые ноды pending без скрытия готовых маршрутов остальных.

## 12. Definition of Done для каждой задачи

Задача считается сделанной, только если:

- описан пользовательский или системный сценарий;
- добавлена валидация и проверка доступа;
- есть миграция, если изменились данные;
- есть тесты на основной и ошибочный путь;
- добавлены структурированные логи без секретов;
- обновлён OpenAPI и интерфейс, если менялся API;
- внесена запись в журнал, если изменилось решение, требование или риск;
- актуальная формулировка решения находится в owner-документе, а не только в журнале;
- код проходит CI и проверен на staging перед production.
