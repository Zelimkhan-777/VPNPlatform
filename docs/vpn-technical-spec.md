# Техническое ТЗ: инфраструктура и развёртывание VPN-платформы

## Document authority

Этот документ является источником истины для:

- control plane / data plane и deployment topology;
- VPN-нод, node lifecycle и инфраструктурной синхронизации;
- networking, health checks, backups, disaster recovery;
- monitoring, alerting, capacity planning и infrastructure scaling;
- эксплуатационных failure scenarios.

Этот документ не является источником истины для:

- тарифов, UX оплаты, device limits и MVP scope — см. `vpn-service-tz.md`;
- стека, API, auth/session, outbox и application security invariants — см. `vpn-application-implementation-tz.md`;
- истории решений — см. `vpn-project-journal.md`.

Отвечает на вопрос: **как система разворачивается, работает и восстанавливается?**

## 1. Цель

Развернуть платформу так, чтобы начать с закрытой беты, а затем масштабировать API, фоновые задачи, базу и VPN-ноды независимо. Никакая отдельная VPN-нода не должна быть единственной точкой отказа для кабинета, бота, платежей или данных пользователей.

## 2. Размещение компонентов

| Контур | Состав | Размещение |
|---|---|---|
| Control plane | Web-кабинет, админка, API, Telegram-бот, worker | Отдельный `platform-1` в российском дата-центре |
| Данные | PostgreSQL, Redis, резервные копии | На старте `platform-1`; primary-сервисы и пользовательские/платёжные данные — в РФ, зашифрованная копия — в отдельном хранилище, предпочтительно другом российском ДЦ |
| VPN data plane | Xray/VLESS-ноды | Отдельные VPS в странах выхода |
| Наблюдаемость | Метрики, логи, алерты, uptime-checks | Отдельный логический контур, не на единственной VPN-ноде |

На старте разрешён один `platform-1` с Docker Compose, но VPN-ноды всегда разворачиваются отдельно от него. На `platform-1` Xray не устанавливается и пользовательский VPN-трафик через него не проходит. При запуске платных пользователей PostgreSQL нельзя оставлять без автоматических зашифрованных бэкапов в отдельном failure domain и проверенного восстановления.

`platform-1` приобретён у Selectel в московском дата-центре: Ubuntu 24.04 LTS, 4 vCPU, 8 GB RAM, 80 GB NVMe и статический IPv4. Read-only inventory и контрольная перезагрузка подтвердили hostname `platform-1`, актуальное ядро, UTC/NTP, SSH-вход отдельного `platformadmin` только по выделенному Ed25519-ключу, запрет password/root SSH, UFW default-deny с rate-limited `22/tcp`, активные Fail2ban и unattended security upgrades, отсутствие failed systemd units. Из официального Docker repository установлены Docker Engine 29.7.2 и Docker Compose 5.5.0; Docker и containerd активны, storage driver `overlayfs`, cgroup v2, контейнеры отсутствуют. Это подтверждённый host и container-runtime baseline, но не завершённый application deployment: reverse proxy, PostgreSQL, Redis и сервисы платформы ещё не развёрнуты, `80/443` закрыты.

Перед первым production pull/start и открытием `80/443` versioned read-only
preflight повторно подтверждает этот baseline, отсутствие Xray и иных public
listeners, чистый checkout, валидный root-only production environment,
детерминированный Compose render и совпадение A-records всех четырёх public
origins с явно переданным IPv4 `platform-1`. Проверка ничего не исправляет и не
разворачивает; любой mismatch останавливает deployment. Она не подменяет
recovery-check secrets, offsite backup/restore drill, проверку правил провайдера
и внешнюю HTTPS-валидацию после запуска. Runbook: `infra/platform/README.md`.

Точный Git commit доставляется на `platform-1` отдельным offline этапом, который
не является application deployment. На доверенной локальной машине versioned
creator требует clean tracked `HEAD`, полный 40-символьный SHA из локальной
`main` и создаёт Git bundle плюс manifest с SHA commit и SHA-256 bundle; untracked
files, локальные `.env`, runtime state и build artifacts в bundle не попадают.
Root-only installer независимо проверяет checksum, `git bundle verify` и exact
commit, материализует clean detached checkout без перезаписи в
`/opt/meteora/releases/<sha>`, выполняет filesystem durability barriers и только
после полной проверки атомарно переключает `/opt/meteora/current`. Unsafe
symlink, relative/non-canonical paths и существующий release завершают операцию
fail-closed; старые releases автоматически не удаляются. Ошибка после switch до
финальной проверки атомарно восстанавливает прежний `current`. Этот этап не
запускает Compose/migrations/containers и не меняет secrets, backup repository,
firewall, DNS или VPN-ноды. SHA-256 вместе с Git object verification подтверждает
целостность локально созданного и доставленного artifact, но не заменяет будущую
signing/provenance policy. Runbook: `infra/platform/release/README.md`.

## 3. Начальная схема серверов

| Сервер | Назначение | Минимальная роль |
|---|---|---|
| platform-1 | Сайт, API, бот, worker | Control plane |
| vpn-fi-1 | Legacy ID ноды, которую оператор сообщает мигрированной из Финляндии в Польшу; фактический inventory ожидает аудита | VPN-нода |
| vpn-eu-1 | Амстердам | VPN-нода и резерв |
| backup-storage | Зашифрованные бэкапы БД и конфигураций | Recovery |

До покупки проверяются: разрешённость выбранного вида сервиса правилами провайдера, лимиты трафика, скорость порта, правила жалоб/абьюза, доступность поддержки и география дата-центра. Для снижения общего риска VPN-ноды по возможности размещаются у разных провайдеров.

Оператор сообщил, что тестовая машина, ранее находившаяся в Финляндии под hostname `vpn-fi-01` и ролью `vpn-fi-1`, мигрирована провайдером в Польшу. До изменения inventory, DNS, профиля или внутренних идентификаторов выполняется read-only аудит: это та же или новая VPS, каковы актуальные endpoint/IP/TLS fingerprint, требуется ли новая версия connection profile и сохраняется ли legacy ID `vpn-fi-1` либо нужен контролируемый rename. До закрытия аудита польская consumer-доступность и production-ready статус не заявляются. Это не Platform VPS: API/Postgres на эту машину не ставятся, а runtime Xray вручную не редактируется.

Вторая тестовая VPS приобретена у отдельного провайдера в Амстердаме под роль `vpn-eu-1`: Ubuntu 26.04 LTS, отдельный sudo-пользователь `vpnadmin`, SSH только по ключу, root/password login отключены, UFW разрешает OpenSSH и VPN `443/tcp`, Fail2ban и unattended security updates включены, UTC/NTP исправны, настроен защищённый swap. После контрольной перезагрузки SSH, UFW, Fail2ban и swap восстановились штатно. Docker Engine и Compose plugin установлены из официального репозитория Docker для Ubuntu `resolute`; `vpnadmin` имеет требуемый операционный доступ к Docker socket, который считается root-equivalent и не выдаётся другим пользователям. На ноде развёрнуты Xray и node-agent, TLS 1.3 inbound имеет доверенный сертификат, desired/applied config version синхронизированы. Consumer-проверка Happ на Windows подтвердила полный TUN и выход через Amsterdam; первоначальная ложная отрицательная проверка была вызвана сторонним глобальным ruleset Happ с direct-маршрутом для IP detection. После утечки тестового consumer UUID старое устройство/grant отозваны, replacement grant применён и подтверждён нодой. Node-agent установлен как enabled systemd service с автоматическим восстановлением; localhost API и reverse SSH закрытого теста запускаются задачами Windows при входе пользователя и имеют минутный recovery-trigger, а tunnel runner переподключается после смены сети и принимает оставшийся дочерний SSH под наблюдение после внешнего завершения PowerShell-задачи. Certbot timer дополнен versioned pre/post/deploy hooks: standalone ACME временно открывает и затем закрывает UFW `80/tcp`, renewed certificate/key проходят проверку срока, hostname и пары ключей, а Xray reload имеет serving-check и rollback. Отрицательный mismatch-тест, deploy текущей пары и staging renewal dry-run пройдены. Контрольная перезагрузка после полного rollout подтвердила автоматическое восстановление Docker-контейнеров Xray/proxy, public TLS `443`, localhost reverse forward, systemd node-agent, Certbot timer и свежего control-plane heartbeat без ручного изменения runtime. Контур по-прежнему зависит от включённого ноутбука и не заменяет production HTTPS origin. До настройки независимого production control plane нода остаётся закрытым тестовым data plane, а не production-ready резервом. Публичный IP и credential material в Git не фиксируются.

Bootstrap в репозитории: production adapter `NODE_AGENT_MODE=xray`, отдельные harness-команды `pnpm vpn-fi:bootstrap` и `pnpm vpn-eu:bootstrap`, параметризованный `infra/docker-compose.vpn-node.yml`, runbook `infra/vpn-node/README.md`. До аудита миграции legacy harness сохраняет `vpn-fi-1`/`var/vpn-fi-01`; Amsterdam использует независимые `vpn-eu-1`/`var/vpn-nl-01`, поэтому подготовка второй ноды не меняет endpoint или credentials первой. Страна не выводится из legacy ID. Идемпотентный повтор не обновляет immutable public config; изменение TLS/display требует новой версии profile. Agent на VPS тянет desired state по HTTPS к control plane. Для закрытого Amsterdam-теста используется localhost-only TLS proxy поверх reverse SSH к Windows API: control-plane API не публикуется в интернет, а публичными остаются только SSH и VPN `443/tcp`. Reload Xray выполняется полным Compose restart, потому что ручной `kill -s HUP` может оставить контейнер остановленным.

## 4. Контейнеры первого деплоя

```text
platform-1
├── reverse-proxy      HTTPS, маршрутизация доменов
├── web                личный кабинет и админка
├── api                авторизация, тарифы, подписки, платежи, subscription API
├── bot                Telegram webhook/long polling
├── worker             очереди, платежи, ноды, уведомления
├── postgres           временно допустимо для закрытой беты
└── redis              очередь и краткоживущий кеш
```

Xray разворачивается на каждой VPN-ноде отдельно. Рядом работает node agent: он получает желаемую конфигурацию, применяет её, хранит локальные сроки действия устройств и отправляет подтверждение версии обратно в control plane. Боевая runtime-конфигурация не редактируется вручную на сервере.

Versioned production-shaped deployment control plane находится в `infra/docker-compose.production.yml`, а runbook — в `infra/platform/README.md`. Manifest публикует только Caddy `80/tcp` и `443/tcp`; web/API используют отдельную edge network, PostgreSQL/Redis — internal data network без host ports, API/worker и будущий bot получают исходящий service network без опубликованного входа. Bot не подключается к data network и не получает прямой доступ к PostgreSQL/Redis. Xray в manifest отсутствует. Caddy маршрутизирует root/app/api/sub из deployment environment, направляет `/api/*` кабинета напрямую в API, не обслуживает subscription bearer path на общем API-origin и редактирует `/sub/<token>`, credentials и raw client address fields в runtime logs. Application и официальные infrastructure images задаются immutable digest references. Одноразовый `migrate` выполняет только forward-only `prisma migrate deploy`; API и worker зависят от его успешного завершения. Неактивный bot scaffold остаётся opt-in profile и в production не запускается.

При включении bot внутренний bot→API transport остаётся `http://api:3001` в `egress`; Docker network не считается TLS, поэтому application-контракт использует HMAC. Network topology и Caddy для этого решения не меняются. Secret wiring обязан передавать `BOT_SIGNING_KEK` только API, а plaintext signing key текущего credential — только bot; web, worker и migrate не получают ни один из них. Bot принимает Telegram webhook, API не получает bot token и не становится Telegram edge. Перед `prisma migrate deploy` application migration wrapper обязательно запускает read-only `admin:check-legacy-admin`; host preflight эту DB-проверку не заменяет.

Наличие manifest не означает выполненный deployment. До первого запуска обязательны зарегистрированный/делегированный домен, проверенные release images, отдельный этап production secrets, автоматический зашифрованный backup в другом failure domain и restore drill. `production.env.example` является только non-secret render/test fixture и запрещён как production configuration.

Первая проверенная партия четырёх application release images опубликована в GHCR из clean commit `031109009a2fc9f65de039976e3a2e99a242c58e`; источником deployment references служит сохранённый GitHub Actions artifact с точными `@sha256`. Это закрывает только image prerequisite и не разрешает deployment до завершения secrets, backup/restore и DNS/HTTPS preconditions.

## 5. Домены и сетевые правила

| Домен / зона | Назначение |
|---|---|
| `mymeteora.ru` | Минимальная публичная информационная и юридическая страница |
| `app.mymeteora.ru` | Личный кабинет и `/admin` в том же web-приложении |
| `api.mymeteora.ru` | API платформы и Telegram webhook |
| `sub.mymeteora.ru` | Персональные subscription URL устройств |
| `status.mymeteora.ru` | Публичный статус, после MVP |

- Покупка `mymeteora.ru` оператором подтверждена. На 2026-09-02 корень и `www` разрешаются в парковочный адрес Timeweb `92.53.96.169`, а release-записи `app`, `api` и `sub` ещё отсутствуют. До их контролируемого переключения на `platform-1` DNS и HTTPS не считаются production-ready. Домены остаются конфигурацией deployment и не хардкодятся в application logic.
- Корневой домен не требует отдельного маркетингового сервера: тот же web deployment отдаёт короткое честное описание сервиса, тариф, порядок выдачи после оплаты, кнопку Telegram, контакты/реквизиты, оферту, privacy и правила возврата.
- HTTPS обязательно для всех публичных доменов.
- Админка дополнительно ограничивается по сети (по возможности IP allowlist для первых администраторов). Роли, 2FA и audit: `vpn-application-implementation-tz.md`, разделы [5](vpn-application-implementation-tz.md#5-api-и-авторизация) и [10](vpn-application-implementation-tz.md#10-application-level-security-invariants).
- Доступ к PostgreSQL и Redis закрыт из публичного интернета.
- Доступ к VPN-серверам — по SSH-ключам; парольный вход отключён.
- Секреты хранятся только в секретном хранилище окружения; `.env` не коммитится.
- Доступность VPN inbound проверяется с целевых пользовательских сетей, а не только с control plane или служебного VPN. Если клиентские TCP-соединения остаются в `SYN_SENT`, а синхронный `tcpdump` на VPN-ноде не видит эти SYN при исправных listener, firewall и Docker publish/NAT, отказ считается внешним routing/filtering blocker провайдера до его устранения или замены публичного IP/ноды. Домен, указывающий на тот же заблокированный IP, этот отказ не устраняет.

## 6. Автоматизация инфраструктуры

### Обязательный минимум

- Docker Compose для первого окружения;
- CI: проверка типов, линтер, тесты, сборка образов;
- CD: ручное подтверждение боевого развёртывания, миграции БД до запуска новой версии;
- отдельные окружения `development`, `staging`, `production`;
- инфраструктурная конфигурация в Git (например, Terraform/Ansible) до появления множества нод.

### Что можно хранить в Git

- IaC;
- declarative templates;
- schemas;
- non-secret defaults;
- deployment definitions;
- versioned desired-state templates без secret material.

Версионирование конфигураций нод означает именно эти артефакты и их резервные копии, а не хранение боевых секретов в репозитории.

Локальный режим `NODE_AGENT_MODE=local-xray` использует versioned template `infra/xray-local/config.template.json` без client UUID и ключей. Материализованный runtime-конфиг и TLS-сертификаты живут только в защищённом local state (`var/xray-local/{a,b}/`, gitignored). Production VPS (`NODE_AGENT_MODE=xray`) использует `infra/xray-production/config.template.json` и отдельный gitignored state `var/<node-state-directory>/`; значение задаётся `VPN_NODE_STATE_DIRECTORY` с совместимым default `vpn-fi-01`, Amsterdam использует `vpn-nl-01`. TLS inbound — сертификат оператора. Credential-bearing runtime-файл имеет mode `0640`, группу непривилегированного Xray-контейнера и наследует её из setgid-каталога при атомарной замене; world-readable runtime state запрещён. Production template включает Xray `HandlerService` только на loopback внутри контейнера; port не публикуется Compose. После reload node-agent с уже требуемым доступом к Docker выполняет read-only сверку активных VLESS users через `docker exec`; failure, лишний, отсутствующий или старый user запрещает продвижение applied version и acknowledgement. Идентификаторы grants и credentials в тексты ошибок и логи этой проверки не попадают. Runbook bootstrap: `infra/vpn-node/README.md`. Опциональный Compose-контур `infra/docker-compose.xray-local.yml` поднимает два раздельных localhost Xray-инстанса (разные порт, runtime-конфиг и node-agent state), отдельно от API/Postgres, и не является боевой VPN-нодой на Platform VPS.

Versioned systemd unit node-agent создаётся только валидируемым параметризованным renderer: project root и Node executable передаются абсолютными POSIX paths, state directory — отдельным leaf name, service user/group и Docker group — допустимыми Linux names. Service identity и обе указанные группы обязаны разрешаться в ненулевые UID/GID; имя `root`, UID/GID `0`, их алиасы и унаследованный GID `0` запрещены. `SupplementaryGroups=` добавляет Docker group, но не очищает memberships service user из системной user/group database. Installer не заявляет строгую очистку групп: если она требуется, оператор использует отдельного service user без `sudo`, `adm` и иных необязательных memberships и повторно проверяет их после изменений host identity. Ни страна, ни state directory, ни домашний каталог, ни версия Node не хардкодятся в unit или installer. Systemd является единственным владельцем lifecycle установленного agent. Наличие legacy PID marker блокирует установку и не разрешает автоматически посылать сигнал PID: переиспользованный PID может принадлежать другому процессу. Такой процесс проверяется оператором по executable, UID и command line вне installer; marker удаляется только после подтверждённого завершения legacy agent. Offline renderer mode не обращается к `/etc`, systemd или ноде и покрывается fixtures для Finland, Amsterdam и произвольного state directory; output path также проходит строгую absolute-POSIX-path validation.

Все versioned Compose manifests проходят отдельный offline `docker compose config` guard в локальной проверке и CI с фиксированным non-secret env fixture. Production control-plane guard дополнительно запрещает host ports у всех сервисов, кроме `80/tcp`/`443/tcp` reverse proxy, требует internal data network, отсутствие Xray, immutable image digests, fail-closed migration dependency, fixed trusted proxy identity и opt-in inactive bot. Privileged containers, host network/PID namespace и Docker socket mounts запрещены. Production Xray container имеет Compose healthcheck через loopback-only Handler API: probe проверяет доступность inbound и не публикует служебный port наружу. Этот healthcheck является наблюдаемым container signal и не заменяет node-agent serving verification перед acknowledgement. Все versioned Bash-скрипты под `infra/` проверяются закреплённым по digest ShellCheck, а PowerShell-скрипты — строго заданной версией PSScriptAnalyzer; новые скрипты автоматически входят в recursive scope. Application images `web`, `api`, `worker` и `bot` собираются из одного multi-stage Dockerfile на закреплённом по digest Node base, содержат только production runtime, работают от непривилегированного пользователя и проходят CI smoke. API runtime image отдельно сохраняет Prisma schema/migrations и production Prisma CLI для одноразового forward-only migration service; обычный API CMD остаётся неизменным. Web rewrite `/api/:path*` фиксируется Next.js во время build: обязательный для development и build `WEB_API_PROXY_TARGET` и одноимённый Docker argument принимают только HTTP(S) origin без credentials/path/query/fragment; production origin или IP задаётся build environment и не хранится в Git. CI использует только test-only origin Docker network. Install и три backend deploy используют один BuildKit pnpm-store cache. Frozen install остаётся обязательным; принудительный `deploy --offline` не применяется, поскольку legacy deploy дополнительно запрашивает registry metadata для peer dependency resolution даже при заполненном content-addressable store. Clean image получает OCI revision текущего HEAD; local dirty build не выдаёт себя за этот commit, а получает явные source-state/head/fingerprint labels и dirty OCI revision. CI перед image build требует clean checkout и точное совпадение HEAD с `GITHUB_SHA`. Smoke принимает только images с build-id и provenance последнего завершённого build, запускает их штатные CMD в отдельной случайной Docker network, проверяет API liveness, inactive worker/bot exit `0`, web root и реальный web-to-API proxy. Каждый созданный resource регистрируется до запуска, удаление и post-condition отсутствия проверяются отдельно; cleanup failure делает smoke неуспешным и сохраняется вместе с исходной ошибкой. Перед успешным сценарием smoke реально инъецирует failure после старта API/web и требует полного cleanup без утечек. Release publication использует отдельный GitHub Actions workflow только для ручного запуска с `main` или тега `platform-v*`: scoped `GITHUB_TOKEN` публикует в GHCR только clean-source images после smoke, а artifact отдаёт оператору точные `@sha256` references. Обычный branch push ничего в registry не публикует; deployment запрещает использовать mutable tag как image reference. Node-agent остаётся отдельным host-level systemd process на VPN-ноде и в application image не включается.

### Что нельзя хранить в Git

- private keys;
- production credentials;
- bearer secrets;
- subscription tokens;
- пользовательские VPN credentials;
- runtime access lists с секретными значениями;
- production secret material;
- любые секреты нод или пользователей.

Production control-plane secrets создаются только вне checkout в root-owned
`/etc/meteora/platform.env` mode `0600`. Versioned initializer принимает
отдельный non-secret config и root-only Telegram token, генерирует независимые
PostgreSQL password и peppers, проверяет точные immutable image references и
согласованность service URL, затем создаёт env атомарно без права overwrite.
Test fixtures и unknown/duplicate keys отклоняются; содержимое env не печатается.
Автоматическая регенерация/ротация запрещена: peppers участвуют в проверке
сессий, subscription URL и credentials, поэтому rotation является отдельным
совместимым rollout. После инициализации обязательна независимая зашифрованная
recovery-копия с проверкой расшифрования. Реализация и runbook:
`infra/platform/secrets/README.md`. Наличие tooling в Git не закрывает
production prerequisite до фактической validation и recovery check.

Ротируемые bot credentials не добавляются в общий one-shot `platform.env`. API-only `BOT_SIGNING_KEK` хранится отдельным root-owned secret с доступом только API; plaintext signing key — отдельным bot-only secret file. Provisioning/rotation выполняет versioned CLI без secret в argv, Git или логах: новый ключ доставляется только bot, bot перезапускается/перезагружается, после overlap старый credential отзывается. На production host используются разные безучастниковые системные группы с фиксированными GID: KEK `root:meteora-api-secret` (`29001`, mode `0440`), bot credential `root:meteora-bot-secret` (`29002`, mode `0440`) и его каталог mode `0750`. Compose монтирует каждый файл отдельным read-only bind mount с `create_host_path: false` и выдаёт контейнеру только нужную supplementary group; только opt-in one-shot `bot-credential-admin` временно получает PostgreSQL, read-only KEK и writable bind выделенного bot-only directory для атомарной установки файла, но не общий каталог остальных platform secrets. Он не публикует ports, не имеет egress и после операции удаляется. Runbook обязан проверять владельца/mode файлов, отсутствие обоих секретов у web/worker/migrate и fail-closed startup API/bot при неверном wiring.

### Запрещено

- вручную править боевую runtime-конфигурацию без версионируемой задачи control plane и фиксации несекретного desired state;
- менять базу данных вручную без миграции;
- использовать продовые секреты локально или в тестах;
- направлять пользовательский VPN-трафик через Platform VPS;
- запускать `NODE_AGENT_MODE=simulation` или `NODE_AGENT_MODE=local-xray` при `NODE_ENV=production` — оба режима не являются боевым data-plane adapter;
- запускать `NODE_AGENT_MODE=xray` вне `NODE_ENV=production` — production adapter только на VPS.

## 7. Ноды и оркестратор

Каждая физическая нода регистрируется в базе: страна, провайдер, ASN/failure domain при наличии, мощность, лимит трафика, lifecycle-статус, желаемая и применённая версии конфигурации. Сетевые endpoints и профили подключения являются отдельными заменяемыми ресурсами и не отождествляются с VPS.

Состояния ноды: `provisioning → healthy → draining → disabled → deleted`. От этой цепочки ответвляется аварийное состояние `quarantined` (emergency disable); оно не является обычным `disabled` и не является availability-состоянием `QUARANTINED` у endpoint/profile.

- `healthy`: выдаётся пользователям;
- `draining`: новых пользователей не получает; существующий VPN-доступ на ноде не обрывается немедленно, пользователи переводятся постепенно;
- `disabled`: полностью исключена из новой выдачи и assignment в subscription API; уже выданный VPN-доступ автоматически не отзывается. Нода остаётся в access-control synchronization, пока node agent доступен: revoke, уменьшение/истечение `expires_at`, credential revocation;
- `quarantined` (emergency disable): исключена из выдачи и принудительно прекращает VPN-serving / revoke-all. Это не availability-состояние `QUARANTINED` у endpoint/profile;
- `deleted`: сервер удалён после сохранения аудита; в синхронизации доступа больше не участвует.

Lifecycle-статус ноды не используется как единственный показатель доступности VPN. Heartbeat node agent, состояние VPS, VPN-процесса, endpoint, connection profile и региональная доступность измеряются и хранятся раздельно.

Application-контракт desired state / ack / outbox: `vpn-application-implementation-tz.md`, разделы [6](vpn-application-implementation-tz.md#6-данные-транзакции-и-outbox)–[8](vpn-application-implementation-tz.md#8-правила-работы-с-нодами-на-уровне-приложения).

### 7.1. Устойчивость data plane к сетевой деградации

Критический архитектурный инвариант: система не должна зависеть от одного VPN-протокола, transport profile, IP-адреса, ASN, VPS-провайдера или географического региона. Пользователь приобретает доступ к восстанавливаемому пулу соединений, а не к конкретному серверу. Изменение инфраструктуры не требует перевыпуска пользовательского subscription URL.

Требование описывает технологически нейтральную устойчивость. Конкретные параметры протоколов и способы настройки data plane выбираются и проверяются отдельно; они не хардкодятся в пользовательской, платёжной или subscription-модели.

Выбор протоколов, transport profiles и клиентских решений ведётся по принципу наиболее надёжного доступного варианта на момент rollout. Базовый MVP использует текущую связку Happ + Xray/VLESS только пока она подтверждена end-to-end тестами и не мешает добавить другой `ConnectionProfile`. Перед production rollout или крупной заменой профиля оператор фиксирует read-only market/compatibility check: активная поддержка upstream, совместимость Happ и целевых ОС, безопасность secret handling, устойчивость из целевых пользовательских сетей, показатели скорости/latency/disconnects, возможность staged rollout/rollback и отсутствие ручного изменения runtime-конфигурации. Экспериментальный или новый профиль сначала проходит test node, ограниченный canary и probes; он не становится единственным production-вариантом до устойчивого периода наблюдения. Маркетинговые заявления провайдера, популярность панели управления или единичный успешный локальный тест не считаются достаточным доказательством надёжности.

Допустимые семейства candidate profiles включают, но не ограничиваются: Xray-core как runtime для VLESS; VLESS поверх raw TCP/TLS; VLESS поверх raw TCP/REALITY; VLESS поверх XHTTP/TLS или XHTTP/REALITY; gRPC-based VLESS/TLS или VLESS/REALITY; а также альтернативные зрелые профили вроде Trojan, Shadowsocks, Hysteria2, TUIC или WireGuard только после отдельной проверки совместимости клиента, эксплуатационной устойчивости и legal/abuse-рисков. `ConnectionProfile` обязан хранить protocol, transport, security, client compatibility, rollout state и version как заменяемые параметры. Конкретные SNI/target, ключи, fingerprints, endpoints, credentials и runtime access lists не фиксируются в Git, публичном API или продуктовой модели.

#### Модель ресурсов

- `Node` описывает физический или виртуальный вычислительный ресурс и его lifecycle. Сетевого адреса в `Node` нет: прежняя свободная колонка `Node.endpoint` удалена после переходного периода.
- `Endpoint` описывает заменяемый адрес подключения: host/IP, порт, IP family, provider, ASN/failure domain, регион и срок активности.
- `ConnectionProfile` описывает protocol, transport, security, совместимость клиента, приоритет, версию и rollout-состояние. Одна нода может обслуживать несколько профилей.
- Доступ пользователя связывается с логическим пулом и device grant, а не с IP-адресом. Subscription API выбирает пригодные endpoints/profiles при каждом обновлении списка.
- Добавление нового типа профиля не требует изменения моделей пользователя, подписки, платежа или устройства.

#### Сигналы здоровья и внешние probes

Health-check является составным и как минимум различает:

1. heartbeat node agent и доступность VPS;
2. состояние VPN-процесса;
3. DNS resolution;
4. доступность IPv4 и IPv6 по отдельности;
5. TCP/transport handshake;
6. VPN authentication/handshake тестовой учётной записью;
7. HTTPS-запрос и небольшой test object через туннель;
8. региональную доступность по независимым внешним probes из целевых сетей.

Probe не получает пользовательские credentials или содержимое трафика. Для проверки используются отдельные ограниченные test credentials с ротацией и отзывом. Результат подписывается или передаётся по аутентифицированному каналу, содержит серверное время приёма и защищён от подмены, replay и неконтролируемого роста данных.

Один отрицательный сигнал не уничтожает VPS и не переводит endpoint сразу в терминальное состояние. Агрегация учитывает кворум независимых probes, окно наблюдения, consecutive failures/successes и отсутствие данных. Недоступность самого probe не считается доказательством блокировки endpoint.

#### Availability-состояния и anti-flapping

Для endpoint/profile отдельно от lifecycle ноды используются состояния `UNKNOWN`, `HEALTHY`, `DEGRADED`, `PARTIALLY_BLOCKED`, `QUARANTINED`, `BLOCKED`, `OFFLINE` и `DISABLED`.

- Пороговые значения, окно наблюдения, cooldown, minimum healthy interval, failure threshold и recovery threshold задаются конфигурацией, а не кодом.
- Деградация у одного оператора не отключает endpoint для всех сетей, если subscription-клиент и доступные сигналы позволяют безопасно выбрать другой маршрут.
- `QUARANTINED` прекращает новую выдачу, но сохраняет ресурс для диагностики и повторных probes. Это availability-состояние endpoint/profile, а не аварийное emergency disable ноды: последнее принудительно прекращает существующий VPN-доступ.
- Возврат в пул требует устойчивого периода успешных проверок; единичный успех не вызывает обратное переключение.
- Физическое удаление VPS является отдельной подтверждаемой операцией с audit log и не запускается только по health-check.

#### Failover, staged rollout и Emergency Mode

- Исключение или замена endpoint/profile выполняется перестроением ответа существующего subscription URL; новый пользовательский секрет не выпускается.
- Control plane поддерживает резервную мощность в независимых failure domains и не размещает весь обязательный пул у одного provider/ASN или в одном регионе.
- Новая версия connection profile или data-plane software проходит test node, внутренние probes, canary, наблюдение и поэтапное расширение. Массовое одновременное обновление без отдельного решения запрещено.
- Рост connection/handshake failures, latency или disconnect rate останавливает rollout и допускает автоматический rollback к последней подтверждённой версии.
- Глобальный режим эксплуатации имеет состояния `NORMAL`, `DEGRADED` и `EMERGENCY`. Переход в `EMERGENCY` аудируется, прекращает выдачу проблемных ресурсов, активирует заранее подготовленный резерв, повышает частоту probes в безопасных пределах, перестраивает subscription feed и отправляет алерт администратору.
- Автоматический Emergency Mode требует кворума и anti-flapping; администратор имеет защищённый ручной override с причиной, сроком действия и audit log.

### Синхронизация и отзыв доступа

Продуктовые SLA (локальный `expires_at`, 5 минут на отзыв): `vpn-service-tz.md`, разделы [3](vpn-service-tz.md#окончание-подписки-и-отзыв-устройства) и [8](vpn-service-tz.md#8-нефункциональные-требования). Application outbox: `vpn-application-implementation-tz.md`, раздел [6](vpn-application-implementation-tz.md#6-данные-транзакции-и-outbox).

- Control plane хранит желаемое состояние доступа, нода — последнюю подтверждённую версию.
- Каждый платёж, окончание подписки, отзыв или добавление устройства создаёт sync job для нод, которые ещё участвуют в access-control: `healthy`, `draining` и доступных `disabled`, пока они способны принимать существующие VPN-подключения. `disabled` запрещает новую выдачу, но не исключает ноду из этой синхронизации. `quarantined` получает аварийный revoke-all / прекращение serving, а не обычный набор assignment jobs. `deleted` в синхронизации не участвует. Job ставится через transactional outbox после commit PostgreSQL-транзакции, а не вызовом Redis внутри этой транзакции.
- Node agent применяет изменения идемпотентно, подтверждает версию и повторно запрашивает конфигурацию после ошибки. Для production Xray применённой считается только версия, чей ожидаемый access list после reload точно совпал с активными users, прочитанными из памяти процесса через закрытый container-local management API; совпадение runtime-файла и exit code restart недостаточны. Локальный `local-xray` adapter доказывает apply/revoke/expiry на localhost Xray; два localhost-инстанса используются только как прототип заменяемых нод и не заменяют боевую VPS. Control-plane pull/ack/heartbeat открыты для `healthy`, `draining`, доступных `disabled` и аварийных `quarantined`. Новая выдача остаётся только на `HEALTHY`. Обычные access-control jobs — на `healthy`, `draining` и доступных `disabled`. `quarantined` получает аварийный revoke-all / прекращение serving одной control-plane операцией, а не набор новых assignment jobs. Возврат в serving state (`healthy`) запрещён, пока `desiredConfigVersion > appliedConfigVersion`.
- Node versions строго монотонны. Snapshot ниже durable applied version считается downgrade и отклоняется; та же version с другим snapshot hash считается collision и переводит применение в fail-closed. Exact same-version/hash replay pending-команды после потерянного ответа не выполняет лишний reload, но повторяет тот же идемпотентный ACK. Уже подтверждённый полный snapshot той же version без pending acknowledgement допускает verified recovery без нового ACK. ACK содержит только `nodeSyncJobId`, `targetVersion` и `snapshotHash`; `nodeId` выводится из аутентифицированной credential, а отсутствие ACK означает failure. Запоздавшая меньшая version не может уменьшить `appliedConfigVersion`.
- PostgreSQL snapshot, а не очередь или порядок событий, определяет expected state. Reconciliation при переходе в `HEALTHY` и периодический repair не реже раза в минуту заново вычисляют его, создают только более новую node version и не восстанавливают устаревший grant. `DRAINING` и обычный `DISABLED` сохраняют ранее назначенный доступ и security sync; только `QUARANTINED` означает emergency revoke-all.
- Локальное применение `expires_at` разрешено только при доверенных часах. Production clock source — chrony. Node-agent запускает только `/usr/bin/chronyc` с фиксированными аргументами `-c tracking` (CSV, без shell, без sudo, без `-h` и без удалённого chronyd). Fallback на `timedatectl`, наличие пакета/сервиса или `Date.now()` недостаточны. CSV `chronyc` 4.6.x содержит 14 полей; для расчёта используются signed system time (поле 5), root delay (поле 11), root dispersion (поле 12) и leap status (поле 14). Reference ID используется только для fail-closed отклонения chrony local/orphan sentinel `7F7F0101` (без учёта регистра) и никогда не логируется. IP, hostname и имя NTP-сервера не участвуют в решении и не логируются. Доверенные leap states ровно `Normal`, `Insert second` и `Delete second`; `Not synchronised`, local/orphan sentinel и любое иное значение — untrusted. Оценка: `estimatedAbsoluteErrorMs = (abs(systemTimeOffsetSeconds) + rootDispersionSeconds + 0.5 * rootDelaySeconds) * 1000` без округления вниз. `error <= 30_000` ms — trusted; `error > 30_000` ms — untrusted. NaN, Infinity, отрицательные root delay/dispersion, пропущенное или лишнее поле, missing `/usr/bin/chronyc`, non-zero exit, timeout, malformed output, недоступный локальный chronyd и невозможность получить числовую оценку — fail-closed. Untrusted clock немедленно вызывает существующий fail-closed, ACK не отправляется, process restart не обходит проверку. Docker, Certbot deploy-hook и любой иной автоматический restart не возобновляют production Xray сами: сервис имеет `restart: "no"`, но явный `compose up`/`restart` всё равно обходит guard, поэтому штатный `vpn-node:up` поднимает только control-plane-proxy, а прямой start Xray — только отдельно названный break-glass. Systemd `ExecStartPre` останавливает контейнер и подтверждает отсутствие running Xray успешным пустым `docker ps`. Certbot после замены TLS делает тот же verified stop и `systemctl restart` node-agent, затем deploy-hook ждёт совпадение live TLS fingerprint с lineage по монотонному 120-секундному deadline (каждый probe ограничен remaining time) и только после этого печатает `XRAY_TLS_DEPLOYED`; timeout возвращает ненулевой код и не поднимает Xray. Periodic reconcile не пропускает reload по cached fingerprint, если runtime фактически не serving. Если перед reload serving не подтверждён (`isServing` false или ошибка probe) и последующий reload/read-back падает, node-agent вызывает существующий `failClosed` и не оставляет контейнер, уже поднятый reload-командой. Serving возобновляет только node-agent после trusted clock и прежнего verified reload/read-back. Installer TLS renewal дополнительно проверяет тот же fingerprint, а не Docker `running`. Потеря control plane при trusted clock и valid durable state сохраняет selective serving. Resume только после trusted clock → verified reload/reconcile → read-back → durability barrier. Режимы `simulation` и `local-xray` chronyc не вызывают. Clock health наблюдается без host/user identifiers и без числового skew как high-cardinality label.
- Selective fail-closed различает потерю control plane и потерю доверенного local state. При исправном durable snapshot нода сохраняет VPN-serving во время control-plane outage и сама применяет сроки. Каждые 10 секунд node-agent повторно читает state и проверяет schema, SHA-256 snapshot hash, совпадение persisted/snapshot version и строгий порядок `previous < current`, не выполняя reload при неизменном access list. Missing, malformed, schema-valid inconsistent, `EACCES`/`EIO` и любой иной unreadable state считаются недоверенными и немедленно останавливают Xray; старый runtime access list не считается разрешением. Recovery допускается по полному snapshot, который control plane уже считает applied (`desiredConfigVersion = appliedConfigVersion`), с обязательным reload/read-back, durable write и без фиктивного acknowledgement. Ошибка write, rename либо file/directory fsync после verified reload снова принудительно останавливает Xray; local reconcile перед resume обязан успешно повторить file и parent-directory fsync, поэтому видимый после failed rename-durability файл сам по себе не считается barrier.
- Security-critical retry отделён от обычного HTTP poll interval: failed production Xray cycle, `waiting-for-command` и local reconcile повторяются не реже чем каждые 10 секунд, а успешный production poll ограничен максимум 60 секундами без изменения env-схемы. На один production apply резервируется до 30 секунд reload и до 49 секунд read-back; fail-closed reserve увеличен до 120 секунд и включает до 6 секунд на lookup, общий stop нескольких matching containers и post-condition probe. Для локального `expires_at` deadline берётся из durable snapshot; для revoke — из `revokedAt` полученной версии относительно ранее serving grant. Snapshot с version gap без matching command не применяется и не получает acknowledgement. Его revoke policy до вызова runtime stop записывается через temp-file, file fsync, atomic rename и parent-directory fsync в `${NODE_AGENT_STATE_FILE}.stop-only.json` mode `0600`; sidecar schema содержит `formatVersion`, `targetVersion`, earliest enforcement deadline и canonical revoked grant IDs, но не credentials. При missing/unreadable основном state marker строится консервативно по всем `REVOKED` grants полного snapshot. Наличие valid, corrupt или unreadable marker немедленно блокирует local resume после process restart. Ошибка durable-записи marker вызывает fail-closed и не скрывается. Marker удаляется и directory-fsync подтверждается только после verified full apply, durable main envelope и проверки, что отмеченные grants отсутствуют в serving access list. Если удаление credential ещё не подтверждено, node-agent через существующий закрытый Docker access останавливает все Xray containers с точными Compose project/service labels и отдельным запросом подтверждает отсутствие running containers. Остановленная нода продолжает retry безопасного access list и возвращает serving только после точного совпадения active users.
- Не подтверждённая в установленный срок задача вызывает алерт и остаётся pending. Недоступная нода не возвращается в serving state (`healthy`), пока pending access updates не reconciled. Вывод в `deleted` прекращает участие в синхронизации.
- Нода локально прекращает доступ устройства по `expires_at`; она не считает subscription URL источником разрешения подключаться.
- Предусмотрен безопасный rollback на предыдущую подтверждённую версию конфигурации.
- Обязательные convergence metrics: число нод с `desiredConfigVersion > appliedConfigVersion`, возраст старейшей pending version, распределение desired/applied gap, failed applies, reconciliation repairs, clock synchronization failures/skew и число действующих entitlement без ready route. Пользовательские, device и credential identifiers запрещены в labels.

## 8. Бэкапы, логи и наблюдаемость

| Что | Правило |
|---|---|
| PostgreSQL | Ежедневный бэкап + тест восстановления по расписанию |
| Несекретные конфигурации нод | Версионируются как IaC/templates и резервируются; секреты — только в secret storage |
| Логи эксплуатации | Только необходимые технические агрегаты с маскированием секретов, URL-токенов, raw IP/port metadata и прямых UUID/ID |
| Метрики | API error rate, очередь, webhook errors, CPU/RAM/disk, трафик, здоровье нод |
| Алерты | Недоступность API, отставание очереди, падение ноды, место на диске, неуспешные бэкапы |

PostgreSQL backup выполняется ежедневно через `pg_dump --format=custom` и сразу
передаётся в зашифрованный restic repository без plaintext dump на host disk.
Repository размещается в отдельном failure domain, предпочтительно у другого
провайдера/в другом российском ДЦ; его credentials ограничены отдельным bucket,
а пароль шифрования имеет независимую офлайн-копию. Retention: 14 daily, 8
weekly и 12 monthly snapshots. После каждого backup выполняется repository check
с чтением 5% data packs. Раз в месяц последний snapshot с выделенным тегом
восстанавливается в одноразовый PostgreSQL без сети, host ports и persistent
volume; проверяются наличие пользовательских таблиц и завершённость Prisma
migrations. Production volume этим drill не изменяется. Versioned реализация и
runbook: `infra/platform/backup/README.md`. Требование считается выполненным
только после фактической настройки offsite repository и успешного restore drill,
а не по наличию скриптов в Git.

Состав запрещённых для логов значений: `vpn-application-implementation-tz.md`, раздел [10](vpn-application-implementation-tz.md#10-application-level-security-invariants). Для эксплуатации достаточно технических агрегатов: нода, время, ошибка, объём, число подключений и идентификатор устройства в псевдонимизированном виде.

Для data plane обязательны клиентские SLI: `connection_success_rate`, `handshake_success_rate`, `median/p95_connect_time`, `disconnect_rate`, `regional_success_rate`, `node_availability` и `profile_success_rate`. Они агрегируются по node, endpoint, profile version, provider/failure domain, региону, IP family и probe network без хранения содержимого пользовательского трафика или полного пользовательского IP. Низкая кардинальность меток и сроки хранения задаются заранее.

Административный overview обязан сводить без SSH: состояние platform services; status/heartbeat/serving/clock/TLS нод; desired/applied convergence; jobs и возраст pending delivery; Telegram webhook и платёжные webhook/reconciliation; subscription delivery и revoke SLA; результаты бэкапов и последнего restore drill; активные incidents/alerts. Node view дополнительно показывает profiles, capacity/resources, grants, jobs и runtime facts, но не credentials и не редактор Xray-конфигурации.

## 9.1. Эксплуатация и аварийные сценарии

| Событие | Обязательная реакция |
|---|---|
| Нода недоступна | Исключить из выдачи, поднять алерт, начать замену, не менять URL пользователей |
| Частичная региональная деградация | Карантинизировать затронутый endpoint/profile для проблемной сети, сохранить остальные маршруты и запустить дополнительные probes |
| Массовая деградация provider/ASN/региона | Перейти в Emergency Mode, активировать независимый резерв и перестроить subscription feed без смены URL |
| Ошибка новой версии profile/software | Остановить staged rollout и откатиться к последней подтверждённой версии |
| Жалоба провайдера | Зафиксировать тикет, ограничить/вывести ноду из пула по процедуре, не принимать решения по одному скриншоту пользователя |
| Недоступен Platform VPS | VPN-ноды продолжают применять локальный срок доступа; восстановить control plane из IaC и бэкапа |
| Недоступен Telegram | VPN продолжает работать; кабинет остаётся доступен для активной веб-сессии, поддержка использует резервный канал |
| Задержан webhook | Заказ остаётся `pending`, worker сверяет статус у эквайринга; доступ не выдаётся до подтверждения. Продуктовые правила оплаты: `vpn-service-tz.md`, раздел [6](vpn-service-tz.md#6-платёжный-контур-обязательные-правила) |
| Утечка ссылки устройства | Немедленно отозвать устройство, выпустить новую ссылку только по явному действию пользователя/поддержки |

## 9.2. Трафик и ресурсы

- Вместимость ноды рассчитывается по трафику, пропускной способности и пиковым одновременным подключениям, а не по количеству аккаунтов.
- До публичного запуска стартового тарифа проводится нагрузочный тест и расчёт себестоимости с учётом эквайринга, резервных нод, бэкапов и поддержки. Актуальная цена: `vpn-service-tz.md`, раздел [2](vpn-service-tz.md#2-границы-первой-версии).
- Пользовательские условия описывают разумное личное использование; фактические численные лимиты утверждаются только после тестов и юридической проверки.
- Ноды не перегружаются выше согласованного порога; оркестратор перестаёт выдавать переполненную ноду новым устройствам.

## 10. Порог масштабирования

| Сигнал | Следующее действие |
|---|---|
| API / кабинет начинают упираться в один сервер | Поднять второй экземпляр API за балансировщиком |
| Очередь растёт или платежи задерживаются | Вынести worker на отдельный сервер |
| База требует больше ресурсов/надёжности | Перевести PostgreSQL в managed DB или выделить отдельный DB-сервер с репликацией |
| Нод много | Terraform/Ansible + автоматическая регистрация и конфигурация нод |
| Subscription API нагружен | Вынести отдельно, добавить Redis cache и rate limit |
| Появляются десятки тысяч активных пользователей | Ввести capacity planning по трафику, multi-region pools и резерв мощности |

Kubernetes не является требованием MVP. Его рассматривать только при устойчивой нагрузке и реальной потребности в автоматическом масштабировании множества сервисов.

## 11. Чек-лист перед закрытой бетой

- [ ] Домен и HTTPS работают.
- [x] Покупка `mymeteora.ru` оператором подтверждена.
- [ ] Root/app/api/sub направлены на production control plane, HTTPS проверен, а `status` включается только при готовности.
- [ ] `platform-1` находится в российском ДЦ, не содержит Xray, PostgreSQL/Redis не опубликованы наружу, а backup хранится отдельно и зашифрован.
- [ ] Read-only аудит мигрированной в Польшу ноды закрыл inventory, endpoint/IP/TLS, profile version и решение по legacy ID `vpn-fi-1`.
- [ ] Есть минимум две независимые VPN-ноды.
- [ ] Subscription URL не меняется при отключении одной ноды.
- [ ] Работают мониторинг и алерт о падении ноды.
- [ ] Есть бэкап PostgreSQL и успешно проведено тестовое восстановление.
- [ ] Webhook платежа проверяется сервером и идемпотентен.
- [ ] Админка закрыта ролью и 2FA.
- [ ] Секреты отсутствуют в Git и логах.
- [ ] Есть ручной сценарий поддержки: найти пользователя, заказ и платёж, проверить доступ, безопасно продлить подписку.
- [ ] Истёкшая подписка и отозванное устройство блокируются не позднее чем за 5 минут на `healthy`, `draining` и доступных `disabled`-нодах, которые ещё принимают существующие VPN-подключения.
- [ ] Синхронизация нод имеет подтверждение версии, повторную доставку и rollback.
- [ ] Протестирована утечка URL: отзыв одного устройства не отключает остальные.
- [ ] Проведена аварийная тренировка для падения ноды, control plane и задержки webhook.
