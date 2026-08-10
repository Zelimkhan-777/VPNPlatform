# VPNPlatform

Стартовый каркас pnpm-монорепозитория для VPN-платформы. В текущем этапе есть
только приложения `web`, `api`, неактивные каркасы `bot` и `worker`, общие
контракты и конфигурации, пустая Prisma-схема и локальные PostgreSQL/Redis.

Оплата, авторизация, кабинет, админка, Telegram polling/webhook, VPN-протоколы,
ноды и production deployment намеренно не реализованы.

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
pnpm dev
```

После запуска:

- web: <http://127.0.0.1:3000>;
- liveness: <http://127.0.0.1:3001/health/live>;
- readiness: <http://127.0.0.1:3001/health/ready>.

`/health/live` проверяет процесс API. `/health/ready` выполняет реальный
`SELECT 1` через Prisma и `PING` через Redis-клиент. Если хотя бы одна
зависимость недоступна или не отвечает за заданный timeout, endpoint возвращает
HTTP 503 без раскрытия строки подключения или внутренней ошибки.

Каркасы бота и worker по умолчанию не подключаются к внешним системам. Бот не
имеет токена, polling или webhook. Worker запускает BullMQ consumer только при
явном `WORKER_ENABLED=true`; бизнес-процессоры на стартовом этапе отсутствуют.

## Локальный subscription-прототип

Тестовый endpoint выключен по умолчанию. Он нужен только для фиксации HTTP-контракта
до проверки Happ на отдельном устройстве; в нём нет конфигураций VPN-нод. Для
локального запуска задайте в некоммитимом `.env` случайный токен длиной не менее 32
символов и включите endpoint:

```text
LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED=true
LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN=<случайный_локальный_токен>
LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX=5
LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS=60000
```

После запуска API запрос `GET /prototype/subscription/<токен>` возвращает UTF-8
`text/plain` fixture. Неверный токен возвращает `401`; когда прототип выключен —
`404`. Полный URL намеренно маскируется в логах.

## Корневые команды

```powershell
pnpm dev        # запустить приложения в watch/dev режиме
pnpm build      # собрать все пакеты и приложения
pnpm lint       # проверить Prettier и ESLint
pnpm typecheck  # проверить TypeScript strict во всех workspace
pnpm test       # запустить тесты всех workspace
```

Дополнительные команды:

```powershell
pnpm db:up             # запустить локальные PostgreSQL и Redis
pnpm db:down           # остановить локальные PostgreSQL и Redis
pnpm test:integration  # проверить readiness на реальных локальных сервисах
pnpm prisma:validate   # проверить пустую Prisma-схему
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
  web/       Next.js и временная главная страница
  api/       NestJS + Fastify и health endpoints
  bot/       неактивный каркас Telegraf
  worker/    неактивный каркас BullMQ worker
packages/
  contracts/ общие Zod-схемы и TypeScript-типы
  config/    общие TypeScript, ESLint и Prettier-конфиги
prisma/      Prisma-схема без бизнес-сущностей
infra/       Docker Compose только для локальных PostgreSQL и Redis
docs/        требования и журнал решений
```

Полный контракт API стартового этапа зафиксирован в
`apps/api/openapi.json`.

Результаты проверки совместимости Happ и предварительной проверки требований к
эквайрингу находятся в `docs/vpn-external-validation-2026-08-09.md`. Это не
заменяет тест на реальном устройстве, письменное одобрение эквайера или
юридическое заключение.
