# Локальный прототип двух Xray-нод

Это localhost/dev-контур. Он не является боевой VPN-нодой, production adapter
или заменой VPS. `NODE_AGENT_MODE=simulation` и `local-xray` запрещены при
`NODE_ENV=production`. Runtime-конфиг, TLS, UUID, credentials и subscription URL
живут в `var/xray-local/` и не коммитятся.

Публичного admin HTTP для нод нет. Harness вызывает внутренние методы
orchestration: `publishConnectionRoute`, `scheduleNodeAccessGrant`,
`disableNode`. Обычный `disabled` не подменяется `quarantined`.

## Окружение

В некоммитимом `.env` (минимум 32 символа для pepper-секретов):

```text
AUTH_SESSION_PEPPER=<случайное локальное значение>
SUBSCRIPTION_TOKEN_PEPPER=<случайное локальное значение>
DATA_PLANE_CREDENTIAL_PEPPER=<случайное_base64url_значение_не_короче_43_символов>
NODE_AGENT_CREDENTIAL_PEPPER=<случайное локальное значение>
SUBSCRIPTION_FEED_BASE_URL=http://127.0.0.1:3001
CABINET_ORIGIN=http://127.0.0.1:3000
SUBSCRIPTION_FEED_RENDERING_ENABLED=true
```

`SUBSCRIPTION_FEED_RENDERING_ENABLED` по умолчанию `false`. Для этого прототипа
включите его явно в local `.env` и перезапустите API. Не включайте в production.

Порты localhost Xray (не VPS):

```text
XRAY_LOCAL_A_PORT=10443
XRAY_LOCAL_B_PORT=10444
```

Пути `NODE_AGENT_*` в `agent.env` относительны к `apps/node-agent`.

## Порядок up

Из корня репозитория:

```powershell
pnpm db:up
pnpm prisma:migrate
pnpm xray:local:up
pnpm --filter @vpn-platform/api dev
pnpm xray:local:harness
pnpm --filter @vpn-platform/node-agent dev:local-a
pnpm --filter @vpn-platform/node-agent dev:local-b
pnpm xray:local:restart
```

`xray:local:harness` создаёт две HEALTHY ноды, endpoint/profile/public config,
публикует маршруты, устройство с активной подпиской и grant на обе ноды, затем
переводит sync jobs в `SUCCEEDED`, чтобы node-agent мог pull/apply/ack.
Кабинет grant не ставит.

Worker для этого прототипа не обязателен: harness сам claim/complete jobs.

## Как получить URL

После harness откройте gitignored файл `var/xray-local/subscription.url`.
Не копируйте полный URL в логи, скриншоты, Git или чат с секретами.
Это bearer-секрет устройства; в базе хранится только хеш.

## Как убрать ноду

Обычный disable, не quarantine:

```powershell
pnpm xray:local:harness -- disable a
```

Нода исключается из следующего ответа subscription feed. Живые grants не
отзываются. Ключ/URL не меняется. Возврат в `HEALTHY` и unquarantine в этот
этап не входят.

## Restart/reload Xray после apply

Процесс Xray читает runtime-конфиг при старте. После того как node-agent
записал apply, перезапустите контейнеры:

```powershell
pnpm xray:local:restart
```

Или по одному:

```powershell
docker compose -f infra/docker-compose.xray-local.yml restart xray-a
docker compose -f infra/docker-compose.xray-local.yml restart xray-b
```

Остановка:

```powershell
pnpm xray:local:down
```

## Ручная проверка Happ

Это чеклист оператора. Агент не закрывает Happ на телефоне или Windows;
факт проверки на устройстве пишет пользователь в `docs/vpn-project-journal.md`.

1. Импортировать URL из `var/xray-local/subscription.url` в актуальную Happ.
2. Убедиться, что видны две конфигурации (`Local A` и `Local B`).
3. Выполнить `pnpm xray:local:harness disable a` (не quarantine).
4. Обновить подписку в Happ без повторного импорта URL.
5. Остаётся одна конфигурация; ключ/URL тот же.
6. Неверный токен: HTTP 401. При выключенном renderer или без applied routes:
   пустой `200 text/plain`.

Happ на iOS отклоняет `http://` («небезопасная схема http запрещена»), в том
числе `http://127.0.0.1:3001`. Подписка может сохраниться без конфигураций.
«Соединение отклонено» на ПК значит, что на адресе/порте никто не слушал
(API не запущен) — это не список нод из harness.

Импорт URL на недоступных loopback-адресах не заменяет эту проверку живого
feed + local-xray. Для iOS живой feed с телефона требует HTTPS URL, который
достижим с устройства, а не `127.0.0.1` компьютера.
