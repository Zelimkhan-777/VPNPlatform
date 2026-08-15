# VPNPlatform

Монорепозиторий control plane для VPN-сервиса. В локальном контуре уже работают
API, кабинет, серверная проверка Telegram Web App-сессии, выпуск устройств,
device-specific subscription URL и пустой subscription feed для проверки Happ.
PostgreSQL — источник правды, Redis используется для readiness и общего лимита
запросов к subscription feed. Все принадлежащие API Redis keys получают
централизованный префикс `API_REDIS_KEY_NAMESPACE`; для каждого окружения нужен
отдельный namespace.

Платежи, Telegram production webhook/polling, админ-панель, боевые VPN-ноды,
production Xray adapter и production deployment намеренно ещё не реализованы.
Локальный `local-xray` adapter есть только для localhost/dev и запрещён в production.
Прототип двух заменяемых localhost-нод для Happ описан в
`infra/xray-local/README.md`. Это не боевые VPS и не production adapter.

## Требования

- Node.js 24 LTS;
- Corepack;
- Docker с Docker Compose.

## Первый локальный запуск

В PowerShell из корня репозитория:

```powershell
corepack enable
corepack prepare pnpm@10.18.3 --activate
pnpm install
Copy-Item .env.example .env
pnpm db:up
pnpm prisma:migrate
pnpm prisma:generate
```

Для локальной проверки кабинета и device-specific subscription URL задайте в
некоммитимом `.env` случайные значения (минимум 32 символа):

```text
AUTH_SESSION_PEPPER=<случайное локальное значение>
SUBSCRIPTION_TOKEN_PEPPER=<случайное локальное значение>
DATA_PLANE_CREDENTIAL_PEPPER=<случайное_base64url_значение_не_короче_43_символов>
SUBSCRIPTION_FEED_BASE_URL=http://127.0.0.1:3001
CABINET_ORIGIN=http://127.0.0.1:3000
```

В разных окнах PowerShell запустите API и web:

```powershell
pnpm --filter @vpn-platform/api dev
pnpm --filter @vpn-platform/web dev
```

После запуска:

- кабинет: <http://127.0.0.1:3000/cabinet>;
- liveness: <http://127.0.0.1:3001/health/live>;
- readiness: <http://127.0.0.1:3001/health/ready>.

`/health/live` проверяет процесс API. `/health/ready` выполняет реальный
`SELECT 1` через Prisma и `PING` через Redis-клиент. Если хотя бы одна
зависимость недоступна или не отвечает за заданный timeout, endpoint возвращает
HTTP 503 без раскрытия строки подключения или внутренней ошибки.

Web проксирует запросы к API на `http://127.0.0.1:3001`. Перед запуском web
можно указать иной локальный адрес: `$env:WEB_API_PROXY_TARGET='http://127.0.0.1:3001'`.
Если порт 3000 занят, используйте уже запущенный web-процесс либо остановите
его; при другом порте `CABINET_ORIGIN` должен совпадать с фактическим origin.

Бот по умолчанию не подключается к внешним системам и не имеет токена, polling
или webhook. Worker также выключен по умолчанию. При явном
`WORKER_ENABLED=true` он читает transactional outbox из PostgreSQL и публикует
валидированные `node-sync.requested` jobs в BullMQ. Consumer той же очереди
повторно связывает команду с точными `NodeSyncJob`, grant и desired version,
захватывает работу по lease на часах PostgreSQL и переводит принятую команду в
`SUCCEEDED`. Этот статус означает готовность desired state для pull со стороны
node agent, а не применение конфигурации на VPN-ноде: применение подтверждается
только отдельным `NodeConfigAcknowledgement`.

Для локальной публикации outbox используйте `.env`, не добавляя в него боевые
секреты:

```text
WORKER_ENABLED=true
WORKER_QUEUE_NAME=node-sync
WORKER_POLL_INTERVAL_MS=1000
WORKER_RETRY_DELAY_MS=5000
NODE_SYNC_RETRY_DELAY_MS=30000
NODE_SYNC_CONCURRENCY=4
ORCHESTRATION_LEASE_DURATION_MS=30000
ORCHESTRATION_MAX_ATTEMPTS=5
```

Worker использует уже заданные `DATABASE_URL` и `REDIS_URL`. UUID события
становится BullMQ job id, поэтому повтор после потери lease не создаёт вторую
команду. Queue retry не короче lease, а PostgreSQL не выдаёт попыток сверх
`ORCHESTRATION_MAX_ATTEMPTS`; истёкшая последняя попытка завершается `FAILED`.
Payload и внутренние тексты ошибок не логируются.

Отдельное приложение `@vpn-platform/node-agent` реализует защищённый
pull/apply/acknowledge цикл. Default — `simulation`: атомарно сохраняет
минимальный lifecycle snapshot и предыдущую версию в локальный state file,
идемпотентно повторяет acknowledgement после сетевой ошибки и отказывается от
downgrade или другого содержимого под тем же version. Режим `local-xray`
применяет тот же snapshot к локальному Xray: активный grant с credential
появляется как VLESS user, revoke и истекший `expires_at` снимают доступ без
смены subscription URL. Оба режима запрещены при `NODE_ENV=production` и не
являются боевым adapter. Credential не передаётся в URL, Git или логи.

```text
NODE_AGENT_ENABLED=true
NODE_AGENT_API_BASE_URL=http://127.0.0.1:3001
NODE_AGENT_CREDENTIAL=<локальная credential ноды>
NODE_AGENT_MODE=simulation
```

```powershell
pnpm --filter @vpn-platform/node-agent dev
```

Локальный Xray-контур (опционально, отдельно от API/Postgres) поднимает **две**
localhost-ноды на портах `10443` и `10444`. Это не боевые VPS:

```powershell
pnpm xray:local:up
pnpm xray:local:harness
```

```text
NODE_AGENT_MODE=local-xray
```

Два процесса node-agent читают gitignored `var/xray-local/{a,b}/agent.env`
(пути относительны к `apps/node-agent`):

```powershell
pnpm --filter @vpn-platform/node-agent dev:local-a
pnpm --filter @vpn-platform/node-agent dev:local-b
```

После apply перезапустите контейнеры, чтобы Xray перечитал runtime-конфиг:

```powershell
pnpm xray:local:restart
```

```powershell
pnpm xray:local:down
```

Обычный вывод одной ноды из выдачи (не quarantine):

```powershell
pnpm xray:local:harness -- disable a
```

Полный runbook, env и чеклист Happ: `infra/xray-local/README.md`. Template в Git
не содержит client UUID; runtime-конфиг, TLS, credentials и subscription URL не
коммитятся. HTTP разрешён только для `localhost`/`127.0.0.1` вне production;
остальные адреса требуют HTTPS.

## Локальный кабинет и subscription feed

Кабинет показывает только данные текущей cookie-сессии. Выпуск устройства
требует активную неистёкшую подписку, применяет device limit транзакционно и
защищён idempotency key. Отзыв требует отдельного подтверждения, идемпотентно
отключает только выбранное устройство и ставит обновление desired state для всех
связанных нод через transactional outbox. `GET /sub/:token` принимает bearer-токен конкретного
устройства, серверно проверяет устройство и подписку, отвечает `text/plain` и
не кэшируется. Renderer выключен по умолчанию (`SUBSCRIPTION_FEED_RENDERING_ENABLED=false`). При явном включении поддерживается только VLESS/TCP/TLS/HAPP из подтверждённых grant; URI не сохраняются и не логируются.

Subscription URL — секрет устройства, а не сессия кабинета. Не добавляйте его в
логи, скриншоты, историю браузера или Git. Его можно добавить в Happ для
проверки subscription endpoint; это не создаёт настоящее VPN-подключение без
подключённых нод.

## Прокси и ограничение subscription feed

Лимит `GET /sub/:token` общий для всех API-экземпляров и хранится в Redis:

```text
SUBSCRIPTION_FEED_RATE_LIMIT_MAX=60
SUBSCRIPTION_FEED_RATE_LIMIT_WINDOW_MS=60000
```

По умолчанию API не доверяет forwarded-заголовкам. За reverse proxy перечислите
только IP-адреса собственных прокси, например
`TRUSTED_PROXY_IPS=192.0.2.10,2001:db8::10`. Не указывайте домены или IP
клиентов. При недоступном Redis feed не обходит ограничение.

## Локальный subscription-прототип

Тестовый endpoint выключен по умолчанию. Он нужен только для фиксации HTTP-контракта
до проверки Happ на отдельном устройстве; в нём нет конфигураций VPN-нод. Для
локального запуска задайте в некоммитимом `.env` случайный токен длиной не менее 32
символов и включите endpoint:

```text
LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED=true
LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN=<случайный_локальный_токен>
# Опционально: локальная тестовая строка subscription; никогда не коммитить.
# LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT=
LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX=5
LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS=60000
ORCHESTRATION_LEASE_DURATION_MS=30000
ORCHESTRATION_MAX_ATTEMPTS=5
```

После запуска API запрос `GET /prototype/subscription/<токен>` возвращает UTF-8
`text/plain` fixture. Если `LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT` не задан, ответ остаётся пустым и не содержит VPN-конфигураций. Значение этой переменной предназначено только для изолированного локального теста Happ, не сохраняется и не логируется. Неверный токен возвращает `401`; когда прототип выключен —
`404`. Полный URL намеренно маскируется в логах.

## Корневые команды

```powershell
pnpm dev        # запустить приложения в watch/dev режиме
pnpm build      # собрать все пакеты и приложения
pnpm lint       # проверить Prettier и ESLint
pnpm typecheck  # проверить TypeScript strict во всех workspace
pnpm test       # запустить тесты всех workspace
pnpm test:integration # PostgreSQL + Redis + API-интеграция
pnpm build      # production-сборка всех приложений
```

API integration tests создают случайную PostgreSQL-схему, применяют в неё все
миграции и гарантированно удаляют после suite. Поэтому append-only audit и
pending outbox-записи тестов не остаются в общей локальной базе.

Дополнительные команды:

```powershell
pnpm db:up             # запустить локальные PostgreSQL и Redis
pnpm db:down           # остановить локальные PostgreSQL и Redis
pnpm xray:local:up     # два localhost Xray (не VPS)
pnpm xray:local:harness # внутренний local-only harness двух нод
pnpm xray:local:restart # перечитать runtime-конфиг Xray после apply
pnpm test:integration  # проверить readiness на реальных локальных сервисах
pnpm prisma:validate   # проверить Prisma-схему
pnpm prisma:generate   # сгенерировать Prisma Client
pnpm format            # применить форматирование
```

Для запуска одного приложения используйте фильтр pnpm, например:

```powershell
pnpm --filter @vpn-platform/web dev
pnpm --filter @vpn-platform/api dev
```

## Структура

```text
apps/
  web/       Next.js кабинет пользователя
  api/       NestJS + Fastify, PostgreSQL и Redis
  bot/       неактивный каркас Telegraf
  worker/    неактивный каркас BullMQ worker
packages/
  contracts/ общие Zod-схемы и TypeScript-типы
  config/    общие TypeScript, ESLint и Prettier-конфиги
prisma/      Prisma schema и миграции
infra/       Docker Compose только для локальных PostgreSQL и Redis
docs/        требования и журнал решений
```

Полный контракт API стартового этапа зафиксирован в
`apps/api/openapi.json`.

Результаты проверки совместимости Happ и предварительной проверки требований к
эквайрингу находятся в `docs/vpn-external-validation-2026-08-09.md`. Это не
заменяет тест на реальном устройстве, письменное одобрение эквайера или
юридическое заключение.

# Вход и завершение сессии

Telegram Web App login requires a trusted pre-launch context created before the
Web App opens. Its public `start_param` is signed by Telegram; a different
256-bit bearer secret exists only in the original browser's HttpOnly
`vpn_platform_prelaunch` cookie. There is deliberately no public challenge
endpoint: an `initData` thief cannot mint the missing browser secret. The
future bot-mediated issuer is an external prerequisite and is not implemented
in this repository. Until it exists, login fails closed. `POST /auth/logout`
idempotently revokes the current session and clears its cookie.
