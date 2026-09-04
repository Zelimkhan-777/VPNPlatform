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

| Зона                   | Выбор                             | Зачем                                                             |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------- |
| Язык                   | TypeScript (strict)               | Один язык для frontend, backend, бота и workers                   |
| Runtime                | Node.js LTS                       | Поддерживаемая среда для всех сервисов                            |
| Монорепозиторий        | pnpm workspaces                   | Простая общая структура без ранней сложности                      |
| Web                    | Next.js + React                   | Кабинет и админка в одном приложении                              |
| UI                     | Tailwind CSS + shadcn/ui          | Быстрая консистентная адаптивная UI-система                       |
| Клиентские данные      | TanStack Query                    | Серверное состояние, кэш и повторные запросы                      |
| Локальное UI-состояние | Zustand, только при необходимости | Модалки, фильтры, временное состояние; не источник данных сервера |
| Формы и схемы          | React Hook Form + Zod             | Типизация и единая валидация на границе данных                    |
| Backend                | NestJS + Fastify                  | Модули, DI, guards, jobs, быстрый HTTP-слой                       |
| API                    | REST + OpenAPI                    | Понятный контракт для web, bot и admin                            |
| База                   | PostgreSQL                        | Транзакции для платежей и подписок                                |
| ORM и миграции         | Prisma                            | Типобезопасные запросы и контролируемые миграции                  |
| Очередь и кеш          | Redis + BullMQ                    | Надёжные фоновые задачи и повторные попытки                       |
| Telegram               | Telegraf                          | Бот и обработка команд/webhook                                    |
| Тесты                  | Vitest + Supertest + Playwright   | unit, API-интеграция и ключевые E2E-сценарии                      |
| Логи                   | Pino                              | Структурированные JSON-логи с маскированием                       |
| Контейнеры             | Docker + Docker Compose           | Одинаковые dev/staging/production окружения                       |
| CI                     | GitHub Actions                    | Проверки до слияния и сборка контейнеров                          |

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
├── trials/           # автоматический пробный доступ и атомарные активации
├── promotions/       # секретные промокоды и атомарные активации
├── subscriptions/    # сроки доступа и subscription URL
├── devices/          # выпуск, отзыв и перевыпуск ссылки устройства
├── nodes/            # реестр нод, состояние, capacity
├── orchestration/    # desired state, sync jobs, подтверждение версий
├── admin/            # административные use cases, audit log
├── notifications/    # Telegram-сообщения и шаблоны
├── health/           # readiness/liveness, status
└── common/           # guard, error format, logger, config
```

Это целевая карта модулей, не текущий путь. Код живёт в `apps/api/src/`. Сейчас есть `auth`, `cabinet`, `orchestration`, `subscription-access`, `trials`, `node-agent`, `health` и связанные сервисы. Отдельных модулей `plans`, `billing`, `promotions`, `admin`, `users` нет.

Каждый модуль содержит контроллер, application/service слой, DTO/Zod-схемы, репозиторий или Prisma-адаптер и тесты. Контроллеры остаются тонкими: не содержат транзакций и бизнес-решений.

## 5. API и авторизация

Продуктовый вход без отдельной регистрации: `vpn-service-tz.md`, разделы [1](vpn-service-tz.md#1-цель) и [3](vpn-service-tz.md#покупка).

### Пользователь

- Telegram — первичный идентификатор.
- Браузер не является доверенной стороной. Telegram identity принимается только после серверной проверки подписи `initData`. Telegram ID из параметров браузера без этой проверки отклоняется.
- Бот открывает кабинет через bot-mediated issuer. Публичный `POST /auth/challenge` запрещён. Production issuer доступен только подписанному внутреннему bot-контракту.
- Issuer создаёт привязанную к `telegramUserId` `AuthChallenge` только после подтверждённого платежа, успешной атомарной активации trial, успешной атомарной активации промокода либо для пользователя с ранее существовавшим entitlement. `launchId` передаётся WebApp только как Telegram `start_param`, не как session secret.
- TTL challenge — 120 секунд по PostgreSQL clock. `POST /auth/telegram` после валидного `initData`, fail-closed rate limit и locks создаёт `PendingLogin`, срок которого равен минимуму из срока challenge и `dbNow + 120 seconds`, выдаёт исходному WebView отдельную 256-битную HttpOnly/Secure/SameSite=Strict pending-cookie и возвращает восьмисимвольный Crockford-код. В БД хранятся только HMAC pending-token и confirmation code.
- Пользователь вводит код в бот. Бот подтверждает его через внутренний подписанный API для того же Telegram user; confirm переводит только связанную pending-запись в `bot_confirmed` и не создаёт браузерную сессию.
- Session cookie ставит только `POST /auth/telegram/complete`: exact `Origin = CABINET_ORIGIN` и fail-closed rate limit проверяются до чтения cookie и mutation; после `SELECT … FOR UPDATE` один `dbNow` подтверждает оба TTL, ту же pending-cookie и `bot_confirmed`. Успех атомарно заменяет pending на session и consume challenge. Cookie другого браузера, отсутствие cookie, отсутствие bot-confirm, истечение любой записи и attacker-first replay дают общий `401` без session cookie.
- Для первого входа нового пользователя production issuer создаёт `AuthChallenge` только после подтверждённого сервером платежа, успешной атомарной активации trial либо успешной атомарной активации промокода. Созданные до entitlement `User`, `Order` и `Payment` сами по себе права входа не дают. Пользователь, который ранее уже имел entitlement, сохраняет доступ к кабинету после истечения VPN-подписки для просмотра состояния и продления; devices/feed остаются недоступны до нового entitlement.
- Challenge короткоживущий и одноразовый; постоянная login-ссылка в сообщении бота запрещена. После обмена используется обычная отзываемая cookie-сессия.
- Production issuer challenge ещё не подключён; пока он отсутствует, публичный self-service challenge не добавлять. История: `vpn-project-journal.md`.
- Initial, bot-confirm и complete линеаризуются locks соответствующих challenge/pending-записей; сроки и freshness Telegram proof считаются по PostgreSQL `clock_timestamp()`. Все криптографические, freshness, identity-binding и pending-binding отказы возвращают один и тот же публичный `401 Telegram login is invalid` без session `Set-Cookie`.
- Два WebView могут создать разные pending-записи одного challenge, но bot-confirm привязывается к конкретному коду и Telegram user, а session получает только браузер с соответствующей pending-cookie. Успешный consume делает последующие initial/confirm/complete fail-closed; retry не создаёт вторую сессию или новый entitlement.
- После входа создаётся cookie-сессия: `HttpOnly`, `SameSite=Strict`, `Secure` в production, с ротацией и отзывом. В базе хранится только HMAC-отпечаток непрозрачного секрета. Auth/session secrets не кладутся в `localStorage`, URL, frontend variables или JSON-ответы.
- `POST /auth/logout` идемпотентен: при точном trusted `Origin` отзывает текущую `UserSession` и возвращает удаляющую cookie; отсутствующий или отличный Origin отклоняется до session mutation.
- Subscription URL устройства — отдельный bearer-секрет и не является сессией кабинета.

### Администратор

- Административные роли `OWNER`, `OPERATOR`, `SUPPORT`, `FINANCE`, `AUDITOR` выдаются только вручную через защищённую процедуру; разрешения проверяет backend, а не только UI.
- В MVP используется один фиксированный список этих пяти ролей, единая статическая backend-матрица разрешений и общий authorization guard. Динамические permissions, конструктор ролей, пользовательские роли и отдельные authorization-механизмы по ролям в MVP не создаются.
- При первом запуске назначается только `OWNER`. `OPERATOR`, `SUPPORT`, `FINANCE` и `AUDITOR` остаются определёнными deny-by-default границами и назначаются только при появлении реальных операционных обязанностей; отсутствие назначения не даёт fallback к `OWNER` и не отменяет тесты границ ролей.
- Для критичных ролей обязательны отдельная admin-сессия, 2FA и append-only audit log.
- Операции с платежами, сроком подписки, промокодами, отзывом устройства и нодами требуют явного подтверждения в UI. Необратимые или массовые операции требуют повторного подтверждения, причины и предварительного просмотра последствий.
- Все state-changing admin use cases идемпотентны и аудитируются. Финансовые и эксплуатационные события не удаляются физически; пользователь не получает доступ к чужим ресурсам.
- Администратор никогда не читает текущий VPN credential или полный subscription URL. Поддержка может инициировать отзыв/замену, но новый секрет раскрывается только самому пользователю по обычному explicit-reveal flow.

Все пять административных ролей критичны и используют один механизм 2FA. Админ входит только через отдельную `AdminSession`: exact trusted Origin → свежий проверенный Telegram `initData` либо действующая кабинетная сессия как первый фактор → активная `AdminMembership` той же личности → TOTP или одноразовый recovery code. Кабинетная cookie сама по себе не авторизует `/admin/*`. TOTP seed хранится только как AEAD ciphertext с nonce и key version; KEK находится вне БД. Recovery codes хранятся как HMAC/хеш. Enrollment остаётся `pending` до первого верного TOTP; повтор кода в том же timestep отклоняется, допускается окно ±1 timestep. Rate limit и отсутствие/повреждение KEK работают fail-closed. Step-up обязателен для необратимых и массовых действий. Recovery material первого OWNER хранит владелец вне системы.

Статическая матрица MVP использует обозначения: `R` — минимальное чтение, `M` — мутация с подтверждением, `C` — preview + повторное подтверждение + причина + свежий step-up, `—` — полный запрет. Любая `M`/`C` требует admin-сессии и 2FA. Ответы не содержат полный subscription URL, VPN credential, полный промокод или 2FA material.

| Область                                            | OWNER | OPERATOR                               | SUPPORT                        | FINANCE                    | AUDITOR                    |
| -------------------------------------------------- | ----- | -------------------------------------- | ------------------------------ | -------------------------- | -------------------------- |
| Platform overview                                  | R     | R только nodes/jobs/delivery/incidents | R только очередь users/devices | R только payments/webhooks | R агрегаты/SLA без raw PII |
| Users и web-сессии                                 | M     | —                                      | M                              | —                          | —                          |
| Полная платёжная/trial/промо-история пользователя  | R     | —                                      | —                              | R только через order       | R только через audit       |
| Subscription status/plan/expiry                    | R     | —                                      | R                              | R для сверки суммы         | R report                   |
| Ручное продление/отмена                            | C     | —                                      | C                              | —                          | —                          |
| Devices и revoke/replacement                       | M     | —                                      | M                              | —                          | —                          |
| Orders/payments/webhook attempts                   | R     | —                                      | —                              | R                          | R без полного payload      |
| Webhook replay/reconciliation и refund             | C     | —                                      | —                              | C                          | —                          |
| Plans                                              | C     | —                                      | —                              | R                          | R                          |
| Trial/promo metadata                               | R     | —                                      | —                              | —                          | R                          |
| Trial/promo create/disable/archive                 | M     | —                                      | —                              | —                          | —                          |
| Trial/promo mass revoke                            | C     | —                                      | —                              | —                          | —                          |
| Nodes/heartbeat/versions/grant counts              | R     | R                                      | —                              | —                          | R report                   |
| Drain/disable/возврат в HEALTHY                    | M     | M                                      | —                              | —                          | —                          |
| Quarantine/staged rollout/node credential rotation | C     | C                                      | —                              | —                          | —                          |
| Delivery/job retry и incidents/alerts              | M     | M                                      | —                              | —                          | R incidents/alerts         |
| Audit log и backup drill status                    | R     | —                                      | —                              | —                          | R                          |
| Restore/break-glass restore                        | C     | —                                      | —                              | —                          | —                          |

Ручной `succeeded`, hard delete использованного промокода, hard delete использованной trial-кампании и self-service назначение ролей запрещены всем. Назначение ролей выполняется только защищённой внеполосной процедурой. SUPPORT и OPERATOR не получают OWNER-права или широкое cross-domain чтение; OPERATOR не читает users/payments/trial/promo, SUPPORT — payments/nodes/trial/promo, FINANCE — devices/nodes/incidents. Authorization deny-by-default и проверяется backend.

### Внутренний bot → API

Bot вызывает API по существующему plaintext HTTP `http://api:3001` в Docker-сети `egress`, которая не считается TLS. Каждый state-changing запрос подписывается HMAC-SHA256 исходным ключом credential по канонической строке `credentialId`, method, path, timestamp, nonce, `telegramUserId`, `Idempotency-Key` и SHA-256 raw body. `Idempotency-Key` входит в подпись, потому что меняет execution scope; посредник в plaintext-сети не может заменить его без нарушения HMAC. Поле `telegramUserId` принимается только после успешной подписи и само по себе личность не доказывает.

Стабильная identity — `BotServicePrincipal`; `BotServiceCredential` является ротируемой версией ключа. API хранит signing key только как AEAD ciphertext с nonce/key version и получает API-only `BOT_SIGNING_KEK`; plaintext signing key получает только bot. Web, worker и migrate не получают ни один из этих секретов. Timestamp допускает ±30 секунд по PostgreSQL clock; nonce атомарно резервируется Redis `SET NX PX` в namespace principal с TTL 120 секунд. Недоступный Redis отклоняет запрос до business mutation. `Idempotency-Key` scoped по principal + method + path + Telegram user + key, а не credential: retry использует новый timestamp/nonce и прежний ключ, exact logical replay возвращает сохранённый ответ, другой request hash даёт `409`. Первый вызов, повторная fail-closed проверка и row lock ещё активного credential, PostgreSQL business mutations/outbox и сохранение JSON response выполняются в одной транзакции под principal-scoped idempotency advisory lock; незавершённая запись не разрешает повторный side effect. Поэтому конкурентный revoke либо следует после уже начавшегося авторизованного действия, либо отклоняет действие до mutation. Порядок проверки: credential/KEK/signature → timestamp → nonce → active credential lock → idempotency → business. Rotation допускает не более двух одновременно активных credential одного principal: новая rotation запрещена, пока старый credential предыдущего overlap не отозван. Секреты, подпись, raw nonce/timestamp/body и Telegram init payload не логируются.

Versioned envelope bot signing key использует AES-256-GCM: `BOT_SIGNING_KEK` — 32 байта в canonical base64url, nonce — 96 бит, authentication tag — 128 бит; `keyCiphertext` хранит canonical base64url ciphertext и tag через точку. AAD связывает формат `bot-signing-key-envelope-v1`, `credentialId`, `principalId` и `keyVersion`. Неканоничная кодировка, неверная длина, подмена любого binding, повреждённый tag или неверный KEK отклоняются fail-closed и не раскрывают причину клиенту.

Runtime API получает KEK только из private file path, а не из значения environment; production inline `BOT_SIGNING_KEK` запрещён. На production host KEK принадлежит `root:meteora-api-secret` (`0440`), bot credential — `root:meteora-bot-secret` (`0440`), а каталог bot secrets — `root:meteora-bot-secret` (`0750`). Compose использует точечные bind mounts с `create_host_path: false` и добавляет API и bot только в соответствующие группы; отсутствие source file/directory не создаёт пустую замену и приводит к fail-closed запуску. Bot читает отдельный private credential file формата одной versioned JSON-строки с `formatVersion = 1`, UUID credential и canonical base64url 32-byte signing key. Provision/rotation/revoke выполняет только интерактивный versioned CLI с PostgreSQL advisory lock, reason и audit без secret material. Provision не перезаписывает существующий bot-файл; rotation сначала создаёт новый credential при сохранении старого overlap, затем атомарно заменяет bot-файл. Revoke выбирает старую key version и отказывается отзывать credential, установленный сейчас. При ошибке установки нового файла CLI отзывает новый credential компенсацией; старый credential остаётся работоспособным. Если первичная установка не оставила активного credential и bot-файла, повторный `provision` сохраняет principal и историю, создавая следующую key version; наличие хотя бы одного активного credential блокирует этот recovery path и требует обычной rotation.

### Миграция legacy `ADMIN` и первый `OWNER`

`UserRole.ADMIN` никогда автоматически не становится `OWNER`. До `prisma migrate deploy` обязательная read-only команда `admin:check-legacy-admin` завершает deployment ошибкой при наличии legacy `ADMIN`. Versioned CLI `admin:demote-legacy-admin` под lock переводит только `ADMIN → CUSTOMER` с audit. Forward-only migration в явной PostgreSQL-транзакции повторно блокирует и проверяет отсутствие `ADMIN`, создаёт `AdminMembership` и удаляет legacy enum value; старые production migrations не редактируются. После failed migration `resolve --rolled-back` разрешён только после read-only доказательства полного rollback DDL; он не чинит схему.

Первый OWNER создаётся one-shot CLI `admin:bootstrap-owner` под advisory lock при `OWNER count = 0`. Telegram identity читается интерактивно с TTY/stdin, не из argv или Git. CLI создаёт membership и pending TOTP, один раз показывает seed/QR и recovery codes на TTY и пишет audit без secret material. Отдельный `admin:confirm-owner-totp` активирует credential; до confirm admin-сессия не выдаётся. Bootstrap второго OWNER запрещён. Последнего OWNER нельзя удалить или понизить. Потеря TOTP обслуживается `admin:recover-owner-totp`, смена identity единственного OWNER — `admin:transfer-last-owner`; обе команды требуют защищённого внеполосного доступа, причины и audit. HTTP/self-promotion и raw SQL не являются bootstrap/recovery-процедурой.

### Основные endpoint-ы

| Группа            | Примеры                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | `POST /auth/telegram`, `POST /auth/telegram/complete`, `POST /auth/logout`, `GET /auth/me`; issuer и confirm для bot — внутренний подписанный контракт                                                                                                                                                         |
| Plans             | `GET /plans`                                                                                                                                                                                                                                                                                                   |
| Orders / billing  | `POST /orders`, `GET /orders/:id`; `POST /webhooks/payment-provider` добавляется только после выбора и документирования эквайера                                                                                                                                                                               |
| Trial             | `POST /trial/activate`; OWNER: `/admin/trial-campaigns`, `/admin/trial-campaigns/:id/disable`, `/admin/trial-campaigns/:id/archive`, отдельная операция предварительного просмотра/отзыва выданного доступа                                                                                                    |
| Promotions        | `POST /promotions/redeem`; OWNER: `/admin/promo-codes`, `/admin/promo-codes/:id/disable`, `/admin/promo-codes/:id/archive`, отдельная операция предварительного просмотра/отзыва выданного доступа                                                                                                             |
| Subscription      | `GET /subscription`, `POST /subscription/renew`                                                                                                                                                                                                                                                                |
| Devices           | `GET /devices`, `POST /devices`, `POST /devices/:id/revoke`, `POST /devices/:id/rotate`                                                                                                                                                                                                                        |
| Cabinet           | `GET /cabinet/overview`, `POST /cabinet/devices`, `POST /cabinet/devices/:deviceId/revoke`                                                                                                                                                                                                                     |
| Subscription feed | `GET /sub/:opaque-token`                                                                                                                                                                                                                                                                                       |
| Node agent        | `GET /node-agent/v1/configuration`, `POST /node-agent/v1/acknowledgements`, `POST /node-agent/v1/heartbeats`                                                                                                                                                                                                   |
| Admin             | `/admin/overview`, `/admin/users`, `/admin/subscriptions`, `/admin/devices`, `/admin/orders`, `/admin/payments`, `/admin/trial-campaigns`, `/admin/promo-codes`, `/admin/nodes`, `/admin/delivery`, `/admin/incidents`, `/admin/alerts`, `/admin/plans`, `/admin/audit-log`, `/admin/system`, `/admin/backups` |
| Health            | `GET /health/live`, `GET /health/ready`                                                                                                                                                                                                                                                                        |

Все изменяющие состояние endpoint-ы требуют схему валидации, авторизацию, проверку роли/владельца ресурса и при необходимости idempotency key.

## 6. Данные, транзакции и outbox

- PostgreSQL — единственный источник правды для пользователей, платежей, устройств, подписок и состояния нод.
- Prisma-миграция обязательна для любого изменения схемы; миграции не редактируются после попадания в production.
- Деньги и сроки хранятся точно: сумма — в минимальных единицах валюты, время — UTC.
- У каждого платежа, webhook-события и sync job — уникальный внешний/идемпотентный ключ.
- Минимальные инварианты схемы: `users.telegram_id` уникален; у платежа уникален `provider_payment_id`; у заказа есть `idempotency_key`; subscription token и session secret хранятся только как хеш; у устройства есть статус и `revoked_at`; у ноды — desired/applied config version; у промокода хранится только HMAC/хеш секрета, а `PromoRedemption(promoCodeId, userId)` уникален. Продуктовый состав сущностей: `vpn-service-tz.md`, раздел [5](vpn-service-tz.md#5-бизнес-сущности).
- Stage A schema включает `PendingLogin` с HMAC pending-token/code, status и ограниченным challenge TTL; `AdminMembership`, отдельные `AdminSession`, `AdminTotpCredential` и одноразовые recovery codes; `BotServicePrincipal`, ротируемые `BotServiceCredential` с `keyCiphertext`/nonce/key version/revocation и principal-scoped idempotency records. Browser/admin/bot secrets хранятся только как HMAC либо AEAD согласно их проверяемости; plaintext material в БД не хранится. DB guard не допускает удаления или понижения последнего OWNER.
- `Plan.durationDays` — целое 1–366, обязательное после backfill. Application services всегда читают это поле и не содержат литерала `30`; `PromoCode.durationDays` независимо. Forward-only migration выполняется в одной явной PostgreSQL-транзакции: nullable колонка без default → lock и проверка состава → подтверждённый data update `30` только для единственного стартового тарифа либо abort с полным rollback → CHECK и NOT NULL. Неизвестный состав или несколько существующих планов не угадываются.
- `TrialCampaign.durationDays` является независимой длительностью бесплатного пробного entitlement и в MVP допускает только продуктовые значения 1, 3 или 5. `TrialActivation` атомарно фиксирует получение trial пользователем; базовый MVP запрещает более одной автоматической trial-активации на Telegram user, если отдельным продуктовым решением не утверждено другое правило. Trial не моделируется как `PromoCode` с пустым секретом и не создаёт `Order`/`Payment`.
- До выбора эквайера schema содержит только provider-neutral `Order`/`Payment` и application port проверки/применения успеха: amount, currency, abstract status, idempotency key и nullable unique provider payment ID. Публичный webhook, provider adapter, подпись payload и provider secrets отсутствуют до отдельного документированного выбора.

### Активация пробного периода

Автоматический trial является самостоятельным бесплатным источником subscription entitlement, отдельным от платежей и промокодов. Активация выполняется в одной PostgreSQL-транзакции и по одному `dbNow` после необходимых locks:

- найти активную `TrialCampaign` и проверить период действия, разрешённую длительность 1/3/5 дней, назначенный тариф и capacity/activation limit при наличии;
- заблокировать пользователя, campaign и строку фактически действующей подписки пользователя;
- подтвердить eligibility, включая отсутствие прежней автоматической trial-активации этого Telegram user в базовом MVP;
- создать `TrialActivation`, создать подписку от `dbNow` при отсутствии действующего entitlement либо отклонить trial, если фактически активная подписка уже есть;
- обновить grants/desired-state без смены device identity;
- записать audit; если активация меняет desired state существующих устройств, создать отдельные node-sync jobs/outbox events для затронутых нод.

Уникальное ограничение, row/advisory locks, idempotency key и общий PostgreSQL clock обязаны сохранять один результат при повторе и не позволять конкурентным запросам выдать trial дважды. `TrialActivation` хранит immutable снимок первоначальных `startsAt`/`expiresAt`; последующее продление или отмена Subscription не меняют ответ повтора trial. При отсутствии active devices фиктивный node-sync outbox не создаётся: durable domain result уже зафиксирован `TrialActivation`, Subscription и audit, а consumer для отдельного entitlement event не утверждён. Клиентский флаг, query parameter, referral marker или возвращение со страницы не являются доказательством eligibility. Отключение trial-кампании запрещает только новые активации; отзыв уже выданного trial-доступа — отдельный OWNER use case с preview/confirm/reason и audit.

### Активация промокода

Промокод является самостоятельным бесплатным источником subscription entitlement, а не фиктивным заказом или платежом. Активация выполняется в одной PostgreSQL-транзакции и по одному `dbNow` после необходимых locks:

- найти код по HMAC/хешу и проверить `active`, `startsAt`, `endsAt`;
- заблокировать кампанию и строку фактически действующей подписки пользователя;
- подтвердить отсутствие прежней активации пары `(promoCodeId, userId)` и наличие свободного места в `maxUniqueUsers`;
- создать `PromoRedemption`, создать либо продлить подписку от текущего `expiresAt` или `dbNow` по продуктовым правилам;
- обновить grants/desired-state без смены device identity;
- записать audit и outbox event.

Уникальное ограничение, row/advisory locks и idempotency key обязаны сохранять один результат при повторе и не позволять конкурентным запросам превысить лимит. Отключение кода запрещает только новые активации. Отзыв уже выданного доступа — отдельный OWNER use case с preview/confirm/reason; он не является побочным эффектом disable/archive.

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

| Очередь         | Задачи                                                  |
| --------------- | ------------------------------------------------------- |
| `billing`       | сверка pending-платежа, обработка webhook, возврат      |
| `node-sync`     | выдача/отзыв устройства, применение версии конфигурации |
| `health-checks` | проверки нод, capacity, создание алертов                |
| `notifications` | оплата, окончание срока, аварийные сообщения            |
| `maintenance`   | очистка истёкших сессий, токенов, технических данных    |

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
- Selective fail-closed обязателен для production access-control. Production `NODE_AGENT_MODE=xray` перед разрешением serving и на каждом periodic local security reconcile проверяет доверенность часов через chrony (`/usr/bin/chronyc -c tracking`); untrusted clock, включая chrony local/orphan sentinel `7F7F0101`, вызывает существующий `failClosed` и не отправляет acknowledgement. Docker/Certbot не возобновляют Xray сами: штатный `vpn-node:up` поднимает только proxy, Certbot после TLS делает verified stop, restart node-agent и bounded wait live TLS fingerprint до `XRAY_TLS_DEPLOYED`, а adapter перед fingerprint shortcut проверяет фактический serving. Если serving не подтверждён и reload/read-back падает, существующий `failClosed` снова останавливает Xray; ACK и durable state не меняются. Serving поднимает только node-agent после trusted clock и verified reload/read-back. `simulation` и `local-xray` chronyc не вызывают. При исправном durable state и trusted clock недоступность control plane не выключает VPN: нода продолжает последнюю подтверждённую конфигурацию и локально применяет `expires_at`. State проверяется каждые 10 секунд: schema, snapshot hash, связь persisted version со snapshot и порядок `previous < current`; missing, unreadable или любой corrupt state немедленно останавливает Xray serving и старый runtime не считается разрешением. Полный snapshot с `desiredConfigVersion = appliedConfigVersion` восстанавливает runtime и durable state после serving verification без нового acknowledgement. Любая ошибка temp write, rename или fsync после recovery повторно останавливает Xray, даже если reload уже возобновил serving; local loop не имеет права возобновить serving, пока повторный file/directory fsync не подтвердит durability. Snapshot без matching command при несовпадающих desired/applied versions не применяется и не подтверждается. Полученный `REVOKED` с `revokedAt` сначала атомарно и durably фиксируется в защищённом stop-only sidecar рядом с основным state и только затем останавливает Xray; marker содержит только format/target version, deadline и grant IDs, переживает restart агента и блокирует local resume даже при missing/unreadable основном state. Ошибка записи marker всё равно переводит serving в fail-closed и возвращает ошибку. Latch удаляется только после matching full snapshot, successful apply/read-back и durability barrier. Outcome `waiting-for-command`, local expiry и failed control-plane apply повторяются с security-интервалом до 10 секунд. Production Xray poll ограничен 60 секундами независимо от большего configured interval. Для `expires_at` и `revokedAt` действует общий пятиминутный deadline с 120-секундным fail-closed reserve; безопасный serving возобновляется только после успешного apply, read-back и durability barrier.
- Локальный прототип двух заменяемых localhost Xray-нод (`infra/xray-local/`, harness `pnpm xray:local:harness`) воспроизводит сценарий Happ → один subscription URL → disable одной ноды без смены ключа. Общий production bootstrap сохраняет совместимый legacy harness `pnpm vpn-fi:bootstrap` (`vpn-fi-1`, `var/vpn-fi-01`) и предоставляет независимый Amsterdam harness `pnpm vpn-eu:bootstrap` (`vpn-eu-1`, `var/vpn-nl-01`); compose выбирает state через `VPN_NODE_STATE_DIRECTORY`, runbook — `infra/vpn-node/README.md`; grant/route выдаются на то же устройство, что local harness. Идемпотентный повтор с теми же TLS/display не переписывает immutable public config, а изменение требует новой версии profile. Default reload использует полный Compose restart Xray и корректный относительный путь из `apps/node-agent`. Это не Platform VPS и не публичный admin API. Feature gate `SUBSCRIPTION_FEED_RENDERING_ENABLED` по умолчанию выключен и включается явно в local env. Обычный `disableNode` исключает ноду из feed и не отзывает grants; `quarantineNode` этим не подменяется. Happ 3.1.0 на Windows импортировал live URL (`Local A` и `Local B`); после `disable a` та же подписка без нового URL оставила только `Local B`; оператор подключился к `Local B` (VLESS/TLS/TCP, скорость в Happ). Renderer выпускает VLESS/TLS/TCP/HAPP без `allowInsecure`; в production этот параметр не включать. Для самоподписанного localhost-TLS оператор может явно разрешить недоверенный сертификат в Happ только для localhost-профиля. Local-only флаг feed под `allowInsecure` не добавлялся. Скорость в Happ доказывает сессию к localhost inbound, не системный VPN. Amsterdam server-side data plane применил и подтвердил desired version через закрытый HTTPS/SSH канал; отдельный Happ consumer-тест подтвердил удалённый VLESS/TCP/TLS/TUN и смену внешнего IP. По сообщению оператора прежняя Finland VPS мигрирована в Польшу, но endpoint/IP/TLS, profile version и решение по legacy ID ещё требуют read-only аудита; iOS/HTTPS пользовательского subscription origin не закрыт. Кабинет control-plane (overview, выпуск, revoke) уже есть; это не этап 2 и не оплата.
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
- Новый пользователь без подтверждённого entitlement не видит `/cabinet`. Ранее допущенный пользователь с истёкшей подпиской продолжает входить для продления, но UI и API не выдают устройство или feed до восстановления entitlement.
- Все данные сервера запрашиваются через API и TanStack Query; Zustand не дублирует состояние пользователя, платежа или подписки.
- Корневой client provider создаёт отдельный `QueryClient` на экземпляр приложения, а не module-level singleton, способный разделить cache между запросами или пользователями. Cabinet overview и безопасные auth outcome хранятся под единым query key; автоматические retry/refetch on focus/reconnect отключены, чтобы не повторять Telegram sign-in скрыто. Обновление выполняется явно после issue/revoke.
- Device mutations сбрасывают и повторно загружают cabinet query после подтверждённого результата. `401` revoke повторно проходит тот же auth/query flow, `404` считается уже достигнутым revoke outcome, а остальные ошибки остаются видимыми. Idempotency key выпуска сохраняется для повтора того же неизменённого input и заменяется при изменении формы.
- Route-level `page.tsx` кабинета остаётся тонким client container: связывает cabinet query с локальным состоянием одноразового URL, но не содержит разметку subscription/device flows. Loading/auth/error/ready states, overview, issue form, revoke confirmation и URL dialog разделены по presentation-компонентам; server-state decisions остаются только в query/mutation hooks.
- Никаких optimistic updates для платежей, продления, отзыва устройства и управления нодами.
- Экран после возврата от оплаты показывает «Проверяем оплату» и опрашивает API; не активирует доступ по URL-параметру. Продуктовое правило return URL: `vpn-service-tz.md`, раздел [6](vpn-service-tz.md#6-платёжный-контур-обязательные-правила).
- URL устройства показывается только после явного действия пользователя, копируется одной кнопкой и не попадает в историю браузера, аналитику, `localStorage` или клиентские логи.
- Результат issue с полным subscription URL передаётся непосредственно в локальное состояние dialog и не становится data query/mutation cache. Mutation возвращает в TanStack Query только `undefined`; закрытие dialog удаляет последнюю UI-ссылку на URL.
- Админские действия имеют статус выполнения, идентификатор операции и понятную ошибку; не «молча» меняют данные.
- Admin overview показывает здоровье platform services, VPN-ноды и heartbeat/serving/clock/TLS, desired/applied versions, очереди и jobs, webhook delivery/reconciliation, subscription delivery и revoke SLA, бэкапы/restore drills и активные alerts.
- Пользовательский раздел поддерживает поиск и историю, бесплатное ручное продление с причиной, отмену фактически действующей подписки, отзыв устройства, инициирование replacement, завершение web-сессий и блокировку новых покупок при abuse. Платёжный раздел показывает orders, states, webhook attempts, provider reconciliation, безопасный replay, refunds и ошибки; ручная отметка `succeeded` без проверки у провайдера запрещена.
- Trial/promo раздел панели позволяет OWNER управлять trial-кампаниями и секретными промокодами: длительность, назначенный тариф/device limit, период действия, лимиты, активность, архивирование, redemption/activation history и служебный комментарий. Полные promo secrets показываются только один раз при создании; trial не имеет пользовательского секрета. Массовый отзыв уже выданного бесплатного доступа требует отдельного критичного use case.
- Node-раздел показывает status, heartbeat, desired/applied versions, serving/TLS/clock, profiles, resources, grants, jobs и runtime state; разрешает drain/disable/quarantine, возврат в `HEALTHY` только после convergence, staged rollout/rollback и rotation credentials. Редактирование runtime Xray-конфигурации из админки запрещено.

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
18. Промокоды криптографически случайны, показываются OWNER полностью только один раз, в БД хранятся как HMAC/хеш и не попадают в URL, аналитику, логи или audit payload.
19. Активация промокода rate-limited, атомарна, идемпотентна и допускается один раз на пользователя и код. Использованный код нельзя hard-delete; disable/archive не отзывают ранее выданный доступ.
20. OWNER создаёт и отключает промокоды. Массовый отзыв их entitlement — отдельная операция с preview, повторным подтверждением, причиной и audit; SUPPORT/OPERATOR не получают это право по умолчанию.
21. Trial-активация rate-limited, атомарна, идемпотентна и допускается только после серверной eligibility-проверки; клиентский флаг или отсутствие кода не доказывают право на trial. Trial и promo не создают `Order`/`Payment`.
22. Bot-команды принимаются только после HMAC identity binding, freshness/replay/idempotency проверок; JSON `telegramUserId` не является доказательством личности.
23. Admin cookie отделена от кабинетной сессии; все роли используют active 2FA, а критичные действия требуют свежего step-up.

### Обязательные инженерные практики

- TypeScript strict; ESLint, Prettier и pre-commit проверки.
- Workspace-пакеты, импортируемые во время typecheck до шага сборки, публикуют type entrypoint, доступный из чистого checkout; runtime entrypoint и production build остаются отдельными.
- Перед параллельным workspace test runtime entrypoints внутренних пакетов собираются отдельным root pretest-шагом; сами тесты не подменяются и не пропускаются.
- Миграции, тесты и OpenAPI обновляются вместе с изменением API.
- Production application image, используемый одноразовым migration service, содержит Prisma CLI и versioned schema/migrations; API и worker запускаются только после успешного `prisma migrate deploy`. Migration container работает непривилегированно, имеет только data-network и не становится long-lived service. Forward-only migration не откатывается импровизированным SQL.
- В CI: typecheck, lint, unit/integration tests, build; E2E — перед staging/production релизом.
- API infrastructure integration scenarios разделены по доменам trial, auth, orchestration, cabinet, feed и migration; каждый suite должен независимо запускаться в собственной случайной disposable PostgreSQL schema и Redis namespace, а manifest фиксирует полный состав сценариев.
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
19. Новый пользователь до подтверждённого payment/trial/promo entitlement не получает `AuthChallenge` кабинета; payment return URL, клиентский trial flag и существование pending order это правило не обходят.
20. Повтор и конкурентная активация trial/промокода дают одному пользователю один результат: trial не чаще одного раза на Telegram user в базовом MVP, промокод — один раз на пользователя и код, campaign limits не превышаются.
21. Проверяются inactive/not-yet-started/expired/unknown code, запрет повторного применения того же кода, последовательное применение разных кодов, начало от `dbNow` без активной подписки и продление от текущего `expiresAt` при активной.
22. Disable/archive промокода не отзывает уже выданный доступ; hard delete использованного кода отклоняется, а отдельный массовый отзыв требует OWNER, preview, подтверждение, причину и audit.
23. Промокод, subscription URL, current credential и admin 2FA material отсутствуют в логах, analytics, errors и audit payload; полный новый промокод возвращается только один раз на операции создания.
24. Admin 2FA tests покрывают pending enrollment, первый confirm, повтор TOTP в одном timestep, окно ±1, recovery consume-once, чужую Telegram identity с верным чужим TOTP, кабинетную cookie без admin-session, CUSTOMER без membership и missing/wrong KEK fail-closed.
25. Bot authentication tests покрывают отсутствие/ошибку HMAC, timestamp за окном, atomic duplicate nonce, logical replay с новым nonce, idempotency conflict, revoked credential, missing/wrong KEK и replay до/во время/после rotation без второго side effect.
26. Issuer tests покрывают attacker-first, victim-first, confirm без cookie, два браузера, чужой код, exact Origin, непродлеваемый challenge/pending TTL и fail-closed rate limits при недоступном Redis без consume и cookie.
27. Migration `Plan.durationDays` реально вызывает guard failure внутри транзакции и подтверждает полный rollback; успешный путь сохраняет 30 как данные, а promo duration остаётся независимым.
28. Legacy ADMIN/OWNER tests покрывают pre-deploy abort, transactional migration rollback, запрет auto-promotion, one-shot bootstrap + отдельный TOTP confirm, запрет второго bootstrap и удаления последнего OWNER, recovery без raw SQL.
29. Authorization tests проходят каждую deny-by-default границу статической RBAC-матрицы, включая запрет CUSTOMER/cabinet-cookie на admin API и запрет любых мутаций AUDITOR.
30. До выбора эквайера contracts/OpenAPI не содержат публичный provider webhook или speculative payload; provider-neutral Order/Payment tests проверяют идемпотентность и уникальность nullable provider ID без имитации внешней подписи.

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
