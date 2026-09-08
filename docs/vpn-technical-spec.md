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
origins с явно переданным IPv4 `platform-1`. Для IPv4-only deployment проверка
независимо от локальной IPv6-конфигурации отклоняет любой native AAAA. Она
проверяет TCP и UDP listeners: публично разрешён только TCP SSH `22`, остальные
listeners допустимы только на loopback. UFW обязан иметь точный default deny
incoming, allow outgoing и deny/disabled routed, а таблица правил — только один
rate-limited IPv4 SSH rule и не более одного соответствующего IPv6 rule; любые
дополнительные IN/OUT/FWD rules запрещены. Проверка ничего не исправляет и не
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

До покупки проверяются: разрешённость выбранного вида сервиса правилами провайдера, лимиты трафика, скорость порта, правила жалоб/абьюза, доступность поддержки и география дата-центра. Capacity, предназначенная для замены самой нагруженной serving-ноды, обязательно размещается вне её provider/ASN failure domain; дополнительные некритичные ноды могут находиться у того же провайдера, но не учитываются как независимый резерв.

Оператор сообщил, что тестовая машина, ранее находившаяся в Финляндии под hostname `vpn-fi-01` и ролью `vpn-fi-1`, мигрирована провайдером в Польшу. До изменения inventory, DNS, профиля или внутренних идентификаторов выполняется read-only аудит: это та же или новая VPS, каковы актуальные endpoint/IP/TLS fingerprint, требуется ли новая версия connection profile и сохраняется ли legacy ID `vpn-fi-1` либо нужен контролируемый rename. До закрытия аудита польская consumer-доступность и production-ready статус не заявляются. Это не Platform VPS: API/Postgres на эту машину не ставятся, а runtime Xray вручную не редактируется.

Вторая тестовая VPS приобретена у отдельного провайдера в Амстердаме под роль `vpn-eu-1`: Ubuntu 26.04 LTS, отдельный sudo-пользователь `vpnadmin`, SSH только по ключу, root/password login отключены, UFW разрешает OpenSSH и VPN `443/tcp`, Fail2ban и unattended security updates включены, UTC/NTP исправны, настроен защищённый swap. После контрольной перезагрузки SSH, UFW, Fail2ban и swap восстановились штатно. Docker Engine и Compose plugin установлены из официального репозитория Docker для Ubuntu `resolute`; `vpnadmin` имеет требуемый операционный доступ к Docker socket, который считается root-equivalent и не выдаётся другим пользователям. На ноде развёрнуты Xray и node-agent, TLS 1.3 inbound имеет доверенный сертификат, desired/applied config version синхронизированы. Consumer-проверка Happ на Windows подтвердила полный TUN и выход через Amsterdam; первоначальная ложная отрицательная проверка была вызвана сторонним глобальным ruleset Happ с direct-маршрутом для IP detection. После утечки тестового consumer UUID старое устройство/grant отозваны, replacement grant применён и подтверждён нодой. Node-agent установлен как enabled systemd service с автоматическим восстановлением; localhost API и reverse SSH закрытого теста запускаются задачами Windows при входе пользователя и имеют минутный recovery-trigger, а tunnel runner переподключается после смены сети и принимает оставшийся дочерний SSH под наблюдение после внешнего завершения PowerShell-задачи. Certbot timer дополнен versioned pre/post/deploy hooks: standalone ACME временно открывает и затем закрывает UFW `80/tcp`, renewed certificate/key проходят проверку срока, hostname и пары ключей, а Xray reload имеет serving-check и rollback. Отрицательный mismatch-тест, deploy текущей пары и staging renewal dry-run пройдены. Контрольная перезагрузка после полного rollout подтвердила автоматическое восстановление Docker-контейнеров Xray/proxy, public TLS `443`, localhost reverse forward, systemd node-agent, Certbot timer и свежего control-plane heartbeat без ручного изменения runtime. Контур по-прежнему зависит от включённого ноутбука и не заменяет production HTTPS origin. До настройки независимого production control plane нода остаётся закрытым тестовым data plane, а не production-ready резервом. Публичный IP и credential material в Git не фиксируются.

Bootstrap в репозитории: production adapter `NODE_AGENT_MODE=xray`, отдельные harness-команды `pnpm vpn-fi:bootstrap` и `pnpm vpn-eu:bootstrap`, параметризованный `infra/docker-compose.vpn-node.yml`, runbook `infra/vpn-node/README.md`. До аудита миграции legacy harness сохраняет `vpn-fi-1`/`var/vpn-fi-01`; Amsterdam использует независимые `vpn-eu-1`/`var/vpn-nl-01`, поэтому подготовка второй ноды не меняет endpoint или credentials первой. Страна не выводится из legacy ID. Идемпотентный повтор не обновляет immutable public config; изменение TLS/display требует новой версии profile. Agent на VPS тянет desired state по HTTPS к control plane. Для закрытого Amsterdam-теста используется localhost-only TLS proxy поверх reverse SSH к Windows API: control-plane API не публикуется в интернет, а публичными остаются только SSH и VPN `443/tcp`. Reload Xray выполняется полным Compose restart, потому что ручной `kill -s HUP` может оставить контейнер остановленным.

## 4. Контейнеры первого деплоя

```text
platform-1
├── reverse-proxy      HTTPS, маршрутизация доменов
├── web                личный кабинет и админка
├── api                авторизация, тарифы, подписки, платежи, subscription API
├── bot                Telegram long polling
├── worker             очереди, платежи, ноды, уведомления
├── postgres           временно допустимо для закрытой беты
└── redis              очередь и краткоживущий кеш
```

Xray разворачивается на каждой VPN-ноде отдельно. Рядом работает node agent: он получает желаемую конфигурацию, применяет её, хранит локальные сроки действия устройств и отправляет подтверждение версии обратно в control plane. Боевая runtime-конфигурация не редактируется вручную на сервере.

Versioned production-shaped deployment control plane находится в `infra/docker-compose.production.yml`, а runbook — в `infra/platform/README.md`. Manifest публикует только Caddy `80/tcp` и `443/tcp`; web/API используют отдельную edge network, PostgreSQL/Redis — internal data network без host ports, API/worker и opt-in bot получают исходящий service network без опубликованного входа. Bot не подключается к data network и не получает прямой доступ к PostgreSQL/Redis. Xray в manifest отсутствует. Caddy маршрутизирует root/app/api/sub из deployment environment, направляет `/api/*` кабинета напрямую в API, не обслуживает subscription bearer path на общем API-origin и редактирует `/sub/<token>`, credentials и raw client address fields в runtime logs. Application и официальные infrastructure images задаются immutable digest references. Одноразовый `migrate` выполняет только forward-only `prisma migrate deploy`; API и worker зависят от его успешного завершения. Bot запускается только явным `--profile bot`, работает через исходящий long polling и не публикует входящий endpoint.

При включении bot внутренний bot→API transport остаётся `http://api:3001` в `egress`; Docker network не считается TLS, поэтому application-контракт использует HMAC. Network topology и Caddy для этого решения не меняются. MVP bot получает Telegram updates исходящим long polling через `egress`, не публикует webhook endpoint и не подключается к `edge`. Для bot-mediated входа несекретный `TELEGRAM_MINI_APP_BASE_URL` задаётся каноническим Direct Mini App link `https://t.me/<bot_username>/<short_name>` без query/hash, trailing/duplicate slash и нормализуемых path segments; bot получает одноразовый `launchId` из подписанного API и добавляет его только как Telegram `startapp`. Secret wiring обязан передавать `BOT_SIGNING_KEK` и производный WebApp validation key только API, а plaintext signing key текущего credential и raw Telegram bot token — только bot; web, worker и migrate не получают ни один из них. API не получает raw bot token и не может обращаться к Telegram Bot API. Перед `prisma migrate deploy` application migration wrapper обязательно запускает read-only `admin:check-legacy-admin`; host preflight эту DB-проверку не заменяет.

Наличие manifest не означает выполненный deployment. До первого публичного запуска обязательны зарегистрированный/делегированный домен, проверенные release images, отдельный этап production secrets, автоматический зашифрованный backup в другом failure domain и restore drill. Первый deployment использует строго изолированный bootstrap: PostgreSQL/Redis и forward-only migrations запускаются без API, worker, web, reverse proxy и bot; затем выполняются первый offsite backup и isolated restore drill, и только их успех разрешает запуск публичных application services. `production.env.example` является только non-secret render/test fixture и запрещён как production configuration.

Первая исторически проверенная партия четырёх application release images опубликована в GHCR из clean commit `031109009a2fc9f65de039976e3a2e99a242c58e`; источником deployment references служит сохранённый GitHub Actions artifact с точными `@sha256`. После последующих application/auth изменений эта партия не является deployment input для текущего `HEAD`: перед первым deployment workflow повторно запускается из окончательного clean commit, а production environment получает четыре digest именно этого release. Immutable digest сам по себе не доказывает соответствие checkout; до отдельной машинной provenance-проверки оператор сверяет artifact commit и установленный release SHA. Secrets, backup/restore и DNS/HTTPS preconditions остаются независимыми blockers.

## 5. Домены и сетевые правила

| Домен / зона | Назначение |
|---|---|
| `mymeteora.ru` | Минимальная публичная информационная и юридическая страница |
| `app.mymeteora.ru` | Личный кабинет и `/admin` в том же web-приложении |
| `api.mymeteora.ru` | API платформы |
| `sub.mymeteora.ru` | Персональные subscription URL устройств |
| `status.mymeteora.ru` | Публичный статус, после MVP |

- Покупка `mymeteora.ru` оператором подтверждена. На 2026-09-02 корень и `www` разрешаются в парковочный адрес Timeweb `92.53.96.169`, а release-записи `app`, `api` и `sub` ещё отсутствуют. До их контролируемого переключения на `platform-1` DNS и HTTPS не считаются production-ready. Домены остаются конфигурацией deployment и не хардкодятся в application logic.
- Корневой домен не требует отдельного маркетингового сервера: тот же web deployment отдаёт короткое честное описание сервиса, тариф, порядок выдачи после оплаты, кнопку Telegram, контакты/реквизиты, оферту, privacy и правила возврата.
- HTTPS обязательно для всех публичных доменов.
- Админка дополнительно ограничивается по сети. При наличии стабильного
  административного egress используется IP allowlist; без него OWNER обязан
  использовать отдельный management VPN/Zero Trust access proxy с MFA. Публичный
  unrestricted `/admin/*`, защищённый только формой логина, для production
  запрещён. Роли, 2FA и audit: `vpn-application-implementation-tz.md`, разделы
  [5](vpn-application-implementation-tz.md#5-api-и-авторизация) и
  [10](vpn-application-implementation-tz.md#10-application-level-security-invariants).
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

Все versioned Compose manifests проходят отдельный offline `docker compose config` guard в локальной проверке и CI с фиксированным non-secret env fixture. Production control-plane guard дополнительно запрещает host ports у всех сервисов, кроме `80/tcp`/`443/tcp` reverse proxy, требует internal data network, отсутствие Xray, immutable image digests, fail-closed migration dependency, fixed trusted proxy identity и opt-in long-polling bot без inbound network. Privileged containers, host network/PID namespace и Docker socket mounts запрещены. Production Xray container имеет Compose healthcheck через loopback-only Handler API: probe проверяет доступность inbound и не публикует служебный port наружу. Этот healthcheck является наблюдаемым container signal и не заменяет node-agent serving verification перед acknowledgement. Все versioned Bash-скрипты под `infra/` проверяются закреплённым по digest ShellCheck, а PowerShell-скрипты — строго заданной версией PSScriptAnalyzer; новые скрипты автоматически входят в recursive scope. Application images `web`, `api`, `worker` и `bot` собираются из одного multi-stage Dockerfile на закреплённом по digest Node base, содержат только production runtime, работают от непривилегированного пользователя и проходят CI smoke. API runtime image отдельно сохраняет Prisma schema/migrations и production Prisma CLI для одноразового forward-only migration service; обычный API CMD остаётся неизменным. Web rewrite `/api/:path*` фиксируется Next.js во время build: обязательный для development и build `WEB_API_PROXY_TARGET` и одноимённый Docker argument принимают только HTTP(S) origin без credentials/path/query/fragment; production origin или IP задаётся build environment и не хранится в Git. CI использует только test-only origin Docker network. Install и три backend deploy используют один BuildKit pnpm-store cache. Frozen install остаётся обязательным; принудительный `deploy --offline` не применяется, поскольку legacy deploy дополнительно запрашивает registry metadata для peer dependency resolution даже при заполненном content-addressable store. Clean image получает OCI revision текущего HEAD; local dirty build не выдаёт себя за этот commit, а получает явные source-state/head/fingerprint labels и dirty OCI revision. CI перед image build требует clean checkout и точное совпадение HEAD с `GITHUB_SHA`. Smoke принимает только images с build-id и provenance последнего завершённого build, запускает их штатные CMD в отдельной случайной Docker network, проверяет API liveness, inactive worker/bot exit `0`, web root и реальный web-to-API proxy. Каждый созданный resource регистрируется до запуска, удаление и post-condition отсутствия проверяются отдельно; cleanup failure делает smoke неуспешным и сохраняется вместе с исходной ошибкой. Перед успешным сценарием smoke реально инъецирует failure после старта API/web и требует полного cleanup без утечек. Release publication использует отдельный GitHub Actions workflow только для ручного запуска с `main` или тега `platform-v*`: scoped `GITHUB_TOKEN` публикует в GHCR только clean-source images после smoke, а artifact отдаёт оператору точные `@sha256` references. Обычный branch push ничего в registry не публикует; deployment запрещает использовать mutable tag как image reference. Node-agent остаётся отдельным host-level systemd process на VPN-ноде и в application image не включается.

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

Ротируемые bot credentials и raw Telegram bot token не добавляются в общий one-shot `platform.env`. API-only `BOT_SIGNING_KEK` хранится отдельным root-owned secret с доступом только API; plaintext signing key и raw Telegram bot token — отдельными bot-only secret files. Инициализатор записывает в `platform.env` только производный canonical base64url WebApp validation key; восстановить из него bot token или использовать Telegram Bot API нельзя. Provisioning/rotation signing credential выполняет versioned CLI без secret в argv, Git или логах: новый ключ доставляется только bot, bot перезапускается/перезагружается, после overlap старый credential отзывается. На production host используются разные безучастниковые системные группы с фиксированными GID: KEK `root:meteora-api-secret` (`29001`, mode `0440`), bot credential и Telegram token `root:meteora-bot-secret` (`29002`, mode `0440`), каталог bot secrets mode `0750`. Compose монтирует каждый файл отдельным read-only bind mount с `create_host_path: false` и выдаёт контейнеру только нужную supplementary group; только opt-in one-shot `bot-credential-admin` временно получает PostgreSQL, read-only KEK и writable bind выделенного bot-only directory для атомарной установки signing credential, но не общий каталог остальных platform secrets и не token mount. Он не публикует ports, не имеет egress и после операции удаляется. Runbook обязан проверять владельца/mode файлов, отсутствие этих секретов у посторонних services и fail-closed startup API/bot при неверном wiring.

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

- `healthy`: lifecycle и runtime допускают работу; пользовательская выдача дополнительно требует pool role `SERVING`, route readiness, assignment и capacity/availability gates;
- `draining`: новых пользователей не получает; существующий VPN-доступ на ноде не обрывается немедленно, пользователи переводятся постепенно;
- `disabled`: полностью исключена из новой выдачи и assignment в subscription API; уже выданный VPN-доступ автоматически не отзывается. Нода остаётся в access-control synchronization, пока node agent доступен: revoke, уменьшение/истечение `expires_at`, credential revocation;
- `quarantined` (emergency disable): исключена из выдачи и принудительно прекращает VPN-serving / revoke-all. Это не availability-состояние `QUARANTINED` у endpoint/profile;
- `deleted`: сервер удалён после сохранения аудита; в синхронизации доступа больше не участвует.

Lifecycle-статус ноды не используется как единственный показатель доступности VPN. Heartbeat node agent, состояние VPS, VPN-процесса, endpoint, connection profile и региональная доступность измеряются и хранятся раздельно.

Целевая pool role также не кодируется lifecycle-статусом. Членство ноды в логической локации имеет отдельную роль `SERVING` или `STANDBY`: `SERVING` допускает кандидатную выдачу при прохождении остальных gates, `STANDBY` означает тёплый проверяемый резерв без обычной пользовательской выдачи. Вычисляемое здоровье ноды (`UNKNOWN/HEALTHY/DEGRADED/DOWN`) не редактируется OWNER вручную и не подменяет route availability. Текущая схема ещё не содержит отдельной pool role и считает `NodeStatus.HEALTHY` пригодностью к выдаче; переход к разделённой модели требует forward-only migration, contracts/OpenAPI и тестов и до этого не считается реализованным.

Application-контракт desired state / ack / outbox: `vpn-application-implementation-tz.md`, разделы [6](vpn-application-implementation-tz.md#6-данные-транзакции-и-outbox)–[8](vpn-application-implementation-tz.md#8-правила-работы-с-нодами-на-уровне-приложения).

### 7.1. Устойчивость data plane к сетевой деградации

Критический архитектурный инвариант: система не должна зависеть от одного VPN-протокола, transport profile, IP-адреса, ASN, VPS-провайдера или географического региона. Пользователь приобретает доступ к восстанавливаемому пулу соединений, а не к конкретному серверу. Изменение инфраструктуры не требует перевыпуска пользовательского subscription URL.

Требование описывает технологически нейтральную устойчивость. Конкретные параметры протоколов и способы настройки data plane выбираются и проверяются отдельно; они не хардкодятся в пользовательской, платёжной или subscription-модели.

Выбор протоколов, transport profiles и клиентских решений ведётся по принципу наиболее надёжного доступного варианта на момент rollout. Базовый MVP использует текущую связку Happ + Xray/VLESS только пока она подтверждена end-to-end тестами и не мешает добавить другой `ConnectionProfile`. Перед production rollout или крупной заменой профиля оператор фиксирует read-only market/compatibility check: активная поддержка upstream, совместимость Happ и целевых ОС, включая Android и iOS, безопасность secret handling, реальный VPN-туннель и передача тестового трафика из согласованного набора целевых пользовательских сетей с фильтрацией/блокировками, показатели скорости/latency/disconnects, возможность staged rollout/rollback и отсутствие ручного изменения runtime-конфигурации. Профиль, который только меняет публичный IP или работает лишь в свободной сети, не считается production-ready. Экспериментальный или новый профиль сначала проходит test node, ограниченный canary и probes; он не становится единственным production-вариантом до устойчивого периода наблюдения. Маркетинговые заявления провайдера, популярность панели управления или единичный успешный локальный тест не считаются достаточным доказательством надёжности.

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

Probe не получает пользовательские credentials или содержимое трафика. Для проверки используются отдельные ограниченные test credentials с ротацией и отзывом. Внешний result передаётся только по HTTPS на `POST /probe-agent/v1/results` с отдельным opaque bearer credential зарегистрированного `ProbeSource`; сервер хранит только domain-separated HMAC verifier с отдельным pepper, выводит source identity/independence key из credential и реестра и не доверяет этим полям body. Result содержит PostgreSQL-время приёма и защищён strict schema, exact replay key, pre-auth IP rate limit, post-auth per-source rate/distinct-scope cardinality limit и ограниченными длинами полей. Значения лимитов являются deployment configuration. Недоступность Redis или credential verifier работает fail-closed. Probe credential не является node-agent credential и не даёт доступа к конфигурации или пользовательским grants.

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

### 7.2. Location pools, резерв и выбор маршрутов

`LocationPool` — логическая пользовательская локация, обычно страна или город. В ней находится управляемый набор node memberships; фиксированного числа нод на локацию нет. Одна нода не должна скрытно принадлежать нескольким взаимоисключающим serving-пулам. Для пула настраиваются public label, состояние выдачи, candidate limit, capacity policy и health policy; пользователь не получает внутренние provider, ASN, node ID или полный inventory.

Тёплая `STANDBY`-нода имеет установленный и актуальный node-agent/Xray runtime, доверенный TLS и clock, отдельные test credentials, свободную capacity и успешные serving/blocking probes. Она остаётся вне обычного feed, но обязана быть достаточно готовой для bounded promotion без ручной установки ПО. Никакого фиксированного требования держать третью ноду в каждой стране нет. Минимальный резервный budget задаётся на весь обязательный сервис и по критичным location pools с учётом спроса и стоимости; для защиты от provider/ASN failure резерв выбирается из независимого failure domain. Для closed beta потеря одной страны может временно убрать эту локацию, но не должна лишать пользователя всех рабочих локаций; сохранение каждой локации и полной предаварийной производительности не является обещанием beta.

Subscription selection использует два этапа:

1. fail-closed eligibility filter исключает `STANDBY`, provisioning/draining/disabled/quarantined/deleted, неподтверждённые desired/applied versions, неготовые endpoint/profile, затронутые blocking policy и исчерпанный capacity budget;
2. deterministic weighted assignment выбирает для конкретного устройства bounded candidates по стабильности, свободной capacity, latency/probe aggregates и diversity failure domain.

Стартовая policy возвращает не более двух кандидатов на локацию при их наличии; значение хранится в policy/configuration и меняется без перевыпуска subscription URL. Assignment является sticky для пары device/location/policy version, чтобы обычное обновление feed не вызывало flapping и не направляло всех пользователей на первый endpoint. Backend выбирает безопасный набор, но не заявляет знание фактической скорости конкретного устройства: окончательное сравнение задержки на клиенте выполняет Happ только после отдельной проверки такого поведения на Android/iOS. Одна пригодная нода даёт один маршрут; отсутствие пригодных нод временно убирает локацию из feed и создаёт наблюдаемый incident/alert.

Backend публикует новую feed version сразу после подтверждённого availability
decision и отвечает `Cache-Control: private, no-store`. Стартовый client update
interval — 5 минут. Closed-beta evidence должно подтвердить на актуальных Happ
Android/iOS, что исключённый route исчезает из активного клиента не позднее 10
минут после публикации. Если версия клиента не выполняет auto-refresh надёжно,
бот/кабинет дают явное действие «Обновить подписку», а seamless failover для неё
не заявляется.

Capacity decision учитывает как минимум CPU/RAM/disk pressure, активные соединения, handshake/error rate, текущую пропускную способность, traffic budget провайдера и запас на отказ. Численные warning/stop-assignment thresholds утверждены как `CapacityPolicy beta-v1` в разделе 7.5 и хранятся как versioned данные, а не литералы domain logic. Превышение stop-assignment threshold прекращает новые назначения, но само по себе не обрывает текущие соединения.

Плановая ротация выполняется `provision/verify new → canary → serving → drain old → grace → controlled retirement`. После начала drain старая нода исчезает из новых и обновлённых candidate sets, но изменение feed не разрывает уже установленную сессию. Grace period настраивается. Его завершение может потребовать отзыва оставшихся credentials и разорвать сохранившиеся соединения; обещание бесконечного сохранения старой сессии запрещено. Физическое удаление VPS выполняется только после convergence, сохранения истории и подтверждённого retirement.

### 7.3. Автоматическое enrollment и provisioning ноды

MVP автоматизирует настройку уже приобретённой совместимой VPS, но не покупку сервера у провайдера. OWNER создаёт draft ноды в панели, выбирает provider/location/pool role и получает короткоживущую одноразовую enrollment ceremony. На чистой поддерживаемой VPS он запускает один проверяемый installer command; сам installer запрашивает одноразовый код интерактивно, чтобы secret не попадал в argv и shell history. Cloud-init допускается как эквивалентный transport той же процедуры.

Первая поддерживаемая automated-provisioning платформа — чистая Ubuntu 24.04 LTS
x86_64. Другая ОС или версия, включая уже вручную проверенную Ubuntu 26.04-ноду,
не добавляется в автоматический support matrix без отдельного installer fixture,
integration test и записи в release evidence. DNS strategy является обязательным
deployment input: до `READY` должен быть настроен и проверен один конкретный DNS
API adapter либо заранее утверждённая wildcard/record policy; отсутствие обоих
оставляет operation в `FAILED` вне feed.

Installer скачивается только с доверенного control-plane origin как versioned artifact, проверяет signature/checksum и поддерживаемую ОС, после чего идемпотентно:

1. создаёт служебного пользователя, SSH/firewall baseline и настраивает security updates без блокировки текущего административного доступа;
2. устанавливает Docker/runtime dependencies и запускает только заранее собранные immutable images по digest, без `git clone`, `pnpm install` и сборки на VPS;
3. получает DNS через настроенный provider API либо проверяет заранее утверждённую wildcard/record policy;
4. получает и проверяет TLS через ACME;
5. обменивает одноразовый enrollment token на собственную ротируемую node-agent credential, не копирует `agent.env` или сертификаты вручную;
6. устанавливает systemd unit, node-agent и Xray, затем выполняет clock, heartbeat, convergence, serving, TLS и tunnel probes.

Состояния `CREATED/ENROLLING/PROVISIONING/VERIFYING/READY/FAILED` относятся к наблюдаемой provisioning operation и не смешиваются с lifecycle, pool role или health ноды. Enrollment exchange выдаёт отдельную provisional node credential со scope только на node/operation bootstrap API и TTL не более 60 минут. Пока lifecycle Node остаётся `PROVISIONING`, агент может получить только test-only runtime state, подтвердить bootstrap version и отправить heartbeat/probe results для clock/TLS/convergence/serving проверки; user grants, обычный production snapshot, subscription assignment и feed запрещены. Успешная `READY` одной транзакцией заменяет provisional credential normal credential, переводит Node в `HEALTHY` и создаёт `STANDBY` membership. Canary promotion в `SERVING` является следующей отдельной operation. Ошибка оставляет ноду вне пользовательского feed, сохраняет безопасную причину/этап и предлагает retry или rollback. Enrollment token короткоживущий, одноразовый, хранится только как hash, rate-limited и не попадает в логи/audit payload. Повтор installer после частичного сбоя либо безопасно продолжает ту же operation, либо требует новый token; он не создаёт дубликат ноды или credential.

### 7.4. Диагностика и repair operations

Control panel управляет нодой только через типизированные desired-state operations и node-agent: `RECHECK`, `RETRY_DELIVERY`, `RECONCILE`, `APPLY_LAST_KNOWN_GOOD`, `DRAIN`, `PROMOTE_STANDBY`, `ROTATE_AGENT_CREDENTIAL`, `RESTORE_AFTER_VERIFY`, `MIGRATE` и `RETIRE`. Каждая operation имеет idempotency key, scope, reason, initiator, preview для опасных действий, статусы `PENDING/RUNNING/SUCCEEDED/FAILED`, bounded retry, timestamps, safe result и append-only audit. Ручные quarantine, credential rotation, migration, policy change и массово влияющее promotion требуют свежего step-up и повторного подтверждения. Автоматическая promotion/failover не имитирует OWNER step-up: её выполняет отдельный service principal только по versioned policy, quorum и cooldown, с incident/audit и запретом расширять scope сверх policy.

Автоматическая repair ladder сначала повторяет независимые probes, затем безопасную delivery/reconciliation, затем verified apply последней подтверждённой конфигурации. Если проблема остаётся, система исключает минимальный затронутый profile/endpoint, переводит ноду в drain или emergency quarantine только по соответствующей policy, включает готовый резерв и создаёт incident с рекомендуемой миграцией. Критическая ошибка доверия к clock/state/credential допускает немедленный fail-closed; обычная потеря одного probe или одна жалоба пользователя — нет.

Нода считается полностью непригодной для новой выдачи, когда составное решение подтверждает недоступность serving либо отсутствие любого пригодного endpoint/profile в требуемом scope. Отказ одного профиля, IP family или целевой сети не делает автоматически неисправной всю VPS. Failure/recovery thresholds, quorum и окна наблюдения задаются утверждённой `HealthPolicy beta-v1` из раздела 7.5 и последующими immutable policy versions.

Если VPS или node-agent полностью недоступны, панель не имитирует ремонт через браузерный root shell. Она прекращает новую выдачу затронутого scope, пытается сохранить сервис через резерв, показывает provider/runbook context и ведёт OWNER к восстановлению через provider console либо к контролируемой миграции. Пароли, SSH private keys, API tokens и VPN credentials в реестре провайдеров не хранятся; допускаются только ссылки на внешний secret storage.

### 7.5. Стартовые HealthPolicy и CapacityPolicy для закрытой beta

Ни одно значение этого раздела не хардкодится в domain logic. `HealthPolicy` и `CapacityPolicy` являются versioned данными с validation bounds, preview затронутых ресурсов, свежим OWNER step-up, audit, staged activation и возможностью rollback к предыдущей подтверждённой версии. Автоматическое решение сохраняет использованную policy version. Стартовые значения действуют до изменения по результатам load tests и beta telemetry.

#### HealthPolicy `beta-v1`

| Параметр | Стартовое значение |
|---|---|
| Обычный node-agent poll/heartbeat | каждые 30 секунд |
| Serving/tunnel probe | каждые 60 секунд из минимум двух независимых обычных probe points |
| Один неуспешный цикл | только событие наблюдения; состояние и feed не меняются |
| Два последовательных неуспешных цикла | `DEGRADED`; новые назначения на затронутый scope останавливаются, существующий candidate пока не удаляется |
| Три последовательных неуспешных цикла | затронутый profile/endpoint исключается из новых и обновлённых candidate sets; запускаются replacement/failover и incident |
| Восстановление | пять последовательных успешных циклов, охватывающих не менее 5 минут, плюс свежий heartbeat, trusted clock, serving check и desired/applied convergence |
| Cooldown после восстановления | 10 минут без повторного автоматического rebalance |
| Stale heartbeat | после 90 секунд — `DEGRADED` и запрет новых grants; сам по себе не доказывает падение VPN-туннеля |
| Полная недоступность ноды | три неуспешных serving/tunnel цикла для всех её пригодных routes; stale heartbeat является подтверждающим, но не единственным сигналом |
| Critical trust failure | untrusted clock/state, credential compromise или подтверждённый unsafe runtime вызывают немедленный fail-closed/quarantine без ожидания трёх циклов |

Probe timeout одного цикла — 10 секунд. Result принимается в cycle только если он
аутентифицирован, относится к текущей route/profile version и получен control
plane не позднее 90 секунд после начала цикла. Route-relevant failure classes:
`DNS`, `TCP_TLS`, `VPN_HANDSHAKE` и `TEST_TRAFFIC`; поломка самого probe source
хранится отдельно как `PROBE_SOURCE_FAILURE` и не голосует против route.

Один failed cycle существует только при совпадающем route-relevant failure class
минимум от двух fresh независимых probe sources с исправными control checks.
Два success дают successful cycle. Один success плюс один failure дают `MIXED` и
запускают дополнительный probe в течение 15 секунд, не увеличивая consecutive
failure counter. Недостаток quorum даёт `UNKNOWN`. Два последовательных обычных
цикла `MIXED`/`UNKNOWN` переводят scope в precautionary `DEGRADED` и запрещают
новые назначения, но не дают `BLOCKED`, не удаляют ресурс и не запускают
revoke-all. Любой quorum-success обнуляет unknown/mixed streak; recovery из
failure-состояния всё равно требует пять success по policy.

Для сетевой фильтрации один target network с тремя последовательными quorum-confirmed failed cycles при исправном control check даёт `PARTIALLY_BLOCKED`; каждый такой cycle требует два независимых зарегистрированных probe instances внутри этого network scope. Пока backend не имеет отдельно проверенного privacy-safe client capability, общий subscription feed не определяет ISP по raw IP: такой route консервативно исключается из новых и обновлённых candidate sets всех устройств при наличии безопасной альтернативы. Если альтернативы нет, локация скрывается и создаётся incident, а заведомо проблемный route не выдаётся как исправный. `BLOCKED` требует тот же класс отказа в двух независимых target networks в одном трёхцикловом окне, причём каждая сеть имеет собственный quorum. Recovery требует пять успешных циклов от тех же обязательных источников. Network-specific feed допускается только отдельным решением после проверки client capability и privacy model.

#### CapacityPolicy `beta-v1`

Capacity utilization вычисляется как максимум из нормализованных CPU за 5 минут, RAM, числа активных соединений относительно проверенного soft limit и текущей пропускной способности относительно измеренной sustainable bandwidth. Runtime snapshot старше 90 секунд является stale. Soft connection limit и sustainable bandwidth обязательны для каждой node capacity class и принимаются только из сохранённого load-test result с датой, software/profile version и OWNER approval; без них нода не получает `SERVING`. Disk и provider traffic budget являются отдельными gates. Неизвестная или stale метрика не трактуется как нулевая нагрузка и запрещает увеличение назначения до восстановления наблюдаемости.

| Уровень | Стартовое действие |
|---|---|
| `< 65%` | нормальная выдача с weighted assignment |
| `≥ 65%` непрерывно 10 минут | warning OWNER и снижение веса ноды |
| `≥ 80%` непрерывно 5 минут | stop-assignment: новые grants/assignments не создаются, текущие соединения не обрываются |
| `≥ 90%` непрерывно 5 минут | critical incident, controlled rebalance и promotion готового резерва; автоматический disconnect не выполняется только из-за нагрузки |
| Recovery | новые назначения возобновляются после `< 60%` непрерывно 10 минут и прохождения health gates |

Свободное место на диске ниже 20% даёт warning, ниже 10% запрещает rollout/provisioning и новые назначения. Provider traffic snapshot для metered-ноды должен быть не старше 24 часов. Линейный прогноз строится только после минимум 24 часов текущего billing period как `used / elapsedFraction`; до этого используется фактическая доля без прогноза. Provider traffic budget предупреждает, если прогноз периода превышает 80% лимита; stop-assignment включается при фактических 90% либо прогнозе более 100%, если OWNER не утвердил time-bounded overage policy. Missing/stale traffic snapshot на metered-нode запрещает новые назначения; OWNER override действует максимум 24 часа, требует reason, step-up и audit. Traffic gate не отзывает уже выданный доступ без отдельного emergency решения.

#### Drain, promotion и резерв `beta-v1`

- плановый drain/grace по умолчанию длится 24 часа; OWNER может выбрать от 1 до 72 часов с preview, reason и audit;
- security quarantine и подтверждённый emergency outage допускают grace `0`, но это отдельная операция, способная оборвать соединения;
- после подтверждённого failover decision готовый `STANDBY` повторно проходит readiness, атомарно становится `SERVING`, затем bounded batch-ами получает replacement assignments/grants. Route попадает в feed конкретного устройства только после convergence. Promotion считается успешной, только когда каждый актуальный affected active Device имеет хотя бы один converged replacement route; для проверенного масштаба closed beta target всей операции — 2 минуты, hard timeout — 5 минут;
- terminal per-device failure или timeout завершает promotion как `FAILED`, создаёт P0 incident/alert и требует следующего готового кандидата либо ручной миграции. Уже converged безопасные replacement routes остаются в feed соответствующих устройств; unconverged routes не выдаются, а автоматический rollback membership не выполняется поверх частично восстановленного доступа. Старый работоспособный route не отзывается до готовности replacement, кроме отдельного security emergency;
- минимальная проверенная свободная резервная capacity сервиса оценивается отдельно по simultaneous connections и throughput: в каждом измерении она равна максимуму из 25% текущей aggregate serving load и 125% нагрузки самой нагруженной serving-ноды. CPU/RAM/disk gates дополнительно должны оставаться ниже stop-assignment. Reserve может обеспечиваться одной или несколькими нодами, но capacity, достаточная для замены самой нагруженной ноды, находится вне её failure domain;
- это capacity budget, а не требование иметь фиксированное число нод в каждой стране. Недоступность конкретной локации допустима, если сервис сохраняет хотя бы одну рабочую локацию и создаёт явный incident.

#### Blocking probe matrix `beta-v1`

Для закрытой beta обязательны минимум три реальные target networks: две сети разных мобильных операторов и один фиксированный провайдер; совокупно проверки охватывают не менее двух географических регионов России. Матрица выполняется на актуальных Happ для Android и iOS, отдельно проверяет импорт/update HTTPS feed, handshake, test traffic, latency, throughput, disconnect/reconnect, Wi-Fi↔mobile и DNS/IPv6 leakage. Каждая ОС проверяется минимум в одной mobile и одной fixed network, а каждый из трёх target networks проходит полный tunnel/test-traffic сценарий хотя бы на одной ОС. Конкретные оператор, регион, устройство, client version, время и результат хранятся в закрытом release evidence, владельцем которого является OWNER. Не каждая комбинация обязана быть постоянным автоматическим probe.

Ручной mobile result может закрывать release matrix, если OWNER подписал evidence,
но не участвует в automatic blocking quorum. Автоматический `PARTIALLY_BLOCKED`
требует двух заранее зарегистрированных аутентифицированных probe instances в
одном target-network scope; `BLOCKED` — такого quorum в каждой из двух
независимых target networks. Пока нужный quorum не развёрнут, система создаёт
alert/incident и требует подтверждения OWNER, а не выполняет automatic block по
ручному наблюдению.

Перед публичным запуском минимальная матрица расширяется до пяти независимых target networks: три мобильных оператора и два фиксированных провайдера минимум в двух регионах. Каждый зарегистрированный automatic target-network probe выполняется каждые 5 минут. Сеть без такого агента остаётся только manual release-evidence source и не участвует в automatic quorum. Список конкретных операторов и регионов ведётся как environment-specific inventory вне Git и пересматривается при изменении фильтрации.

### Синхронизация и отзыв доступа

Продуктовые SLA (локальный `expires_at`, 5 минут на отзыв): `vpn-service-tz.md`, разделы [3](vpn-service-tz.md#окончание-подписки-и-отзыв-устройства) и [8](vpn-service-tz.md#8-нефункциональные-требования). Application outbox: `vpn-application-implementation-tz.md`, раздел [6](vpn-application-implementation-tz.md#6-данные-транзакции-и-outbox).

- Control plane хранит желаемое состояние доступа, нода — последнюю подтверждённую версию.
- Каждый платёж, окончание подписки, отзыв или добавление устройства создаёт sync job для нод, которые ещё участвуют в access-control: `healthy`, `draining` и доступных `disabled`, пока они способны принимать существующие VPN-подключения. `disabled` запрещает новую выдачу, но не исключает ноду из этой синхронизации. `quarantined` получает аварийный revoke-all / прекращение serving, а не обычный набор assignment jobs. `deleted` в синхронизации не участвует. Job ставится через transactional outbox после commit PostgreSQL-транзакции, а не вызовом Redis внутри этой транзакции.
- Node agent применяет изменения идемпотентно, подтверждает версию и повторно запрашивает конфигурацию после ошибки. Для production Xray применённой считается только версия, чей ожидаемый access list после reload точно совпал с активными users, прочитанными из памяти процесса через закрытый container-local management API; совпадение runtime-файла и exit code restart недостаточны. Локальный `local-xray` adapter доказывает apply/revoke/expiry на localhost Xray; два localhost-инстанса используются только как прототип заменяемых нод и не заменяют боевую VPS. Control-plane pull/ack/heartbeat открыты для `healthy`, `draining`, доступных `disabled` и аварийных `quarantined`. После pool-stage новая пользовательская выдача требует одновременно `NodeStatus.HEALTHY`, pool role `SERVING`, assignment и route/capacity/availability readiness; `STANDBY` использует только test credentials. Обычные access-control jobs — на `healthy`, `draining` и доступных `disabled`, если там остаются ранее назначенные grants. `quarantined` получает аварийный revoke-all / прекращение serving одной control-plane операцией, а не набор новых assignment jobs. Возврат в serving state (`healthy`) запрещён, пока `desiredConfigVersion > appliedConfigVersion`.
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

Стартовая retention policy: raw технические probe results — 30 дней;
агрегированные SLI/capacity series — 12 месяцев; incidents и их timeline — 180
дней; support notes — 90 дней после закрытия обращения. Payment, receipt, security
audit и бухгалтерские данные хранятся по применимому закону, договору эквайера и
утверждённой учётной политике; до юридической фиксации их автоматическое удаление
запрещено. Retention jobs не удаляют записи, связанные с открытым incident,
расследованием, refund/chargeback или legal hold, и сами создают audit aggregate
без включения удалённого содержимого.

Для одного OWNER основной канал operational alerts — личный Telegram, резервный
— независимый email. `P0` отправляется одновременно в оба канала и включает:
потерю всех рабочих локаций, невозможность выдачи доступа, failure promotion с
hard timeout, потерю платёжной сверки, credential/security incident и неуспешный
backup/restore drill. `P1` отправляется в Telegram и попадает в ежедневный email
digest: отдельная деградация route/node, reserve deficit, capacity warning,
отстающая delivery и приближение traffic budget. Incident в панели является
обязательной записью, но не заменяет внешний канал. Delivery алерта имеет
idempotency, retry и наблюдаемый terminal status.

Административный overview обязан сводить без SSH: состояние platform services; status/heartbeat/serving/clock/TLS нод; desired/applied convergence; jobs и возраст pending delivery; Telegram polling и платёжные webhook/reconciliation; subscription delivery и revoke SLA; результаты бэкапов и последнего restore drill; активные incidents/alerts. Node view дополнительно показывает profiles, capacity/resources, grants, jobs и runtime facts, но не credentials и не редактор Xray-конфигурации.

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
- [ ] Эквайер утверждён письменно; для Robokassa, если выбрана она, external
      validation и sandbox закрыли ResultURL/status verification, карту/СБП,
      чеки, refund/chargeback и test/production credential separation.
- [ ] Админка закрыта ролью и 2FA.
- [ ] Секреты отсутствуют в Git и логах.
- [ ] Есть ручной сценарий поддержки: найти пользователя, заказ и платёж, проверить доступ, безопасно продлить подписку.
- [ ] Истёкшая подписка и отозванное устройство блокируются не позднее чем за 5 минут на `healthy`, `draining` и доступных `disabled`-нодах, которые ещё принимают существующие VPN-подключения.
- [ ] Синхронизация нод имеет подтверждение версии, повторную доставку и rollback.
- [ ] Протестирована утечка URL: отзыв одного устройства не отключает остальные.
- [ ] Subscription URL импортируется в актуальные Happ на Android и iOS по HTTPS, VPN-туннель устанавливается, а тестовый трафик проходит через него.
- [ ] На Android/iOS подтверждены точный HWID/client-instance contract,
      стабильность после restart/network change и fail-closed поведение при
      отсутствующем identifier без IP/User-Agent fallback.
- [ ] В согласованном наборе целевых пользовательских сетей пройдены blocked-network/filtering tests; результаты handshake, throughput, latency, disconnects и reconnects сохранены в staging/release отчёте.
- [ ] Проведена аварийная тренировка для падения ноды, control plane и задержки webhook.
- [ ] `HealthPolicy beta-v1` и `CapacityPolicy beta-v1` загружены как active
      immutable versions; тесты подтвердили 1/2/3/5 cycles, `MIXED/UNKNOWN`,
      stale metrics и hysteresis 65/80/90/60.
- [ ] Для каждой `SERVING` capacity class сохранён load-test result; reserve
      calculation не показывает deficit по connections, throughput и failure
      domain.
- [ ] На масштабе closed beta проверены promotion target 2 минуты/hard timeout 5
      минут и planned drain 24 часа без раннего отзыва работоспособного route.
- [ ] Release matrix содержит две mobile и одну fixed target network минимум в
      двух регионах, Android и iOS; ручные результаты не участвуют в automatic
      blocking quorum.
- [ ] Happ Android/iOS фактически обновляет feed с целевым интервалом 5 минут и
      удаляет исключённый route не позднее 10 минут либо release evidence явно
      фиксирует обязательный manual-refresh UX без заявления seamless failover.
- [ ] Проверены основной Telegram и резервный email для `P0`, включая failure
      promotion и backup alert.
- [ ] Финальное read-only ревью полного diff и release evidence выполнено через
      `gpt-6-astra`; blocker/high findings устранены либо явно приняты OWNER в
      журнале.
