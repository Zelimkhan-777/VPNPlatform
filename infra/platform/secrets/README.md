# Production secrets для `platform-1`

Этот каталог создаёт и проверяет единый защищённый
`/etc/meteora/platform.env`, который читает production Compose. Реальные
значения никогда не пишутся в checkout и не выводятся в stdout/stderr.

Инициализатор:

- принимает отдельный non-secret deployment config и Telegram bot token из
  root-only файла;
- генерирует криптографически независимые PostgreSQL password и четыре pepper;
- связывает `DATABASE_URL`, cabinet/feed origins и service DNS с исходными
  полями, чтобы они не могли разойтись;
- отклоняет test fixtures, mutable image tags, неизвестные/повторяющиеся ключи,
  неверные права и symlink;
- создаёт `platform.env` mode `0600` через fsync и атомарную no-overwrite
  операцию;
- никогда не перезаписывает существующий файл.

Bot signing использует отдельные файлы и не расширяет one-shot
`platform.env`. `initialize-bot-signing-kek.sh` один раз создаёт API-only
`/etc/meteora/platform-secrets/bot-signing-kek` как 32 random bytes в canonical
base64url. Активный `/etc/meteora/bot-secrets/credential` создаёт и
атомарно заменяет только application CLI после записи encrypted credential в
PostgreSQL.

Ротация намеренно не автоматизирована. Замена peppers может инвалидировать
сессии, subscription URL или credentials нод и требует отдельного плана,
совместимого rollout и recovery.

## Входные файлы

На `platform-1`:

```text
/etc/meteora/                              root:root 0700
/etc/meteora/platform-config.env           root:root 0600
/etc/meteora/platform-secrets/             root:root 0700
/etc/meteora/platform-secrets/telegram-bot-token  root:root 0600
/etc/meteora/platform-secrets/bot-signing-kek     root:meteora-api-secret 0440
/etc/meteora/bot-secrets/                         root:meteora-bot-secret 0750
/etc/meteora/bot-secrets/credential               root:meteora-bot-secret 0440 (после provisioning)
```

`platform-config.env` не содержит секретов, но определяет точные production
домены, release images, database identity и несекретные trial rate-limit settings. Он создаётся по структуре
`platform-config.env.example`, при этом все `.example.invalid` и тестовые digest
обязательно заменяются. Image references копируются только из проверенного
release artifact и заканчиваются точным `@sha256:<64 hex>`.

Telegram bot token не передаётся аргументом командной строки. Без настоящего
токена production API сейчас fail-closed, поэтому до создания бота этот этап
можно проверить локально, но нельзя завершить на сервере.

Пример безопасной подготовки token-файла без echo секрета и без его появления в
shell history:

```bash
sudo install -d -o root -g root -m 0700 /etc/meteora
sudo install -d -o root -g root -m 0700 /etc/meteora/platform-secrets
sudo groupadd --system --gid 29001 meteora-api-secret
sudo groupadd --system --gid 29002 meteora-bot-secret
sudo install -d -o root -g meteora-bot-secret -m 0750 /etc/meteora/bot-secrets
sudo install -o root -g root -m 0600 platform-config.env /etc/meteora/platform-config.env
sudo bash -c 'umask 077; read -r -s -p "Telegram bot token: " token; printf "\n" >&2; printf "%s\n" "$token" > /etc/meteora/platform-secrets/telegram-bot-token; unset token'
```

Не вставляйте токен или содержимое итогового env в сообщения, скриншоты,
clipboard history или команды.

Имена и GID групп являются частью versioned wiring. Перед повторным запуском
команд убедитесь через `getent group`, что GID `29001` и `29002` принадлежат
ровно указанным группам, а список постоянных участников пуст. Не добавляйте в
них host users: доступ контейнерам выдаёт только Compose `group_add`.

## Инициализация и проверка

Команды выполняются на `platform-1` из versioned checkout:

```bash
cd /opt/meteora/current
sudo bash infra/platform/secrets/initialize.sh
sudo bash infra/platform/secrets/initialize-bot-signing-kek.sh
sudo bash infra/platform/secrets/validate.sh
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  config --quiet
```

Успех подтверждают маркеры `PLATFORM_ENV_INITIALIZATION_COMPLETE`,
`BOT_SIGNING_KEK_INITIALIZATION_COMPLETE` и `PLATFORM_ENV_VALID`. Validator
проверяет одновременно `platform.env`, отдельный KEK `root:meteora-api-secret
0440` и, если он уже provisioned, bot credential `root:meteora-bot-secret
0440`. `docker compose config`
разрешён только с `--quiet`:
обычный вывод render может раскрыть environment values.

Инициализатор запускается один раз. Если `platform.env` уже существует, нельзя
удалять его и генерировать новый «для повтора». Сначала сверяются сохранённая
зашифрованная recovery-копия, действующие credentials и отдельный план ротации.

## Bot credential provisioning и rotation

Команды выполняются только после успешной Stage B migration. Они требуют TTY;
principal name, reason, confirmation и key version вводятся интерактивно.
Signing key не передаётся через argv/stdout, общий env или логи. Одноразовый
`bot-credential-admin` имеет data network и временный доступ к каталогу secrets;
обычные `web`, `worker` и `migrate` не получают ни KEK, ни bot credential.
API получает только точечный read-only mount KEK и GID 29001, bot — только
точечный read-only mount credential и GID 29002. Admin получает KEK read-only и
каталог `/etc/meteora/bot-secrets` writable; общий каталог
`/etc/meteora/platform-secrets` ему не монтируется.

Первичное создание principal и key version 1:

```bash
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  --profile bot-admin \
  -f infra/docker-compose.production.yml \
  run --rm bot-credential-admin provision
```

Если DB commit первичного provisioning прошёл, но атомарная установка файла
завершилась ошибкой, CLI автоматически отзывает новый credential. После
устранения причины ту же команду `provision` можно повторить: только при полном
отсутствии активных credentials она сохранит principal/audit history и создаст
следующую key version. При наличии активного credential recovery закрыт и
оператор обязан использовать обычную rotation.

Rotation создаёт следующую key version, оставляя прежнюю действующей, и только
после commit атомарно заменяет bot-only файл:

```bash
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  --profile bot-admin \
  -f infra/docker-compose.production.yml \
  run --rm bot-credential-admin rotate

sudo docker compose \
  --env-file /etc/meteora/platform.env \
  --profile bot \
  -f infra/docker-compose.production.yml \
  run --rm bot
```

Второй вызов пока только fail-closed проверяет чтение credential и signer:
production Telegram mode остаётся неактивным. Старую версию запрещено отзывать,
пока новая не подтверждена реальным подписанным bot→API вызовом после реализации
соответствующего endpoint. После такого подтверждения revoke выполняется по
старой key version; CLI не позволит отозвать credential из текущего bot-файла:

```bash
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  --profile bot-admin \
  -f infra/docker-compose.production.yml \
  run --rm bot-credential-admin revoke
```

KEK автоматически не ротируется. Его потеря лишает API возможности проверить
все сохранённые bot credentials; его замена требует отдельного совместимого
rollout и проверенной recovery-копии.

## Хранение и recovery

`platform.env` содержит bootstrap material, необходимый не только для запуска
БД, но и для проверки существующих сессий, subscription URL и node credentials.
После создания оператор делает независимую зашифрованную офлайн-копию файла и
проверяет возможность её расшифровать. Копия хранится отдельно от `platform-1`,
репозитория Git и обычных screenshots/notes. Сам restic repository не является
единственным допустимым местом для этой копии: его собственный пароль тоже
требует независимого recovery path.

Наличие tooling в Git не закрывает production precondition. Он закрывается
только после создания настоящего root-only файла, успешной validation и
проверенной recovery-копии.
