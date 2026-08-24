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
| Control plane | Web-кабинет, админка, API, Telegram-бот, worker | Platform VPS / облако |
| Данные | PostgreSQL, Redis, резервные копии | Отдельный DB-контур или managed-сервис; резервная копия — в другом хранилище |
| VPN data plane | Xray/VLESS-ноды | Отдельные VPS в странах выхода |
| Наблюдаемость | Метрики, логи, алерты, uptime-checks | Отдельный логический контур, не на единственной VPN-ноде |

На старте разрешён один Platform VPS с Docker Compose, но VPN-ноды всегда разворачиваются отдельно от него. При запуске платных пользователей PostgreSQL нельзя оставлять без автоматических бэкапов и проверенного восстановления.

## 3. Начальная схема серверов

| Сервер | Назначение | Минимальная роль |
|---|---|---|
| platform-1 | Сайт, API, бот, worker | Control plane |
| vpn-fi-1 | Финляндия | VPN-нода |
| vpn-eu-1 | Вторая европейская локация | VPN-нода и резерв |
| backup-storage | Зашифрованные бэкапы БД и конфигураций | Recovery |

До покупки проверяются: разрешённость выбранного вида сервиса правилами провайдера, лимиты трафика, скорость порта, правила жалоб/абьюза, доступность поддержки и география дата-центра. Для снижения общего риска VPN-ноды по возможности размещаются у разных провайдеров.

Оператор подготовил тестовую машину hostname `vpn-fi-01` (Финляндия, Ubuntu 24.04) под роль `vpn-fi-1`: SSH только по ключу, Xray и node-agent развёрнуты отдельно от control plane, inbound опубликован на `:443/tcp`. Это не Platform VPS: API/Postgres на эту машину не ставятся. Runtime Xray на сервере по-прежнему не редактируется вручную.

Вторая тестовая VPS приобретена у отдельного провайдера в Амстердаме под роль `vpn-eu-1`: Ubuntu 26.04 LTS, отдельный sudo-пользователь `vpnadmin`, SSH только по ключу, root/password login отключены, UFW разрешает OpenSSH и VPN `443/tcp`, Fail2ban и unattended security updates включены, UTC/NTP исправны, настроен защищённый swap. После контрольной перезагрузки SSH, UFW, Fail2ban и swap восстановились штатно. Docker Engine и Compose plugin установлены из официального репозитория Docker для Ubuntu `resolute`; `vpnadmin` имеет требуемый операционный доступ к Docker socket, который считается root-equivalent и не выдаётся другим пользователям. На ноде развёрнуты Xray и node-agent, TLS 1.3 inbound имеет доверенный сертификат, desired/applied config version синхронизированы. Consumer-проверка Happ на Windows подтвердила полный TUN и выход через Amsterdam; первоначальная ложная отрицательная проверка была вызвана сторонним глобальным ruleset Happ с direct-маршрутом для IP detection. После утечки тестового consumer UUID старое устройство/grant отозваны, replacement grant применён и подтверждён нодой. Node-agent установлен как enabled systemd service с автоматическим восстановлением; localhost API и reverse SSH закрытого теста запускаются задачами Windows при входе пользователя и имеют минутный recovery-trigger, а tunnel runner переподключается после смены сети и принимает оставшийся дочерний SSH под наблюдение после внешнего завершения PowerShell-задачи. Certbot timer дополнен versioned pre/post/deploy hooks: standalone ACME временно открывает и затем закрывает UFW `80/tcp`, renewed certificate/key проходят проверку срока, hostname и пары ключей, а Xray reload имеет serving-check и rollback. Отрицательный mismatch-тест, deploy текущей пары и staging renewal dry-run пройдены. Контрольная перезагрузка после полного rollout подтвердила автоматическое восстановление Docker-контейнеров Xray/proxy, public TLS `443`, localhost reverse forward, systemd node-agent, Certbot timer и свежего control-plane heartbeat без ручного изменения runtime. Контур по-прежнему зависит от включённого ноутбука и не заменяет production HTTPS origin. До настройки независимого production control plane нода остаётся закрытым тестовым data plane, а не production-ready резервом. Публичный IP и credential material в Git не фиксируются.

Bootstrap в репозитории: production adapter `NODE_AGENT_MODE=xray`, отдельные harness-команды `pnpm vpn-fi:bootstrap` и `pnpm vpn-eu:bootstrap`, параметризованный `infra/docker-compose.vpn-node.yml`, runbook `infra/vpn-node/README.md`. Финляндия сохраняет `vpn-fi-1`/`var/vpn-fi-01`; Amsterdam использует независимые `vpn-eu-1`/`var/vpn-nl-01`, поэтому подготовка второй ноды не меняет endpoint или credentials первой. Идемпотентный повтор не обновляет immutable public config; изменение TLS/display требует новой версии profile. Agent на VPS тянет desired state по HTTPS к control plane. Для закрытого Amsterdam-теста используется localhost-only TLS proxy поверх reverse SSH к Windows API: control-plane API не публикуется в интернет, а публичными остаются только SSH и VPN `443/tcp`. Reload Xray выполняется полным Compose restart, потому что ручной `kill -s HUP` может оставить контейнер остановленным.

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

## 5. Домены и сетевые правила

| Домен / зона | Назначение |
|---|---|
| `app.<домен>` | Личный кабинет и админка |
| `api.<домен>` | API платформы |
| `sub.<домен>` | Персональные subscription URL |
| `status.<домен>` | Публичный статус, опционально |

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

### Что нельзя хранить в Git

- private keys;
- production credentials;
- bearer secrets;
- subscription tokens;
- пользовательские VPN credentials;
- runtime access lists с секретными значениями;
- production secret material;
- любые секреты нод или пользователей.

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

#### Модель ресурсов

- `Node` описывает физический или виртуальный вычислительный ресурс и его lifecycle.
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
- Selective fail-closed различает потерю control plane и потерю доверенного local state. При исправном durable snapshot нода сохраняет VPN-serving во время control-plane outage и сама применяет сроки. Каждые 10 секунд node-agent повторно читает state и проверяет schema, SHA-256 snapshot hash, совпадение persisted/snapshot version и строгий порядок `previous < current`, не выполняя reload при неизменном access list. Missing, malformed, schema-valid inconsistent, `EACCES`/`EIO` и любой иной unreadable state считаются недоверенными и немедленно останавливают Xray; старый runtime access list не считается разрешением. Recovery допускается по полному snapshot, который control plane уже считает applied (`desiredConfigVersion = appliedConfigVersion`), с обязательным reload/read-back, durable write и без фиктивного acknowledgement. Ошибка write, rename либо file/directory fsync после verified reload снова принудительно останавливает Xray; local reconcile перед resume обязан успешно повторить file и parent-directory fsync, поэтому видимый после failed rename-durability файл сам по себе не считается barrier.
- Security-critical retry отделён от обычного HTTP poll interval: failed production Xray cycle, `waiting-for-command` и local reconcile повторяются не реже чем каждые 10 секунд, а успешный production poll ограничен максимум 60 секундами без изменения env-схемы. На один production apply резервируется до 30 секунд reload и до 49 секунд read-back; fail-closed reserve увеличен до 120 секунд и включает до 6 секунд на lookup, общий stop нескольких matching containers и post-condition probe. Для локального `expires_at` deadline берётся из durable snapshot; для revoke — из `revokedAt` полученной версии относительно ранее serving grant. Snapshot с version gap без matching command не применяется и не получает acknowledgement. Его revoke policy до вызова runtime stop записывается через temp-file, file fsync, atomic rename и parent-directory fsync в `${NODE_AGENT_STATE_FILE}.stop-only.json` mode `0600`; sidecar schema содержит `formatVersion`, `targetVersion`, earliest enforcement deadline и canonical revoked grant IDs, но не credentials. При missing/unreadable основном state marker строится консервативно по всем `REVOKED` grants полного snapshot. Наличие valid, corrupt или unreadable marker немедленно блокирует local resume после process restart. Ошибка durable-записи marker вызывает fail-closed и не скрывается. Marker удаляется и directory-fsync подтверждается только после verified full apply, durable main envelope и проверки, что отмеченные grants отсутствуют в serving access list. Если удаление credential ещё не подтверждено, node-agent через существующий закрытый Docker access останавливает все Xray containers с точными Compose project/service labels и отдельным запросом подтверждает отсутствие running containers. Остановленная нода продолжает retry безопасного access list и возвращает serving только после точного совпадения active users.
- Не подтверждённая в установленный срок задача вызывает алерт и остаётся pending. Недоступная нода не возвращается в serving state (`healthy`), пока pending access updates не reconciled. Вывод в `deleted` прекращает участие в синхронизации.
- Нода локально прекращает доступ устройства по `expires_at`; она не считает subscription URL источником разрешения подключаться.
- Предусмотрен безопасный rollback на предыдущую подтверждённую версию конфигурации.

## 8. Бэкапы, логи и наблюдаемость

| Что | Правило |
|---|---|
| PostgreSQL | Ежедневный бэкап + тест восстановления по расписанию |
| Несекретные конфигурации нод | Версионируются как IaC/templates и резервируются; секреты — только в secret storage |
| Логи эксплуатации | Технические агрегаты с маскированием секретов и URL-токенов |
| Метрики | API error rate, очередь, webhook errors, CPU/RAM/disk, трафик, здоровье нод |
| Алерты | Недоступность API, отставание очереди, падение ноды, место на диске, неуспешные бэкапы |

Состав запрещённых для логов значений: `vpn-application-implementation-tz.md`, раздел [10](vpn-application-implementation-tz.md#10-application-level-security-invariants). Для эксплуатации достаточно технических агрегатов: нода, время, ошибка, объём, число подключений и идентификатор устройства в псевдонимизированном виде.

Для data plane обязательны клиентские SLI: `connection_success_rate`, `handshake_success_rate`, `median/p95_connect_time`, `disconnect_rate`, `regional_success_rate`, `node_availability` и `profile_success_rate`. Они агрегируются по node, endpoint, profile version, provider/failure domain, региону, IP family и probe network без хранения содержимого пользовательского трафика или полного пользовательского IP. Низкая кардинальность меток и сроки хранения задаются заранее.

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
