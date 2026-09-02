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
```

`platform-config.env` не содержит секретов, но определяет точные production
домены, release images и database identity. Он создаётся по структуре
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
sudo install -o root -g root -m 0600 platform-config.env /etc/meteora/platform-config.env
sudo bash -c 'umask 077; read -r -s -p "Telegram bot token: " token; printf "\n" >&2; printf "%s\n" "$token" > /etc/meteora/platform-secrets/telegram-bot-token; unset token'
```

Не вставляйте токен или содержимое итогового env в сообщения, скриншоты,
clipboard history или команды.

## Инициализация и проверка

Команды выполняются на `platform-1` из versioned checkout:

```bash
cd /opt/meteora/current
sudo bash infra/platform/secrets/initialize.sh
sudo bash infra/platform/secrets/validate.sh
sudo docker compose \
  --env-file /etc/meteora/platform.env \
  -f infra/docker-compose.production.yml \
  config --quiet
```

Успех подтверждают маркеры `PLATFORM_ENV_INITIALIZATION_COMPLETE` и
`PLATFORM_ENV_VALID`. `docker compose config` разрешён только с `--quiet`:
обычный вывод render может раскрыть environment values.

Инициализатор запускается один раз. Если `platform.env` уже существует, нельзя
удалять его и генерировать новый «для повтора». Сначала сверяются сохранённая
зашифрованная recovery-копия, действующие credentials и отдельный план ротации.

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
