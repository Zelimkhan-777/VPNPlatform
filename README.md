# VPNPlatform

Монорепозиторий control plane для VPN-сервиса. В локальном контуре уже работают
API, кабинет, серверная проверка Telegram Web App-сессии, выпуск устройств,
device-specific subscription URL и пустой subscription feed для проверки Happ.
PostgreSQL — источник правды, Redis используется для readiness и общего лимита
запросов к subscription feed.

Платежи, Telegram production webhook/polling, админ-панель, реальные VPN-ноды,
Xray/VLESS-конфигурации, worker processors и production deployment намеренно
ещё не реализованы.

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

Каркасы бота и worker по умолчанию не подключаются к внешним системам. Бот не
имеет токена, polling или webhook. Worker запускает BullMQ consumer только при
явном `WORKER_ENABLED=true`; бизнес-процессоры пока отсутствуют.

## Локальный кабинет и subscription feed

Кабинет показывает только данные текущей cookie-сессии. Выпуск устройства
требует активную неистёкшую подписку, применяет device limit транзакционно и
защищён idempotency key. `GET /sub/:token` принимает bearer-токен конкретного
устройства, серверно проверяет устройство и подписку, отвечает `text/plain` и
не кэшируется. Пока реальных нод нет, успешный feed намеренно пустой.

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

Дополнительные команды:

```powershell
pnpm db:up             # запустить локальные PostgreSQL и Redis
pnpm db:down           # остановить локальные PostgreSQL и Redis
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

Telegram Web App вход сначала получает одноразовый pre-auth challenge через
`POST /auth/challenge`, затем передаёт подписанный `initData` в `POST /auth/telegram`.
Challenge живёт только в HttpOnly cookie и не может быть повторно использован из
другого браузерного контекста. `POST /auth/logout` идемпотентно отзывает текущую
сессию и очищает cookie.
