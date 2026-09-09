# VPNPlatform

Control plane для **Meteora VPN**: Telegram/cabinet access, entitlement и device management, subscription feed, orchestration VPN-нод и production-oriented deployment.

Текущее состояние проекта и следующий milestone: [docs/project-status.md](docs/project-status.md).

## Состав monorepo

- `apps/api` — NestJS/Fastify API;
- `apps/web` — Next.js кабинет;
- `apps/bot` — Telegram bot;
- `apps/worker` — BullMQ/outbox/reconciliation;
- `apps/node-agent` — pull/apply/ack lifecycle VPN-ноды;
- `packages/*` — contracts, config и shared libraries;
- `prisma` — PostgreSQL schema/migrations;
- `infra` — production/local deployment and VPN-node automation.

PostgreSQL — source of truth. Redis используется для readiness/rate limiting/queues.

## Требования

- Node.js 24 LTS;
- Corepack;
- Docker + Docker Compose.

## Быстрый локальный запуск

```powershell
corepack enable
corepack prepare pnpm@10.18.3 --activate
pnpm install
Copy-Item .env.example .env
pnpm db:up
pnpm prisma:migrate
pnpm prisma:generate
```

Для кабинета/API задайте локальные непроизводственные secrets в `.env`, затем:

```powershell
pnpm --filter @vpn-platform/api dev
$env:WEB_API_PROXY_TARGET='http://127.0.0.1:3001'
pnpm --filter @vpn-platform/web dev
```

Основные endpoints:

- cabinet: `http://127.0.0.1:3000/cabinet`;
- liveness: `http://127.0.0.1:3001/health/live`;
- readiness: `http://127.0.0.1:3001/health/ready`.

Полные env/runbook детали находятся рядом с соответствующим приложением или в `infra/*/README.md`. Production secrets, credentials, subscription URLs и runtime config в Git не коммитятся.

## Основные команды

Используйте package scripts из корневого `package.json`. Перед merge обязательны проверки затронутого scope; release gate собран в [docs/release-checklist.md](docs/release-checklist.md).

## Документация

Активные источники истины:

- [project-status.md](docs/project-status.md) — где проект сейчас и что делать дальше;
- [vpn-service-tz.md](docs/vpn-service-tz.md) — продукт/user flows;
- [vpn-application-implementation-tz.md](docs/vpn-application-implementation-tz.md) — application contracts/invariants;
- [vpn-technical-spec.md](docs/vpn-technical-spec.md) — infrastructure/deployment;
- [vpn-operations-spec.md](docs/vpn-operations-spec.md) — nodes/pools/health/failover;
- [project-decisions.md](docs/project-decisions.md) — устойчивые cross-cutting решения;
- [release-checklist.md](docs/release-checklist.md) — closed-beta gates;
- [vpn-external-validation-2026-08-09.md](docs/vpn-external-validation-2026-08-09.md) — внешний validation snapshot.

Исторические журналы, старые планы и pre-consolidation specs находятся в `docs/archive/` и не являются source of truth.

## Важные инварианты

- subscription URL является секретом конкретного Device;
- route/node replacement не требует нового subscription URL;
- `DRAINING`/`DISABLED` не равны emergency revoke;
- `QUARANTINED` идёт по отдельному аварийному пути;
- queue delivery не доказывает применение конфигурации — нужен acknowledgement;
- production secrets и runtime state не хранятся в Git;
- локальные simulation/local-Xray режимы не являются production adapters.

Подробнее — в owner-spec документах, а не в README.
