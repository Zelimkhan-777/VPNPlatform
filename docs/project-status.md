# Текущее состояние проекта

Обновлено: 2026-09-09.

Этот файл — единственный краткий источник истины о текущем этапе проекта. Он отвечает на вопрос: **где мы сейчас и что является следующим практическим шагом**.

Исторические детали не хранятся здесь. Полный журнал до 2026-09-09 находится в `docs/archive/vpn-project-journal-through-2026-09-09.md`.

## Текущий этап

Documentation consolidation завершена. Текущий engineering milestone — **North Star closed-beta E2E**.

Новая работа допустима, только если она двигает North Star scenario или закрывает конкретный release gate. Новые foundational-механизмы и расширение MVP scope не нужны.

## Что уже реализовано

- monorepo с API, web-кабинетом, Telegram-ботом, worker и node-agent;
- PostgreSQL как source of truth, Redis и BullMQ;
- Telegram auth / cabinet login flow, включая bot-mediated confirmation;
- device issuance и device-specific subscription URL;
- grants, desired state, worker/outbox, reconciliation и acknowledgement;
- VLESS/TCP/TLS subscription rendering для Happ;
- production-shaped node-agent/Xray adapter;
- локальный двухнодовый Happ-прототип с заменой/disable/quarantine;
- отдельная Amsterdam VPN-нода и подтверждённый consumer tunnel;
- versioned production deployment/release foundation;
- encrypted PostgreSQL backup/restore foundation;
- versioned health/capacity policy foundation;
- persisted health evidence, incidents и node operations;
- authenticated external probe ingestion;
- LocationPool persistence foundation.

## Подтверждённые практические результаты

- один subscription URL может менять состав маршрутов без выпуска нового URL;
- Amsterdam data plane применял desired state и подтверждал acknowledgement;
- отдельный Happ consumer test через Amsterdam подтвердил реальный VLESS/TCP/TLS/TUN маршрут и смену внешнего IP;
- migrations, integration suite и application image smoke проходят в текущем `main`.

## Текущий CI-статус

`main` зелёный на коммите `f45c6e0`: compose validation, infra lint, Prisma validation/migrations, typecheck, lint, unit/integration tests, OpenAPI contract, build, image build и application image smoke проходят.

## Главные внешние и продуктовые blockers

1. **Эквайринг.** Robokassa — главный кандидат, но provider не утверждён до проверки договора, sandbox, webhook/status verification, refund/chargeback и требований к чекам.
2. **Happ client identity.** Нужно подтвердить реальный стабильный HWID/client-instance contract на актуальных Android/iOS.
3. **Mobile compatibility.** Обязательны реальные Android/iOS проверки импорта, refresh и удаления маршрута по тому же subscription URL.
4. **Blocking/filtering matrix.** Для closed beta нужны проверки в согласованном наборе мобильных и fixed сетей.
5. **Production deployment.** Platform control plane должен быть вынесен с операторского ноутбука на отдельный production VPS.
6. **Backup/restore drill.** Нужна фактическая проверка восстановления.
7. **Load/capacity evidence.** Нужны реальные нагрузочные данные перед масштабированием.

## North Star closed-beta сценарий

Следующий этап разработки должен двигать только этот сквозной сценарий:

1. новый пользователь открывает Telegram;
2. получает валидный trial/promo/payment entitlement;
3. входит в кабинет;
4. создаёт устройство;
5. получает HTTPS subscription URL;
6. импортирует его в Happ на Android/iOS;
7. видит минимум два пригодных реальных маршрута;
8. одна нода выводится из выдачи или деградирует;
9. после refresh того же URL старый маршрут исчезает, замена появляется;
10. пользователь продолжает пользоваться сервисом без выпуска нового subscription URL.

## Следующий порядок работ

1. завершить конкретный North Star E2E;
2. закрыть мобильный/HWID gate;
3. выбрать и проверить payment adapter;
4. выполнить production deployment + backup/restore drill;
5. провести blocking/filtering acceptance;
6. начать closed beta.

Новые foundational-механизмы не добавляются, если они не закрывают один из этих пунктов.

## Где искать требования

- продукт и пользовательское поведение: `vpn-service-tz.md`;
- application contracts и security invariants: `vpn-application-implementation-tz.md`;
- инфраструктура/deployment: `vpn-technical-spec.md`;
- nodes, pools, health, reserve, incidents и repair: `vpn-operations-spec.md`;
- устойчивые решения и причины: `project-decisions.md`;
- beta/release gates: `release-checklist.md`;
- внешняя проверка Happ/эквайринга: `vpn-external-validation-2026-08-09.md`;
- история: `archive/`.
