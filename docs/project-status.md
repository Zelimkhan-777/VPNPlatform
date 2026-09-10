# Текущее состояние проекта

Обновлено: 2026-09-11.

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
- LocationPool persistence и pool-aware subscription selection: feed учитывает
  только enabled pools и membership `SERVING`, соблюдает per-pool
  `candidateLimit` и fail-closed исключает unassigned/standby nodes;
- отдельная Poland bootstrap identity `vpn-pl-1` / `vpn-pl-01` / `VPN_PL_*` и
  LocationPool `poland` с начальной ролью `STANDBY`; Finland `vpn-fi-1`
  сохраняется как historical identity и не переименовывается скрыто;
- штатные closed-test operations: attach текущего Device из gitignored
  subscription URL, `DRAINING`/`DISABLED`/`HEALTHY`, serving promotion после
  convergence и fail-closed SSH fingerprint verify без записи `known_hosts`.

## Подтверждённые практические результаты

- один subscription URL может менять состав маршрутов без выпуска нового URL;
- Amsterdam data plane применял desired state и подтверждал acknowledgement;
- отдельный Happ consumer test через Amsterdam подтвердил реальный VLESS/TCP/TLS/TUN маршрут и смену внешнего IP;
- migrations, integration suite и application image smoke проходят в текущем `main`.
- локальная closed-test БД приведена к актуальной схеме после audited удаления
  трёх orphan integration-планов; рабочий `local-two-node` сохранён с
  `durationDays = 30`;
- актуальный replacement subscription URL отвечает `200` и выдаёт converged
  Amsterdam route без перевыпуска URL;
- повторная read-only проверка Amsterdam 2026-09-11: node-agent active,
  chrony trusted (leap `Normal`, не local sentinel), Xray serving, TLS 1.3
  hostname/expiry/fingerprint совпадают, heartbeat свежий,
  `desiredConfigVersion = appliedConfigVersion = 4`, feed по тому же URL
  остаётся `200` / 1 route / `Netherlands`;
- physical Finland VPS больше не используется как serving identity:
  `vpn-fi-1` переведена в `DISABLED` штатной operation, active grants = 0,
  feed не содержит Finland. Новая Poland identity ещё не подключена.

## Текущий CI-статус

`main` зелёный: compose validation, infra lint, Prisma validation/migrations,
typecheck, lint, unit/integration tests, OpenAPI contract, build, image build и
application image smoke проходят.

## Главные внешние и продуктовые blockers

1. **Второй реальный route.** Amsterdam снова подтверждён. После миграции
   Finland → Poland создаётся новая identity `vpn-pl-1`, а не rename
   `vpn-fi-1`. SSH host key польской VPS не принят: нет независимых ED25519/RSA
   SHA256 fingerprints из provider console. До совпадения с `ssh-keyscan`
   запрещено принимать ключ, отключать `StrictHostKeyChecking` или продолжать
   Poland rollout. Happ consumer tunnel для второго маршрута не проверялся.
2. **Эквайринг.** Robokassa — главный кандидат, но provider не утверждён до проверки договора, sandbox, webhook/status verification, refund/chargeback и требований к чекам.
3. **Happ client identity.** Нужно подтвердить реальный стабильный HWID/client-instance contract на актуальных Android/iOS.
4. **Mobile compatibility.** Обязательны реальные Android/iOS проверки импорта, refresh и удаления маршрута по тому же subscription URL.
5. **Blocking/filtering matrix.** Для closed beta нужны проверки в согласованном наборе мобильных и fixed сетей.
6. **Production deployment.** Platform control plane должен быть вынесен с операторского ноутбука на отдельный production VPS.
7. **Backup/restore drill.** Нужна фактическая проверка восстановления.
8. **Load/capacity evidence.** Нужны реальные нагрузочные данные перед масштабированием.

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

1. вставить ED25519/RSA SHA256 fingerprints польской VPS из provider console в
   gitignored `var/vpn-pl-01/expected-ssh-fingerprints.json`, пройти
   `pnpm vpn-node:verify-ssh-host-keys -- --state-directory vpn-pl-01`, затем
   bootstrap `vpn-pl-1` как `STANDBY`, проверить TLS/clock/node-agent/Xray,
   attach текущий Device, дождаться acknowledgement и promote в `SERVING`;
   только после этого выполнить North Star replacement на том же subscription
   URL (baseline → Netherlands+Poland → drain Amsterdam → Poland remains →
   optional Amsterdam recovery). Без Happ tunnel/IP evidence mobile E2E не
   закрывать;
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
