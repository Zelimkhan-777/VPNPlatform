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
| Telegram               | Telegraf                          | Бот и обработка команд/long-polling updates                      |
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
├── providers/        # несекретный реестр инфраструктурных провайдеров
├── node-pools/       # location pools, pool roles, selection и capacity policy
├── nodes/            # реестр нод, состояние, capacity
├── orchestration/    # desired state, sync jobs, подтверждение версий
├── provisioning/     # enrollment и наблюдаемые операции установки ноды
├── incidents/        # affected scope, repair history и рекомендации OWNER
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
- В MVP Telegram updates получает только bot через long polling. Raw bot token находится только в отдельном bot-only private file; API получает только canonical base64url 32-byte WebApp validation key, производный как `HMAC-SHA256("WebAppData", bot token)`, и не может обращаться к Telegram Bot API. Token, validation key, update payload, confirmation code и Telegram identity не попадают в Git, argv или логи.
- Session cookie ставит только `POST /auth/telegram/complete`: exact `Origin = CABINET_ORIGIN` и fail-closed rate limit проверяются до чтения cookie и mutation; после `SELECT … FOR UPDATE` один `dbNow` подтверждает оба TTL, ту же pending-cookie и `bot_confirmed`. Успех атомарно заменяет pending на session и consume challenge. Cookie другого браузера, отсутствие cookie, отсутствие bot-confirm, истечение любой записи и attacker-first replay дают общий `401` без session cookie.
- После выдачи pending-cookie исходный WebView автоматически вызывает `POST /auth/telegram/complete` с этой HttpOnly cookie, не читая её в JavaScript и не кладя cookie, confirmation code или session secret в URL, query или frontend storage. Опрос не повторяет `POST /auth/telegram` и останавливается после успеха, отказа Origin (`403`), expiry или размонтирования.
- Для первого входа нового пользователя production issuer создаёт `AuthChallenge` только после подтверждённого сервером платежа, успешной атомарной активации trial либо успешной атомарной активации промокода. Созданные до entitlement `User`, `Order` и `Payment` сами по себе права входа не дают. Пользователь, который ранее уже имел entitlement, сохраняет доступ к кабинету после истечения VPN-подписки для просмотра состояния и продления; devices/feed остаются недоступны до нового entitlement.
- Challenge короткоживущий и одноразовый; постоянная login-ссылка в сообщении бота запрещена. После обмена используется обычная отзываемая cookie-сессия.
- Production bot выпускает challenge только через подписанный внутренний `POST /auth/telegram/challenge` по команде `/start` или `/cabinet` и отправляет Telegram Direct Mini App link с `startapp=<launchId>`. Base URL обязан канонически и посимвольно соответствовать `https://t.me/<bot_username>/<short_name>` без query/hash, trailing/duplicate slash или нормализуемых path segments; bot добавляет только одноразовый `launchId`. Web root до application hydration загружает официальный Telegram WebApp SDK, после чего использует только предоставленный им подписанный `initData`. Публичный self-service challenge запрещён.
- Выпуск challenge имеет отдельный principal/user-scoped fail-closed Redis rate limit внутри idempotency-miss operation и до PostgreSQL mutation. Exact replay с тем же idempotency key возвращает сохранённый результат без повторного расхода бюджета; превышение возвращает `429`, недоступный Redis — `503`, и оба отказа откатывают новую bot idempotency row и не создают `AuthChallenge`.
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
| Providers/location pools metadata и policy drafts  | M     | R                                      | —                              | —                          | R report                   |
| Policy activation/rollback и assignment к pool     | C     | —                                      | —                              | —                          | R report                   |
| Nodes/heartbeat/versions/grant counts              | R     | R                                      | —                              | —                          | R report                   |
| Drain/disable/возврат в HEALTHY                    | M     | M                                      | —                              | —                          | —                          |
| Enroll/provision/migrate/retire ноды               | C     | C                                      | —                              | —                          | —                          |
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
| Probe agent       | `POST /probe-agent/v1/results`; отдельный revocable credential зарегистрированного `ProbeSource`, strict body без caller-supplied source identity, server receive time, replay/rate/cardinality protection                                                                                                      |
| Node bootstrap    | `POST /node-agent/v1/enrollment/exchange`, затем provisional-auth `GET /node-agent/v1/bootstrap-configuration`, `POST /node-agent/v1/bootstrap-acknowledgements`, `POST /node-agent/v1/bootstrap-heartbeats`, `POST /node-agent/v1/bootstrap-probe-results`                                                                                                                   |
| Admin             | `/admin/overview`, `/admin/users`, `/admin/subscriptions`, `/admin/devices`, `/admin/orders`, `/admin/payments`, `/admin/trial-campaigns`, `/admin/promo-codes`, `/admin/providers`, `/admin/location-pools`, `/admin/nodes`, `/admin/probe-sources`, `/admin/probe-results`, `/admin/node-operations`, `/admin/provisioning-operations`, `/admin/health-policies`, `/admin/capacity-policies`, `/admin/delivery`, `/admin/incidents`, `/admin/alerts`, `/admin/plans`, `/admin/audit-log`, `/admin/system`, `/admin/backups` |
| Health            | `GET /health/live`, `GET /health/ready`                                                                                                                                                                                                                                                                        |

Все изменяющие состояние endpoint-ы требуют схему валидации, авторизацию, проверку роли/владельца ресурса и при необходимости idempotency key.

## 6. Данные, транзакции и outbox

- PostgreSQL — единственный источник правды для пользователей, платежей, устройств, подписок и состояния нод.
- Prisma-миграция обязательна для любого изменения схемы; миграции не редактируются после попадания в production.
- Деньги и сроки хранятся точно: сумма — в минимальных единицах валюты, время — UTC.
- У каждого платежа, webhook-события и sync job — уникальный внешний/идемпотентный ключ.
- Минимальные инварианты схемы: `users.telegram_id` уникален; у платежа уникален `provider_payment_id`; у заказа есть `idempotency_key`; применение payment/trial/promo к доступу имеет неизменяемую source/contribution identity, чтобы refund не вычитал произвольный срок; subscription token и session secret хранятся только как хеш; у устройства есть статус и `revoked_at`; у ноды — desired/applied config version; у промокода хранится только HMAC/хеш секрета, а `PromoRedemption(promoCodeId, userId)` уникален. Продуктовый состав сущностей: `vpn-service-tz.md`, раздел [5](vpn-service-tz.md#5-бизнес-сущности).
- Stage A schema включает `PendingLogin` с HMAC pending-token/code, status и ограниченным challenge TTL; `AdminMembership`, отдельные `AdminSession`, `AdminTotpCredential` и одноразовые recovery codes; `BotServicePrincipal`, ротируемые `BotServiceCredential` с `keyCiphertext`/nonce/key version/revocation и principal-scoped idempotency records. Browser/admin/bot secrets хранятся только как HMAC либо AEAD согласно их проверяемости; plaintext material в БД не хранится. DB guard не допускает удаления или понижения последнего OWNER.
- `Plan.durationDays` — целое 1–366, обязательное после backfill. Application services всегда читают это поле и не содержат литерала `30`; `PromoCode.durationDays` независимо. Forward-only migration выполняется в одной явной PostgreSQL-транзакции: nullable колонка без default → lock и проверка состава → подтверждённый data update `30` только для единственного стартового тарифа либо abort с полным rollback → CHECK и NOT NULL. Неизвестный состав или несколько существующих планов не угадываются.
- Цена, длительность или device limit использованного `Plan` не переписываются на
  месте: OWNER создаёт новую plan version и отдельно активирует её для новых
  orders/entitlements. `Order` и entitlement contribution сохраняют immutable
  snapshot `planVersion`, amount, currency, duration и device limit, поэтому
  изменение цены в панели не меняет историю и уже оплаченное право доступа.
- Если future contribution имеет device limit ниже лимита непосредственно
  предшествующего active/scheduled contribution, `POST /orders` требует явный
  `retainedDeviceIds` не длиннее нового лимита независимо от текущего количества
  active Devices и проверяет ownership/status до создания payment. Selection
  хранится с order, может быть изменён пользователем до `startsAt` и не выбирается
  backend-ом. Устройство, добавленное после checkout, сохраняется на пониженной
  границе только после явного включения в selection. На границе interval одна
  транзакция активирует contribution, фиксирует selection, отзывает все остальные
  active Devices и создаёт revoke jobs/outbox/audit. Уже отозванный selected
  Device не заменяется другим автоматически.
- `TrialCampaign.durationDays` является независимой длительностью бесплатного пробного entitlement и в MVP допускает только продуктовые значения 1, 3 или 5. `TrialActivation` атомарно фиксирует получение trial пользователем; базовый MVP запрещает более одной автоматической trial-активации на Telegram user, если отдельным продуктовым решением не утверждено другое правило. Trial не моделируется как `PromoCode` с пустым секретом и не создаёт `Order`/`Payment`.
- До выбора эквайера schema содержит только provider-neutral `Order`/`Payment` и application port проверки/применения успеха: amount, currency, abstract status, idempotency key и nullable unique provider payment ID. Публичный webhook, provider adapter, подпись payload и provider secrets отсутствуют до отдельного документированного выбора.

Подтверждение payment/trial/promo создаёт entitlement contribution с immutable
source type/id, duration, plan version и sequence order, а полуоткрытый interval
`[startsAt, expiresAt)` хранится как versioned materialized schedule. Status —
`SCHEDULED/AWAITING_DEVICE_SELECTION/ACTIVE/EXPIRED/REVOKED`. Contributions одного пользователя строго
упорядочены и не перекрываются; повтор provider event не создаёт второй source
или interval. Полный refund либо подтверждённый chargeback одной транзакцией
помечает только payment contribution `REVOKED`, запрещает его повторное
применение и использует один `dbNow`. Если contribution уже завершён, schedule
не меняется и использованное время не выдаётся повторно. Если он покрывает
`dbNow`, только ещё не начавшийся suffix перестраивается от `dbNow`. Если он
будущий, suffix после него перестраивается от
`max(dbNow, expiresAt последнего предшествующего неотозванного contribution)`.
Сохраняются полная duration не начавшихся contributions и sequence order. Каждая
смена schedule version хранит прежние/новые даты и причину в audit.

После reflow вычисляется effective entitlement и при необходимости обновляются
Subscription, grants, sync/outbox. Если будущего или текущего покрывающего
contribution не осталось, доступ прекращается; если следующий contribution был,
он начинается от рассчитанного anchor и использует существующие device/grant
identities, кроме уже явно `REVOKED`. Новый подтверждённый payment при отсутствии
текущего entitlement, но наличии future contributions, сначала reflow-ит их от
`dbNow`, затем append-ится после последнего interval. Checkout preview показывает
результирующее расписание.

Reflow повторно валидирует каждую новую смежную границу device limit.
Refund/chargeback фиксируется независимо от наличия selection. Если новый
переход понижает limit, а валидного `retainedDeviceIds` нет, целевой contribution
атомарно получает `AWAITING_DEVICE_SELECTION`; его entitlement-bearing interval
и интервалы зависимого suffix не materialize-ятся, grants не создаются, duration
не расходуется. Notification/outbox сообщает пользователю и OWNER.

Явный selection под user lock заново вычисляет anchor как
`max(dbNow, expiresAt последнего предшествующего неотозванного contribution)` и
materialize-ит contribution/suffix без overlap. При `anchor > dbNow` contribution
становится `SCHEDULED`: selection сохраняется, а предшествующий доступ и Devices
не меняются до scheduled boundary. Только при `anchor = dbNow` contribution
становится `ACTIVE` и в той же транзакции отзывает невыбранные Devices. Backend
не выбирает устройства автоматически. Постоянная блокировка user не является
автоматическим side effect: создаётся risk flag для OWNER. Partial refund в MVP
не меняет contribution автоматически и остаётся reconciliation case до
provider-specific решения. Это target schema; текущая схема без contribution и
versioned schedule не считается готовой к refund flow.

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

- До contribution-stage `effectiveSubscriptionStatus` равен `ACTIVE` только при persisted `status = ACTIVE` и `expiresAt > dbNow`; равенство означает expiry, а `PENDING`, `EXPIRED` и `CANCELLED` имеют приоритет над датой.
- После contribution-stage authoritative `effectiveEntitlement` существует только при contribution со `status = ACTIVE` и `startsAt <= dbNow < expiresAt`. `SCHEDULED`, `AWAITING_DEVICE_SELECTION`, `EXPIRED` и `REVOKED` всегда дают false независимо от сохранённых исторических или preview-дат; unresolved suffix не имеет entitlement-bearing intervals. Materialized `Subscription.status/expiresAt` отражает текущий непрерывный interval и не превращает future contribution в ранний доступ. Scheduled worker на boundary повторно проверяет status, selection и predecessor, создаёт новое текущее состояние только для готового `SCHEDULED` contribution и не изменяет старый `REVOKED`.
- `hasEntitlement` требует `Device.status = ACTIVE` и authoritative effective entitlement;
- `isGrantConverged` требует `NodeAccessGrant.status = ACTIVE`, неистёкший `expiresAt` и равенство его `appliedVersion = desiredVersion`;
- `isRouteReady` дополнительно требует действующий assignment, `Node.status = HEALTHY`, pool role `SERVING`, подтверждённую node version, допустимые capacity/availability gates, активные endpoint/profile и route activation, уже применённую нодой.

Эти predicates принадлежат одной domain policy и одной табличной test matrix. SQL может выражать их непосредственно через PostgreSQL, но feed, кабинет, issuance, renewal и reconciliation не определяют независимые варианты семантики. Внутри state-changing транзакции `dbNow` читается один раз через `clock_timestamp()` после требуемых locks и используется всеми проверками этой операции.

Выпуск устройства сериализуется существующим user advisory lock. Целевая операция в одной PostgreSQL-транзакции блокирует subscription/plan, versioned pool policy и выбранные eligible `SERVING`-ноды, повторно проверяет `hasEntitlement` и device limit, создаёт Device и desired `NodeAccessGrant` только для bounded персонального candidate set, повышает desired versions затронутых нод и создаёт связанные `NodeSyncJob`, outbox и audit. Нужен хотя бы один generic-ready serving-кандидат в обязательном пуле; иначе транзакция откатывается без Device, token, grant или занятого slot. `STANDBY` не получает пользовательский grant. Commit не ждёт node-agent acknowledgement и не означает route readiness: feed допускает конкретный маршрут только после convergence его grant/node version.

Текущая реализация до pool-stage создаёт grants для всех `NodeStatus.HEALTHY` и сортирует feed по статическим profile/endpoint priorities. Она не реализует `LocationPool`, `SERVING/STANDBY`, capacity/health scoring, sticky bounded assignment или автоматическую замену кандидата и поэтому не удовлетворяет целевой модели этого раздела. Миграция выполняется отдельным совместимым stage с characterization текущего поведения, forward-only schema, contracts/OpenAPI и transition/reconciliation tests.

Target schema различает как минимум `NodePoolMembership`,
`DeviceLocationAssignment`, immutable `HealthPolicyVersion` и
`CapacityPolicyVersion`, `ProbeSource`, `ProbeResult`, `AvailabilityDecision`,
`Incident`, `NodeOperation` и `ProvisioningOperation`. Assignment уникален в
активной policy version для device/location/candidate slot; automatic decision
ссылается на точные policy version и входные probe IDs. Активная policy version
seed-ится forward-only migration как `beta-v1`, поэтому production не стартует
с отсутствующей policy и не зависит от ручного первого клика OWNER.

Device limit применяется к числу активных `Device`, а не к ОС: любая комбинация поддерживаемых платформ расходует одинаковые slots. Каждый `Device` получает отдельный bearer subscription URL единого Happ-формата. Поле platform служит для инструкции, совместимости и диагностики, но не определяет тип секрета и не доказывает identity устройства.

Целевая MVP-граница физического использования — одна client instance на один `Device`/URL. Новый URL изначально не связан с client instance. Первый успешный subscription request с валидным стабильным идентификатором атомарно создаёт binding; конкурентная первая активация допускает только одного победителя. Повтор того же идентификатора разрешён после перезапуска приложения и смены сети, а другой идентификатор отклоняется до рендеринга feed единым безопасным ответом. Для Happ candidate source — HWID либо другой документированный client-instance identifier, подтверждённый реальными Android/iOS запросами. Raw identifier не сохраняется: persisted value является domain-separated keyed hash с versioned derivation и отдельным secret из secret storage; значение, заголовок и производные fingerprints отсутствуют в логах, errors, analytics и audit payload.

Отсутствие или нестабильность client identifier не заменяются подсчётом IP, `User-Agent` или модели устройства: эти признаки не являются identity и не вызывают автоматический revoke. Политика fail-closed для запроса без обязательного identifier включается только после подтверждения одинакового контракта в целевых версиях Happ; до этого физический enforcement считается незавершённым release requirement. Revoke/replacement удаляет возможность дальнейшего использования старого URL, отзывает его grants по обычному SLA и создаёт новый URL только для нового `Device`; перенос binding без rotation секрета не допускается.

Этот MVP-контроль ограничивает обычное повторное использование subscription URL, но не заявляет защиту от modified client или ручной передачи уже извлечённой `vless://`-конфигурации. Такая защита и поведенческий анализ соединений остаются вне MVP.

Grant lifecycle не является вторым источником delivery truth. Новый grant записывается как `PENDING` с `desiredVersion > appliedVersion`; verified acknowledgement одной транзакцией продвигает applied version и при первом apply переводит его в `ACTIVE`. Состояние `PENDING` с уже применённой desired version запрещено, но последующий renewal уже `ACTIVE` grant закономерно оставляет status `ACTIVE` при временном version gap. Readiness никогда не выводится из status без проверки versions. Renewal не меняет identity или credential: обновляет `expiresAt`, повышает node/grant desired version и временно делает маршрут not-ready до нового acknowledgement. Естественный expiry не переводит grant в `REVOKED`: entitlement становится false по времени, а credential исключается из serving state. `REVOKED` с `revokedAt` зарезервирован для явного отзыва и не восстанавливается renewal/reconciliation.

Отмена блокирует пользователя, Subscription и contributions по одному `dbNow` и принимает явный scope. `CURRENT` помечает `REVOKED` только contribution, покрывающий `dbNow`, запрещает повторно применить его source, записывает `Subscription.CANCELLED`/`cancelledAt` и отзывает текущие grants; future contributions не reflow-ятся и сохраняют первоначальные даты. `CURRENT_AND_SCHEDULED` дополнительно отзывает все future contributions. Preview до step-up перечисляет отзываемые sources, дату возможного возобновления при `CURRENT` и affected Devices. Confirm одной PostgreSQL-транзакцией сохраняет contribution statuses, Subscription, grants, монотонные node/grant versions, sync/outbox и audit. Повтор с тем же idempotency key не создаёт writes, а повторно использовать отменённый source запрещено. Scheduled activation после `CURRENT` создаёт новый фактический Subscription interval и desired state, но не восстанавливает `REVOKED` contribution/grant; уже действующие неотозванные device identities переиспользуются. Историческая `CANCELLED`-строка сама по себе не является новым revoke intent для более позднего contribution. Новая покупка во время gap до её подтверждения показывает reflow будущего расписания к `dbNow`; после подтверждения выполняет этот reflow и добавляет купленный contribution в конец.

Expiry worker и renewal используют `SELECT ... FOR UPDATE` одной строки Subscription, после lock повторно читают status/`expiresAt` и единый `dbNow`. Worker bounded batch-ами materializes `ACTIVE → EXPIRED` и создаёт audit и per-node sync/outbox только если subscription всё ещё фактически истекла; продлённая конкурентно подписка даёт no-op. До выбора grants expiry-транзакция вычисляет effective replacement entitlement пользователя. Если действующей замены нет, каждый неотозванный grant нормализуется к истёкшему сроку независимо от собственного более позднего `expiresAt`; если замена есть, grants приводятся к её authoritative `expiresAt`, а не к сроку старой подписки. Ошибка одной subscription/node transaction учитывается отдельно и не отменяет уже завершённые элементы batch. Подтверждённый до expiry платёж продлевает от прежнего `expiresAt`, после expiry — от проверенного immutable provider success timestamp; если провайдер не даёт надёжного timestamp, один раз сохраняется PostgreSQL-время первой успешной серверной верификации. Provider payment ID и факт применения платежа идемпотентны, поэтому replay webhook не продлевает срок повторно.

Reconciliation запускается при переходе ноды в `HEALTHY` и периодически как repair loop. Она заново строит expected state только из текущего PostgreSQL snapshot, versioned pool policy и действующих assignments: создаёт отсутствующие grants только для назначенного bounded `SERVING` set и обновляет устаревшие сроки/versions, но не выдаёт пользовательские grants `STANDBY`, не расширяет assignment на весь inventory и не выводит новый revoke intent из истории статусов подписок. Потеря eligibility запускает отдельный replacement/rebalance decision; новый кандидат попадает в feed только после grant convergence, а вывод старого следует drain/grace policy. Уже сохранённый `REVOKED` остаётся authoritative и при terminal `FAILED` либо отсутствии живой delivery получает новую монотонную node/grant version и delivery operation. Аналогичный version-gap repair выполняется для остальных grants. Естественный expiry сохраняет grant и синхронизирует его deadline, не подменяя expiry явным revoke. Старые события не воспроизводятся как бизнес-решения. Переход в `DRAINING` или обычный `DISABLED` сам по себе не отзывает существующие grants; `QUARANTINED` выполняет emergency revoke-all, `DELETED` не участвует. Repair, который изменил desired state, получает audit; no-op scan — нет.

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
- Локальный прототип двух заменяемых localhost Xray-нод (`infra/xray-local/`, harness `pnpm xray:local:harness`) воспроизводит сценарий Happ → один subscription URL → disable одной ноды без смены ключа. Общий production bootstrap сохраняет совместимый legacy harness `pnpm vpn-fi:bootstrap` (`vpn-fi-1`, `var/vpn-fi-01`) и предоставляет независимый Amsterdam harness `pnpm vpn-eu:bootstrap` (`vpn-eu-1`, `var/vpn-nl-01`); compose выбирает state через `VPN_NODE_STATE_DIRECTORY`, runbook — `infra/vpn-node/README.md`; grant/route выдаются на то же устройство, что local harness. Идемпотентный повтор с теми же TLS/display не переписывает immutable public config, а изменение требует новой версии profile. Default reload использует полный Compose restart Xray и корректный относительный путь из `apps/node-agent`. Это не Platform VPS и не публичный admin API. Feature gate `SUBSCRIPTION_FEED_RENDERING_ENABLED` по умолчанию выключен и включается явно в local env. Обычный `disableNode` исключает ноду из feed и не отзывает grants; `quarantineNode` этим не подменяется. Happ 3.1.0 на Windows импортировал live URL (`Local A` и `Local B`); после `disable a` та же подписка без нового URL оставила только `Local B`; оператор подключился к `Local B` (VLESS/TLS/TCP, скорость в Happ). Renderer выпускает VLESS/TLS/TCP/HAPP без `allowInsecure`; в production этот параметр не включать. Для самоподписанного localhost-TLS оператор может явно разрешить недоверенный сертификат в Happ только для localhost-профиля. Local-only флаг feed под `allowInsecure` не добавлялся. Скорость в Happ доказывает сессию к localhost inbound, не системный VPN. Amsterdam server-side data plane применил и подтвердил desired version через закрытый HTTPS/SSH канал; отдельный Happ consumer-тест подтвердил удалённый VLESS/TCP/TLS/TUN и смену внешнего IP. По сообщению оператора прежняя Finland VPS мигрирована в Польшу, но endpoint/IP/TLS, profile version и решение по legacy ID ещё требуют read-only аудита; Android/iOS, HTTPS пользовательского subscription origin и устойчивость к сетевой фильтрации не закрыты. Кабинет control-plane (overview, выпуск, revoke) уже есть; это не этап 2 и не оплата.
- Amsterdam consumer-тест на Happ 3.1.0/Windows подтвердил полный VLESS/TCP/TLS/TUN маршрут и выход через публичный адрес ноды. При диагностике учитывать глобально выбранный в Happ routing ruleset: сторонний `globalProxy=false` ruleset может принудительно отправлять `geosite:ip-detect` и unmatched traffic в `direct`, поэтому неизменившийся IP сам по себе не доказывает отказ профиля. Встроенный `Default` с `globalProxy=true` подтвердил туннель. Засвеченный consumer UUID был отозван через device/grant lifecycle; replacement device получил новый grant, а node-agent подтвердил новую desired/applied version. Секреты и URL в Git/журнал не попадают.
- API вне production может слушать HTTP на `localhost`/`127.0.0.1`. Production startup отклоняет `http:` для `SUBSCRIPTION_FEED_BASE_URL` и `CABINET_ORIGIN`; оба публичных origin обязательны и используют `https:`. Development/test сохраняют localhost HTTP для локального harness. Happ на iOS отклоняет HTTP subscription URL, в том числе loopback («небезопасная схема http запрещена»). Неверный token даёт HTTP 401; Windows Happ показывает это как «узел запрашивает аутентификацию». Пользовательский subscription URL для iOS и для production — HTTPS. Это не новый формат Happ.
- Обычные node-agent pull/ack/heartbeat принимаются от `healthy`, `draining`,
  доступных `disabled` и аварийных `quarantined`-нод с normal credential.
  `PROVISIONING` не допускается к этим endpoint-ам, user grants или production
  snapshot, но после одноразового enrollment exchange получает отдельную
  provisional credential, scoped к node/provisioning operation и bootstrap API.
  Bootstrap configuration содержит только test credentials и installer/runtime
  desired state; provisional agent может отправлять bootstrap heartbeat, ack и
  probe results, необходимые для clock/TLS/convergence/serving verification.
  Credential истекает не позднее 60 минут, не авторизует subscription/feed или
  access-control mutation и после `READY` атомарно заменяется normal credential.
  Та же транзакция переводит Node `PROVISIONING → HEALTHY` и создаёт membership
  `STANDBY`; canary `SERVING` запускается следующей отдельной operation.
  После pool-stage новая пользовательская выдача/assignment
  (`scheduleNodeAccessGrant`, subscription feed, route activation) требует
  `NodeStatus.HEALTHY`, pool role `SERVING` и остальные eligibility gates;
  `STANDBY` получает только test credentials/probes. Обычный access-control sync
  (revoke устройства, `expires_at`, credential revocation) идёт на `healthy`,
  `draining` и доступные `disabled`, если на них остаются ранее назначенные grants.
  `deleted` не участвует. Возврат в `HEALTHY` при
  `desiredConfigVersion > appliedConfigVersion` отклоняется, пока pending updates
  не reconciled.
- Аварийная операция `quarantineNode` переводит ноду в `QUARANTINED`, в одной транзакции отзывает все живые grants и ставит один emergency sync job (если grants были), чтобы агент получил snapshot без доступа. Это не обычный набор assignment jobs и не availability-состояние `QUARANTINED` у endpoint/profile. Прямой переход в `QUARANTINED` при живых grants отклоняется PostgreSQL. Admin HTTP для quarantine в этот этап не входил.
- Обычный `disabled` исключает ресурс из новой выдачи subscription feed и не является командой отзыва уже выданного VPN-доступа. Пока node agent доступен, disabled-нода остаётся в access-control synchronization и получает security-critical updates: revoke устройства, уменьшение/истечение `expires_at`, credential revocation. Принудительное прекращение serving / revoke-all выполняется только аварийной операцией `quarantined`. `draining` не обрывает существующий VPN немедленно. `deleted` в синхронизации не участвует. Продуктовые правила: `vpn-service-tz.md`, раздел [3](vpn-service-tz.md#замена-ноды); lifecycle и sync: `vpn-technical-spec.md`, раздел [7](vpn-technical-spec.md#7-ноды-и-оркестратор).
- Истёкший или отозванный доступ блокируется локально не позднее чем через 5 минут на `healthy`, `draining` и доступных `disabled`-нодах, которые ещё способны принимать существующие VPN-подключения. Для локального expiry или полученного revoke при исчерпании безопасного retry budget применяется selective fail-closed всей Xray-ноды, а не продолжение старого access list. Успех force-stop подтверждается отдельной проверкой отсутствия running Xray containers по точным Compose labels. Недоступная нода копит pending updates и не возвращается в serving state, пока они не reconciled. Нода не считает subscription URL источником разрешения подключаться.
- Секреты нод, пользовательские VPN credentials и transport parameters не логируются и не коммитятся.
- Доменная модель разделяет физическую `Node`, заменяемый `Endpoint` и версионируемый `ConnectionProfile`. Нельзя закреплять инвариант «одна нода = один IP = один профиль» в бизнес-логике.
- Реализованный persistence foundation содержит `LocationPool` и `LocationPoolMembership` с независимой `SERVING/STANDBY` pool role, ссылками на точные health/capacity policy versions, public label, enabled-state и candidate limit. В MVP одна нода имеет не более одного текущего membership: это сохраняет прежнюю семантику единственного `Node.locationLabel` и исключает скрытое участие в нескольких serving pools. Forward-only migration группирует legacy-ноды по точному location label; `PROVISIONING` backfill становится `STANDBY`, остальные прежние lifecycle-состояния сохраняют роль `SERVING`. Pool role не подменяет persisted lifecycle `NodeStatus`, вычисляемое health-состояние либо availability endpoint/profile. До следующего application-среза membership ещё не является gate существующей выдачи; тогда же все provisioning/bootstrap paths обязаны явно создавать membership, а `STANDBY` становится fail-closed для новых grants и feed. `InfrastructureProvider` и `ProvisioningOperation` остаются целевой моделью следующих этапов.
- `InfrastructureProvider` хранит только несекретные операционные сведения: название, регионы/ДЦ, ASN/failure domain, стоимость и даты продления, traffic limits, SLA/abuse policy, support contacts, состояние и заметки. Secret material не хранится; допустим только непрозрачный reference на secret storage.
- `LocationPool` не имеет фиксированного product limit по числу нод. Его candidate limit, health/capacity policy и public label являются валидируемыми данными. `STANDBY`-нода получает test-only serving/grants для probes, но не пользовательские assignments/feed до атомарной promotion operation.
- `HealthPolicy` и `CapacityPolicy` являются immutable versioned records после activation. Новая версия создаётся draft-операцией, проходит validation/preview, активируется OWNER со свежим step-up и audit и может быть заменена только новой версией; update/delete активной версии запрещены. Каждое automatic decision и `NodeOperation` сохраняет использованные policy IDs/versions. Неизвестная, отсутствующая или невалидная active policy работает fail-closed для новых assignments и не выключает существующие маршруты без подтверждённого health/security decision.
- Стартовая `HealthPolicy beta-v1`: node-agent poll/heartbeat 30 секунд; serving/tunnel probe 60 секунд с timeout 10 секунд; 2 consecutive failures → `DEGRADED`/stop new assignment, 3 → route exclusion/replacement, 5 consecutive successes минимум за 5 минут + heartbeat/clock/serving/convergence → recovery; cooldown 600 секунд; stale heartbeat 90 секунд запрещает новые grants, но сам по себе не доказывает tunnel outage. Global `BLOCKED` требует один и тот же подтверждённый failure class в двух независимых target networks; critical trust failures используют отдельный немедленный fail-closed path.
- Стартовая `CapacityPolicy beta-v1`: warning `65%` за 10 минут, stop-assignment `80%` за 5 минут, critical rebalance `90%` за 5 минут, recovery ниже `60%` за 10 минут; disk warning/stop — 20%/10% свободного места; planned drain default/min/max — 24/1/72 часа; standby promotion target/hard timeout — 120/300 секунд. Reserve target хранит параметры `aggregateLoadShare=25%`, `largestNodeLoadMultiplier=125%` и требует независимый failure domain. Точные определения и traffic-budget gates принадлежат infrastructure policy из `vpn-technical-spec.md`, раздел 7.5, и не дублируются независимой логикой.
- Subscription route selection сначала применяет единый eligibility predicate, затем deterministic weighted/sticky selection для пары device/location/policy version. Eligibility требует serving pool role, node lifecycle/readiness, converged grant и route, допустимую regional availability и capacity budget. Вес учитывает только агрегаты стабильности, capacity, probe latency и failure-domain diversity; прямые user/device identifiers не попадают в metric labels. Стартовый candidate limit — до двух на локацию, но хранится в policy, а не литералом application-кода.
- Backend не называет выбранный маршрут «самым быстрым для устройства»: он выдаёт безопасных кандидатов, а локальный Happ ping/selection считается частью поведения только после Android/iOS validation. Sticky assignment меняется при policy version, потере eligibility, controlled rebalance или manual operation, но не от единичного колебания метрики.
- Health decision service возвращает `decision`, `reason`, `affectedScope`,
  использованную policy version и ссылки на сигналы. Одна ошибка или жалоба не
  выключает ресурс; security-critical trust failure может немедленно вызвать
  fail-closed. Profile, endpoint, node и provider/ASN scope оцениваются
  раздельно. Один failed cycle засчитывается только при двух fresh,
  аутентифицированных и независимых probe sources с одинаковым route-relevant
  failure class. Один success плюс один failure не увеличивают failure counter:
  создаётся `MIXED`, выполняется дополнительная проверка. Недостаток quorum даёт
  `UNKNOWN`; два последовательных `MIXED/UNKNOWN` останавливают новые назначения
  как precautionary `DEGRADED`, но сами по себе никогда не дают `BLOCKED` или
  удаления ресурса. Числовые thresholds берутся из утверждённой `beta-v1`, а не
  хардкодятся.
- Для общего subscription feed `PARTIALLY_BLOCKED` трактуется консервативно:
  route, подтверждённо заблокированный хотя бы в одной обязательной target
  network, исключается из новых/обновлённых candidate sets всех устройств, если
  backend не имеет проверенного privacy-safe механизма выбора по сети. Raw IP и
  ISP inference таким механизмом не являются. Network-specific выдача возможна
  только после отдельного подтверждения client capability; до этого отсутствие
  безопасной альтернативы скрывает локацию и создаёт incident. Automatic
  `PARTIALLY_BLOCKED` требует quorum двух зарегистрированных probe instances в
  одном network scope; global `BLOCKED` — такого quorum в каждой из двух
  независимых target networks. Ручное evidence автоматического голоса не даёт.
- Node repair/provisioning выполняются как идемпотентные `NodeOperation` с ownership/authorization, idempotency key, preview/step-up для критичных ручных действий, bounded retry и terminal status. Автоматическая promotion/failover исполняется отдельным service principal только по versioned policy, quorum и cooldown и всегда создаёт incident/audit. Панель не принимает shell command или raw Xray config. Полная недоступность VPS приводит к исключению затронутого scope, promotion резерва и incident/runbook/migration path, а не к фиктивной кнопке «починить».
- Persistence foundation создаёт не более одного `Incident` на triggering `AvailabilityDecision` и не более одной операции каждого типа на это решение. Scope и активная `HealthPolicyVersion` копируются только из immutable decision/state и защищены DB-boundary; caller не может подменить их. Automatic materializer под advisory lock создаёт `OPEN` incident, `PENDING PROMOTE_STANDBY` intent только при `triggerReplacement` и наличии policy version, append-only timeline и audit от отдельного service principal. Retry budget берётся из валидированной orchestration-конфигурации. `NodeOperation` поддерживает только `PENDING → RUNNING → SUCCEEDED/FAILED` (либо fail из pending), monotonic bounded attempts и immutable terminal result. `Incident` разрешается только после terminal status всех связанных операций; resolution event атомарно переводит его в `RESOLVED`. Этот foundation не исполняет promotion и не подменяет обязательные readiness/capacity/convergence проверки следующего pool-stage.
- `PROMOTE_STANDBY` сначала повторно подтверждает health, clock, TLS, serving и
  capacity, затем атомарно переводит membership в `SERVING` и bounded batch-ами
  создаёт replacement assignments/grants/outbox для affected active devices.
  Конкретный route появляется в feed устройства только после grant convergence.
  Operation считается `SUCCEEDED` только когда каждый актуальный affected active
  Device имеет хотя бы один converged replacement route. Любой terminal per-device
  failure или общий timeout делает operation `FAILED` с явным partial result;
  target 120 секунд и hard timeout 300 секунд действуют на весь этот результат
  при проверенном масштабе closed beta. Уже converged безопасные replacement
  routes остаются доступными и не откатываются автоматически из-за ошибки других
  устройств; unconverged routes в feed не попадают. Старый работоспособный route
  не отзывается до готовности replacement, кроме отдельного security emergency.
- Subscription response запрещает shared/intermediate caching (`Cache-Control:
  private, no-store`) и формируется из текущей decision/policy version. Стартовый
  Happ update interval — 5 минут; Android/iOS acceptance измеряет фактическое
  удаление исключённого route не позднее 10 минут после публикации. Если клиент
  не соблюдает интервал, UI/бот требуют ручной refresh и система не заявляет
  seamless failover для этой версии клиента.
- Enrollment создаёт короткоживущий одноразовый token и наблюдаемую provisioning operation. Installer получает token интерактивно, проверяет подписанный versioned artifact и идемпотентно настраивает host baseline, immutable container images, DNS/TLS, node credential, systemd, node-agent/Xray и verification probes. Token хранится только как HMAC/hash и не попадает в argv, shell history, логи или audit payload. Failed provisioning не делает ноду serving.
- Плановая ротация использует canary и `DRAINING`: обновлённый feed больше не выдаёт старый маршрут, но не является командой разрыва текущей сессии. После policy-defined grace отдельная controlled retirement/revoke operation может завершить оставшиеся соединения. Hard delete истории ноды, grants, incidents и operations из обычной панели запрещён.
- Пользователь, подписка, платёж и устройство не зависят от конкретного protocol/transport.
- Heartbeat агента не считается доказательством доступности VPN из пользовательской сети.
- Внешние probe results — недоверенный вход: обязательны аутентификация источника, схема, timestamp/freshness, replay-защита, rate limit и ограничение кардинальности меток. `POST /probe-agent/v1/results` использует отдельный opaque bearer credential конкретного `ProbeSource` только по HTTPS; в PostgreSQL хранится domain-separated HMAC verifier с отдельным secret pepper, credential ротируется/отзывается и не переиспользует node-agent identity. Source ID/independence key берутся только из credential/реестра, время приёма — только из PostgreSQL. До DB lookup действует IP limiter, после аутентификации — per-source request и distinct-scope limiter; недоступный Redis работает fail-closed.
- Staged rollout, rollback, quarantine, ручной override и Emergency Mode — команды control plane с idempotency key, наблюдаемым статусом и append-only audit event.
- Сырые пользовательские IP, содержимое трафика и пользовательские VPN credentials в probes/метрики не попадают.

## 9. Правила frontend-а

- Разделы `/cabinet` и `/admin` живут в одном Next.js-приложении, но имеют раздельные layouts, guards и навигацию.
- Новый пользователь без подтверждённого entitlement не видит `/cabinet`. Ранее допущенный пользователь с истёкшей подпиской продолжает входить для продления, но UI и API не выдают устройство или feed до восстановления entitlement.
- Все данные сервера запрашиваются через API и TanStack Query; Zustand не дублирует состояние пользователя, платежа или подписки.
- Корневой client provider создаёт отдельный `QueryClient` на экземпляр приложения, а не module-level singleton, способный разделить cache между запросами или пользователями. Cabinet overview и безопасные auth outcome хранятся под единым query key; автоматические retry/refetch on focus/reconnect отключены, чтобы не повторять Telegram sign-in скрыто. Пока кабинет в состоянии confirmation-required, WebView явно опрашивает только `POST /auth/telegram/complete`; это не скрытый retry sign-in. `403` Origin завершает опрос сразу и показывает отказ входа, без ожидания expiry. Обновление выполняется явно после issue/revoke.
- Device mutations сбрасывают и повторно загружают cabinet query после подтверждённого результата. `401` revoke повторно проходит тот же auth/query flow, `404` считается уже достигнутым revoke outcome, а остальные ошибки остаются видимыми. Idempotency key выпуска сохраняется для повтора того же неизменённого input и заменяется при изменении формы.
- Route-level `page.tsx` кабинета остаётся тонким client container: связывает cabinet query с локальным состоянием одноразового URL, но не содержит разметку subscription/device flows. Loading/auth/error/ready states, overview, issue form, revoke confirmation и URL dialog разделены по presentation-компонентам; server-state decisions остаются только в query/mutation hooks.
- Никаких optimistic updates для платежей, продления, отзыва устройства и управления нодами.
- Экран после возврата от оплаты показывает «Проверяем оплату» и опрашивает API; не активирует доступ по URL-параметру. Продуктовое правило return URL: `vpn-service-tz.md`, раздел [6](vpn-service-tz.md#6-платёжный-контур-обязательные-правила).
- URL устройства показывается только после явного действия пользователя, копируется одной кнопкой и не попадает в историю браузера, аналитику, `localStorage` или клиентские логи.
- Результат issue с полным subscription URL передаётся непосредственно в локальное состояние dialog и не становится data query/mutation cache. Mutation возвращает в TanStack Query только `undefined`; закрытие dialog удаляет последнюю UI-ссылку на URL.
- Админские действия имеют статус выполнения, идентификатор операции и понятную ошибку; не «молча» меняют данные.
- Admin overview показывает здоровье platform services, VPN-ноды и heartbeat/serving/clock/TLS, desired/applied versions, очереди и jobs, webhook delivery/reconciliation, subscription delivery и revoke SLA, бэкапы/restore drills и активные alerts.
- Admin overview в первую очередь показывает actionable queue: affected scope, автоматическое действие, активный резерв, рекомендуемый следующий шаг и состояние последней operation. Nodes view разделяет lifecycle, pool role, computed health и route availability; показывает location/provider/failure domain, capacity budget, candidates, drain/grace, probes, incidents и provisioning/repair history.
- Пользовательский раздел поддерживает поиск и историю, бесплатное ручное продление с причиной, отмену фактически действующей подписки, отзыв устройства, инициирование replacement, завершение web-сессий и блокировку новых покупок при abuse. Платёжный раздел показывает orders, states, webhook attempts, provider reconciliation, безопасный replay, refunds и ошибки; ручная отметка `succeeded` без проверки у провайдера запрещена.
- Trial/promo раздел панели позволяет OWNER управлять trial-кампаниями и секретными промокодами: длительность, назначенный тариф/device limit, период действия, лимиты, активность, архивирование, redemption/activation history и служебный комментарий. Полные promo secrets показываются только один раз при создании; trial не имеет пользовательского секрета. Массовый отзыв уже выданного бесплатного доступа требует отдельного критичного use case.
- Node-раздел показывает status, heartbeat, desired/applied versions, serving/TLS/clock, profiles, resources, grants, jobs и runtime state; разрешает drain/disable/quarantine, возврат в `HEALTHY` только после convergence, staged rollout/rollback и rotation credentials. Редактирование runtime Xray-конфигурации из админки запрещено.
- Provider/location sections позволяют OWNER вести реестр, создавать и отключать pools, назначать `SERVING/STANDBY`, candidate/capacity policies и запускать enrollment. Обычная форма не изменяет на месте immutable endpoint/TLS/profile identity: миграция создаёт новую version/resource и controlled drain старого.
- Policy editor показывает draft и активную version, validation errors, preview затронутых pools/routes, ожидаемое изменение assignments/reserve deficit и rollback target. Свободный ввод неизвестных полей, изменение active record на месте и применение без step-up запрещены.

## 10. Application-level security invariants

Единственный канонический список application-level security rules. Продуктовые следствия (отзыв ссылки, device limit как поле тарифа): `vpn-service-tz.md`. Эксплуатационные следствия (бэкапы, SSH, сеть): `vpn-technical-spec.md`.

1. Браузер не является доверенной стороной.
2. Telegram identity принимается только после серверной проверки подписи.
3. Frontend не получает прямой доступ к PostgreSQL, Redis, payment provider или node agent.
4. Auth/session secrets не хранятся в небезопасном клиентском storage (`localStorage`, frontend env, URL).
5. Subscription URL является bearer secret; в базе хранится только хеш токена.
6. Полные subscription URL, client-instance identifiers/HWID и их fingerprints, платёжные данные, секреты, содержимое трафика, raw IP/port metadata и прямые UUID/ID не логируются. API, worker, node-agent и bot используют общий safe Pino factory; API передаёт тот же wrapped logger в `pinoHttp.logger`, поэтому request-scoped `PinoLogger.assign()` и все child bindings проходят единую sanitization policy. HTTP request при прямой передаче и на любом уровне вложенности сохраняет только method; явный `res`/`response` или структурно подтверждённый HTTP response — только status code, но обычная operational-запись с одним `statusCode` не сворачивается; raw `Error` — только type. Secret families включают auth/session/bearer/challenge/prelaunch с credential suffixes, включая verifier, nonce, proof, fingerprint, hash, value и material; 32-byte base64url credentials и чувствительные значения маскируются единым pre-serialization pass и Pino redact policy. Ошибка чтения throwing getter/Proxy, включая bindings `child()`, приводит к одному минимальному безопасному record без исходных данных и дублированных JSON-ключей. Разрешены только необходимые технические агрегаты, enum outcomes, boolean и безопасные counters; новый независимый полный проход sanitization без пересмотра performance budget не добавляется.
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
15. Выпуск устройства атомарно выбирает bounded `SERVING` candidate set и создаёт grants/jobs/outbox только для назначенных нод; `STANDBY` не получает пользовательский grant, replay и конкурентный выпуск не занимают второй slot, а отсутствие любого eligible serving-кандидата или поздняя ошибка полностью откатывают operation scope.
16. Generic-ready serving-нода получает grant только после назначения устройству; feed возвращает `503`, пока нет ни одного converged назначенного маршрута, а истёкший entitlement получает общий `401`.
17. Граница `expiresAt = dbNow`, отставшая materialization, конкурентные expiry/renewal и повтор webhook проверяются по одному PostgreSQL clock/lock policy и не продлевают срок дважды.
18. Reconciliation покрывает event-driven и periodic repair, восстанавливает только текущий bounded assignment, не выдаёт grants всему inventory/`STANDBY`, не отзывает их только из-за `DRAINING`/`DISABLED`, не воспроизводит старую version и оставляет частично применённые ноды pending без скрытия готовых маршрутов остальных.
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
31. До закрытой беты staging-проверка подтверждает импорт HTTPS subscription URL, VPN-туннель и передачу тестового трафика в Happ на Android и iOS. Для согласованного набора целевых пользовательских сетей отдельно фиксируется успешность blocked-network/filtering tests; один только факт смены публичного IP не считается прохождением сценария.
32. Device limit не зависит от ОС: fixture-plan с лимитом четыре допускает любые четыре зарегистрированных устройства, хотя стартовый product plan использует три. Один и тот же URL стабильно обновляется с впервые связанного client identifier после перезапуска и смены IP, но запрос с подтверждённо другим identifier не получает feed; конкурентная первая привязка не занимает два устройства и не раскрывает победивший identifier.
33. Android/iOS staging-проверка фиксирует реальные Happ request headers, стабильность HWID/client identifier, поведение при отключённой передаче HWID и возможность обязательного identifier. Ни IP, ни `User-Agent`, ни модель устройства не используются как замена identity; raw identifier и его fingerprints отсутствуют в логах, errors, analytics и audit.
34. Location pool допускает ноль, одну и несколько нод без фиксированного требования «три на страну». Feed не раскрывает весь inventory: для каждой локации возвращается не больше configured candidate limit, а отсутствие eligible routes скрывает только эту локацию и создаёт incident/alert.
35. `STANDBY` с успешными probes не попадает в обычный пользовательский feed до promotion. Promotion, конкурентный failover и replay идемпотентны; после promotion candidate set перестраивается без нового subscription URL и не превышает capacity policy.
36. Deterministic assignment остаётся стабильным при неизменной policy/health, распределяет разные устройства между несколькими serving nodes и меняется при потере eligibility. Одна transient probe failure или колебание latency не вызывает flapping; отказ provider/ASN исключает затронутый failure domain.
37. Ротация `A → C` сначала проверяет C и вводит canary, затем удаляет A из новых feed через drain. Обновление subscription не является принудительным disconnect; завершение grace и controlled revoke отдельно проверяют convergence, оставшиеся grants и наблюдаемый результат.
38. Health decision tests различают profile, endpoint, node и provider/ASN scope, stale/отсутствующие probes и security-critical trust failure. Thresholds загружаются из versioned policy; неизвестная или невалидная policy работает fail-closed и не удаляет VPS.
39. Enrollment token одноразов и истекает, exact retry не создаёт вторую ноду/credential, конкурентный consume имеет одного победителя. Provisional credential принимает только bootstrap configuration/ack/heartbeat/probes, отклоняется обычным agent API и не получает user grants. `READY` атомарно заменяет credential, переводит Node в `HEALTHY`/`STANDBY`; interrupted provisioning безопасно продолжается либо остаётся `FAILED` вне feed.
40. Каждая repair operation имеет idempotency, permission, preview/step-up по классу риска, bounded retry, terminal result и audit. Полностью недоступная нода приводит к минимальному route exclusion, promotion готового резерва и incident; arbitrary shell/raw Xray payload через admin API отсутствует.
41. `HealthPolicy beta-v1` проверяется boundary cases: один/два/три failure, пять recovery successes минимум за 5 минут, 90-second stale heartbeat, missing probe source, 10-minute cooldown, out-of-order/stale/replayed results и immediate critical trust failure. Один сбой не меняет feed, а recovery не происходит по одному успешному циклу.
42. `CapacityPolicy beta-v1` проверяет sustained windows и hysteresis: краткий spike выше 65/80/90% не переключает состояние, stop-assignment не обрывает текущие соединения, а recovery до завершения 10 минут ниже 60% запрещён. Stale/unknown metric не считается нулевой нагрузкой.
43. Reserve calculation отдельно по connections и throughput выбирает максимум `25% aggregate serving load` и `125% busiest-node load`, учитывает failure domain и создаёт deficit alert без автоматической покупки VPS. Promotion доводит affected devices до converged replacement route за target 120 секунд либо завершается `FAILED` не позднее 300 секунд и не выдаёт неподтверждённую ноду.
44. Planned drain использует default 24 часа и принимает только 1–72 часа; emergency zero-grace проходит отдельную permission/step-up policy. До завершения grace feed не выдаёт старый route новым/обновившимся устройствам, но сам drain не отправляет команду disconnect.
45. Closed-beta release evidence покрывает три target networks — двух мобильных операторов и одного fixed ISP минимум в двух регионах — на Android/iOS. Public-release gate требует пять сетей — три мобильных и две fixed; unauthenticated/manual результат не участвует в automatic blocking quorum.
46. Probe aggregation проверяет exact quorum: два совпадающих fresh failure,
    `success + failure → MIXED`, missing source → `UNKNOWN`, дополнительный probe
    за 15 секунд и запрет превращать `MIXED/UNKNOWN` в `BLOCKED` или удаление.
47. `PARTIALLY_BLOCKED` route без проверенного privacy-safe client capability не
    персонализируется по IP/ISP: он исключается из общего нового/обновлённого feed,
    а отсутствие альтернативы скрывает только локацию и создаёт incident.
48. Promotion test требует повторной readiness, atomic role transition, bounded
    assignment/grant creation и convergence каждого affected device. Operation не
    получает `SUCCEEDED` по одному изменению role или при terminal per-device
    failure; timeout даёт `FAILED` с partial result, сохраняет уже converged
    replacements и не отзывает работоспособный старый route вне security emergency.
49. Capacity tests проверяют 90-second runtime freshness, обязательные approved
    connection/bandwidth limits, reserve отдельно по обоим измерениям,
    24-hour traffic snapshot и time-bounded audited override.
50. Subscription response использует `private, no-store`; Android/iOS evidence
    проверяет 5-minute requested interval и удаление route не позднее 10 минут,
    либо фиксирует manual-refresh UX без обещания seamless failover.
51. Full refund/chargeback отзывает ровно один immutable payment source, replay
    не уменьшает entitlement дважды, а reflow различает completed/current/future:
    прошлое время не выдаётся повторно, current suffix стартует от `dbNow`,
    future suffix — от конца оставшегося predecessor, без overlap и с audit.
    Partial refund не выполняет скрытую корректировку; новая покупка во время gap
    reflow-ит не начавшееся расписание и append-ится после него.
52. Любой future plan с меньшим device limit относительно предшествующего
    interval без валидного explicit `retainedDeviceIds` отклоняется до payment,
    даже если active Devices меньше нового лимита. Устройство, добавленное после
    checkout, не сохраняется без обновления selection. На `startsAt` одна
    транзакция фиксирует selection, отзывает только невыбранные active Devices и
    создаёт jobs/outbox/audit; отозванный selected Device не заменяется.
53. Cancellation с scope `CURRENT` атомарно отзывает покрывающий contribution и
    grants, но сохраняет даты future contributions; `CURRENT_AND_SCHEDULED`
    отзывает оба множества. Preview/step-up/reason, idempotent replay, запрет
    повторного применения source и scheduled reactivation покрыты отдельно.
54. Reflow, создавший новую пониженную device-limit boundary без selection, не
    блокирует refund/chargeback: contribution становится
    `AWAITING_DEVICE_SELECTION`, duration не расходуется, доступ fail-closed, а
    user/OWNER уведомляются. Явный выбор использует anchor `max(dbNow, end
    predecessor)`: до будущей границы сохраняет predecessor Devices и status
    `SCHEDULED`, а при немедленной активации отзывает невыбранные. `AWAITING`
    никогда не удовлетворяет entitlement predicate.

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

Release candidate закрытой beta дополнительно проходит полный read-only review
актуального diff и release evidence через `gpt-6-astra`; blocker/high findings
устраняются либо явно принимаются OWNER с записью в журнале. Такое ревью не
заменяет исполняемые тесты и реальные Android/iOS/network проверки.
