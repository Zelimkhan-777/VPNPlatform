# Versioned release delivery

Этот этап доставляет точный Git checkout на `platform-1`, но не является
application deployment: он не запускает Compose, migrations или containers, не
меняет firewall/DNS и не обращается к VPN-нодам.

## Создание offline artifact

На доверенной локальной машине checkout должен иметь чистые tracked files,
`HEAD` должен совпадать с полным SHA и входить в локальную `main`. Untracked files
(включая локальный `.env`) Git bundle не включает. Output намеренно разрешён
только вне repository:

```powershell
node infra/platform/release/create-release-bundle.mjs `
  --commit '<full-40-character-sha>' `
  --output-directory 'C:\secure-transfer\meteora-release'
```

Команда создаёт `<sha>.bundle` и `<sha>.manifest.json`. Manifest содержит только
SHA commit, имя bundle и его SHA-256. Artifact не содержит runtime state,
untracked files или production secret/config files, находящихся вне tracked Git
history. Перед передачей оператор сверяет оба файла и переносит bundle по
доверенному каналу.

SHA-256 вместе с проверкой Git objects подтверждает целостность локально
созданного и доставленного artifact. Это не аутентифицирует автора и не заменяет
будущую signing/provenance policy.

## Установка checkout

Один раз подготовьте root-owned каталоги без symlink:

```bash
sudo install -d -o root -g root -m 0755 /opt/meteora /opt/meteora/releases
```

Затем передайте installer три значения из независимо проверенного manifest:

```bash
sudo bash infra/platform/release/install-release.sh \
  --bundle '/absolute/path/<sha>.bundle' \
  --expected-commit '<full-40-character-sha>' \
  --expected-sha256 '<64-character-sha256>'
```

Installer проверяет checksum, `git bundle verify` и наличие exact commit как
bundle head, создаёт clean detached checkout в temporary directory и устанавливает
его в `/opt/meteora/releases/<sha>`. Существующий release не перезаписывается.
После materialization выполняются `sync -f` durability barriers для filesystem,
а `/opt/meteora/current` меняется одним `rename(2)` через `mv -T`. Старые releases
не удаляются. Ошибка до switch сохраняет прежний `current`, а ошибка между switch
и финальной проверкой атомарно его восстанавливает; повтор уже установленного SHA
завершается fail-closed с `release-already-exists`.

После успеха отдельно запускается read-only preflight из platform runbook.
Создание release checkout само по себе не разрешает production deployment.
