# Журнал работы над VPN-сервисом

## Document authority

Этот документ является источником истины для истории решений, изменений, findings и рисков.

Этот документ не является текущим ТЗ и не переопределяет:

- продукт — `vpn-service-tz.md`;
- реализацию — `vpn-application-implementation-tz.md`;
- инфраструктуру — `vpn-technical-spec.md`;
- процесс работы агента — `AGENTS.md`.

Если решение принято, его актуальная формулировка должна находиться в соответствующем authoritative document. Запись только в журнале без переноса в спецификацию — документационная несогласованность.

Как читать: смотри статус записи (`решено` / `изменено` / `отменено` / `риск` / `в работе`). Более новая датированная запись с статусом `изменено` или `отменено` имеет приоритет над более старой формулировкой того же вопроса. Текущие требования брать из трёх спецификаций, не из текста старых записей.

### 2026-08-18 — Bootstrap vpn-fi-01: production adapter xray и harness

**Статус:** решено (код bootstrap; факт деплоя и consumer-туннель — оператор)

Добавлен production data-plane adapter `NODE_AGENT_MODE=xray`: разрешён только при `NODE_ENV=production`, запрещён вне production; dev-режимы `simulation`/`local-xray` по-прежнему запрещены в production. Adapter переиспользует snapshot apply/local durability из local-xray, template `infra/xray-production/config.template.json`, reload через обязательный `NODE_AGENT_XRAY_RELOAD_COMMAND` после изменения runtime-конфига.

Bootstrap harness `pnpm vpn-fi:bootstrap` регистрирует ноду `vpn-fi-1`, endpoint/profile/public config, grant и route на устройство из local harness (`var/xray-local/harness.json`), ротирует agent credential, пишет `var/vpn-fi-01/agent.env` и `bootstrap.json` (gitignored). Требует env: `VPN_FI_ENDPOINT_HOST`, `VPN_FI_TLS_SERVER_NAME`, `VPN_FI_NODE_AGENT_API_BASE_URL` (HTTPS, reachable с VPS). IP, ключи, tokens и subscription URL в Git/чат не попадают.

Infra: `infra/docker-compose.vpn-node.yml` (Xray на `:443`), `infra/vpn-node/README.md`, `pnpm vpn-node:prepare|up|down|restart`. UFW VPN-порт открывает оператор при inbound. Control plane на VPS не ставится. iOS/HTTPS subscription origin, платежи и доказанный 5‑минутный SLA отзыва на боевой ноде этим не закрыты.

**Обновлены документы:** `vpn-service-tz.md`, `vpn-application-implementation-tz.md`, `vpn-technical-spec.md`, `.env.example`, `README.md`, этот журнал.

### 2026-08-18 — OS-заготовка vpn-fi-01, без Xray

**Статус:** решено (оператор; заготовка ОС, не нода платформы)

Оператор арендовал тестовую VPS в Финляндии (AdminVPS, Ubuntu 24.04, hostname `vpn-fi-01`): отдельный sudo-пользователь, SSH только по ключу, root и пароль SSH выключены, UFW (входящий deny, исходящий allow, 22/tcp), Fail2ban sshd, UTC/NTP, unattended-upgrades, сеть Netplan после конфликта с ifupdown. Снаружи слушает SSH. Ресурсы тестового тарифа: 1 vCPU, ~2 GB RAM, 15 GB диск.

Намеренно не ставились: Xray/VLESS, production node-agent, регистрация в VPNPlatform, пользовательский VPN-порт. Control plane на эту машину не ставился. Runtime Xray руками не правился.

Это не consumer-туннель и не production adapter. Следующий этап — проектирование bootstrap/интеграции ноды в платформу, не ручная установка Xray. IP, ключи и конфиги SSH в Git и чат не попадают. При появлении inbound UFW нужно будет открыть VPN-порт отдельно; сейчас открывать его незачем.

**Обновлены документы:** `vpn-service-tz.md` (этап 1 / «что делать прямо сейчас»), `vpn-application-implementation-tz.md` (раздел 8), `vpn-technical-spec.md` (§3), этот журнал.

### 2026-08-16 — Документация после ревью control plane

**Статус:** решено (только документы; код не менялся)

Инвентаризация 2026-08-16 и последующее ревью (ТЗ / код / факт оператора) подтвердили: localhost Windows этап 1 закрыт; кабинет control-plane начат без оплаты; iOS/HTTPS, VPS и эквайринг не закрыты.

Ревью не закрывало неоднозначности догадкой. Открытые риски без смены кода: CSRF в ТЗ vs `SameSite=Strict` + точный `Origin`; `SUBSCRIPTION_FEED_BASE_URL` в production допускает `http:`; production issuer challenge не подключён; worker/node-agent без Pino redact; отзыв/expiry не доказаны 5‑минутным SLA на боевой ноде.

Следующий код не начинать, пока владелец не выберет **либо** HTTPS/публичный origin, **либо** боевую VPS — не оба и не платежи.

**Обновлены документы:** `vpn-service-tz.md` (этап 1–2 / «что делать прямо сейчас»), `vpn-application-implementation-tz.md` (разделы 4 и 8), этот журнал (блок совместимости).

### 2026-08-15 — Ручная проверка Happ: сессия Local B на Windows, не consumer VPN

**Статус:** решено (оператор, Windows Happ 3.1; сессия к ноде, не системный VPN)

Оператор подключился к `Local B` по уже импортированному URL. В карточке видны VLESS / TLS / TCP; по нажатию Happ показывает скорость соединения. Это проверка сессии к localhost Xray (`127.0.0.1:10444`), не выдача нового URL.

Системный VPN (весь трафик устройства как через удалённую ноду) на этом контуре не работает и не ожидается: outbound localhost Xray — `freedom` с того же ПК, это не боевая VPS. Скорость в Happ не равна «трафик пользователя идёт через удалённый data plane».

Не закрыто: iOS/HTTPS; боевые VPS и production adapter; проверка consumer-туннеля с удалённой ноды.

**Обновлены документы:** `vpn-service-tz.md` (этап 1 / «что делать прямо сейчас»), `vpn-application-implementation-tz.md` (раздел 8), `vpn-technical-spec.md` (§6), `infra/xray-local/README.md`, этот журнал.

### 2026-08-15 — Localhost VPN через Happ: контур Local B, TLS, ожидание факта оператора

**Статус:** изменено (факт оператора — следующая запись)

Цель этапа: Happ 3.1 на этом Windows ПК подключается к `Local B` (`127.0.0.1:10444`) по уже импортированному URL и даёт рабочий туннель. URL не меняется. Нода A остаётся `DISABLED`.

Проверен контур без печати секретов:

- API `127.0.0.1:3001` live 200; node-agent `local-b` в `local-xray`, циклы `synchronized`.
- Рабочий файл URL — `var/xray-local/subscription.url` (не `apps/var/...`). Длина 69, путь `/sub/` + 43 символа, URL не менялся.
- GET рабочего URL → 200 `text/plain`, одна `vless://`, `displayName` Local B, `127.0.0.1:10444`, SNI `localhost`, `security=tls`, `type=tcp`, **без** `allowInsecure`.
- Неверный token → HTTP 401.
- Нода A в feed отсутствует.

Finding: `xray-a` и `xray-b` были в restart-loop, `:10444` не слушал. Лог без секретов: `open /etc/xray/tls/cert.pem: permission denied`. Init ставил `chmod 600`, официальный образ Xray работает как UID 65532. Исправлено в `infra/docker-compose.xray-local.yml`: после наличия файлов `chmod 644` (localhost self-signed volume, не production). После recreate init и restart: `xray-b` Up, `:10444` Listen, «Xray 25.6.8 started». UUID, grant и inbound не менялись.

TLS-политика этого localhost-прототипа (не production-подписка):

- Production-renderer по-прежнему не выпускает `allowInsecure` и не должен этого делать.
- Если Happ не принимает самоподписанный сертификат — оператор явно разрешает недоверенный сертификат **в Happ только для localhost-профиля**.
- Local-only флаг feed (default `false`, запрещён при `NODE_ENV=production`) не добавлялся: нет факта, что UI Happ не даёт такого разрешения. Неоднозначность не разрешалась догадкой.

Чеклист Connect / критерий успеха / TLS: `infra/xray-local/README.md`. Агент не закрывает Happ. Этап не закрыт, пока оператор не напишет: Happ на Windows подключился к Local B, трафик идёт через локальный Xray, URL тот же.

Проверки этапа: lint, typecheck, unit API 111 / worker 21 / node-agent 18, integration API 37 / worker 9, build, `prisma validate`. `git diff --check` чистый. Миграции `20260815130000`–`20260815141000` не менялись. Renderer/feed URI не менялись — новых тестов контракта не требовалось. Первый прогон API integration дал 4×403 на cabinet devices из-за `CABINET_ORIGIN` в local `.env`; повтор с тестовым origin `https://app.example.test` (без правки `.env` и без рестарта live API) прошёл.

**Обновлены документы:** `vpn-service-tz.md` (этап 1 / «что делать прямо сейчас»), `vpn-application-implementation-tz.md` (раздел 8), `vpn-technical-spec.md` (§6), `infra/xray-local/README.md`, `infra/docker-compose.xray-local.yml`, этот журнал.

### 2026-08-15 — Ручная проверка Happ: disable Local A без нового URL

**Статус:** решено (оператор, Windows Happ 3.1.0, localhost)

После `pnpm xray:local:harness disable a` feed на том же token вернул одну URI `Local B`. Оператор обновил подписку в Happ без повторного импорта URL: `Local A` исчезла, `Local B` осталась. Это обычный `disabled`, не quarantine; live grants не отзывались.

Не закрыто этим прогоном: фактическое VPN-соединение через Local B; iOS/HTTPS; боевые VPS.

**Обновлены документы:** `vpn-service-tz.md` (этап 1 / «что делать прямо сейчас»), `vpn-application-implementation-tz.md` (раздел 8), `infra/xray-local/README.md`, этот журнал.

### 2026-08-15 — Ручная проверка Happ: Local A и Local B на Windows

**Статус:** изменено (импорт закрыт; disable закрыт следующей записью)

Оператор импортировал device-specific URL из `var/xray-local/subscription.url` в Happ 3.1.0 на Windows при поднятом API и двух localhost Xray. В списке видны `Local A` и `Local B`. Это живой feed harness, не origin `http://127.0.0.1:3001` без token и не test fixture.

Сопутствующие findings:

- Неверный или устаревший token даёт HTTP 401; Happ/Qt показывает «узел запрашивает аутентификацию». Логин/пароль вводить не нужно.
- Happ может сохранить старую подписку по хосту `127.0.0.1` и продолжить ходить со старым путём. Нужно удалить все такие записи и импортировать URL заново, не «обновить» прежнюю.
- Артефакт неверного пути harness `apps/var/xray-local/subscription.url` содержит отозванный token и тоже даёт 401. Рабочий файл — `var/xray-local/subscription.url` в корне репозитория.

Не закрыто на момент этой записи: `disable` одной ноды (закрыто следующей записью); iOS (HTTP по-прежнему отклоняется); фактическое VPN-соединение через Local A/B.

**Обновлены документы:** `vpn-service-tz.md` (этап 1 / «что делать прямо сейчас»), `vpn-application-implementation-tz.md` (раздел 8), `infra/xray-local/README.md`, этот журнал.

### 2026-08-15 — Ручная проверка Happ: HTTP на iOS и отказ соединения на ПК

**Статус:** изменено (частично снято live-прогоном на Windows; iOS HTTP остаётся риском)

Оператор импортировал `http://127.0.0.1:3001` (базовый origin без device token, без поднятого live feed).

- **iOS Happ:** сообщение «небезопасная схема http запрещена». Подписка сохраняется как `127.0.0.1`, список конфигураций пустой. iOS Happ не скачивает HTTP subscription URL, в том числе loopback.
- **Happ на ПК:** та же ссылка добавляется как `127.0.0.1`, всплывает «соединение отклонено». Это TCP refuse: на `127.0.0.1:3001` никто не слушал (API не был запущен) либо Happ стучится не туда. Это не две VLESS-конфигурации из harness.
- Сценарий «две ноды → disable одной → обновление без нового URL» этим прогоном не закрыт.

**Следствие:** production и iOS-проверка требуют HTTPS subscription URL. HTTP на localhost остаётся разрешением API вне production, не разрешением Happ на iOS. Формат Happ не менялся.

**Обновлены документы:** `vpn-application-implementation-tz.md` (раздел 8), `vpn-service-tz.md` (этап 1), `infra/xray-local/README.md`, этот журнал.

### 2026-08-15 — Локальный прототип двух заменяемых нод для Happ

**Статус:** решено (локальный, не production)

- Добавлен второй localhost Xray-инстанс: отдельные порт, runtime-конфиг и node-agent state (`infra/docker-compose.xray-local.yml`, `var/xray-local/{a,b}/`). Оба режима node-agent по-прежнему запрещены при `NODE_ENV=production`. Секреты, UUID и runtime-конфиг не коммитятся.
- Local-only harness `pnpm xray:local:harness` вызывает внутренние методы orchestration (не публичный admin API): две HEALTHY ноды, endpoint/profile/public config, `publishConnectionRoute`, устройство с активной подпиской, `scheduleNodeAccessGrant` на обе ноды, claim/complete для pull/apply/ack. Feature gate feed включается явно в local `.env`; default остаётся `false`.
- Обычный `disableNode` исключает ноду из subscription feed и не отзывает live grants. `quarantined` этим не подменяется. Правила disabled/quarantined и миграции `20260815130000`–`20260815141000` не менялись.
- Автотест: два applied маршрута в одном token feed; после disable той же token возвращает один URI; quarantine после disable отзывает grant, disable сам — нет.
- Runbook и чеклист Happ: `infra/xray-local/README.md`. Проверка Happ на устройстве этим этапом не закрывается; её фиксирует пользователь в журнале.
- Проверки этапа: lint, typecheck, unit (API 110), integration API 37 / worker 9, build, `prisma validate`. `git diff --check` чистый. Миграции `20260815130000`–`20260815141000` не менялись.

**Не закрыто этим этапом:** боевые VPS и production Xray adapter; эквайринг; admin HTTP нод; unquarantine; probes.

**Обновлены документы:** `vpn-service-tz.md` (этап 1 / «что делать прямо сейчас»), `vpn-application-implementation-tz.md` (раздел 8), `vpn-technical-spec.md` (§6–7), этот журнал.

### 2026-08-15 — Emergency quarantine / revoke-all

**Статус:** решено

- В `NodeStatus` добавлен `QUARANTINED`. Это lifecycle ноды, не availability-`QUARANTINED` endpoint/profile.
- `quarantineNode` — идемпотентная control-plane операция: исключает ноду из выдачи, отзывает все живые grants, при наличии grants ставит один sync job на полный snapshot без доступа. Обычные assignment jobs на quarantined не ставятся.
- Pull/ack/heartbeat принимают `quarantined`, чтобы доставить emergency snapshot. PostgreSQL запрещает вход в `QUARANTINED` при живых grants и появление live grants на уже quarantined-ноде.
- Admin HTTP, отдельный unquarantine use case и остановка Xray-процесса (сверх пустого access list) в этот этап не входили.
- Миграция `20260815141000_add_node_quarantine_emergency_stop` forward-only.
- Проверки этапа: lint, typecheck, unit, integration API 36 / worker 9, build, `prisma validate`. `git diff --check` чистый.

**Обновлены документы:** `vpn-application-implementation-tz.md` (раздел 8), `vpn-technical-spec.md` (§7), этот журнал.

### 2026-08-15 — Access-control sync для draining и disabled

**Статус:** решено

- Pull/ack/heartbeat принимают credential нод со статусом `HEALTHY`, `DRAINING` или `DISABLED`. `PROVISIONING` и `DELETED` по-прежнему получают общий `401`.
- Новая выдача (`scheduleNodeAccessGrant`) и subscription feed остаются только для `HEALTHY`. Обычный disable не отзывает уже выданный VPN.
- `revokeDeviceAccess` ставит sync job на ноды в access-control sync. На `deleted` grant отзывается в control plane без job.
- PostgreSQL запрещает переход в `HEALTHY`, пока `desiredConfigVersion > appliedConfigVersion`. Миграция `20260815140000_allow_disabled_access_control_sync` forward-only; прежние миграции не менялись.
- Emergency `quarantined` / revoke-all и смена Node enum не входили в этот этап.
- Проверки этапа: lint, typecheck, unit (107 API), integration API 35 / worker 9, build, `prisma validate`. `git diff --check` чистый.

**Обновлены документы:** `vpn-application-implementation-tz.md` (раздел 8), `vpn-technical-spec.md` (§7), этот журнал.

### 2026-08-15 — Локальный Xray/VLESS adapter для node-agent

**Статус:** решено (локальный, не production)

- `NODE_AGENT_MODE` допускает `simulation` (default) и `local-xray`. Оба режима запрещены при `NODE_ENV=production`: это не боевой data-plane adapter.
- `local-xray` принимает тот же `NodeAgentConfigurationSnapshot`, что simulation. Активные grants с credential и неистёкшим `expires_at` материализуются в VLESS inbound; revoked и expired остаются без доступа. Идемпотентный replay той же desired version возвращает `already-applied` без ложного collision и без смены subscription URL.
- Ошибка или частичный apply не вызывает acknowledgement: durability barrier (state-file) выполняется только после успешного apply на Xray runtime.
- Runtime-конфиг, UUID и credentials не коммитятся. В Git — non-secret template `infra/xray-local/config.template.json`. Опциональный localhost Compose `infra/docker-compose.xray-local.yml` отделён от API/Postgres и не является боевой нодой на Platform VPS.
- Simulation adapter, его тесты и HTTP pull/ack цикл не менялись. CI доказывает apply/revoke/expiry через in-memory/file double, без живого Happ и без облачной VPS.

**Не закрыто этим этапом:** покупка/настройка боевых VPS; Happ e2e на устройствах; расширение pull/ack с healthy-only на доступные `disabled`; emergency `quarantined` / revoke-all и смена Node enum.

**Обновлены документы:** `vpn-application-implementation-tz.md` (раздел 8), `vpn-technical-spec.md` (§6–7), этот журнал.

### 2026-08-15 — Disabled остаётся в access-control sync

**Статус:** решено

- Обычная `disabled`-нода запрещает новую выдачу/assignment, но пока node agent доступен продолжает получать security-critical access updates: revoke, уменьшение/истечение `expires_at`, credential revocation. Ранее выданные credentials могут продолжать работать, поэтому нода не выводится из синхронизации доступа.
- SLA ≤5 минут действует для `healthy`, `draining` и доступных `disabled`-нод, если они ещё способны принимать существующие VPN-подключения.
- Недоступная нода копит pending updates; возврат в serving state (`healthy`) запрещён, пока они не reconciled.
- `quarantined` по-прежнему отдельное emergency-состояние: исключение из выдачи + принудительное прекращение VPN-serving / revoke-all.
- `deleted` в синхронизации доступа не участвует.
- Код, enum Node, pull/ack (сейчас только healthy) и постановка sync job в этом этапе не менялись. Это требование к следующему этапу реализации, не текущее поведение API.

**Обновлены документы:** `vpn-service-tz.md`, `vpn-technical-spec.md`, `vpn-application-implementation-tz.md`, этот журнал.

### 2026-08-15 — Disable не отзывает VPN; emergency quarantine — отзывает

**Статус:** решено (продуктовое правило доступа)

- Обычный `disabled` полностью исключает ноду из дальнейшей выдачи subscription API и **не** отзывает автоматически уже выданный VPN-доступ на data plane. Это подтверждает прежнее поведение feed fail-closed без retraction snapshot.
- `draining` — мягкий вывод: новая выдача останавливается, существующий VPN на ноде не обрывается немедленно.
- Аварийные случаи требуют отдельной операции/состояния `quarantined` (emergency disable): исключение из выдачи **и** принудительное прекращение существующего VPN-доступа на ноде. Обычный disable этим не подменяется.
- Availability-состояние `QUARANTINED` у endpoint/profile (диагностика, без уничтожения VPS) **не** является этой аварийной операцией. Имена совпадают на разных слоях; смешивать их нельзя.
- Код, enum Node и admin API в этом этапе не менялись. Реализация emergency disable — отдельный этап после появления реального data plane apply.

**Оставшаяся неоднозначность:** закрыта предыдущей записью — disabled остаётся в access-control sync.

**Обновлены документы:** `vpn-service-tz.md` (замена ноды), `vpn-technical-spec.md` (lifecycle ноды и отличие availability quarantine), `vpn-application-implementation-tz.md` (раздел 8), этот журнал.

### 2026-08-15 — Terminal close route sync после fail-closed

**Статус:** решено (P2 закрыт)

- После fail-closed matching `activationVersion` отсутствует, а `lastActivationVersion` сохраняется. Worker больше не считает это временной недоступностью: `PrismaNodeSyncStore.claim` переводит не-terminal route job в `FAILED` с кодом `ROUTE_ACTIVATION_CLOSED` без lease и без роста `attempts`. `process()` завершается как `terminal`, повторный claim той же команды тоже terminal.
- Job без когда-либо назначенной activation (`lastActivationVersion < targetVersion`) по-прежнему `null` / retryable. Production `publishConnectionRoute` назначает activation до claim, поэтому ложный `FAILED` возможен только для ручного DML.
- Идемпотентный повтор тех же keys не создаёт новую version/job/outbox и не поднимает activation. Новый rollout требует новой пары keys и version выше `lastActivationVersion` и `appliedConfigVersion`; feed закрыт до ack.
- Живой PENDING grant на той же ноде остаётся claimable. Отсутствие grant по-прежнему mismatch/terminal только если resource не совпал.
- Миграция не требовалась: terminal close выражен в worker. `VALIDATE CONSTRAINT "NodeSyncJob_exactly_one_sync_resource"` остаётся deploy checklist предыдущего rollout-этапа, на этом этапе не выполнялся.
- Контракт кода ошибки перенесён в `vpn-application-implementation-tz.md`, раздел 7.

**Оставшийся риск реализации (не закрыт кодом):** обычный disable по-прежнему не снимает уже доставленный route с data plane — это теперь продуктовое правило. Принудительное прекращение serving реализовано как `quarantined` / emergency disable.

### 2026-08-15 — Нормализация документации

**Статус:** решено

- Зафиксирована иерархия документов: product / application / infrastructure / process. `AGENTS.md` сжат до операционных инструкций и политики разрешения конфликтов.
- Актуальные формулировки auth (`SameSite=Strict`, pre-launch `AuthChallenge`, запрет публичного challenge), transactional outbox (PostgreSQL-транзакция без Redis; BullMQ после commit) и хранения node configuration (IaC/templates в Git, секреты вне Git) перенесены в owner-документы.
- Журнал оставлен историей: устаревшие пробелы и «следующий практический этап» помечены, незакоммиченные записи реализации от 2026-08-15 сохранены.

**Что заменило:** ситуацию, когда журнал, `AGENTS.md` и три ТЗ одновременно выглядели текущими спецификациями с повторами и расхождениями.

**Обновлены документы:** `AGENTS.md`, `vpn-service-tz.md`, `vpn-application-implementation-tz.md`, `vpn-technical-spec.md`, этот журнал.

**Оставшиеся риски:** прежние blockers эквайринга, права, провайдеров и production data plane не закрывались этим этапом.

### 2026-08-15 — Доставляемая активация subscription routes

**Статус:** устранены два оставшихся P1 finding по rollout route.

- `EndpointConnectionProfile.activationVersion` назначается только единым
  production use case после блокировок Node → Endpoint → ConnectionProfile →
  public config → mapping. Операция одной транзакцией активирует material,
  повышает desired version, связывает route-specific `NodeSyncJob`, создаёт
  transactional outbox и audit event. Повтор с теми же idempotency keys
  возвращает исходную операцию без новой версии.
- Прямой INSERT mapping, `DRAFT`/`DISABLED → ACTIVE` и поздний INSERT public
  config оставляют activation закрытой. Переход из ACTIVE в неактивное
  состояние немедленно сбрасывает activation fail-closed; повторное включение
  требует нового rollout. Любая смена статуса Node также сбрасывает activation,
  поэтому `DRAINING`/`DISABLED → HEALTHY` не восстанавливает старый route.
  PostgreSQL разрешает назначить activation только для HEALTHY Node, активного
  material и matching route sync job.
- Контракт `node-sync.requested` поддерживает grant и route commands, worker
  проверяет точную route binding. Node-agent snapshot содержит
  activationVersion и точные endpoint/profile/VLESS public-config данные.
- GET snapshot создаёт immutable delivery proof с SHA-256 hash. Acknowledgement
  передаёт этот hash и принимается только для фактически выданного snapshot и
  успешно завершённой matching job; одна только `SUCCEEDED` job больше не
  позволяет продвинуть `Node.appliedConfigVersion`.
- Feed выдаёт mapping только при `activationVersion <= appliedConfigVersion`.
  Подтверждённый route остаётся доступным во время независимого pending rollout,
  а неподтверждённый route не открывается acknowledgement более ранней grant
  version.
- Добавлены forward-only миграции
  `20260815130000_deliver_route_activations` и
  `20260815131000_align_route_delivery_constraints`, затем hardening
  `20260815132000_close_unbacked_route_activations` и
  `20260815133000_require_route_activation_outbox`, а история монотонной
  активации сохраняется миграцией
  `20260815134000_preserve_route_activation_history`. Миграция
  `20260815135000_require_unapplied_route_activation` требует, чтобы новая
  activation была выше текущей applied version ноды. Миграция
  `20260815136000_bind_route_activation_before_delivery` требует точного
  четырёхполевого outbox command и запрещает activation после delivery той же
  версии. `20260815137000_serialize_route_activation_delivery` сериализует
  activation с snapshot/acknowledgement через lock Node и учитывает любую
  delivery той же node/version; worker не claim-ит route job до matching
  activation. Существующие миграции не изменялись. Все legacy activation без
  route-specific job и точного outbox command переводятся в `NULL` fail-closed
  без ложного backfill.
  `lastActivationVersion` не сбрасывается при отключении, поэтому прежнюю
  acknowledged или pending version нельзя восстановить после fail-closed.
  PostgreSQL отклоняет новую activation без job и outbox. Idempotent retry
  дополнительно сверяет полный outbox payload с job, route и target version.

### 2026-08-15 — Закрытие findings subscription feed

**Статус:** устранены пять подтверждённых findings независимого ревью.

- Каждый endpoint/profile mapping получает назначенную PostgreSQL
  `introducedAtConfigVersion`; feed выдаёт его только после acknowledgement этой
  версии нодой. Legacy mappings остаются `NULL` без backfill и fail-closed,
  подтверждённый v1 сохраняется во время независимого pending rollout v2.
- Публикация mapping сериализуется row lock ноды и connection material.
  Опубликованные host/address kind/port/node binding и значимые поля versioned
  profile неизменяемы; delete/reinsert mapping создаёт новую rollout version.
  Disabled status по-прежнему исключает маршрут немедленно.
- VLESS/TCP/TLS public config запрещено обновлять и удалять. Parent profile и
  child insert сериализуются блокировкой строки profile; новый SNI создаётся
  только в новой версии `ConnectionProfile`.
- Selection выполняет детерминированный SQL `LIMIT max + 1` и отклоняет overflow
  до credential derivation/rendering и URI dedup. Размер UTF-8 body считается
  инкрементально; URI не обрезаются, публичная ошибка остаётся общей.
- PostgreSQL и runtime используют один validation domain: display name допускает
  обычные пробелы и Unicode, но не control characters; TLS server name — только
  ASCII hostname длиной до 253 с labels 1..63. Общая table-driven matrix
  проверяет обе границы.
- API Redis keys получают централизованный namespace. Integration harness
  передаёт случайный namespace дочернему Vitest, очищает только его в `finally`
  после успешного и намеренно падающего suite и проверяет сохранность foreign
  key.
- Добавлены forward-only миграции
  `20260815120000_add_route_rollout_versions`,
  `20260815121000_make_connection_material_immutable` и
  `20260815122000_align_vless_public_validation`; прежние миграции не менялись.

### 2026-08-14 — Безопасный Happ feed VLESS/TCP/TLS

**Статус:** реализовано как третий этап блока.

- Renderer выключен по умолчанию feature gate и выпускает только VLESS/TCP/TLS/HAPP из подтверждённого applied grant. URI — UTF-8 `text/plain`, одна строка на URI, без завершающего newline и без хранения в БД/Redis/audit/outbox.
- Public SNI и display label отделены в типизированную неизменяемую конфигурацию конкретной версии profile; несовместимые/legacy/revoked/expired route fail-closed. IPv6 bracketed, query/fragment encoded; real Xray adapter не добавлялся.

### 2026-08-14 — Per-grant data-plane credential lifecycle

**Статус:** реализовано как второй этап трёхэтапного блока.

- Новый grant получает детерминированный RFC 4122 UUID из domain-separated
  HMAC-SHA-256 (`credential:v1`) над grant, device и node ID; verifier хранится
  отдельно через домен `verifier:v1`. Plaintext никогда не сохраняется в
  PostgreSQL, audit или outbox, а сравнение verifier выполняется constant-time.
- `DATA_PLANE_CREDENTIAL_PEPPER` отделён от subscription-token и node-agent
  pepper. Он обязателен в production, хранится вне Git; его ротация требует
  явного reissue grants, поскольку старый UUID больше не выводим.
- Legacy grants сохраняют NULL derivation version и fail-closed: unsupported,
  revoked или expired записи передаются lifecycle state, но не получают client
  credential. Node bearer credential остаётся отдельным и не сохраняется в
  state; data-plane UUID допустим только внутри защищённого local state ноды.
- Snapshot versioned contract выдаёт UUID только bearer-аутентифицированной
  healthy ноде и только для её проверенного grant. Публичный subscription feed
  намеренно остаётся пустым до третьего этапа renderer-а.

### 2026-08-14 — Endpoint и versioned connection profile selection

**Статус:** реализовано как внутренний protocol-neutral control-plane этап.

- `Endpoint` отделён от физической `Node`: он содержит только публичный host/IP,
  IP family, port, lifecycle и priority. `ConnectionProfile` имеет стабильный
  `profileKey`, отдельную версию, lifecycle/rollout status, compatibility и
  protocol/transport/security kinds без URI, credentials, ключей или transport
  parameters. Явная связующая таблица допускает несколько endpoint-ов и profiles
  на ноде и PostgreSQL composite foreign keys не позволяют связать ресурсы разных
  нод.
- Внутренний selection service принимает и повторно проверяет user/device
  ownership, активность device, подписки и grant, healthy lifecycle ноды, active
  endpoint/profile и время истечения через PostgreSQL `clock_timestamp()`.
  Результат детерминированно упорядочен и содержит только безопасную projection,
  без bearer credentials, token-ов, subscription URL или готового connection URI.
- Локальная диагностика до миграции не обнаружила значений в `Node.endpoint`.
  Поле сохранено как deprecated на один переходный этап, потому что его старый
  свободный формат нельзя автоматически разложить на host, address kind и port
  без потери смысла. Новый selection flow его не читает; тест подтверждает, что
  legacy-only node не может попасть в выдачу.
- Добавлены миграции `20260814100000_add_connection_routes` и
  `20260814101000_fix_endpoint_host_validation` с DB constraints для
  port, priority, version, enum-ов, уникальности активной версии и cross-node
  associations. Subscription feed намеренно остаётся пустым: rendering, VLESS
  URI, Happ-specific output, Xray/VLESS adapter, probes, provisioning и rollout
  automation перенесены на следующие этапы.

### 2026-08-14 — Crash recovery node-sync и надёжность локального state

**Статус:** устранены findings независимого ревью без подключения production data plane.

- BullMQ lock/stalled lifecycle согласован с PostgreSQL lease и общей
  `ORCHESTRATION_MAX_ATTEMPTS`: очередь допускает все разрешённые stalled
  recovery и одну терминальную доставку, но store никогда не выдаёт DB-попытку
  сверх лимита. Независимый периодический reclaimer на часах PostgreSQL
  возвращает истёкшие lease в `PENDING` либо завершает исчерпанную работу как
  `FAILED`, даже если конкретный BullMQ job больше не доставляется.
- Завершение и retry по-прежнему требуют действующие owner/token/lease; старый
  token не может изменить новую попытку. Shutdown сначала останавливает BullMQ
  consumer, затем reclaimer/publisher loops и только после этого отключает
  Prisma. Payload и внутренние тексты исключений не логируются.
- Simulation state теперь хранит `current` и ровно одну подтверждённую
  `previous` версию в едином envelope. Запись выполняется через один
  детерминированный temp-файл, file fsync, atomic rename и directory fsync там,
  где он поддерживается; любая ошибка очищает temp. Потерянный acknowledgement
  после rename восстанавливается идемпотентным повтором, а повреждение,
  downgrade и same-version collision обрабатываются fail-closed.
- Идентичный replay больше не считает одно наличие state-файла доказательством
  durability: перед `already-applied` adapter повторно синхронизирует state-файл
  и родительский каталог. Пока этот barrier не завершился успешно,
  `NodeAgentRunner` не отправляет acknowledgement.
- BullMQ Queue и Worker сразу получают явные `error` listeners. В безопасный
  logger передаются только component, фиксированное имя event и стабильный тип;
  исходные Error/message/stack/URL не сериализуются и не попадают в
  `console.error` через fallback BullMQ.
- Worker integration runner создаёт случайную PostgreSQL-схему, применяет в неё
  все миграции и передаёт дочернему Vitest отдельный Redis namespace. `finally`
  удаляет namespace и всю схему вместе с append-only audit/acknowledgement.
  Guard-сценарии для успешного и намеренно падающего suite проверяют неизменность
  общей схемы и постороннего Redis job.
- Схема БД, OpenAPI и runtime-параметры не менялись. Xray/VLESS adapter, VPS,
  платежи и production deployment остаются вне этого этапа.

### 2026-08-13 — Сквозное доказательство apply/acknowledge

**Статус:** реализовано для локального simulation-контура.

- API integration suite поднимает настоящий HTTP endpoint в одноразовой схеме,
  доводит `NodeSyncJob` до `SUCCEEDED`, запускает общий `NodeAgentRunner` и
  проверяет цепочку heartbeat → configuration pull → state-file apply →
  acknowledgement.
- После подтверждения `Node.appliedConfigVersion` и grant `appliedVersion`
  продвигаются до desired version, создаются append-only acknowledgement/audit,
  а повторный pull возвращается как уже синхронизированный без повторного apply.
- Локальный state не содержит bearer credential. Идемпотентность определяется
  содержимым desired configuration, а не техническим ID sync job: новый
  acknowledgement handle для той же версии не вызывает ложный version collision.
- Вместе с отдельным реальным BullMQ/PostgreSQL integration test это закрывает
  локальную control-plane цепочку от durable queue delivery до подтверждения
  применения. Реальный Xray adapter и доказательство VPN-трафика остаются вне
  этого simulation-этапа.

### 2026-08-13 — Локальный node-agent runner

**Статус:** реализована безопасная simulation-граница, production data plane не подключён.

- В монорепозиторий добавлено отдельное приложение `apps/node-agent`, поскольку
  этот процесс по требованиям работает на VPN VPS рядом с data plane, а не внутри
  control plane. Решение не добавляет сетевой микросервис: agent использует уже
  существующий исходящий HTTPS pull API.
- Snapshot contract и OpenAPI теперь возвращают только точный
  `pendingAcknowledgement` для текущей desired version. Runtime schema запрещает
  лишние поля, version mismatch и acknowledgement уже применённой версии.
- Runner сначала отправляет heartbeat, получает и валидирует snapshot, применяет
  его через adapter boundary и лишь затем отправляет acknowledgement. Ошибка
  adapter не подтверждается; потеря ответа acknowledgement безопасно приводит к
  идемпотентному повтору.
- Единственный текущий adapter — локальная state-file simulation без VPN-ключей и
  управления Xray. Он атомарно сохраняет текущий и предыдущий snapshot, запрещает
  downgrade и version collision. Production-конфигурация с simulation mode
  отклоняется до запуска; credential не попадает в URL, state или логи, а HTTP
  разрешён только для loopback в development/test.
- Схема PostgreSQL и миграции не менялись. Реальные Xray/VLESS credentials,
  transport parameters, VPS provisioning и production adapter остаются отдельным
  будущим этапом.

### 2026-08-13 — Приём node-sync команд из BullMQ

**Статус:** реализовано на уровне локального control plane.

- Worker теперь потребляет `node-sync.requested` из BullMQ, строго валидирует
  runtime contract и повторно связывает команду с точными `NodeSyncJob`,
  `NodeAccessGrant`, target version и актуальным desired state ноды.
- Захват, завершение и retry защищены владельцем и случайным lease token; время
  и границы lease вычисляются PostgreSQL. Истёкшая последняя попытка становится
  `FAILED` без превышения общей `ORCHESTRATION_MAX_ATTEMPTS`, а очередь получает
  достаточно retry для восстановления после потерянного lease.
- `NodeSyncJob.SUCCEEDED` на этом этапе означает, что durable desired-state
  команда принята control plane и доступна существующему pull API node agent.
  Это не доказательство применения VPN-конфигурации: data plane считается
  применённым только после отдельного `NodeConfigAcknowledgement`.
- Реальный node agent, Xray/VLESS adapter, VPS и production deployment не
  добавлялись. Unit-тесты закрепляют строгую валидацию, idempotent replay и
  безопасный retry; интеграционный BullMQ/PostgreSQL-тест проверяет успешный
  lifecycle, mismatch fencing и exhausted lease без лишней попытки.

### 2026-08-13 — Отзыв устройства из кабинета

**Статус:** реализовано на уровне локального control plane.

- Добавлен идемпотентный `POST /cabinet/devices/:deviceId/revoke`: действующая
  cookie-сессия и точный trusted `Origin` обязательны, а чужое или отсутствующее
  устройство возвращает `404` без раскрытия владельца.
- Одна PostgreSQL-транзакция отзывает устройство и все его незавершённые
  `NodeAccessGrant`, использует время БД, повышает `Node.desiredConfigVersion` и
  создаёт по одной `NodeSyncJob`, outbox-команде `node-sync.requested` и
  append-only audit-записи для каждого затронутого grant. Повторный и
  конкурентный отзыв не создаёт дубликатов.
- Выдача нового grant теперь блокирует и повторно проверяет активность устройства,
  поэтому не может завершиться после конкурентного отзыва. Кабинет требует
  отдельного подтверждения действия и обновляет данные только после ответа API.
- Интеграционный тест подтверждает ownership boundary, конкурентную
  идемпотентность и согласованность версий/задач/outbox. Реальные VPN-ноды,
  data-plane adapter и подтверждение применения конфигурации этим этапом не
  добавлялись.
- API integration suite запускается в случайной одноразовой PostgreSQL-схеме:
  перед тестами туда применяются все миграции, а `finally` удаляет схему вместе
  с append-only audit и незавершённой outbox-работой даже при падении suite.
  Два последовательных прогона подтвердили отсутствие оставшихся test-схем и
  загрязнения общей БД.
- UI сохраняет семантику ошибок отзыва: `401` немедленно запускает существующий
  authentication recovery, `404` обновляет overview без optimistic revoke, а
  `403` и временные ошибки остаются явным retryable-состоянием.

### 2026-08-13 — Публикация transactional outbox в BullMQ

**Статус:** решено.

- Worker атомарно захватывает готовое outbox-событие через PostgreSQL
  `FOR UPDATE SKIP LOCKED`, использует lease token и часы БД, валидирует payload
  `node-sync.requested`, затем публикует его в BullMQ с `OutboxEvent.id` как
  идемпотентным job id.
- Успех и retry записываются только владельцем действующего lease. Истёкший lease
  не позволяет старому worker изменить новую попытку; зависшие записи возвращаются
  в `PENDING`, а истёкшая последняя попытка завершается `FAILED` без выдачи
  попытки сверх общей orchestration-политики.
- Payload, произвольный topic и тексты внутренних исключений не попадают в лог.
  Интеграционный store ограничен ID созданных тестом событий и не может захватить
  чужую pending-работу. Автономные worker scripts сначала собирают runtime contracts.
  Реальный consumer
  команд нод, VPN-конфигурации, VPS и production Redis этим этапом не добавлялись.

### 2026-08-13 — Telegram ID остаётся частью retry binding

**Статус:** решено.

- Повторный Telegram login теперь сверяет `User.telegramUserId` владельца связанной
  сессии с ID из заново проверенного подписанного `initData`. Согласованности
  `AuthChallenge.userId` и `UserSession.userId` недостаточно, поскольку составной
  внешний ключ намеренно каскадирует обновление владельца.
- HTTP integration test переносит сессию другому пользователю, подтверждает каскад
  challenge и требует общий `401 Telegram login is invalid` без `Set-Cookie`.
- Схема БД, миграции и публичный API не менялись.

### 2026-08-13 — Единая auth-ошибка и PostgreSQL-часы pre-launch

**Статус:** решено.

- Все криптографические, freshness и context/binding отказы Telegram login
  возвращают одинаковый публичный `401 Telegram login is invalid` без session
  cookie, поэтому endpoint не раскрывает валидность перехваченного proof.
- `AuthChallenge.createdAt`, `expiresAt` и граница bounded cleanup вычисляются
  от PostgreSQL `clock_timestamp()` внутри транзакций. Рассинхронизация часов
  API больше не продлевает bearer secret и не удаляет активный по БД context.
- HTTP table-driven и clock-skew тесты закрепляют оба свойства. Публичный issuer
  и production Telegram flow не добавлялись.

### 2026-08-13 — Доказательство security-инвариантов Telegram auth

**Статус:** реализовано, production issuer остаётся внешней предпосылкой.

- Prisma и PostgreSQL согласованы на составной связи
  `AuthChallenge(sessionId, userId) → UserSession(id, userId)`; новая
  forward-only migration удаляет только избыточный прямой FK к User и заменяет
  одиночный unique index сессии составным, не ослабляя ownership invariant.
- Retry требует совпадения пользователя, Telegram replay hash и хеша
  детерминированного session secret; revoke, expiry и повреждённые binding fields
  дают общий 401 без session cookie. Свежесть Telegram proof повторно проверяется
  по `clock_timestamp()` после ожидания row lock.
- Интеграционные тесты закрепляют Redis limit/TTL и fail-closed поведение,
  bounded cleanup, expiry во время lock wait, CHECK/composite-FK constraints и
  HTTP device race. OpenAPI и Pino покрыты отрицательными проверками секретов.
- Публичный issuer, production Telegram, платежи, реальные VPN-ноды,
  Xray/VLESS и worker processors не добавлялись.

### 2026-08-13 — Защита Telegram pre-launch контекста

**Статус:** реализовано, ожидает внешнего bot-mediated issuer.

- Публичный `POST /auth/challenge` удалён: созданный после получения `initData`
  browser cookie не доказывал исходный Telegram launch и допускал attacker-first replay.
- Вход требует заранее созданную запись `AuthChallenge`: Telegram-подписанный
  `start_param` идентифицирует запись, а отдельный 256-битный секрет остаётся в
  HttpOnly cookie исходного браузера. Без обоих значений API отвечает общим 401
  и не устанавливает session cookie.
- Линеаризация login/retry — `SELECT ... FOR UPDATE` pre-launch записи, затем
  PostgreSQL `clock_timestamp()` и создание/проверка неотозванной сессии в той
  же транзакции. Redis-лимитирование issuer fail-closed; очистка истёкших
  записей ограничена batch и не влияет на login.

### 2026-08-13 — Подсистема устойчивости data plane к сетевой деградации

**Статус:** решено на уровне требований

- Зафиксирован технологически нейтральный принцип: пользователь получает доступ к восстанавливаемому пулу соединений, а не к конкретному протоколу, IP, VPS, ASN, провайдеру или региону.
- Будущая доменная модель разделяет физическую Node, заменяемый Endpoint и версионируемый ConnectionProfile; допускает несколько профилей на одной ноде и замену инфраструктуры без перевыпуска subscription URL.
- Health-модель разделяет heartbeat/VPS, VPN process, DNS, IPv4/IPv6, handshake, выход через туннель и региональные результаты независимых probes.
- Для автоматизации обязательны quarantine, кворум, конфигурируемые thresholds, cooldown/hysteresis, staged rollout/rollback, независимые failure domains и аудируемый Emergency Mode.
- Решение не подключает реальные VPS, Xray/VLESS, production credentials, probes или worker processors и не меняет текущую Prisma-схему/API. Реализация выполняется отдельными согласованными этапами после локального control plane.

**Влияние на ТЗ:** дополнены продуктовые, инфраструктурные и implementation-требования; запрещено закреплять связь «одна нода = один IP = один профиль» до проектирования реального data plane.

### 2026-08-12 — Client-bound Telegram pre-auth и logout

**Статус:** изменено

- Изначально перед Telegram login API публично выдавал одноразовый server-side challenge, связанный
  с отдельной HttpOnly cookie. Пара challenge + подписанный `initData` потреблялась
  в транзакции; тот же браузерный контекст мог безопасно повторить запрос, но
  независимый cookie jar не получал существующую сессию.
- Заменено записью `2026-08-13 — Защита Telegram pre-launch контекста`: публичный `POST /auth/challenge` удалён. Актуальная модель: `vpn-application-implementation-tz.md`, раздел 5.
- Добавлен идемпотентный `POST /auth/logout`: он отзывает текущую `UserSession`
  по хешу cookie и возвращает удаляющую cookie с `Max-Age=0`.
- Добавлены unit и integration-проверки двух независимых cookie jars, retry в
  исходном jar, повторного logout и запрета старой cookie. Миграция
  `20260812160000_add_auth_challenges` добавляет только данные challenge;
  реальные Telegram webhook/polling, платежи, ноды и production-секреты не
  подключались.

### 2026-08-12 — Актуализирована инструкция локального запуска

**Статус:** решено

- README теперь описывает фактический локальный контур: миграции, API, кабинет,
  Redis/PostgreSQL, subscription feed, Happ fixture и полный набор проверок.
- Явно зафиксированы отсутствующие возможности: платежи, production Telegram,
  админ-панель, реальные ноды, Xray/VLESS, worker processors и боевой деплой.
- Добавлены правила локального proxy target и `TRUSTED_PROXY_IPS`, без
  production-секретов и конкретных production-доменов.

### 2026-08-12 — Распределённое ограничение запросов subscription feed

**Статус:** решено

- Ограничение `GET /sub/:token` перенесено из памяти API-процесса в Redis:
  атомарное увеличение счётчика и установка TTL выполняются одним Lua-скриптом.
  Поэтому лимит остаётся единым при нескольких экземплярах API и автоматически
  очищается по окончании фиксированного окна.
- Fastify принимает адрес клиента из заголовков прокси только когда IP прокси
  явно внесён в `TRUSTED_PROXY_IPS`; по умолчанию доверенных прокси нет.
- При недоступности Redis запрос к feed завершается ошибкой, а не обходит
  ограничение. Публичный API, реальные ноды, VLESS/Xray, платежи и worker
  processors не менялись.

### 2026-08-12 — Линейризуемая проверка подписки при выпуске устройства

**Статус:** изменено

- Заменено записью ниже: `CURRENT_TIMESTAMP` фиксируется в начале транзакции
  и может устареть, пока запрос ожидает блокировку.

### 2026-08-12 — Проверка срока после блокировок при выпуске устройства

**Статус:** решено

- После user advisory lock выпуск сначала блокирует все Subscription пользователя
  и связанные Plan через `SELECT … FOR UPDATE`, без predicate срока или статуса.
  Затем отдельный запрос проверяет активный статус и `expiresAt > clock_timestamp()`.
  Устройство и audit event по-прежнему создаются в той же транзакции.
- Конкурентный integration-тест удерживает advisory lock до окончания подписки;
  ожидающий выпуск после разблокировки получает `409` и не создаёт Device.
- Публичный API, миграции, тарифы, реальные ноды, VLESS/Xray, платежи и worker
  processors не менялись.

### 2026-08-12 — Защита от replay входа и сетевого повтора выпуска устройства

**Статус:** решено

- Каждый валидный Telegram Web App payload получает HMAC-отпечаток его
  канонической подписанной части. PostgreSQL уникально связывает его с одной
  server-side сессией; повторный payload возвращает ту же сессию и не создаёт
  новые записи.
- `POST /cabinet/devices` теперь требует UUID `idempotency-key`. Для одного
  пользователя повтор с тем же ключом возвращает то же устройство и тот же
  subscription URL; ключ и URL не хранятся в plaintext.
- Token устройства воспроизводится сервером только из отдельного
  domain-separated HMAC, а в БД остаются исключительно HMAC-отпечатки token и
  idempotency key. HTTP-логи редактируют сам заголовок ключа.
- P2-ограничения lifecycle-блокировок подписки и rate limiting subscription
  feed вынесены в следующий отдельный этап; реальные ноды, VLESS/Xray,
  платежи и worker processors не добавлялись.

### 2026-08-12 — Выпуск устройства из кабинета

**Статус:** решено

- В кабинете появилась форма добавления устройства. Она показывает доступное место по тарифу, но окончательную проверку активной подписки и лимита по-прежнему выполняет API внутри транзакции.
- Полный subscription URL появляется только после явного действия пользователя, держится только в памяти текущей страницы и может быть скопирован одной кнопкой. После закрытия карточки URL не остаётся в кабинете, URL страницы, localStorage или логах браузера.
- Web-клиент обращается только к same-origin маршруту `/api/cabinet/devices`, строго проверяет ответ общим контрактом и не доверяет непредусмотренным полям ответа.
- Реальные VPN-ноды, VLESS/Xray-конфигурации, платежи и worker processors этим этапом не добавлялись.

### 2026-08-12 — Безопасный выпуск устройства

**Статус:** решено

- Выпуск устройства требует действующую сессию, точное совпадение `Origin` кабинета, активную неистёкшую подписку и свободное место в лимите её тарифа.
- Операция сериализуется PostgreSQL advisory lock по пользователю; создаёт устройство, HMAC-хеш нового случайного token и append-only audit event одной транзакцией.
- Полный subscription URL строится сервером по конфигурации и возвращается только в ответе явного создания. Он не записывается в БД, audit metadata или логи.

### 2026-08-12 — Device-specific subscription endpoint

**Статус:** решено

- Добавлен `GET /sub/:opaque-token`: он rate-limited по IP, не кешируется и разрешает ответ только после серверной проверки токена, активного устройства и неистёкшей подписки.
- Для действительного устройства endpoint пока возвращает пустой UTF-8 список: VPN-конфигурации, endpoint-ы нод и user data намеренно не выдаются до отдельного этапа data plane.
- Недействительные, отозванные и истёкшие токены получают общий `401`, не раскрывающий причину. Полный URL маскируется в HTTP-логах.

### 2026-08-12 — Серверная проверка токена устройства

**Статус:** решено

- Добавлен внутренний сервис, который разрешает доступ только по корректному opaque token, хешированному HMAC-SHA-256 с отдельным pepper, активному устройству и неистёкшей `ACTIVE`-подписке.
- Некорректный токен не запрашивает БД и во всех запрещённых случаях возвращает только отсутствие доступа, без oracle о причине отказа.
- `SUBSCRIPTION_TOKEN_PEPPER` обязателен в production. Публичный subscription endpoint, выпуск токенов, VPN-конфигурации и ноды этим пакетом не добавляются.

### 2026-08-12 — Постоянный маршрут кабинета

**Статус:** решено

- Кабинет доступен по маршруту `/cabinet`, который будет использовать кнопка Telegram-бота. Текущий корневой экран сохранён для локальной совместимости и ведёт к тому же безопасному интерфейсу.
- Маршрут не добавляет источников данных, авторизации, VPN-конфигураций или действий с устройствами.

### 2026-08-12 — Вход веб-кабинета из Telegram Web App

**Статус:** решено

- Экран кабинета сначала использует существующую серверную сессию; только при её отсутствии он читает подписанные `initData` из Telegram Web App и передаёт их через same-origin API в `POST /auth/telegram`.
- Данные Telegram не сохраняются в `localStorage`, cookie, URL, интерфейсе или логах браузера. Клиент не извлекает Telegram ID и не принимает решение о входе: подпись и срок жизни по-прежнему проверяет API.
- Добавлены тесты отсутствующего Telegram-контекста, корректной передачи initData, строгой схемы сессии и отклонённого входа. Защита от повторного запуска эффекта исключает двойную попытку входа в React Strict Mode.
- Реальный Telegram-бот, bot token, polling/webhook, платежи и VPN-ноды в этот этап не добавлялись.

### 2026-08-12 — Первый экран веб-кабинета

**Статус:** решено

- Веб-приложение получает сводку только через same-origin маршрут `/api/cabinet/overview`; cookie сессии остаётся `HttpOnly` и недоступна JavaScript-коду страницы.
- Ответ API проверяется строгой схемой contracts до отображения. Экран показывает только безопасные поля подписки и устройств и отдельно обрабатывает состояния загрузки, отсутствующей сессии и временной недоступности API.
- Добавлены тесты клиента API для успешного ответа, `401` и недопустимого чувствительного поля в ответе; локальная проверка в браузере подтвердила корректное сообщение для пользователя без сессии.
- Управление устройствами, платежи, production Telegram-бот, реальные VPN-ноды и VLESS/Xray в этот этап не добавлялись.

### 2026-08-12 — Read-only сводка кабинета пользователя

**Статус:** решено

- Добавлен `GET /cabinet/overview`: он работает только по действующей серверной сессии и возвращает текущую или наиболее актуальную подписку, название тарифа, лимит устройств и список устройств владельца.
- Ответ намеренно не содержит полных subscription URL, VPN-ключей, credential/token-хешей, Telegram ID или данных других пользователей.
- Интеграционный тест создаёт двух пользователей и две сессии и подтверждает, что сессия первого не получает устройство второго и не раскрывает его собственный token hash.
- Этап только читает данные: выпуск, отзыв или переименование устройств, платежи, реальный Telegram-бот и VPN-ноды не подключались.

### 2026-08-11 — Основа безопасной сессии кабинета

**Статус:** решено

- Добавлена миграция `UserSession`: база хранит только HMAC-отпечаток непрозрачного 256-битного секрета сессии, срок действия и отзыв; сам секрет не попадает в БД, JSON-ответы или журналы.
- `POST /auth/telegram` принимает только подписанный Telegram Web App `initData`, проверяет подпись и срок действия на сервере и устанавливает `HttpOnly`, `SameSite=Strict` cookie. `GET /auth/me` возвращает только безопасные данные текущей сессии. Актуальная cookie-политика: `vpn-application-implementation-tz.md`, раздел 5. Pre-launch binding позже ужесточён записями 2026-08-13.
- В production обязательны `TELEGRAM_WEB_APP_BOT_TOKEN` и `AUTH_SESSION_PEPPER`; без них вход намеренно недоступен. Реальный Telegram-бот, polling/webhook, VPN-ноды, платежи и production-секреты не подключались.
- Контракты, OpenAPI и тесты покрывают валидный вход, поддельные данные, отсутствие конфигурации, отсутствие утечки секрета и безопасные атрибуты cookie.

## Правила ведения

- Запись добавляется после каждого принятого решения, изменения требований, выполненного этапа или обнаруженного риска.
- Старые решения не стираются: им присваивается статус `решено`, `изменено` или `отменено`, а ниже указывается причина и ссылка на новую запись.
- В каждом изменении ТЗ фиксируются: что изменилось, почему, на какие части системы влияет и требуется ли миграция.
- Актуальная формулировка переносится в owner-документ. Этот журнал — источник истории, не альтернативное текущее ТЗ.
- Активные спецификации: `vpn-service-tz.md` (продукт), `vpn-application-implementation-tz.md` (код), `vpn-technical-spec.md` (инфраструктура), `AGENTS.md` (процесс агента).

## Статусы

- `решено` — договорились и внесли в актуальное ТЗ;
- `в работе` — реализуется или исследуется;
- `риск` — требует проверки до следующего этапа;
- `изменено` — решение заменено более новым;
- `отменено` — не делаем.

## Решения и история

### 2026-08-10 — Lease для persistent-очередей

**Статус:** изменено

- У `NodeSyncJob` и `OutboxEvent` введены владелец и срок lease; состояние `PROCESSING` без lease запрещено ограничением PostgreSQL.
- Добавлен сервис возврата просроченных lease в `PENDING`.
- Добавлены атомарный захват и подтверждение публикации для outbox-событий; повторная доставка использует тот же lease-механизм.
- Длительность lease и предел повторных попыток задаются валидируемыми переменными окружения, а не значениями в коде.

Заменено более поздними записями: публикация transactional outbox в BullMQ (2026-08-13) и приём `node-sync` команд worker-ом. Актуальная формулировка outbox: `vpn-application-implementation-tz.md`, раздел 6.

**Влияние на ТЗ:** добавлена миграция `20260810165000_add_orchestration_leases`; публичный API не менялся.

### 2026-08-10 — Целостность привязки sync-задачи к ноде

**Статус:** решено

- `NodeSyncJob`, содержащая `nodeAccessGrantId`, на уровне PostgreSQL может ссылаться только на grant той же ноды.
- Добавлены составной уникальный ключ grant, внешнее ограничение и интеграционный тест ошибочного сценария.
- Это защищает будущий processor от отправки конфигурации устройства на неверную ноду; processor и реальные ноды по-прежнему не реализованы.

**Влияние на ТЗ:** добавлена миграция `20260810162000_enforce_node_sync_grant_ownership`; публичный API и формат subscription URL не менялись.

### 2026-08-10 — Инварианты control plane в PostgreSQL

**Статус:** решено

- PostgreSQL теперь отвергает нулевую/отрицательную цену и лимит устройств, неполный или некорректный период активной подписки и отзыв устройства без времени отзыва.
- Версии нод и access grants не могут быть отрицательными или иметь applied-версию выше desired; счётчики попыток очереди также неотрицательны.
- Добавлены интеграционные тесты корректного и ошибочных сценариев. Ограничения защищают данные независимо от будущих API и worker-процессоров.

**Влияние на ТЗ:** добавлена миграция `20260810163500_enforce_control_plane_invariants`; публичный API не менялся.

### 2026-08-09 — Продуктовая модель

**Статус:** решено

- Сервис — массовый потребительский VPN для пользователей из России.
- Стартовая цена: 200 ₽ / месяц; цены редактируются из админки и не хардкодятся.
- Основной пользовательский путь: Telegram-бот → личный кабинет → оплата → копирование subscription URL → Happ.
- У пользователя нет обязательных email/пароля: Telegram user_id — первичная идентичность.

**Влияние на ТЗ:** `vpn-service-tz.md`, разделы 1–3 и 5–6.

### 2026-08-09 — Модель доступа

**Статус:** решено

- Пользователь получает постоянный персональный subscription URL, а не ключ одной ноды.
- Пока подписка активна, URL выдаёт набор актуальных VLESS-конфигураций для Happ.
- При истечении срока доступ прекращается серверной логикой.
- При замене ноды URL пользователя сохраняется; обновляется только список конфигураций.

**Влияние на ТЗ:** `vpn-service-tz.md`, разделы 3–5; `vpn-technical-spec.md`, раздел 7.

### 2026-08-09 — Платежи

**Статус:** решено

- Оплата происходит в личном кабинете через внешний российский эквайринг: карта и СБП.
- Экран возврата после оплаты не выдаёт доступ сам по себе.
- Подписка продлевается только после проверенного webhook-а от эквайринга.
- Обязательны защита от двойного клика, идемпотентность, сверка суммы и журнала событий.

**Влияние на ТЗ:** `vpn-service-tz.md`, раздел 6.

### 2026-08-09 — Интерфейсы платформы

**Статус:** решено

- Telegram-бот: онбординг, уведомления, переход в кабинет.
- Личный кабинет: оплата, подписка, ключ, инструкция Happ.
- Админка: тарифы, пользователи, платежи, подписки, ноды, поддержка и мониторинг.
- Это части одной платформы и одного репозитория, не три независимых продукта.

**Влияние на ТЗ:** `vpn-service-tz.md`, раздел 4.

### 2026-08-09 — Архитектура и масштабирование

**Статус:** решено

- С первого дня разделяем control plane и VPN data plane.
- Backend начинаем как модульный монолит; преждевременные микросервисы и Kubernetes не используем.
- Платформа, VPN-ноды, база и бэкапы располагаются раздельно.
- Для первого прототипа: один Platform VPS, две отдельные VPN-ноды, бэкап-хранилище.

**Влияние на ТЗ:** `vpn-service-tz.md`, разделы 4 и 8; `vpn-technical-spec.md`, разделы 2–4 и 9.

### 2026-08-09 — Контроль рисков доступа и эксплуатации

**Статус:** изменено

- Изначально решили дать до двух устройств, но это оказалось недостаточным для типичного набора «телефон + ПК + ноутбук/планшет».
- Каждая нода локально применяет срок действия устройства и блокирует доступ после окончания подписки, даже если control plane временно недоступен.
- Добавление, отзыв и окончание подписки синхронизируются с нодами через версионируемые подтверждаемые задачи с повторной доставкой и rollback.
- Отзыв устройства должен примениться на всех healthy-нодах не позднее чем за 5 минут.
- До публичного запуска нужны нагрузочный тест, правила разумного использования, процедура abuse-жалоб, минимизация логов и аварийная тренировка.

**Влияние на ТЗ:** `vpn-service-tz.md`, разделы 2–3, 5, 7–9 и 11; `vpn-technical-spec.md`, разделы 4, 7–11.

### 2026-08-09 — Лимит устройств на тарифе

**Статус:** решено

- Стартовый тариф за 200 ₽ включает до трёх именованных устройств.
- У каждого устройства отдельный subscription URL, поэтому отзыв одного не отключает остальные.
- Лимит устройств — поле тарифа и меняется из админки; он не должен быть захардкожен.
- Лимит не равен числу одновременных подключений: последнее контролируется отдельно на уровне нод.

**Влияние на ТЗ:** `vpn-service-tz.md`, разделы 2–3, 5, 7 и 11.

### 2026-08-09 — Старт разработки: стек и правила

**Статус:** решено

- Создаётся отдельное техническое ТЗ реализации приложения: стек TypeScript, Next.js, NestJS, PostgreSQL, Redis/BullMQ, Prisma, Docker и pnpm workspaces.
- Кабинет и админка находятся в одном Next.js-приложении; API, бот и worker — отдельные приложения одного монорепозитория.
- В ТЗ зафиксированы границы приложений, запреты, безопасность, тестовые сценарии и Definition of Done.

**Влияние на ТЗ:** создан `vpn-application-implementation-tz.md`.

### 2026-08-09 — Инструкции для AI-агента

**Статус:** решено

- Создан `AGENTS.md`: обязательный порядок чтения ТЗ, границы первого этапа, запреты и Definition of Done.
- Первым поручением агенту будет только каркас монорепозитория и локальное окружение без платежей, VPN-нод и боевых секретов.

**Влияние на ТЗ:** создан `AGENTS.md`.

### 2026-08-09 — Выполнен стартовый этап разработки

**Статус:** решено

- Создан pnpm-монорепозиторий с приложениями `web`, `api`, `bot`, `worker` и общими пакетами `contracts`, `config`.
- `web` содержит только временную главную страницу на Next.js; кабинет и админка не реализованы.
- `api` построен на NestJS и Fastify. Добавлены `GET /health/live` и `GET /health/ready`, Zod-контракты, OpenAPI-описание и тесты успешного и ошибочного readiness-сценариев.
- `bot` и `worker` созданы как неактивные каркасы Telegraf и BullMQ: Telegram-токен, polling, production webhook и бизнес-процессоры отсутствуют.
- Добавлена Prisma-схема без бизнес-сущностей и миграций. Изменений схемы данных на этом этапе нет, миграция не требуется.
- Docker Compose содержит только локальные PostgreSQL и Redis, привязанные к loopback-интерфейсу; production-инфраструктура и VPN-ноды не добавлялись.
- Настроены TypeScript strict, ESLint, Prettier, корневые команды, GitHub Actions и документация локального запуска.
- Проверены typecheck, lint/format, 6 тестов, сборка всех workspace, Prisma schema и Docker Compose config; проверки прошли успешно.

**Влияние на ТЗ:** выполнен стартовый этап из `AGENTS.md`; продуктовые требования и решения не изменялись.

### 2026-08-09 — Подключение PostgreSQL и Redis в API

**Статус:** решено

- API использует Prisma Client как runtime-доступ к PostgreSQL и `ioredis` как управляемое подключение к Redis.
- `GET /health/ready` выполняет реальный `SELECT 1` и `PING` с ограниченным timeout; недоступность одной зависимости возвращает HTTP 503, но не препятствует запуску и liveness API.
- Переменные `DATABASE_URL`, `REDIS_URL`, API host/port, timeout и log level валидируются централизованной Zod-схемой при запуске.
- Строки подключения и ошибки клиентов не включаются в health-ответ; расширено маскирование чувствительных полей Pino.
- Добавлены unit-тесты конфигурации и probe-адаптера, API-тесты успешного/ошибочного health-сценария и integration-тест с локальными PostgreSQL/Redis.
- CI поднимает сервисные контейнеры PostgreSQL/Redis и отдельно запускает infrastructure integration test.
- Prisma-схема не менялась и бизнес-сущности не добавлялись, поэтому миграция не требуется.

**Влияние на ТЗ:** реализовано инфраструктурное подключение, форма health-контракта не изменилась; обновлены OpenAPI, тесты, CI и README.

### 2026-08-09 — Проверка Happ и эквайринга

**Статус:** риск

- Документация Happ подтверждает поддержку VLESS и стандартного web subscription URL с текстовым списком конфигураций. Архитектурная модель совместима, но финальный формат остаётся заблокирован до end-to-end теста в актуальных приложениях на целевых ОС.
- Техническая интеграция интернет-эквайринга для онлайн-сервиса, карт и СБП возможна, однако публичная документация не является одобрением VPN-категории.
- Production-платежи остаются заблокированы до письменного подтверждения конкретного эквайера и юридического заключения по статье 15.8 закона № 149-ФЗ, запрету рекламы VPN, фискализации, персональным данным, оферте и возвратам.
- Подробные выводы, первичные источники и чек-листы сохранены в `vpn-external-validation-2026-08-09.md`.

**Влияние на ТЗ:** риски «Эквайринг и юридическая модель» и «Протокол и клиентская совместимость» уточнены, но не закрыты; платежи и subscription endpoint не реализовывались.

### 2026-08-10 — Среда тестового прототипа

**Статус:** решено

- Для закрытого технического прототипа допускаются облачные VM AWS, Google Cloud и Oracle Cloud.
- Среда предназначена только для проверки архитектуры, subscription URL и замены тестовой ноды; она не является production-средой и не предназначена для публичной раздачи доступа.
- Control plane и VPN-ноды остаются раздельными; для проверки отказоустойчивости тестовые ноды размещаются как минимум у двух независимых провайдеров.
- Перед production будут выбраны отдельные подходящие VPS-провайдеры и пройдена их проверка по условиям сервиса, доступности, трафику и процедурам abuse.

**Влияние на ТЗ:** уточнён способ размещения тестовой инфраструктуры; требования к изоляции control plane/data plane, безопасности и проверке провайдеров не меняются.

### 2026-08-10 — Локальный subscription-прототип

**Статус:** решено

- Добавлен выключенный по умолчанию локальный endpoint с непрозрачным токеном из окружения.
- Endpoint возвращает только UTF-8 `text/plain` fixture; VLESS-конфигурации, пользовательские данные, платежи и VPN-ноды не добавлялись.
- Зафиксированы ответы `200`, `401` и `404`, OpenAPI-контракт и автоматические тесты; полный URL маскируется в логах.
- Схема Prisma не менялась, миграция не требуется.

**Влияние на ТЗ:** начат технический прототип проверки формата subscription URL; end-to-end проверка Happ на устройствах остаётся отдельной задачей.

## Открытые вопросы / риски

### Эквайринг и юридическая модель

**Статус:** риск

Нужно до разработки подтвердить у выбранного эквайринга возможность подключения категории сервиса, требования к юрлицу/самозанятости, кассе/чекам, возвратам и документам для пользователей.

**Блокирует:** запуск боевых платежей.

### Регуляторные и рекламные ограничения в РФ

**Статус:** риск

С 1 сентября 2025 года действует запрет на рекламу VPN-сервисов и средств обхода блокировок. До публичного запуска нужны профильная юридическая консультация, оценка допустимого позиционирования сервиса, условий использования Telegram-бота и рекламных каналов. Нельзя закладывать обычную рекламную воронку как гарантированный способ привлечения пользователей.

**Источник для первичной проверки:** разъяснение прокуратуры Санкт-Петербурга от 17 сентября 2025 года.

**Блокирует:** публичный маркетинговый запуск; не блокирует локальный технический прототип.

### Провайдеры VPN-нод

**Статус:** риск

Нужно выбрать провайдеров, которые допускают нужный тип трафика, дают приемлемую пропускную способность и позволяют масштабировать пул нод без ручной миграции пользователей.

**Блокирует:** выбор боевой инфраструктуры, не блокирует локальный прототип.

### Протокол и клиентская совместимость

**Статус:** изменено (Windows localhost закрыт; iOS/HTTPS и VPS нет)

Happ 3.1.0 на Windows: импорт live URL, две ноды, обычный disable без нового URL, сессия к Local B (VLESS/TLS/TCP, скорость). Системный VPN на localhost не ожидается. iOS Happ отклоняет HTTP, в том числе loopback. Android, macOS, iOS/HTTPS и production VLESS-параметры не испытаны. Снимок внешней проверки 2026-08-09 остаётся историческим; актуальный статус — здесь и в `vpn-service-tz.md`.

**Блокирует:** финальный формат выдачи и пользовательский URL в production (нужен HTTPS origin); не блокирует уже закрытый localhost-прототип.

## Критические пробелы, выявленные при ревизии ТЗ

### Доступ к VPN после окончания подписки

**Статус:** изменено

Требования зафиксированы: нода хранит локальный `expires_at` и блокирует доступ после срока даже без control plane; отзыв доставляется на healthy-ноды с целевым SLA 5 минут; subscription URL не является источником разрешения на ноде. Актуальные формулировки: `vpn-service-tz.md` разделы 3 и 8; `vpn-technical-spec.md` раздел 7.

Оставшийся риск реализации: production data plane / Xray adapter ещё не подключён, поэтому эксплуатационное доказательство блокировки на реальных нодах отсутствует.

**Блокирует:** безопасный запуск платных подписок до появления проверенного data plane.

### Утечка и перепродажа subscription URL

**Статус:** изменено

Продуктовая модель зафиксирована: device-specific URL, отзыв и перевыпуск из кабинета/админки, в базе только хеш токена, полный URL не логируется. Актуальные формулировки: `vpn-service-tz.md` разделы 3 и 7; `vpn-application-implementation-tz.md` раздел 10.

Оставшийся риск: численные пороги одновременных подключений на ноде, детектирование аномальных IP и UX ложного срабатывания ещё не утверждены.

**Блокирует:** финальную антиабьюз-политику, не саму device-specific модель доступа.

### Экономика трафика и злоупотребления ресурсами

**Статус:** риск

Цена 200 ₽ не гарантирует прибыль: расходы определяют не число зарегистрированных пользователей, а одновременные подключения, объём исходящего трафика, скорость порта, платежная комиссия, поддержка и резервные ноды. До ценообразования нужно определить допустимое использование, лимиты/правила справедливого использования и нагрузочные предположения.

**Блокирует:** утверждение боевой цены и выбор тарифов серверов.

### Жалобы провайдеров и жизненный цикл нод

**Статус:** риск

Эксплуатационная реакция на жалобу зафиксирована в `vpn-technical-spec.md`, раздел 9.1. Остаётся выбрать провайдеров, проверить их ToS и иметь резервный пул до боевой эксплуатации.

**Блокирует:** устойчивую эксплуатацию, не блокирует изолированный прототип.

### Согласованность оркестратора и нод

**Статус:** изменено

Требования и локальный control plane зафиксированы: desired/applied version, transactional outbox, lease, retry, acknowledgement, rollback. Актуальные формулировки: `vpn-application-implementation-tz.md` разделы 6–8; `vpn-technical-spec.md` раздел 7.

Оставшийся риск: реальное применение на production Xray-нодах ещё не доказано.

**Блокирует:** автоматическое масштабирование за пределы тестовых/simulation нод.

### Приватность, персональные данные и поддержка

**Статус:** риск

Telegram ID, платежи, обращения и технические журналы — персональные данные. Нужны минимизация собираемых данных, сроки хранения, политика конфиденциальности, контроль доступа сотрудников и юридическая проверка трансграничного хранения/обработки данных.

**Блокирует:** публичный запуск.

### Отказ внешних зависимостей

**Статус:** изменено

Эксплуатационные сценарии для падения ноды, Platform VPS, Telegram, DNS и задержки webhook зафиксированы в `vpn-technical-spec.md`, раздел 9.1. При недоступности Telegram активная веб-сессия кабинета сохраняется; VPN продолжает работать по локальному сроку доступа.

Оставшийся пробел: альтернативный вход в кабинет без Telegram для новой сессии не специфицирован и не должен додумываться. Статус-страница и резервный канал поддержки остаются в плане этапа 4 `vpn-service-tz.md`.

**Блокирует:** production-ready запуск до закрытия оставшегося пробела и тренировки аварийных сценариев.

### 2026-08-10 — Стабилизация prototype и CI после ревью

**Статус:** решено

- Limiter тестового subscription endpoint не создаёт записи при выключенном prototype, ограничен по числу клиентов и очищает истёкшие окна.
- Runtime-проверка opaque token приведена в соответствие с OpenAPI; ошибочный токен остаётся `401`, чтобы не создавать отдельный oracle для bearer-секрета.
- CI применяет Prisma-миграции перед integration tests. Добавлены overrides исправленных версий `find-my-way` и `js-yaml`; их результат проверяется production audit.
- Добавлен `.gitattributes` с LF для воспроизводимой проверки форматирования на Windows и Linux.

**Влияние на ТЗ:** устранены непосредственные риски DoS test endpoint и падения CI на чистой БД. Инварианты orchestration, append-only audit и lifecycle data-plane credentials остаются отдельным этапом миграции и дизайна доступа.

### 2026-08-10 — Проверка Telegram Mini App initData

**Статус:** решено

- Добавлен серверный verifier для Telegram Mini App `initData`: HMAC-подпись проверяется в constant time, проверяются обязательные параметры, уникальность security-полей и срок действия.
- Из проверенных данных извлекается только Telegram user ID; профиль, username и исходная строка initData не сохраняются и не логируются.
- Реальный bot token не добавлен в код или тестовые конфигурации. Endpoint, сессии, Telegram webhook и доступ к устройствам этим этапом не добавлялись.

**Влияние на ТЗ:** подготовлен обязательный криптографический фундамент для будущей серверной Telegram-авторизации, без доверия к данным, присланным браузером.

### 2026-08-10 — Безопасный worker-каркас

**Статус:** решено

- До регистрации реальных processors worker отклоняет каждое задание с ошибкой вместо ложного успешного выполнения.
- `WORKER_ENABLED` разбирается строго: допускаются только `true` и `false`.
- Проверены ошибочный сценарий неизвестной задачи и валидация URL Redis. Очереди, node agent и реальные обработчики не добавлялись.

**Влияние на ТЗ:** worker нельзя ошибочно использовать как работающий механизм синхронизации нод до появления явно зарегистрированных и протестированных processors.

### 2026-08-10 — Базовая модель данных control plane

**Статус:** решено

- Добавлены миграция PostgreSQL и Prisma-модели пользователей, тарифов, подписок, устройств, нод, назначений доступа на ноды, задач синхронизации, transactional outbox и audit events.
- Subscription-токен устройства и отдельный credential для data plane хранятся только в виде уникальных хэшей. В БД нет полных subscription URL, реальных ключей нод или VPN-конфигураций.
- Нода хранит желаемую и подтверждённо применённую версии конфигурации; задачи синхронизации идемпотентны. Очередь и node agent этим этапом не подключались.
- Удаление связанных сущностей ограничено внешними ключами, чтобы не потерять аудит и состояние доступа неявно.

**Влияние на ТЗ:** заложена модель для device-specific доступа, отзыва и будущей синхронизации с нодами. Платежи, API для пользователей и реальные ноды остаются за пределами этапа.

### 2026-08-10 — Усиление локального subscription-прототипа

**Статус:** решено

- Локальный endpoint нельзя включить в `production`; если он включён, переменная с токеном обязательна.
- Сравнение токена выполняется в constant time, ответ передаётся с `Cache-Control: no-store`, а частота запросов ограничена настраиваемым локальным лимитом по IP.
- Контракт OpenAPI и автоматические тесты дополнены сценариями конфигурации, кеширования и лимита запросов; полные URL по-прежнему маскируются в логах.
- Prisma-схема, платежи, реальные VPN-ноды и VPN-конфигурации не изменялись.

**Влияние на ТЗ:** закрыты риски тестового endpoint до проверки его на изолированной локальной среде; endpoint остаётся техническим fixture, а не механизмом выдачи доступа пользователям.

### 2026-08-11 — Локальный fixture для проверки обновления Happ

**Статус:** решено

- Технический endpoint локальной подписки по-прежнему выключен по умолчанию и запрещён в production.
- Для изолированной ручной проверки Happ его содержимое можно передать только через некоммитимую переменную окружения `LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT`; значение не записывается в БД и не логируется.
- Если переменная не задана, endpoint отдаёт прежний пустой текстовый fixture. Автотесты проверяют оба варианта и нормализацию завершающего перевода строки.
- Этот шаг не подключает VPN-ноды, Xray/VLESS-сервер, платёжные системы или worker processors: тестовая VLESS-строка указывает только на недоступный локальный адрес и предназначена для проверки импорта и обновления в клиенте.

**Влияние на ТЗ:** можно проверить, что Happ импортирует и обновляет подписку по стабильному URL, не создавая реальный VPN-доступ и не раскрывая конфигурации в репозитории.

### 2026-08-11 — Конкурентная идемпотентность постановки desired state

**Статус:** решено

- PostgreSQL advisory lock по ключу идемпотентности сериализует одновременные одинаковые команды до проверки и создания desired state.
- Конкурентный интеграционный тест подтверждает создание ровно одного `NodeAccessGrant`, `NodeSyncJob` и `OutboxEvent`, а также единственное увеличение версии конфигурации ноды.
- Миграция не требуется: используется существующая PostgreSQL-транзакция и уже заданные уникальные ключи. Реальные ноды, Xray/VLESS-серверы и worker processors не подключались.

**Влияние на ТЗ:** сетевой повтор команды не выдаёт двойной доступ и не создаёт лишнюю конфигурационную версию ноды даже при одновременной обработке.

### 2026-08-11 — Порядок конкурентных разных команд одной ноде

**Статус:** решено

- Интеграционный тест одновременно выдаёт доступ двум разным устройствам на одной ноде.
- PostgreSQL сериализует увеличение версии ноды: обе команды сохраняются с разными целевыми версиями `1` и `2`, а итоговая desired version равна `2`.
- Проверены оба grant, обе sync-задачи и оба outbox-события. Реальные ноды, Xray/VLESS-серверы и worker processors не подключались.

**Влияние на ТЗ:** параллельная выдача доступа нескольким устройствам не теряет одну из команд и сохраняет упорядоченную историю конфигурации ноды.

### 2026-08-11 — Явное отклонение конфликтующих idempotency keys

**Статус:** решено

- Постановка desired state захватывает PostgreSQL advisory locks для ключей sync job и outbox event в детерминированном порядке.
- Если любой из ключей уже принадлежит другой команде, запрос отклоняется понятной прикладной ошибкой до создания grant, sync job или outbox event.
- Интеграционный тест подтверждает отсутствие частичного состояния и исключает возврат сырой ошибки уникального индекса. Реальные ноды, Xray/VLESS-серверы и worker processors не подключались.

**Влияние на ТЗ:** повтор и конфликт команды не могут скрытно изменить доступ, создать частичную конфигурацию или привести к непредсказуемому ответу сервиса.

### 2026-08-11 — Интеграционная проверка lease fencing

**Статус:** решено

- Интеграционный тест PostgreSQL проверяет sync job и outbox event при захвате, истечении и повторном захвате lease.
- Завершение или публикация чужим worker отклоняется; после истечения lease работу безопасно захватывает новый worker с новым fencing token.
- Reclaimer очищает fencing token вместе с owner и expiration при возврате работы в `PENDING`; это сохраняет инвариант lease на уровне PostgreSQL.
- Только актуальные tokens переводят sync job в `SUCCEEDED` и outbox event в `PUBLISHED`. Реальные ноды, Xray/VLESS-серверы и worker processors не подключались.

### Подтверждение применённой конфигурации ноды

**Статус:** решено

- Добавлен append-only `NodeConfigAcknowledgement`: подтверждение связывает ноду, версию и успешно завершённую `NodeSyncJob`.
- PostgreSQL запрещает повысить `Node.appliedConfigVersion` без такого подтверждения и не позволяет понизить уже применённую версию.
- Внутренний метод control plane идемпотентно сохраняет подтверждение и обновляет применённую версию в одной транзакции с audit event. Публичный HTTP endpoint и node-agent аутентификация этим этапом намеренно не добавлялись.

**Влияние на ТЗ:** зависший либо устаревший worker не сможет подтвердить работу, которая уже безопасно перешла новому исполнителю.

### Неизменяемость терминальной orchestration-работы

**Статус:** решено

- PostgreSQL запрещает изменение `NodeSyncJob` в состояниях `SUCCEEDED` и `FAILED`, а также `OutboxEvent` в состояниях `PUBLISHED` и `FAILED`.
- Удаление остаётся отдельной будущей политикой retention, но завершённую работу нельзя скрытно перевести в другое состояние или исправить после неё поля.
- Интеграционные тесты покрывают успешные и исчерпавшие лимит повторов задания и события. Реальные ноды и worker processors не подключались.

### Учётные данные node agent

**Статус:** решено

- Для каждой ноды предусмотрена одна активная opaque credential; PostgreSQL предотвращает одновременную выдачу двух активных credential одной ноде.
- Секрет создаётся криптографически случайным, возвращается только при ротации и хранится лишь как HMAC-SHA-256 с pepper из secret storage. Полный секрет, его хеш и pepper не записываются в audit log.
- Внутренний сервис поддерживает ротацию, отзыв и проверку только healthy-ноды; на этом этапе публичный endpoint, node-agent и реальные VPN-ноды не добавлялись.

### Защищённое подтверждение от node agent

**Статус:** решено

- Добавлен `POST /node-agent/v1/acknowledgements`: endpoint принимает только bearer credential healthy-ноды и подтверждает версию через существующий идемпотентный use case.
- Общий Zod-контракт и OpenAPI фиксируют UUID sync-задачи и неотрицательную версию; неверная credential, тело и неподходящая задача отклоняются без выдачи конфигурации или пользовательских данных.
- Endpoint не выдаёт VPN-конфигурации, не запускает worker и не подключает реальный node agent или VPS.

### Снимок desired state для node agent

**Статус:** решено

- Добавлен `GET /node-agent/v1/configuration`: credential ноды получает только версии конфигурации и lifecycle grants, принадлежащие этой ноде.
- Снимок намеренно не включает device ID, credential-хеши, VPN-ключи, URL или пользовательские данные. Отключённая нода не может его получить.
- Подтверждение версии в той же PostgreSQL-транзакции продвигает applied-версии grants до соответствующих desired-версий. Worker, реальный node agent, VPS и доставка секретных VPN-данных не добавлялись.

### Heartbeat ноды

**Статус:** решено

- Добавлен `POST /node-agent/v1/heartbeats`: он записывает серверное время последнего контакта только для аутентифицированной healthy-ноды в отдельное `lastHeartbeatAt`.
- Нода не передаёт собственное время и heartbeat не меняет её статус. Credential и статус перепроверяются перед обновлением, поэтому отключённая нода не может незаметно обновить отметку.
- `lastHealthCheckAt` намеренно не используется для heartbeat: оно зарезервировано для независимых будущих проверок доступности data plane.
- Реальные node agent, VPS, автоматическое исключение нод и VPN-данные не добавлялись.

### Атомарная авторизация node agent

**Статус:** решено

- После независимого ревью проверка active credential, статуса `HEALTHY` и действие node-agent endpoint выполняются в одной PostgreSQL-транзакции с блокировкой строк credential и ноды.
- Revoke или отключение ноды больше не могут вклиниться между авторизацией и выдачей снимка, heartbeat либо подтверждением версии: порядок операций линейно определяется блокировкой.
- Интеграционные проверки покрывают revoked credential, disabled-ноду и конкурентный revoke во время авторизованного действия.

### Синхронизация OpenAPI и heartbeat

**Статус:** решено

- `lastHeartbeatAt` отделено миграцией от `lastHealthCheckAt`, чтобы контакт агента не маскировал независимую будущую проверку data plane.
- `apps/api/openapi.json` теперь генерируется командой `pnpm --filter @vpn-platform/api openapi:generate` из Swagger-декораторов и проверяется на точное совпадение в тесте.
- Snapshot имеет полный OpenAPI-контракт grants и заголовок `Cache-Control: no-store`.

### Устранение замечаний повторного ревью node agent

**Статус:** решено

- Для acknowledgement закреплён порядок блокировок: сначала строка Node, затем advisory lock версии конфигурации.
- OpenAPI фиксирует opaque bearer credential и строгие схемы snapshot/grant без дополнительных свойств; CI генерирует контракт и проверяет отсутствие diff.
- Интеграционный тест доказывает, что acknowledgement одной ноды не продвигает grants другой ноды того же устройства.

### Ручная локальная проверка Happ: замена test fixture

**Статус:** решено

- На Windows в Happ подтверждён импорт и обновление одного локального subscription URL.
- При неизменном URL fixture `VPNPlatform-Test-A` был заменён на `VPNPlatform-Test-B`; Happ обновил список без добавления новой подписки.
- Обе строки указывали только на недоступные локальные адреса `127.0.0.1`; реальное VPN-подключение, VPS, Xray/VLESS-инфраструктура, пользовательские ключи и платежи не использовались.

### Ручная локальная проверка Happ: точечная замена ноды

**Статус:** решено

- По одному и тому же subscription URL Happ сначала получил две изолированные test fixtures `VPNPlatform-Test-A` и `VPNPlatform-Test-B`.
- Затем в ответе была заменена только A на C. После обновления Happ сохранил B, убрал A и добавил `VPNPlatform-Test-C` без создания новой подписки.
- Проверка проведена только на недоступных локальных адресах; она подтверждает поведение списка конфигураций, но не является реальным VPN-подключением или production-проверкой нод.

### Дополнительная ручная проверка Happ: устойчивость обновления

**Статус:** решено

- Повторные обновления subscription не создают дублирующие записи в Happ.
- После перезапуска клиента сохранённый subscription URL и актуальный список fixtures остаются доступными.
- Временная недоступность локального API не нарушила ранее импортированный список; после восстановления API Happ успешно обновил его.

### 2026-08-11 — Интеграционная проверка retry-политики

**Статус:** решено

- Интеграционный тест выполняет пять последовательных попыток для `NodeSyncJob` и `OutboxEvent` с configured local limit `5`.
- До лимита работа возвращается в `PENDING` с запланированной следующей попыткой; на лимите обе записи становятся `FAILED` и очищают lease.
- Terminal-задачи больше не могут быть захвачены worker’ом. Реальные ноды, Xray/VLESS-серверы и worker processors не подключались.

**Влияние на ТЗ:** временные сетевые ошибки допускают контролируемые повторы, а постоянная ошибка останавливает работу в наблюдаемом terminal-состоянии без бесконечного цикла.

## Следующий практический этап

**Статус:** отменено как актуальный план

Этот чек-лист относился к старту проекта 2026-08-09/10. Репозиторий создан, локальный Happ fixture проверен, control plane развивается поэтапно. Текущие blockers и риски — в разделах «Открытые вопросы / риски» и «Критические пробелы»; актуальный порядок работы — `AGENTS.md` и этапы `vpn-service-tz.md`.

### 2026-08-10 — Инварианты жизненного цикла control plane

**Статус:** решено

- PostgreSQL гарантирует не более одной `ACTIVE`-подписки на пользователя частичным уникальным индексом.
- Ограничения БД связывают терминальные состояния sync job и outbox event с обязательными временными метками `completedAt` и `publishedAt`.
- Для `NodeAccessGrant` состояние `ACTIVE` несовместимо с `revokedAt`, а `REVOKED` по-прежнему требует эту метку.
- `cancelledAt` теперь существует только у `CANCELLED`-подписки; тесты интеграции проверяют все новые ошибочные сценарии.

**Влияние на ТЗ:** инварианты состояния защищены от обхода сервисного слоя. Реальные ноды, VPN-конфигурации, платежи и worker processors в этот этап не добавлялись.

### 2026-08-10 — Инварианты повторных попыток orchestration

**Статус:** решено

- `nextAttemptAt` разрешён только у `PENDING`-задач синхронизации и outbox events; обрабатываемая или терминальная работа не может сохранить отложенную попытку.
- Claim очищает `nextAttemptAt` перед выдачей lease, что исключает одновременную интерпретацию записи как запланированной и обрабатываемой.

**Влияние на ТЗ:** retry-состояние control plane согласовано на уровне PostgreSQL и сервисного перехода. Реальные ноды и worker processors не добавлялись.

### 2026-08-10 — Append-only аудит control plane

**Статус:** решено

- PostgreSQL-триггер запрещает прямые `UPDATE` и `DELETE` записей `AuditEvent`; журнал принимает только новые события.
- Интеграционный тест подтверждает, что создание события разрешено, а попытки изменить или удалить его отклоняются базой данных.

**Влияние на ТЗ:** важные действия control plane нельзя незаметно переписать или удалить через Prisma либо прямой SQL. Реальные ноды, платежи и worker processors не добавлялись.

### 2026-08-10 — Атомарная постановка desired state

**Статус:** решено

- Внутренний use case одной PostgreSQL-транзакцией увеличивает desired version ноды и создаёт grant, sync job, outbox event и append-only audit event.
- Интеграционный тест подтверждает согласованность созданных записей; HTTP API, реальные node agents и worker processors не добавлялись.

### 2026-08-10 — Идемпотентность постановки desired state

**Статус:** решено

- Повторная команда с теми же ключами sync job и outbox возвращает исходные идентификаторы и не увеличивает desired version второй раз.
- Повторное использование ключей для другой ноды, устройства или outbox-записи отклоняется, чтобы ключ нельзя было использовать для иной команды.

**Влияние на ТЗ:** сетевой retry внутренней команды не создаёт дубли доступа или повторную синхронизацию. HTTP API, реальные ноды и worker processors не добавлялись.

### 2026-08-10 — Проверка атомарного отката desired state

**Статус:** решено

- Интеграционный тест создаёт конфликт idempotency key на этапе outbox и подтверждает откат повышения desired version, grant и sync job.

**Влияние на ТЗ:** ошибка на позднем шаге постановки desired state не оставляет частично созданный доступ или рассинхронизированную версию ноды.
