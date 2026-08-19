# Bootstrap VPN-ноды vpn-fi-01

Это первый боевой data-plane контур для тестовой VPS `vpn-fi-01` (Финляндия).
Control plane остаётся на машине оператора (Windows, API `:3001`); на VPS ставятся
только Xray и node-agent. Runtime Xray на сервере не правится вручную — только
через node-agent и control plane.

`NODE_AGENT_MODE=xray` разрешён только при `NODE_ENV=production`. Режимы
`simulation` и `local-xray` на VPS запрещены.

## Предусловия

1. Закрытый localhost-этап: `pnpm xray:local:harness` (устройство и subscription URL).
2. API и Postgres подняты локально (`pnpm db:up`, `pnpm prisma:migrate`, API dev).
3. VPS `vpn-fi-01`: SSH по ключу, UFW (22/tcp), **VPN-порт пока закрыт**.
4. TLS-сертификат для inbound: `cert.pem` и `key.pem` с SAN/SNI, совпадающим с
   `VPN_FI_TLS_SERVER_NAME`. Production-renderer не выпускает `allowInsecure`.
5. **HTTPS origin control plane**, доступный с VPS outbound: tunnel (Cloudflare,
   ngrok и т.п.), публичный API или reverse proxy. IP Windows и ключи в Git/чат
   не класть.

## Переменные bootstrap (локально, не коммитить)

В `.env` или окружении перед `pnpm vpn-fi:bootstrap`:

```text
VPN_FI_ENDPOINT_HOST=<публичный IPv4 VPS без секретов в логах>
VPN_FI_TLS_SERVER_NAME=<hostname из сертификата, например fi.example.test>
VPN_FI_NODE_AGENT_API_BASE_URL=https://<tunnel-or-api-host>
VPN_FI_VPN_PORT=443
VPN_FI_DISPLAY_NAME=Finland
# опционально, если compose лежит не в корне репо на VPS:
# VPN_FI_XRAY_RELOAD_COMMAND=docker compose -f /opt/vpn-platform/infra/docker-compose.vpn-node.yml kill -s HUP xray
```

`VPN_FI_NODE_AGENT_API_BASE_URL` — URL, с которого **VPS** достучится до
`GET/POST /node-agent/v1/*` по HTTPS. Это не `http://127.0.0.1:3001`.

## Порядок на control plane (Windows)

```powershell
pnpm vpn-fi:bootstrap
```

Harness:

- регистрирует ноду `vpn-fi-1` (HEALTHY), endpoint, VLESS/TCP/TLS profile;
- выдаёт grant и route на **то же устройство**, что local harness
  (`var/xray-local/harness.json`);
- пишет `var/vpn-fi-01/agent.env` и `bootstrap.json` (gitignored).

Обновите подписку в Happ **без нового URL** — должна появиться нода Finland
(рядом с Local A/B, если они ещё enabled).

## Порядок на VPS

1. Клонировать репозиторий, `pnpm install`, `pnpm build`.
2. Скопировать `var/vpn-fi-01/agent.env` с control plane (режим `600`, не Git).
3. Положить TLS: `var/vpn-fi-01/tls/cert.pem` и `key.pem` (для образа Xray UID
   65532 — `chmod 644`, как в local runbook).
4. `pnpm vpn-node:prepare` — seed `var/vpn-fi-01/xray-config.json`.
5. Открыть UFW только когда inbound нужен:
   `sudo ufw allow 443/tcp comment 'VPN VLESS/TLS'`
6. `pnpm vpn-node:up` — Xray на `:443`.
7. Node-agent (из `apps/node-agent`, с `agent.env`):

   ```bash
   cd apps/node-agent
   node --env-file=../../var/vpn-fi-01/agent.env dist/main.js
   ```

   Или systemd unit с тем же `--env-file` (unit не в Git — настраивает оператор).

8. Проверка цикла: heartbeat → pull → apply → ack → `appliedConfigVersion`
   догоняет desired в БД.
9. Happ Windows: обновить подписку, подключиться к Finland, проверить смену IP
   (например ifconfig.me). Это consumer-туннель через удалённую ноду.

## Reload Xray

Node-agent после записи runtime-конфига выполняет
`NODE_AGENT_XRAY_RELOAD_COMMAND` (по умолчанию `docker compose … kill -s HUP xray`).
Команда должна работать из каталога, где доступен compose-файл, и иметь право
послать SIGHUP контейнеру xray.

## Что вне этого этапа

- Platform VPS (API/Postgres на vpn-fi-01).
- iOS / HTTPS subscription origin (отдельный трек).
- Платежи, admin HTTP, вторая VPS.
- `allowInsecure` в production feed.
- Ручное редактирование `/etc/xray/config.json` на сервере.

## Ссылки

- Local prototype: `infra/xray-local/README.md`
- Application rules: `docs/vpn-application-implementation-tz.md` §8
- Infra: `docs/vpn-technical-spec.md` §3, §6–7
