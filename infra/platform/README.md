# Production control plane на `platform-1`

Этот каталог описывает первый production-shaped deployment control plane. Он не
разворачивает Xray и не меняет VPN-ноды. Единственные публикуемые host ports —
`80/tcp` и `443/tcp` reverse proxy; PostgreSQL, Redis, API и web доступны только
по Docker networks.

## Состав и текущие ограничения

- `reverse-proxy`: Caddy с автоматическим TLS и маршрутизацией четырёх доменов;
- `web`: корневая страница, кабинет и будущая `/admin`;
- `migrate`: одноразовый `prisma migrate deploy` до запуска API/worker;
- `api`, `worker`, PostgreSQL и Redis;
- `bot`: честно оставлен opt-in profile, потому что production polling/webhook ещё
  не реализован и текущий scaffold сразу завершается;
- application images передаются только immutable references с `@sha256`;
- Caddy/PostgreSQL/Redis закреплены multi-platform digest официальных образов;
- production secret storage и backup/restore — отдельные обязательные этапы. До
  их завершения этот manifest нельзя запускать для платных пользователей.

`production.env.example` — только безопасная render/test fixture. Она содержит
заведомо тестовые значения и не является шаблоном, который можно копировать в
production без замены. Реальный файл предполагается вне checkout:
`/etc/meteora/platform.env`, owner `root:root`, mode `0600`. Не добавляйте его в
Git, сообщения, логи или скриншоты.

## Локальная проверка manifest

Из корня репозитория:

```powershell
pnpm platform:compose:validate
node --test infra/compose-guardrails.test.mjs
```

Проверка работает без Docker daemon и не создаёт контейнеры. Guardrails требуют:

- ровно один публикующий сервис (`reverse-proxy`);
- только `80/tcp` и `443/tcp`;
- internal network для PostgreSQL/Redis;
- отсутствие Xray;
- immutable image digests;
- успешную миграцию как dependency API и worker;
- read-only filesystem, dropped capabilities и `no-new-privileges` для
  application/reverse-proxy containers;
- фиксированный proxy IP, совпадающий с `TRUSTED_PROXY_IPS` API;
- редактирование subscription bearer path в proxy runtime logs.

## Preconditions перед первым deploy

Deploy запрещён, пока не выполнены все пункты:

1. Регистрация и управление `mymeteora.ru` подтверждены; A/AAAA records не
   направляются на сервер до готовности deployment.
2. Собраны, протестированы и опубликованы четыре release images; в
   `/etc/meteora/platform.env` записаны их точные digest references.
3. Завершён отдельный этап production secrets. Значения fixture не используются.
4. Настроен автоматический зашифрованный PostgreSQL backup в отдельном failure
   domain и выполнено тестовое восстановление.
5. Проверены правила Selectel для размещаемого control plane.
6. На `platform-1` по-прежнему нет Xray и публичных listeners, кроме SSH.

## Первый deploy

Команды ниже выполняются на `platform-1` из versioned checkout
`/opt/meteora/current`. Не запускайте их с Windows и не подменяйте пути.

```bash
cd /opt/meteora/current
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  config --quiet

sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  pull

sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  up -d postgres redis

sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  up migrate
```

`migrate` обязан завершиться с exit code `0`. Только после этого:

```bash
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  up -d --wait api worker web reverse-proxy
```

Profile `bot` не включается до реализации и отдельной проверки Telegram mode.
Не используйте `--profile bot` на production server на текущем этапе.

После успешного локального `config`, DNS-проверки и готовности containers оператор
отдельно разрешает UFW `80/tcp` и `443/tcp`. Docker published ports могут обходить
часть UFW policy, поэтому guardrail проверяется до каждого deploy; добавлять
публикацию API/PostgreSQL/Redis запрещено.

## Обязательная проверка

```bash
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  ps
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  logs --since 10m --no-log-prefix reverse-proxy api worker
sudo ss -lntup
sudo ufw status verbose
sudo systemctl --failed
```

Снаружи проверяются HTTPS и цепочка сертификата для root/app/api/sub, API
`/health/live` и `/health/ready`, отсутствие доступа к `3000`, `3001`, `5432`,
`6379`, запрет произвольных путей на `sub` и отсутствие полного subscription URL
в логах. Реальный bearer token не передаётся в shell history или скриншоты.

## Обновление и rollback

1. Сохранить текущие image digests и результат backup.
2. Обновить только digest references в защищённом environment file.
3. Выполнить `config --quiet`, `pull`, `up migrate`, затем
   `up -d --wait api worker web reverse-proxy`.
4. При application regression вернуть предыдущие совместимые image digests и
   повторить `up -d --wait`. Forward-only migration не откатывается вручную.
5. Если новая схема несовместима с прежним приложением, применяется заранее
   утверждённая recovery procedure и проверенный backup, а не импровизированный
   SQL rollback.

`docker compose down -v`, ручное удаление volumes и редактирование production БД
запрещены. Обычный `down` также не используется как штатный способ обновления.
