# Bootstrap production VPN-ноды

Runbook поддерживает независимые state-каталоги нод: `vpn-fi-01` для Финляндии
и `vpn-nl-01` для Амстердама. В control plane это разные записи: `vpn-fi-1` и
`vpn-eu-1`; bootstrap одной ноды не изменяет другую.
Control plane остаётся на машине оператора (Windows, API `:3001`); на VPS ставятся
только Xray и node-agent. Runtime Xray на сервере не правится вручную — только
через node-agent и control plane.

`NODE_AGENT_MODE=xray` разрешён только при `NODE_ENV=production`. Режимы
`simulation` и `local-xray` на VPS запрещены.

## Предусловия

1. Закрытый localhost-этап: `pnpm xray:local:harness` (устройство и subscription URL).
2. API и Postgres подняты локально (`pnpm db:up`, `pnpm prisma:migrate`, API dev).
3. Целевая VPS: SSH по ключу, UFW (22/tcp), **VPN-порт пока закрыт**.
4. Production clock source — **chrony**. На ноде должен существовать executable
   `/usr/bin/chronyc`, а локальный `chronyd` должен быть запущен и синхронизирован
   с внешним NTP-источником. Node-agent проверяет часы только командой
   `/usr/bin/chronyc -c tracking` без shell, sudo и `-h`. Fallback на
   `timedatectl` нет. Installer проверяет наличие `/usr/bin/chronyc` и не
   устанавливает пакет, не правит конфигурацию chrony и не отключает
   `systemd-timesyncd`. Режим chrony `local` без внешнего источника не является
   доверенным clock source: node-agent отклоняет tracking CSV с Reference ID
   `7F7F0101` и не записывает этот идентификатор в логи. Этот этап не
   устанавливает chrony на VPS.
5. TLS-сертификат для inbound: `cert.pem` и `key.pem` с SAN/SNI, совпадающим с
   `VPN_*_TLS_SERVER_NAME`. Production-renderer не выпускает `allowInsecure`.
6. **HTTPS origin control plane**, доступный с VPS outbound: tunnel (Cloudflare,
   ngrok и т.п.), публичный API или reverse proxy. IP Windows и ключи в Git/чат
   не класть.

Для закрытого теста без публикации API допустим reverse SSH: Windows держит
`-R 127.0.0.1:13001:127.0.0.1:3001`, а `control-plane-proxy` из production
Compose принимает только `https://127.0.0.1:13443` и проксирует в этот tunnel.
Локальный CA создаётся `infra/vpn-node/prepare-control-plane-tls.sh`; node-agent
запускается с `NODE_EXTRA_CA_CERTS=var/<state-directory>/control-plane-tls/ca.pem`.
Порт `13443` публично не открывается. Это operator-dependent closed-test канал,
не замена будущему постоянному HTTPS origin control plane.

## Переменные bootstrap (локально, не коммитить)

Для Финляндии перед `pnpm vpn-fi:bootstrap` используются `VPN_FI_*`:

```text
VPN_FI_ENDPOINT_HOST=<публичный IPv4 VPS без секретов в логах>
VPN_FI_TLS_SERVER_NAME=<hostname из сертификата, например fi.example.test>
VPN_FI_NODE_AGENT_API_BASE_URL=https://<tunnel-or-api-host>
VPN_FI_VPN_PORT=443
VPN_FI_DISPLAY_NAME=Finland
# опционально, если compose лежит не в корне репо на VPS:
# VPN_FI_XRAY_RELOAD_COMMAND=docker compose -f /opt/vpn-platform/infra/docker-compose.vpn-node.yml restart xray
```

`VPN_FI_NODE_AGENT_API_BASE_URL` — URL, с которого **VPS** достучится до
`GET/POST /node-agent/v1/*` по HTTPS. Это не `http://127.0.0.1:3001`.

Для независимой Amsterdam-ноды перед `pnpm vpn-eu:bootstrap` используются:

```text
VPN_EU_ENDPOINT_HOST=<публичный IPv4 VPS без секретов в логах>
VPN_EU_TLS_SERVER_NAME=<hostname из сертификата, например nl.example.test>
VPN_EU_NODE_AGENT_API_BASE_URL=https://<tunnel-or-api-host>
VPN_EU_VPN_PORT=443
VPN_EU_DISPLAY_NAME=Netherlands
# опционально: VPN_EU_XRAY_RELOAD_COMMAND=...
```

## Порядок на control plane (Windows)

Запустите ровно одну команду для целевой ноды: `pnpm vpn-fi:bootstrap` либо
`pnpm vpn-eu:bootstrap`.

Harness:

- регистрирует отдельную ноду (`vpn-fi-1` либо `vpn-eu-1`), endpoint и
  VLESS/TCP/TLS profile;
- выдаёт grant и route на **то же устройство**, что local harness
  (`var/xray-local/harness.json`);
- пишет `agent.env` и `bootstrap.json` в каталог выбранной ноды (gitignored).

Обновите подписку в Happ **без нового URL** — должна появиться выбранная нода.

## Порядок на VPS

1. Клонировать репозиторий, `pnpm install`, `pnpm build`.
2. Выбрать каталог: `vpn-fi-01` или `vpn-nl-01`. Далее он обозначен как
   `<state-directory>`.
3. Скопировать `var/<state-directory>/agent.env` с control plane (режим `600`, не Git).
4. Положить TLS: `var/<state-directory>/tls/cert.pem` и `key.pem`.
   Для закрытой VPS без собственного домена `obtain-public-tls.sh` умеет получить
   сертификат для hostname, уже резолвящегося в IP (например, через `sslip.io`):
   скрипт временно открывает `80/tcp`, закрывает его после ACME и только затем
   открывает `443/tcp`. Такой внешний DNS — тестовая зависимость; перед публичным
   запуском используется домен оператора и настраивается deploy-hook renewal.
5. Экспортировать `VPN_NODE_STATE_DIRECTORY=<state-directory>` и выполнить
   `pnpm vpn-node:prepare` — seed `var/<state-directory>/xray-config.json`, затем дать
   группе контейнера Xray (GID 65532) только чтение runtime state:

   ```bash
   sudo chgrp 65532 var/<state-directory> var/<state-directory>/tls
   sudo chmod 2750 var/<state-directory> var/<state-directory>/tls
   sudo chgrp 65532 var/<state-directory>/xray-config.json var/<state-directory>/tls/cert.pem var/<state-directory>/tls/key.pem
   sudo chmod 640 var/<state-directory>/xray-config.json var/<state-directory>/tls/cert.pem var/<state-directory>/tls/key.pem
   ```

   Node-agent в production создаёт новый runtime-файл с mode `0640`; setgid на
   каталоге сохраняет группу 65532 после атомарной замены. `0644` для файла с
   клиентскими credentials не использовать.

6. Открыть UFW только когда inbound нужен:
   `sudo ufw allow 443/tcp comment 'VPN VLESS/TLS'`
7. С сохранённым `VPN_NODE_STATE_DIRECTORY` выполнить `pnpm vpn-node:up` —
   только control-plane-proxy. Команда не поднимает Xray: явный `compose up`
   обходит clock guard даже при `restart: "no"`. Serving поднимает только
   node-agent после trusted clock и verified reload. Аварийный
   `pnpm vpn-node:break-glass-start-xray` в штатный порядок не входит.
8. Node-agent (из `apps/node-agent`, с `agent.env`):

   ```bash
   cd apps/node-agent
   node --env-file=../../var/<state-directory>/agent.env dist/main.js
   ```

   Для постоянного запуска из корня checkout установите versioned systemd unit,
   явно указав параметры конкретной ноды. `VPN_NODE_STATE_DIRECTORY` должен быть
   leaf-каталогом вроде `vpn-fi-01` или `vpn-nl-01`, а путь Node берётся из
   фактически установленного runtime, а не из примера в репозитории:

   ```bash
   project_root="$(pwd)"
   node_binary="$(command -v node)"
   sudo bash infra/vpn-node/install-node-agent-systemd.sh \
     --project-root "$project_root" \
     --state-directory "$VPN_NODE_STATE_DIRECTORY" \
     --node-binary "$node_binary" \
     --service-user vpnadmin \
     --service-group vpnadmin \
     --docker-group docker
   systemctl is-enabled vpn-platform-node-agent
   systemctl is-active vpn-platform-node-agent
   ```

   Renderer принимает только абсолютные POSIX paths, безопасные Linux user/group
   names и один leaf state-directory; неизвестные, повторные и небезопасные
   параметры отклоняются до установки. Имена `root`, UID/GID `0` и их алиасы
   запрещены. Unit запускает agent от явно указанного непривилегированного
   пользователя, добавляет явно указанную Docker-группу, использует `agent.env`
   выбранной ноды и восстанавливает процесс после любого неожиданного выхода.

   `SupplementaryGroups=` добавляет группу к memberships из системной user/group
   database, а не заменяет их. Поэтому installer не заявляет, что у процесса будет
   только Docker supplementary group. Для строгого least privilege создайте отдельный
   service user и не включайте его в `sudo`, `adm` или иные необязательные группы;
   проверяйте `id -G <service-user>` при provisioning и после изменения host identity.

   Systemd является единственным владельцем lifecycle node-agent. Если в state
   остался legacy `node-agent.pid`, установщик останавливается и не посылает сигнал
   указанному PID: PID может быть переиспользован другим процессом. Оператор сначала
   отдельно проверяет executable, UID и command line процесса и завершает реальный
   legacy agent через его прежний supervisor/процедуру. Stale marker удаляется только
   после подтверждения, что соответствующего legacy agent больше нет; затем installer
   запускается повторно. Для offline-проверки renderer без `/etc` и `systemctl`
   предусмотрен `--render-only <absolute-output.service>`; output обязан быть
   безопасным абсолютным POSIX path.

9. Проверка цикла: heartbeat → pull → apply → container-local serving verification
   → ack → `appliedConfigVersion` догоняет desired в БД. Acknowledgement допустим
   только после точного совпадения фактически загруженных Xray users с ожидаемым
   access list.
10. Happ Windows: обновить подписку, подключиться к выбранной ноде, проверить смену IP
    (например ifconfig.me). Это consumer-туннель через удалённую ноду.

## Постоянный запуск закрытого Windows-контура

Для Amsterdam closed test локальный API и reverse SSH можно зарегистрировать как
две задачи текущего пользователя Windows:

```powershell
& .\infra\vpn-node\windows\install-closed-test-tasks.ps1
```

Задачи стартуют при входе пользователя, не требуют административных прав и имеют
минутный recovery-trigger: пока процесс работает, повторный запуск игнорируется,
а после внешнего завершения задача поднимается на ближайшем интервале. Task action
использует GUI launcher `wscript.exe`, который создаёт PowerShell сразу в скрытом
режиме без краткой консольной вспышки. API
остаётся только на `127.0.0.1:3001`;
reverse SSH публикует на VPS только loopback `127.0.0.1:13001` и сам повторяет
подключение после смены сети. Tunnel runner хранит PID и время запуска дочернего
`ssh.exe`: если PowerShell-задача была завершена отдельно, новый runner принимает
оставшийся SSH под наблюдение вместо конкурирующего remote forward. Endpoint берётся из gitignored
`var/vpn-nl-01/bootstrap.json`, поэтому IP не попадает в versioned task scripts.

Это устойчивый closed-test контур, но не production control plane: он зависит от
включённого ноутбука и активного входа пользователя Windows. Для production нужен
постоянный HTTPS origin вне ноутбука.

## Диагностика `SYN_SENT` без смены IP

Если Happ показывает подключение, но публичный IP не меняется:

1. Проверить глобальный `Настройки → Правила маршрутизации` в Happ. Сторонний
   ruleset может применяться к серверу из другой подписки: при `globalProxy=false`
   и direct-правиле для `geosite:ip-detect` сайт проверки IP намеренно обходит
   VPN. Для full-tunnel теста использовать ruleset с `globalProxy=true`.
2. На клиенте проверить, что физическое соединение к inbound ноды не остаётся в
   `SYN_SENT`.
3. Одновременно на VPS запустить ограниченный по времени захват
   `sudo timeout 240 tcpdump -l -nn -tttt -i any 'tcp port 443'` и повторить
   подключение из целевой пользовательской сети.
4. Если SYN клиента отсутствует в захвате, но VPS видит и обслуживает SYN других
   источников, дополнительно проверить listener, UFW и Docker publish/NAT. При их
   исправности передать провайдеру VPS время теста и исходный публичный IP для
   проверки routing, anti-DDoS/security filters и blackhole.

Домен, резолвящийся в тот же публичный IP, не устраняет блокировку маршрута к IP.
До успешного consumer-теста из целевой сети этап не считается завершённым.

## Reload Xray

Node-agent после записи runtime-конфига выполняет
`NODE_AGENT_XRAY_RELOAD_COMMAND` (по умолчанию `docker compose … restart xray`).
`docker compose kill -s HUP` не использовать: Docker считает это ручной
остановкой и не обязан вернуть контейнер в serving. Production Xray имеет
`restart: "no"`: Docker daemon после reboot не поднимает Xray сам. Это не
запрещает явный `compose up`/`restart` — штатный `vpn-node:up` запускает
только proxy. Systemd `ExecStartPre` останавливает Xray и подтверждает
отсутствие running container той же docker-ps post-condition, что fail-closed.
Certbot после замены TLS делает verified stop и `systemctl restart` агента.
Serving поднимает только агент после trusted clock и verified reload/read-back.
Неизменный access list не вызывает reload только если runtime реально serving;
внешняя остановка контейнера инвалидирует fingerprint shortcut.
Команда должна завершиться только после успешного запуска Xray. Затем node-agent
через `docker exec` читает активных users из Xray Handler API и сравнивает их с
ожидаемым списком. API слушает `127.0.0.1:10085` только внутри Xray-контейнера;
не добавлять для него Compose `ports` и не открывать UFW. Ошибка API либо
старый/частичный список запрещает durable applied state и acknowledgement;
следующий pull той же версии повторяет restart и проверку.

При отсутствующем или повреждённом `NODE_AGENT_STATE_FILE` node-agent применяет
selective fail-closed: production Xray container принудительно останавливается,
пока полный уже applied snapshot не будет заново загружен, проверен и сохранён.
Обычная недоступность control plane при исправном state Xray не останавливает.
Целостность state проверяется каждые 10 секунд, включая snapshot hash и
version-инварианты; unreadable state также считается недоверенным. Неизменный
access list при этом не вызывает restart. После failed write/rename/fsync
serving не возобновляется, пока повторный file и directory fsync не подтвердит
durability видимого state.
Локальный expiry и failed apply повторяются каждые 10 секунд, production poll
ограничен 60 секундами. Version gap без matching command также проверяется через
10 секунд: snapshot не применяется, но полученный revoke атомарно создаёт
`NODE_AGENT_STATE_FILE.stop-only.json` mode `0600` без credentials, подтверждает
file/directory durability до runtime stop и затем немедленно останавливает Xray.
Marker переживает restart node-agent и блокирует local resume
при недоступном control plane либо временно unreadable основном state. Он
удаляется только после verified matching apply и полного durability barrier.
Если expiry/revoke apply не укладывается в пятиминутный SLA с 120-секундным
резервом, все matching Xray containers останавливаются одной командой, а
отдельный `docker ps` подтверждает отсутствие running container. Serving
поднимается штатным restart только для verified matching command или recovery.

## Автоматическое обновление TLS

Для Certbot standalone renewal используются versioned hooks из
`infra/vpn-node/certbot/` и root-only installer:

```bash
sudo bash infra/vpn-node/install-xray-certificate-renewal.sh \
  <state-directory> <tls-hostname>
```

Installer размещает root-owned hooks в стандартных каталогах Certbot и включает
`certbot.timer`. Pre-hook открывает UFW `80/tcp` только на время ACME challenge и
создаёт marker в `/run`; post-hook удаляет только правило, созданное этим
контуром. Уже существующее правило оператора hook не удаляет.

Deploy-hook принимает только Certbot lineage из `/etc/letsencrypt/live`,
проверяет срок, hostname и совпадение публичного ключа сертификата с private key,
подготавливает пару в закрытом staging-каталоге, сохраняет owner/mode/GID и
заменяет файлы на диске. После замены hook выполняет verified stop
(`docker ps` должен завершиться успешно и не показать running Xray) и
перезапускает `vpn-platform-node-agent.service`. Затем hook сам ждёт
совпадение live TLS fingerprint на localhost с lineage-сертификатом по
монотонному deadline 120 секунд; каждый probe ограничен оставшимся
временем, а не отдельными 8 секундами сверх бюджета. `XRAY_TLS_DEPLOYED`
печатается только после этого совпадения. Timeout завершает hook ненулевым
кодом, восстанавливает предыдущую пару и не поднимает Xray. Serving
возобновляет node-agent после clock-проверки и verified reload/read-back.
При ошибке замены, остановки, wakeup или fingerprint-wait предыдущая пара
восстанавливается, Xray остаётся остановленным. Installer после deploy
дополнительно проверяет active агент и тот же fingerprint. Docker `running`
не считается verified resume; access list по-прежнему подтверждает только
node-agent.

Установщик выполняет отрицательный тест с несовпадающим ключом, успешный deploy
текущей production-пары и `certbot renew --dry-run` без запуска deploy-hook для
staging-сертификата. После dry-run marker и UFW `80/tcp` должны отсутствовать.

## Что вне этого этапа

- Platform VPS (API/Postgres на vpn-fi-01).
- iOS / HTTPS subscription origin (отдельный трек).
- Платежи и admin HTTP.
- `allowInsecure` в production feed.
- Ручное редактирование `/etc/xray/config.json` на сервере.

## Ссылки

- Local prototype: `infra/xray-local/README.md`
- Application rules: `docs/vpn-application-implementation-tz.md` §8
- Infra: `docs/vpn-technical-spec.md` §3, §6–7
