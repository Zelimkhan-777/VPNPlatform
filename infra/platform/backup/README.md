# PostgreSQL backup и restore drill для `platform-1`

Этот каталог содержит versioned host-level automation для ежедневного
зашифрованного backup PostgreSQL и ежемесячной изолированной проверки
восстановления. Скрипты используют закреплённые digest образов restic и
PostgreSQL. Дамп передаётся из `pg_dump` в restic по pipe и не записывается на
диск в открытом виде.

Это не процедура восстановления production БД. `restore-drill.sh` создаёт
одноразовый PostgreSQL без сети, host ports и persistent volume, проверяет
таблицы и состояние Prisma migrations, затем всегда удаляет контейнер.

## Зафиксированная политика

- запуск backup: ежедневно в `02:15 UTC` с jitter до 30 минут;
- retention: 14 daily, 8 weekly, 12 monthly snapshots;
- после backup: repository check с чтением случайных 5% data packs;
- restore drill: ежемесячно с jitter до 2 часов;
- repository: S3-compatible object storage в отдельном failure domain,
  предпочтительно у другого провайдера/в другом российском ДЦ;
- шифрование: restic с отдельным сильным паролем, не совпадающим с любым
  application/server credential.

Object storage versioning/immutability следует включить, если провайдер это
поддерживает. Его lifecycle policy не должна удалять объекты раньше restic.
Доступ выдаётся отдельному service account только к одному backup bucket.

## Секреты и конфигурация

Реальные значения находятся только вне checkout:

```text
/etc/meteora/backup.env                 root:root 0600
/etc/meteora/backup-policy.env          root:root 0600
/etc/meteora/backup-secrets/            root:root 0700
/etc/meteora/backup-secrets/restic-password  root:root 0600
```

`backup.env.example` — заведомо нерабочая test-only форма S3-конфигурации.
`backup-policy.env.example` не содержит секретов, но production-копия всё равно
защищается mode `0600`, потому что parser принимает только точный allowlist.
Пароль restic нельзя потерять: без него backup невосстановим. Его независимая
офлайн-копия хранится отдельно от сервера и object-storage credentials.

Пример подготовки после отдельного утверждённого secrets stage:

```bash
sudo install -d -o root -g root -m 0700 /etc/meteora/backup-secrets
sudo install -o root -g root -m 0600 backup.env /etc/meteora/backup.env
sudo install -o root -g root -m 0600 backup-policy.env /etc/meteora/backup-policy.env
sudo install -o root -g root -m 0600 restic-password /etc/meteora/backup-secrets/restic-password
```

Не вставляйте реальные файлы, токены, bucket URL или пароль в Git, shell
history, сообщения и скриншоты.

## Первый запуск

До запуска должны существовать production Compose и
`/etc/meteora/platform.env`; контейнер `postgres` должен быть healthy. Затем:

```bash
cd /opt/meteora/current
sudo bash infra/platform/backup/initialize-repository.sh
sudo bash infra/platform/backup/backup-postgres.sh
sudo bash infra/platform/backup/restore-drill.sh
sudo bash infra/platform/backup/install-systemd.sh
```

Repository инициализируется ровно один раз. Повторный `init` не является
штатной операцией. Таймеры включаются только после успешных ручных backup и
restore drill.

Проверка состояния:

```bash
sudo systemctl list-timers 'meteora-postgres-*'
sudo systemctl status meteora-postgres-backup.timer
sudo systemctl status meteora-postgres-restore-drill.timer
sudo journalctl -u meteora-postgres-backup.service --since '7 days ago'
sudo journalctl -u meteora-postgres-restore-drill.service --since '2 months ago'
```

Успех подтверждают только маркеры `POSTGRES_BACKUP_CHECK_COMPLETE` и
`POSTGRES_RESTORE_DRILL_COMPLETE`. Любой ненулевой exit code или
`BACKUP_ERROR` требует расследования; старый успешный backup не закрывает новый
сбой. Репозиторий не следует автоматически `unlock`/`repair`: сначала
проверяется отсутствие живого процесса и сохраняется диагностический вывод.

## Disaster recovery boundary

Восстановление реального `platform-1` выполняется отдельной утверждённой
maintenance-процедурой на чистом host: закреплённый release, совместимые
forward-only migrations, пустая PostgreSQL, выбранный проверенный snapshot и
последующая application/infrastructure validation. Эти скрипты намеренно не
перезаписывают production volume и не выполняют destructive restore.

До фактической настройки offsite repository и успешного drill требование
production backup остаётся незакрытым.

Локальный disposable end-to-end smoke без production credentials запускается из
корня репозитория командой `pnpm platform:backup:smoke`. Он проверяет реальный
зашифрованный round trip и удаляет оба временных контейнера и repository.
