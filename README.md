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
pnpm dev
```

После запуска:

- web: <http://127.0.0.1:3000>;
- liveness: <http://127.0.0.1:3001/health/live>;
- readiness: <http://127.0.0.1:3001/health/ready>.

`/health/live` проверяет процесс API. `/health/ready` делает TCP-проверку
локальных PostgreSQL и Redis и возвращает HTTP 503, если одна из зависимостей
недоступна.

Каркасы бота и worker по умолчанию не подключаются к внешним системам. Бот не
имеет токена, polling или webhook. Worker запускает BullMQ consumer только при
явном `WORKER_ENABLED=true`; бизнес-процессоры на стартовом этапе отсутствуют.

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
pnpm prisma:validate   # проверить пустую Prisma-схему
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
