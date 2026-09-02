# Application Stage A — decision proposal

**Статус:** рекомендации всех семи разделов подтверждены владельцем 2026-09-03 и перенесены в owner-документы. Альтернативы и вопросы сохранены как история принятия решения, а не как действующие варианты реализации.

**Дата:** 2026-09-02

**Основание:** принятый аудит `docs/reviews/application-readiness-audit.md` (этап A) и owner-документы.

**Назначение:** сохранить рассмотренные варианты, аргументы и принятый пакет решений Application Stage A. Текущие требования находятся в authoritative product/application/infrastructure specifications, а не в этом review-файле.

**Правки:** после пятого review P2: HMAC-вариант не меняет network topology/Caddy, но обязан описать Compose secret wiring, initializer и runbook (`BOT_SIGNING_KEK` только API, signing key только bot).

Как читать каждый раздел: ограничения действующих ТЗ → рассмотренные варианты → подтверждённая рекомендация → trade-offs → перенесённый текст → влияние на schema/API/tests → закрытые вопросы владельцу.

Нельзя закрывать догадкой: auth, billing, subscription behavior и data integrity (`AGENTS.md`). Пакет ниже принят владельцем 2026-09-03; дальнейшие изменения требуют нового решения и синхронизации owner-документов.

---

## 1. 2FA критичных административных ролей

### Ограничения owner-документов

- Продукт §7: админка — отдельные роли, 2FA, журнал ручных действий; реализация — application ТЗ §5 и §10.
- Application §5: роли `OWNER`, `OPERATOR`, `SUPPORT`, `FINANCE`, `AUDITOR` выдаются только вручную через защищённую процедуру; для **критичных** ролей обязательны отдельная admin-сессия, 2FA и append-only audit.
- Application §10 п.11, п.23: admin 2FA material нет в логах, analytics, errors и audit payload.
- Technical spec: админка дополнительно ограничивается по сети (IP allowlist по возможности). Это инфраструктурный слой, не замена 2FA.
- Первичная пользовательская идентичность — Telegram, без пароля. Telegram как второй фактор использует тот же канал, что и вход.
- Какие роли считаются «критичными», механизм (TOTP/WebAuthn/иное), enrollment, recovery и step-up **не зафиксированы**.
- TOTP verifier считает код от исходного shared secret. HMAC/хеш секрета **необратим** и для TOTP непригоден. HMAC/хеш пригоден для одноразовых recovery codes.

### Варианты

1. **TOTP (RFC 6238)** с AEAD-encrypted seed в PostgreSQL; ключ шифрования (`key version` + KEK) только в secret storage вне БД; nonce/IV рядом с ciphertext; recovery codes как HMAC/хеш; enrollment `pending` до первого верного TOTP; отдельная `AdminSession`; step-up на необратимых операциях.
2. **WebAuthn/passkeys** как единственный второй фактор: сильнее к фишингу, сложнее enrollment/recovery первого OWNER на новой машине, выше объём schema/API.
3. **Код в Telegram / SMS** как 2FA: тот же мессенджер, что первичная идентичность, либо SIM-swap и PII. Не закрывает требование отдельного фактора. HMAC-only хранение TOTP seed **не является вариантом**: verifier не сможет вычислить код.

### Рекомендация (утверждена владельцем 2026-09-03)

Вариант 1 с явным разделением хранения: TOTP seed — AEAD, recovery codes — HMAC/хеш. Критичны **все** административные роли. Enrollment не активен, пока пользователь не подтвердил первый TOTP. Первый OWNER не использует admin HTTP для enrollment: seed/QR показывает versioned CLI на TTY, первый TOTP принимает отдельный CLI confirm (§6). Rotation = новый pending seed, старый остаётся действительным до confirm либо отзывается OWNER. IP allowlist не заменяет 2FA.

Полная HTTP-церемония admin login (не «только TOTP»):

1. До любой мутации — exact `Origin = CABINET_ORIGIN` (тот же trusted-Origin guard, что logout/issue/revoke). Отсутствующий, чужой и same-site sibling Origin → отказ без чтения cookie, без проверки TOTP и без `Set-Cookie`.
2. Первый фактор — **либо** свежий серверно проверенный Telegram `initData` (те же правила подписи/freshness, что кабинетный вход), **либо** действующая неотзванная кабинетная `UserSession`. Поле `telegramUserId` в JSON без этой проверки не принимается. Кабинетная cookie доказывает только «кто это», она **никогда** не авторизует `/admin/*`.
3. Из первого фактора получить `User`. Найти `AdminMembership` этого user с `active` TOTP. Нет membership, роль `CUSTOMER`, pending TOTP, чужая личность — общий `401` без admin cookie и без различия причин.
4. Второй фактор — TOTP или recovery code **этого** membership. Верный TOTP чужого администратора при чужом первом факторе не подходит. Rate limit на `/admin/auth/login` fail-closed.
5. Успех: отдельная HttpOnly/Secure/SameSite=Strict admin-cookie (`vpn_platform_admin_session`); в БД HMAC. Кабинетную cookie не менять и не принимать на `/admin/*` (кроме этого login как first factor).

### Trade-offs

- AEAD оставляет seed извлекаемым при компрометации KEK + БД; KEK вне БД и ротация key version это ограничивают. HMAC seed сделал бы 2FA неработоспособным.
- TOTP фишится легче WebAuthn; для MVP проще enrollment.
- Telegram-код дешевле и бесполезен против компрометации Telegram-аккаунта администратора.
- Step-up на каждой мутации утомляет; только login слаб для длинной сессии. Компромисс: 2FA при создании admin-сессии и повтор для C-операций.
- Кабинетная сессия как first factor удобна (админка в том же origin), но XSS кабинета может начать login; TOTP всё равно обязателен. `telegramUserId`+TOTP без first factor отвергается.

### Текст, перенесённый в owner-документ

В `vpn-application-implementation-tz.md` §5 «Администратор», после абзаца о ролях:

> Критичными считаются все административные роли `OWNER`, `OPERATOR`, `SUPPORT`, `FINANCE`, `AUDITOR`. Каждая входит в админку только через отдельную admin-сессию, отличную от кабинетной `UserSession`. `POST /admin/auth/login` до мутации требует точное совпадение `Origin = CABINET_ORIGIN`; отсутствующий, чужой и same-site sibling Origin отклоняются без проверки факторов и без admin `Set-Cookie`. Первый фактор — свежий серверно проверенный Telegram `initData` либо действующая кабинетная сессия; JSON `telegramUserId` без этой проверки недостаточен. Второй фактор — действующий TOTP (RFC 6238) или одноразовый recovery code `AdminMembership` того же пользователя. Кабинетная cookie сама по себе `/admin/*` не авторизует и admin-сессию не создаёт. Shared secret TOTP хранится в PostgreSQL только как AEAD ciphertext с nonce и идентификатором версии ключа; ключ шифрования живёт в secret storage вне БД и не попадает в Git, frontend и логи. Recovery codes хранятся только как HMAC/хеш. Plaintext seed и codes показываются один раз при enrollment и не попадают в логи, analytics, errors, URL, argv, shell history и audit payload. Enrollment создаёт статус `pending` и становится `active` только после первого верного TOTP; до confirm admin-сессия не выдаётся. Первый OWNER проходит enrollment только через versioned CLI (§6): отдельная команда один раз показывает seed/QR на TTY, отдельная команда принимает первый TOTP с TTY/stdin; admin HTTP-enrollment доступен лишь после того, как уже есть хотя бы один OWNER с `active` TOTP. Повтор того же TOTP-кода в одном timestep-окне отклоняется. Неуспешные попытки rate-limited; при недоступности KEK или повреждённом ciphertext проверка fail-closed. Rotation и re-enrollment создают новый pending seed; старый active secret принимается до успешного confirm нового либо до отзыва OWNER. Необратимые и массовые операции требуют свежего step-up 2FA. Сброс 2FA другого администратора — только `OWNER` из admin-сессии со step-up, причиной и audit; самосброс по кабинетной сессии запрещён. Сетевой allowlist не заменяет 2FA.

### Влияние на schema / API / tests

- Schema (этап B): `AdminSession` (`userId`/`membershipId`, `tokenHash`); `AdminTotpCredential` (`membershipId`, `ciphertext`, `nonce`, `keyVersion`, `status` pending|active, `lastVerifiedTimestep`, `enrolledAt`); `AdminRecoveryCode` (`codeHash`, `consumedAt`). Cookie name `vpn_platform_admin_session`, отдельно от кабинетной. KEK только env/secret storage, отдельный от bot signing KEK.
- API (этап H): `POST /admin/auth/login` (Origin guard + first factor + TOTP); start enrollment и confirm по HTTP — только когда уже есть OWNER с `active` TOTP. Первый OWNER: CLI `admin:bootstrap-owner` и `admin:confirm-owner-totp`, не HTTP. Далее step-up, rotation, OWNER reset; rate limit; расширение safe-logger (`totp`, `otp`, `recovery`, `kek`).
- Tests: pending без confirm не логинит; confirm одним верным кодом активирует; повтор того же кода в том же timestep-окне отклоняется; соседнее окно по RFC 6238 — отдельный кейс; recovery consume-once; cabinet-cookie-only на `/admin/auth/login` и на `/admin/*` → 401 без admin cookie; чужой Telegram identity + верный TOTP жертвы → 401; CUSTOMER без membership + любой TOTP → 401; Origin absent/foreign/sibling на login → отказ без мутации; missing/wrong TOTP KEK fail-closed; ciphertext/nonce/seed отсутствуют в логах, argv и audit (сценарий 23); bootstrap без CLI confirm не выдаёт admin-сессию.

### Вопросы владельцу

1. Критичны ли все пять ролей или 2FA можно не требовать у `AUDITOR`?
2. Допустим ли TOTP (AEAD seed) вместо WebAuthn в MVP?
3. Нужен ли step-up на каждой state-changing admin-операции или только на необратимых/массовых плюс login?
4. Кто хранит recovery codes первого OWNER вне системы?
5. Окно TOTP: строго 30 секунд, допуск ±1 timestep как обычно?
6. Первый фактор admin login: `initData`, кабинетная сессия или оба (рекомендация: оба)?

---

## 2. Аутентификация bot → API

### Ограничения owner-документов

- Application §3: `bot` не меняет подписку сам — вызывает API по внутреннему контракту или ставит команду в очередь; в production bot без прямого доступа к PostgreSQL/Redis.
- Продукт §4: бот не хранит credentials и не принимает решений о праве доступа.
- Application §10: браузер не доверен; Telegram identity только после серверной проверки подписи; секреты не в Git/frontend; внешние входы валидируются Zod; rate limit на заказы; логи без секретов.
- Аудит §3.3 п.7 и §4.11: `telegramUserId` в JSON body недоверенный; публичный redeem/order/issuer HTTP до контракта запрещён.
- Контракт, binding, replay, ротация credential **не описаны**. Telegram webhook на `api.mymeteora.ru` (technical spec) не снимает требования внутреннего контракта.

### Факт текущей topology (не свойство TLS)

Сейчас это **не** защищённый транспорт:

- API слушает обычный HTTP на `3001` (`infra/docker-compose.production.yml`, healthcheck `http://127.0.0.1:3001`).
- `api` в сетях `edge`, `data`, `egress`; `bot` только в `egress`; Caddy (`reverse-proxy`) только в `edge` на `80/443`.
- Общая Docker `egress` bridge/overlay **не шифрует** пакеты и не является TLS.
- Bot **не** может обратиться к Caddy по внутренней сети: они не в одной сети.
- Node-agent ходит к control plane по публичному HTTPS через Caddy, потому что живёт на другой VPS. Это не путь bot→API на `platform-1`.

Нельзя писать «внутренний TLS/сеть Compose» как уже существующее свойство.

### Варианты транспорта

1. **HMAC-подпись поверх текущего внутреннего HTTP** (`http://api:3001` в `egress`). Реализуемо без нового PKI и без смены Compose-сетей/Caddy. Секрет не едет как bearer; подделать запрос без ключа нельзя. Конфиденциальность на проводе нет: другой контейнер в `egress` может увидеть payload. Integrity + replay-правила — на application-слое. **Secret wiring всё равно меняется:** текущий production Compose не передаёт `BOT_SIGNING_KEK` в API и не передаёт signing key в bot (у bot сейчас только `LOG_LEVEL`).
2. **HTTPS через Caddy + bearer, как node-agent.** Требует **нового** маршрута, которого нет: bot должен достичь Caddy по TLS. Это либо подключение `reverse-proxy` к `egress` и `extra_hosts`/`https://$API_DOMAIN`, либо documented hairpin на публичный `443`. Сертификаты — существующий ACME Caddy, не новый listener API. Нужно обновить technical spec, Compose и runbook. Нельзя оставлять `http://api:3001`.
3. **Отдельный internal TLS listener API** или **mTLS**: новый порт, сертификаты в secret storage, rotation, Compose expose. PKI в MVP Compose нет. **API принимает Telegram webhook сам** ломает границу bot/API. Оба отклоняются как рекомендация Stage A.

### Рекомендация (утверждена владельцем 2026-09-03)

Вариант 1: подписанный запрос по уже существующему `http://api:3001` на `egress`. Это **не** bearer-over-TLS и **не** эквивалент HTTPS. Вариант 2 допустим только после отдельного подтверждения владельца как изменение technical spec/Compose. Вариант 3 не предлагать в код Stage A. Стабильная идентичность бота — `BotServicePrincipal`; credential — версия секрета. Telegram-edge остаётся у `apps/bot`.

### Как API проверяет HMAC (не `secretHash`)

HMAC — симметричная подпись: verifier должен знать исходный signing key. Необратимый `secretHash` годится только для **bearer** (вариант транспорта 2), где секрет предъявляют. В варианте 1 секрет на проводе нет, поэтому `secretHash` **не** verifier.

Варианты хранения ключа для варианта 1:

1. **AEAD-encrypted signing key** в строке `BotServiceCredential` (`keyCiphertext`, `nonce`, `keyVersion`); KEK API (`BOT_SIGNING_KEK`) только в secret storage вне БД. Как TOTP seed. Рекомендуется.
2. **HKDF** от server master key и `credentialId`: API выводит ключ, в БД ключа нет. Bot получает derived plaintext при provisioning. Ротация master меняет все ключи сразу.
3. **Асимметрия (Ed25519):** в БД public key, у bot private. KEK не нужен. Новый протокол, нет прецедента в стеке.

`secretHash` как единственный verifier HMAC **запрещён**.

Provisioning варианта 1: versioned CLI генерирует 32-byte key, AEAD-шифрует KEK API, пишет credential, **один раз** показывает plaintext на TTY и кладёт его только в bot-only secret (не argv, не Git, не логи, не общий `platform.env`). Bot KEK не получает. API plaintext после записи не хранит вне ciphertext. Неверный/отсутствующий KEK — fail-closed `401`, без попытки сверить `secretHash`.

Ротация: новый credential того же principal с новым случайным ключом и новым ciphertext; overlap; CLI доставляет новый plaintext только bot и перезапускает/перезагружает bot; затем revoke старого. Idempotency остаётся на principal. One-shot initializer `platform.env` для этой ротации не используется.

Если владелец выбирает транспорт 2 (HTTPS + bearer), verifier = HMAC-отпечаток предъявленного bearer (`secretHash`), как `NodeAgentCredential`. AEAD signing key тогда не нужен. Меняются транспорт **и** модель секрета, не «только заголовок».

Проверяемый контракт state-changing команд:

| Правило | Значение |
|---|---|
| Транспорт | `http://api:3001` в `egress`; Docker network не считается TLS |
| Аутентификация | HMAC-SHA256 **исходным** signing key текущего `BotServiceCredential`; ключ API достаёт расшифровкой AEAD (`BOT_SIGNING_KEK` + `keyCiphertext`/`nonce`/`keyVersion`), не из `secretHash`; заголовки `X-Bot-Timestamp`, `X-Bot-Nonce`, `X-Bot-Credential-Id`, `X-Bot-Signature`; секрет на проводе не передаётся; неверная/отозванная/отсутствующая подпись, missing/wrong KEK — общий `401` |
| Canonical string | `credentialId \\n method \\n path \\n timestamp \\n nonce \\n telegramUserId \\n SHA-256(raw body)` |
| Timestamp | unix seconds; `|ts - PostgreSQL clock_timestamp()| ≤ 30s`, иначе `401` |
| Nonce | атомарно уникален в namespace `bot-nonce:{principalId}:{nonce}`; TTL 120s; повтор — `401` |
| Idempotency-Key | обязателен; область = `principalId + method + path + telegramUserId + Idempotency-Key` (не `credentialId`) |
| Canonical request hash | SHA-256(`method \\n path \\n telegramUserId \\n raw body bytes`) — для идемпотентности, отдельно от подписи |
| Потерянный ответ / retry клиента | **новый** timestamp и nonce, **тот же** Idempotency-Key |
| Logical replay | тот же principal/ключ/hash после успешного резерва nonce → сохранённый статус и тело, без повторного side effect |
| Conflict | тот же ключ, другой hash → `409`, без side effect |
| Bit-identical HTTP replay | тот же nonce → `401` (даже если Idempotency-Key совпал) |
| Duplicate nonce, другой Idempotency-Key | `401` |
| `telegramUserId` | только после успешной подписи; без подписи / только JSON — `401` |

Атомарный порядок в одной транзакции (или сравнимый linearizable lock):

1. Найти неотзванный credential по `X-Bot-Credential-Id`, расшифровать signing key (KEK обязателен), сверить HMAC, получить `principalId`.
2. Проверить timestamp.
3. Атомарно зарезервировать nonce в namespace principal; конфликт → `401`, дальше не идём.
4. Найти запись идемпотентности по области principal.
5. Есть, hash совпал → вернуть сохранённый ответ.
6. Есть, hash другой → `409`.
7. Нет → выполнить business transaction и атомарно записать ответ.

Ротация: CLI выпускает новый credential того же principal с новым AEAD-encrypted key, plaintext один раз на TTY/secret storage bot, overlap двух credential разрешён, затем revoke старого; отозванный сразу fail-closed. Повтор после rotation с новым credential, новым nonce и прежним Idempotency-Key — logical replay на том же principal, не новая операция.

Если владелец выбирает транспорт 2 вместо 1: HTTPS Caddy + `Authorization: Bearer`; verifier = `secretHash`, без AEAD signing key. Principal, nonce namespace, порядок nonce/idempotency и тесты rotation остаются. Technical spec обязан зафиксировать: Caddy в `egress` или hairpin; bot **запрещено** звать `http://api:3001`; сертификаты и rotation — ACME Caddy, не отдельный PKI API.

### Trade-offs

- Подпись на plaintext HTTP закрывает подделку без ключа и не выдумывает TLS. Другой процесс в `egress` (сейчас ещё `worker`) может прочитать telegram identity и тело. Worker не получает signing key и не получает `BOT_SIGNING_KEK`.
- Network topology и Caddy для варианта 1 не меняются. Compose environment, secrets initializer и platform runbook — меняются: без этого HMAC в production не стартует.
- `secretHash`-only сделал бы HMAC непроверяемым. AEAD + отдельный KEK API симметричен TOTP seed; KDF проще ротации одного master и хуже изоляции ключей; Ed25519 сильнее, но это новый протокол.
- HTTPS через Caddy даёт конфиденциальность и совпадает с node-agent, но это **новое** сетевое ребро: Caddy сегодня не в `egress`, hairpin на Selectel не зафиксирован. Нужны Compose, technical spec, проверка, что внутренние маршруты на публичном `API_DOMAIN` закрыты той же подписью/bearer.
- Internal TLS listener — отдельный lifecycle сертификатов, которого нет.
- Nonce в Redis: fail-closed при недоступности (как issuer rate-limit). PostgreSQL unique переживает restart ценой latency.

### Текст, перенесённый в owner-документы

> Внутренний контракт bot→API — HMAC-подпись канонического запроса по существующему plaintext HTTP `api:3001` в сети `egress`. Docker network не является TLS и не заменяет подпись. Network topology и Caddy для этого варианта не меняются; меняются technical spec, Compose secret wiring, secrets initializer и runbook. Это не публичный пользовательский API и не bearer-over-TLS, пока владелец отдельно не утвердит HTTPS через Caddy с правкой technical spec и сетей Compose. Браузер, кабинетная cookie и JSON-поле `telegramUserId` сами по себе не аутентифицируют команды. Стабильная идентичность — `BotServicePrincipal`; `BotServiceCredential` — версия секрета. Signing key хранится в PostgreSQL только как AEAD ciphertext с nonce и key version; `BOT_SIGNING_KEK` живёт в secret storage API вне БД и инжектится **только** в сервис `api`. Plaintext signing key конкретного credential инжектится **только** в сервис `bot`. Worker, web и migrate не получают ни KEK, ни signing key. Оба секрета не попадают в argv, Git, логи и не кладутся в общий `/etc/meteora/platform.env` рядом с peppers, если это даёт лишний доступ другим сервисам или backup-контуру: KEK — API-only файл/переменная; signing key — отдельный bot-only секрет с возможностью замены при rotation (one-shot initializer `platform.env` не перезаписывается и для rotatable credential непригоден). `secretHash` не является verifier HMAC. API расшифровывает ключ и сверяет подпись неотзванного credential, затем берёт principal этой версии. Missing/wrong KEK, повреждённый ciphertext, неверная подпись, `|timestamp - clock_timestamp()| > 30s` или повторный nonce в namespace `bot-nonce:{principalId}:{nonce}` (TTL 120s, атомарное резервирование) отклоняются общим `401`, в том числе bit-identical replay и duplicate nonce с другим Idempotency-Key. `Idempotency-Key` обязателен; область ключа — principal + method + path + telegramUserId + ключ клиента, не credential id. Canonical hash тела для идемпотентности = SHA-256 method, path, telegramUserId и raw body. Retry после потерянного ответа использует новый timestamp/nonce и прежний Idempotency-Key: тот же hash возвращает сохранённый результат, другой hash — `409`. Ротация меняет credential и не меняет principal; overlap допустим; CLI безопасно доставляет новый plaintext только bot (TTY/bot-only secret file, не argv) и перезапускает/перезагружает bot, затем отзывает старый credential; повтор с новым credential не создаёт второй order/redeem/issuer. `telegramUserId` допустим только после успешной подписи и означает пользователя из уже проверенного ботом Telegram update. Порядок проверки: credential+KEK+подпись → timestamp → nonce → idempotency → business. Логи: enum outcome, boolean, безопасный operation id; ключ, KEK, ciphertext, подпись, nonce, timestamp raw, body и init payload не логируются.

### Влияние на schema / API / tests

- Schema: `BotServicePrincipal`; `BotServiceCredential` (`id`, `principalId`, `keyCiphertext`, `nonce`, `keyVersion`, `revokedAt`, `createdAt`) — **без** `secretHash` как HMAC verifier. Таблица или Redis для nonce с ключом principal; таблица идемпотентности с `principalId`, `requestHash` и сохранённым ответом.
- API: internal tag, не self-service; CLI provisioning/rotation credential.
- Infra утверждённого варианта 1: **network topology и Caddy не меняются**. Меняются technical spec, production Compose secret wiring, secrets initializer и platform runbook. Сейчас ни `BOT_SIGNING_KEK`, ни bot signing key в Compose нет. После правки: `BOT_SIGNING_KEK` только в `api`; plaintext signing key текущего credential только в `bot`; worker/web/migrate — ни один из них. Секреты не в argv, не в Git, не в логах и не в общем `platform.env` с доступом шире, чем у потребителя. KEK можно сгенерировать как API-only секрет (как pepper: без автоматической overwrite-ротации). Signing key доставляет application CLI и bot-only файл; rotation заменяет этот файл и перезапускает/перезагружает bot, не переписывая `platform.env`.
- При варианте 2 — `secretHash` вместо ciphertext **и** смена сетей: technical spec `reverse-proxy` в `egress` или hairpin, запрет plaintext, ACME как единственный TLS, rotation сертификатов = Caddy; bearer секрет тоже только bot, не worker.
- Tests: 401 без подписи и с body-only telegram id; timestamp 31s → 401; duplicate nonce → 401; duplicate nonce с другим Idempotency-Key → 401; bit-identical replay → 401; logical replay (новый nonce, тот же ключ/hash) → сохранённый ответ; conflict 409; revoked credential; missing KEK → 401; wrong KEK → 401; replay **до и после** rotation и во время overlap (тот же principal, новый credential, прежний Idempotency-Key не создаёт второй side effect); redact ciphertext/key; worker env не содержит KEK/signing key. Этапы C/D/E без HTTP, пока контракт не в owner-документе.

### Вопросы владельцу

1. Подтверждаете HMAC на текущем внутреннем HTTP (вариант 1, AEAD signing key + `BOT_SIGNING_KEK`, secret wiring без смены Caddy) или отдельным решением HTTPS через Caddy + bearer/`secretHash` (вариант 2)?
2. Telegram webhook принимает `apps/bot` (Caddy → bot) или `apps/api`?
3. Overlap двух credential одного principal на время rotation (рекомендуется) или сразу revoke старого?
4. Nonce в Redis fail-closed или PostgreSQL unique (рекомендация: Redis fail-closed, как prelaunch rate-limit)?
5. Signing key: AEAD в строке credential (рекомендация), HKDF от master, или Ed25519?
6. KEK — отдельный API-only секрет (не общий `platform.env`); signing key — bot-only файл с reload при rotation. Подтверждаете это разделение?

---

## 3. Bot-mediated issuer ceremony

### Ограничения owner-документов

- Application §5: нет публичного `POST /auth/challenge`; нужны и Telegram-подписанный `start_param`, и 256-битный секрет в HttpOnly cookie **исходного браузера**; без обоих — общий `401` без `Set-Cookie`.
- Issuer создаёт challenge только после подтверждённого платежа или успешного промокода; `User`/`Order`/`Payment` до оплаты входа не дают; ранее допущенный пользователь после expiry входит для продления.
- Challenge одноразовый и короткоживущий; постоянная login-ссылка запрещена; секреты не в URL/`localStorage`/JSON.
- Production issuer не подключён; публичный self-service не добавлять.
- Аудит §4.1–4.2: текущий `issue()` не биндит user и не проверяет entitlement.
- Application §5: login/retry линеаризуются `SELECT … FOR UPDATE`; сроки challenge и freshness считаются по PostgreSQL `clock_timestamp()`. Application §6: внутри state-changing транзакции `dbNow` читается один раз после locks и используется всеми проверками.
- Application §10 п.14: rate limiting обязателен на auth; при недоступности Redis лимит не обходится. Аудит §4.5: на `POST /auth/telegram` лимита сейчас нет.

### Варианты

1. **Буквально оба фактора (cookie + `initData`).** Не найден реализуемый канал доставить HttpOnly cookie в WebView, не положив секрет в URL и не выдав cookie в обмен на `initData`.
2. **Bound challenge + `initData` без prelaunch cookie.** Закрывает attacker-first **публичного** challenge (запись создаёт только бот после entitlement). **Не эквивалент** текущей двухкомпонентной ceremony: украденный до consume свежий `initData` уже содержит identity и `start_param`; кто первым дойдёт до `POST /auth/telegram`, тот получает session cookie. TTL и одноразовость делают это гонкой, не привязкой к исходному браузеру.
3. **Pending-cookie WebView + confirm в боте:** `POST /auth/telegram` с валидным `initData` не ставит session cookie. Этому WebView выдаётся отдельная 256-битная HttpOnly/Secure/SameSite=Strict pending-cookie; в БД только HMAC. Bot confirm разрешает завершение **конкретной** pending-записи (код подтверждения, если показывается, связан с этой записью). Session cookie получает только клиент, который предъявил эту pending-cookie, после одноразовой атомарной замены pending→session. Вор `initData` может создать свою pending-запись, но без pending-cookie жертвы и без confirm именно её записи сессию не получает.

Ticket в URL отклоняется: auth-секрет в URL запрещён.

### Рекомендация (утверждена владельцем 2026-09-03)

Не описывать вариант 2 как security-эквивалент cookie-фактора. Рекомендовать **вариант 3** с явной pending-cookie: это реализуемый browser-bound proof. Bot confirm сам по себе **не** привязывает вход к WebView; без pending-cookie это снова гонка за сессию. Вариант 2 допустим **только** как отдельное явное согласие владельца на ослабленный threat model: «свежий `initData` до consume — bearer».

Если владелец всё же выбирает вариант 2, обязательны фиксированные семантики ниже — не открытый TTL.

Общие правила issue (варианты 2 и 3):

- Публичного `POST /auth/challenge` нет.
- Issuer — только bot-контракт §2; challenge bound к telegram user; только после confirmed payment, promo redemption или earlier entitlement.
- `AuthChallenge.expiresAt = dbNow + 120 seconds` в транзакции issue. Pending **не** получает независимые +120s: `PendingLogin.expiresAt = LEAST(AuthChallenge.expiresAt, dbNow + interval '120 seconds')`. Cookie `Max-Age` = оставшиеся секунды до `PendingLogin.expiresAt`, не фиксированные 120, если challenge ближе к expiry.
- `FOR UPDATE` challenge, затем pending (один порядок, без deadlock). После locks — один `dbNow = clock_timestamp()`. Initial, bot-confirm и complete проверяют `challenge.expiresAt > dbNow` **и** (где pending уже есть) `pending.expiresAt > dbNow`, плюс not consumed. Истёкший challenge нельзя «продлить» живым pending.
- Consume на успешном **завершении** входа (вариант 2 — при выдаче session cookie; вариант 3 — при атомарной замене pending-cookie → session cookie).
- Повтор того же consumed challenge + того же проверенного `initData` после успешной сессии: существующая сессия, если `User.telegramUserId` совпал **и** предъявлена соответствующая cookie (вариант 3 — уже session cookie, не чужая pending); иначе общий `401` без новой cookie (как нынешний retry binding).
- Все crypto/freshness/binding отказы: `401 Telegram login is invalid` без `Set-Cookie` сессии.
- Rate limit fail-closed (Redis, как issuer) на `POST /auth/telegram` и `POST /auth/telegram/complete` **до** locks/consume/`Set-Cookie`. Превышение — `429`; Redis недоступен — `503`. Ни то ни другое не consume challenge/pending и не ставит cookie. Ключи Redis и метрики: HMAC/SHA-256 от source identity (trusted-proxy IP и/или уже проверенный telegram user) с pepper; raw Telegram ID, pending token, initData и cookie в ключах, логах и метриках не появляются.

Точный поток варианта 3:

1. WebView `POST /auth/telegram` + подписанный `initData`. Сначала fail-closed rate limit. Затем транзакция: `FOR UPDATE` challenge, один `dbNow`. Если challenge истёк или consumed → `401`, pending не создаётся. Иначе создать `PendingLogin` (challenge, telegram user, HMAC pending-секрета, HMAC кода подтверждения, `expiresAt = LEAST(challenge.expiresAt, dbNow + 120s)`, статус `awaiting_bot_confirm`). `Set-Cookie` только pending (`vpn_platform_pending_login`, HttpOnly, SameSite=Strict, Secure в production, `Max-Age` = секунды до `pending.expiresAt`). JSON возвращает confirmation code (не pending-секрет и не session secret).
2. **Канал кода в бот (рекомендация):** пользователь **сам** вводит код из WebView в Telegram-бот (текст или кнопка после ввода). Бот **не** читает PostgreSQL/Redis. Бот вызывает внутренний контракт §2: confirm pending `{ confirmationCode }` плюс `telegramUserId` из уже проверенного Telegram update. API: fail-closed rate limit перебора, затем `FOR UPDATE` challenge+pending, один `dbNow`. Успех только если обе записи живы (`expiresAt > dbNow`), challenge not consumed, HMAC(code)+telegram user совпали. Истёкший challenge или pending → общий `401`, статус не меняется. Иначе только эта строка → `bot_confirmed`. Pending-секрет в сообщение бота не попадает.
   Допустимо, но не рекомендуется: (a) Telegram WebApp `sendData` — зависит от способа открытия Mini App и не обязан работать для `start_param`/Menu Button; (b) API сам шлёт Telegram-сообщение — кладёт bot token в API и ломает границу. Оба не выбирать как Stage A default.
   Код: 8 символов Crockford base32 (~40 bit), namespace `login-confirm:{hmac(telegramUserId)}` (в Redis/логах не raw ID), одноразовый до consume/expiry.
3. Тот же WebView `POST /auth/telegram/complete` с pending-cookie. **До** чтения cookie и consume: exact `Origin = CABINET_ORIGIN` (тот же `TrustedOriginGuard`, что logout), затем fail-closed rate limit. Отсутствующий, чужой, same-site sibling Origin → отказ без mutation и без session `Set-Cookie`. `SameSite=Strict` этот guard не заменяет. Затем транзакция: `FOR UPDATE` challenge+pending, один `dbNow`. Успех только если Origin верный, HMAC cookie совпал, статус `bot_confirmed`, `pending.expiresAt > dbNow`, `challenge.expiresAt > dbNow`, challenge ещё не consumed. Нельзя считать достаточным «pending жив и challenge not consumed», если challenge уже истёк. Одна транзакция: создать `UserSession`, consume оба, `Set-Cookie` session, удаляющая pending-cookie. Повтор complete с той же cookie после consume — существующая сессия при совпадении пользователя, иначе `401`.
4. Complete без pending-cookie, с чужой cookie, до bot confirm, после expiry **любой** из двух записей — `401` без session cookie. Ожидание confirm без cookie сессию не даёт. Rate limit `429`/`503` cookie не ставит и записи не consume.

### Trade-offs

- Вариант 3 с pending-cookie восстанавливает привязку к исходному WebView: attacker-first на `initData` получает **свою** pending-cookie, а не сессию жертвы. Код в бот несёт пользователь; API не пишет в Telegram, bot не читает БД. Цена — шаг ввода кода. XSS в WebApp без pending-cookie, без Origin и без confirm сессию не ставит. Слепое подтверждение в боте кода, которого не было в WebView, отдаёт сессию владельцу той pending-cookie; сверка кода это закрывает. Pending не удлиняет challenge: `LEAST` обрезает TTL до исходного `AuthChallenge.expiresAt`.
- Bot confirm без pending-cookie **недостаточен**: атакующий мог бы создать/опрашивать ту же pending-запись. `SameSite=Strict` не заменяет Origin guard на complete. Rate limit на initial/complete закрывает перебор, который аудит отмечал на `POST /auth/telegram`.
- Вариант 2 удобнее UX и **слабее**: attacker-first на украденном `initData` в окне 120s. Это не текущий инвариант и не эквивалент варианта 3.
- Вариант 1 без смены других инвариантов, скорее всего, нереализуем.

### Текст, перенесённый в owner-документ

Базовый текст (общий):

> Публичный `POST /auth/challenge` запрещён. Production issuer доступен только внутреннему bot-контракту. Issuer создаёт `AuthChallenge`, связанный с `telegramUserId`, только после подтверждённого платежа, успешной активации промокода либо ранее существовавшего entitlement. `User`, `Order` и `Payment` сами по себе challenge не создают. `launchId` попадает в WebApp только как Telegram `start_param`, не как session secret и не как постоянная ссылка. TTL challenge: `expiresAt = dbNow + 120 seconds` в транзакции issue. Pending login не продлевает этот срок: `PendingLogin.expiresAt = LEAST(AuthChallenge.expiresAt, dbNow + interval '120 seconds')`. Initial, bot-confirm и complete после `FOR UPDATE` читают один `dbNow` и отклоняют запрос, если истекла любая из двух записей. Consume выполняется в одной транзакции с `SELECT … FOR UPDATE`. `POST /auth/telegram` и `POST /auth/telegram/complete` имеют fail-closed Redis rate limit до мутации; превышение и недоступный Redis не consume записи и не ставят cookie.

Текст утверждённого варианта 3; ослабленный threat model варианта 2 не принят:

> `POST /auth/telegram` с валидным `initData` не ставит session cookie. Сначала fail-closed rate limit, затем locks и один `dbNow`. Исходному WebView выдаётся отдельная 256-битная HttpOnly/Secure/SameSite=Strict pending-cookie; в PostgreSQL хранится только HMAC. `PendingLogin.expiresAt = LEAST(AuthChallenge.expiresAt, dbNow + 120s)`; cookie `Max-Age` не длиннее этого срока. JSON возвращает confirmation code (8 символов Crockford, не session secret). Пользователь вводит этот код в бот; бот вызывает внутренний контракт confirm. API не отправляет Telegram-сообщения и не кладёт bot token в API. Confirm после locks проверяет, что не истекли pending и challenge; иначе общий `401`, статус не `bot_confirmed`. Неверный код — общий `401`, rate-limited. Session cookie ставит только `POST /auth/telegram/complete`. До чтения pending-cookie и consume complete требует точное `Origin = CABINET_ORIGIN` и fail-closed rate limit; отсутствующий, чужой и same-site sibling Origin отклоняются без mutation и без session `Set-Cookie`. `SameSite=Strict` этот guard не заменяет. Успех complete: предъявлена эта pending-cookie, статус `bot_confirmed`, `pending.expiresAt > dbNow`, `challenge.expiresAt > dbNow`; атомарно pending→session, challenge consumed, pending-cookie удаляется. Украденный свежий `initData` без pending-cookie жертвы сессию не даёт. Complete без cookie, с cookie другого браузера, до confirm или после expiry challenge/pending — общий `401` без session `Set-Cookie`.

Текст варианта 2 (только после **отдельного** подтверждения ослабления threat model; не эквивалент cookie-ceremony и не эквивалент варианта 3):

> Владелец принимает, что до consume свежий подписанный `initData` достаточен для получения кабинетной session cookie: prelaunch cookie и pending-cookie на этом пути не требуются. Кто первым успешно вызовет `POST /auth/telegram` с этим payload при `challenge.expiresAt > dbNow`, тот получает сессию; второй получает общий `401` либо retry существующей сессии только при совпадении пользователя. После `expiresAt` — общий `401` без cookie. Это гонка внутри TTL challenge, не browser binding и не продление TTL. Rate limit на endpoint тот же, fail-closed.

### Влияние на schema / API / tests

- Schema: `AuthChallenge.userId` обязателен для production-issued; `PendingLogin` (`challengeId`, `telegramUserId`, `pendingTokenHash`, `confirmationCodeHash`, `status` awaiting_bot_confirm|bot_confirmed|consumed, `expiresAt` с инвариантом `expiresAt <= AuthChallenge.expiresAt`). Cookie name отдельно от session и prelaunch.
- API: внутренний issuer; `POST /auth/telegram` и `POST /auth/telegram/complete` не публичный challenge; complete под `TrustedOriginGuard`; внутренний confirm-code endpoint для бота по контракту §2; Redis rate-limit keys без raw Telegram ID/pending token.
- Tests обязательны: сценарий 19; чужой telegram user; нет публичного challenge; логи/метрики без secret/`initData`/pending plaintext/raw telegram id.
- Тесты WebView-binding варианта 3:
  - **attacker-first:** копия валидного `initData` у атакующего до пользователя; атакующий получает свою pending-cookie; жертва вводит в бот код из **своего** WebView; complete атакующего → `401` без session; complete жертвы с её cookie после confirm → session.
  - **victim-first:** жертва pending → ввод своего кода в бот → complete → session; последующий attacker initData/complete → `401`.
  - **confirm без cookie:** bot confirm по коду успешен; complete без pending-cookie → `401`, session cookie нет ни у кого.
  - **два браузера:** две pending-cookie на один challenge; confirm одного кода; session только у предъявившего подтверждённую cookie; второй complete → `401`.
  - **Origin на complete:** отсутствующий Origin; чужой Origin; same-site sibling Origin (`https://api.…` при `CABINET_ORIGIN=https://app.…`). Во всех трёх — отказ до consume, без session `Set-Cookie`, pending не consumed.
  - **Чужой код:** код атакующего в боте жертвы / код жертвы от другого telegram user → общий `401`, запись не `bot_confirmed`.
  - **TTL не продлевается:** pending создан непосредственно перед expiry challenge (`pending.expiresAt = challenge.expiresAt`); после `challenge.expiresAt` confirm и complete дают общий `401`, session cookie нет, записи не consumed как успешный вход.
  - **Rate limit:** превышение на `/auth/telegram` и на `/complete` → `429`, challenge/pending не consumed, cookie нет; Redis недоступен → `503`, то же; в метриках нет raw Telegram ID и pending token.
- Ожидание варианта 2 (если принят): первый `POST /auth/telegram` при живом challenge получает session `Set-Cookie`, второй — без новой cookie; после expiry challenge — `401`; документ теста называет это принятым ослаблением, не доказательством эквивалентности cookie-фактору.

### Вопросы владельцу

1. Принимаете ли вариант 3 (pending-cookie исходного WebView + пользователь вводит код в бот + Origin guard на complete) вместо prelaunch cookie?
2. Если нет: подтверждаете ли **отдельно** ослабление threat model варианта 2 (украденный свежий `initData` до consume может выиграть гонку) и TTL 120s?
3. Канал кода: ввод пользователем в бот (рекомендация), `sendData`, или API→Telegram (отклоняется)?
4. Оставлять ли cookie-harness только в integration tests, не в production issuer?

---

## 4. Формат длительности тарифа

### Ограничения owner-документов

- Продукт §2: стартовый тариф 200 ₽ / **30 календарных дней**; цена, длительность и device limit редактируются из админки и не хардкодятся.
- Продукт §5: `plans` — цена, длительность, device_limit.
- Продукт §3 «Продление»: если подписка активна, «новый месяц прибавляется». Это формулировка продукта, не колонка.
- Промокод: отдельная duration от OWNER; `deviceLimit` из плана.
- Schema: у `Plan` нет duration; нельзя читать «значение из данных», которого ещё нет.
- Application services не содержат литерала длительности. Миграция применяется не только к тестовым фикстурам.

### Варианты

1. **`durationDays INTEGER`**, календарные дни, CHECK 1–366. Стартовые 30 — только data, после явного подтверждения состава существующих строк.
2. **Календарные месяцы.** Расходится с «30 календарных дней».
3. **PostgreSQL `interval`.** Хуже для Zod/админки.

### Рекомендация (утверждена владельцем 2026-09-03)

Вариант 1. Продление прибавляет `Plan.durationDays`. Промокод имеет своё `PromoCode.durationDays`.

Fail-closed backfill, forward-only, без runtime default и без литерала `30` в application services. **Весь** SQL одной PostgreSQL-транзакции (`BEGIN` … `COMMIT` в том же migration-файле). Prisma не считается атомарной сама по себе: без явной транзакции `RAISE` после части DDL может оставить колонку.

1. `BEGIN`.
2. `LOCK TABLE "Plan" IN ACCESS EXCLUSIVE MODE`.
3. `ADD COLUMN "durationDays" INTEGER` (nullable, без DEFAULT).
4. Если есть строки с `durationDays IS NULL`:
   - владелец **заранее** подтвердил, что все существующие планы — один стартовый тариф MVP → `UPDATE ... SET "durationDays" = 30 WHERE "durationDays" IS NULL` как **data statement этой же** транзакции;
   - иначе, в том числе при нескольких различных планах или неизвестном составе → `RAISE` (транзакция откатывает и колонку).
5. `CHECK ("durationDays" >= 1 AND "durationDays" <= 366)`, затем `SET NOT NULL`.
6. `COMMIT`.
7. Не редактировать старые migrations.

Владелец подтвердил `30` как data value стартового тарифа. Migration применяет этот UPDATE только после проверки, что существующие данные действительно представлены единственным стартовым тарифом; иначе действует abort-путь. Литерал не появляется в application services.

Если Prisma записала failed migration: runbook **сначала** read-only подтверждает, что `"durationDays"` нет в `information_schema.columns` и enum/constraint не частично созданы; только после этого `prisma migrate resolve --rolled-back`, затем повторный deploy. `resolve` не чинит схему.

### Trade-offs

- Abort при любой существующей строке до подтверждения безопаснее ложного 30 на неизвестном тарифе.
- Подтверждённый UPDATE 30 на всех NULL-строках опасен, если в БД уже несколько продуктовых планов — поэтому при count различных тарифов abort обязателен даже после «да, это стартовый».
- Календарный месяц ближе к фразе «в месяц» и даёт разную фактическую длительность.

### Текст, перенесённый в owner-документы

Продукт §3:

> Если подписка фактически активна, к текущему `expiresAt` прибавляется `Plan.durationDays` оплачиваемого тарифа, не константа кода и не календарный месяц. Стартовое значение MVP хранится в данных как 30 календарных дней.

Application §6:

> У `Plan` есть `durationDays` (целое, 1–366). Application services читают поле и не содержат литерала 30. `PromoCode.durationDays` независимо; `deviceLimit` берётся из связанного `Plan`. Forward-only migration в одной явной PostgreSQL-транзакции добавляет nullable колонку без DEFAULT, берёт `ACCESS EXCLUSIVE`, затем либо атомарно заполняет её подтверждённым data statement, либо `RAISE` с полным rollback, если состав существующих планов неизвестен или не сводится к одному стартовому тарифу. После успешного backfill в той же транзакции — CHECK и NOT NULL. Prisma не предполагается атомарной без `BEGIN`/`COMMIT`.

### Влияние на schema / API / tests

- Одна новая migration: явные `BEGIN`/`COMMIT`, шаги выше; без операторов, которые PostgreSQL не выполняет в транзакции.
- Contracts: `durationDays` в plan DTO.
- Tests: пустая таблица `Plan` → NOT NULL проходит без backfill; integration: реальный guard failure (неожиданные/несколько NULL-планов) → `RAISE`, после abort колонки `durationDays` нет, CHECK/NOT NULL нет; затем `resolve --rolled-back` только после этой проверки и повторный deploy. После подтверждённого пути одна стартовая строка получает 30 в данных. Сервисы в тесте задают duration явно. Promo 7 дней при плане 30.

### Вопросы владельцу

1. Подтверждаете, что **все текущие** строки `Plan` (если они есть в какой-либо среде) — стартовый MVP-тариф и data migration может записать 30?
2. Подтверждаете abort, если планов несколько или состав неизвестен?
3. Продление = `durationDays`, не календарный месяц?
4. CHECK 1–366 приемлем?
5. Duration промокода может быть любой в том же диапазоне, без «не длиннее плана»?

---

## 5. RBAC-матрица

### Ограничения owner-документов

Роли: `OWNER`, `OPERATOR`, `SUPPORT`, `FINANCE`, `AUDITOR`. Backend authorization. Подтверждение для платежей, срока подписки, промо, отзыва устройства, нод. Необратимое — preview, reconfirm, reason. Ручной `succeeded` запрещён. Массовый отзыв промо — только OWNER. Админ не читает credential и полный subscription URL. SUPPORT инициирует revoke/replace; секрет видит пользователь. Кабинетная cookie ≠ admin. Полной матрицы нет. Least privilege в ТЗ явно не таблицирована; широкий read всем ролям не вытекает из формулировок ролей.

### Варианты

1. **Deny-by-default, доменные срезы** (рекомендуется): роль видит только свой контур; cross-domain — только с необходимостью и минимальными полями.
2. **Широкое чтение всем, мутации по ролям.** 2FA не заменяет минимизацию; раздувает доступ к Telegram ID, платежам и нодам.
3. **Флаги только в UI.** Запрещено.

### Рекомендация и точная матрица (утверждены владельцем 2026-09-03)

Вариант 1.

**Подтверждено владельцем 2026-09-02 и дополнено 2026-09-03:** в MVP сохраняются пять фиксированных
ролей, одна статическая backend-матрица, общий authorization guard, общая модель
отдельной admin-сессии и один механизм 2FA. Динамические permissions, конструктор
ролей, пользовательские роли и отдельные authorization-механизмы по ролям не
создаются. При первом запуске назначается только `OWNER`; остальные роли
назначаются по мере появления реальных обязанностей. Их deny-by-default границы
и тесты существуют до первого назначения. Точные клетки матрицы ниже подтверждены
владельцем 2026-09-03.

- `OWNER` — полный административный контур.
- `OPERATOR` — nodes, delivery/jobs, incidents/alerts; без users/payments/promo.
- `SUPPORT` — минимальные user/subscription/device поля для сопровождения; без orders, payments, promo, nodes, backups.
- `FINANCE` — orders, payments, refunds, reconciliation; подписка только как ссылка статуса для суммы; без devices, nodes, promo mutate, incidents.
- `AUDITOR` — read-only audit и согласованные report views, не копия чужих рабочих списков.

Обозначения: R чтение минимального набора полей, M мутация с подтверждением, C preview+reconfirm+reason+step-up, «—» нет доступа, включая чтение. M/C требуют admin-сессии и 2FA. URL/credential/полный промокод/2FA material ни в одном ответе.

| Область | OWNER | OPERATOR | SUPPORT | FINANCE | AUDITOR |
|---|---|---|---|---|---|
| overview: platform services, backups status, alerts summary | R | R (nodes/jobs/delivery/incidents only) | R (own queue: users/devices tickets, без платежей и нод) | R (payments/webhooks only) | R (report: SLA/aggregates, без сырых PII списков) |
| users: id, telegramUserId, status, purchase-blocked | M | — | M | — | — |
| users: полная платёжная/промо история | R | — | — | R только через order | R только через audit |
| завершение web-сессий пользователя | M | — | M | — | — |
| subscriptions: status, planName, expiresAt | R | — | R | R (для сверки суммы) | R (report) |
| ручное продление / отмена с причиной | C | — | C | — | — |
| devices: id, displayName, status, createdAt | R | — | R | — | — |
| device revoke / initiate replacement | M | — | M | — | — |
| orders / payments / webhook attempts | R | — | — | R | R (report ids/status, не полный payload) |
| webhook replay / reconciliation | C | — | — | C | — |
| refund | C | — | — | C | — |
| ручной `succeeded` | запрещён всем | | | | |
| plans | C | — | — | R | R |
| promo metadata без кода | R | — | — | — | R |
| promo create / disable / archive | M | — | — | — | — |
| promo hard delete использованного | запрещён | | | | |
| promo массовый отзыв | C | — | — | — | — |
| nodes / heartbeat / versions / grants counts без credentials | R | R | — | — | R (report status/version) |
| drain / disable / HEALTHY после convergence | M | M | — | — | — |
| quarantine / staged rollout / node credential rotate | C | C | — | — | — |
| delivery / job retry | M | M | — | — | — |
| incidents / alerts (ops) | M | M | — | — | R |
| audit log | R | — | — | — | R |
| backups: drill status | R | — | — | — | R |
| backups: restore drill / break-glass restore | C | — | — | — | — |
| назначение ролей | внеполосная процедура §6, не self-service | | | | |

SUPPORT не получает OWNER-права и не читает payments/nodes/promo. OPERATOR не читает users/payments/promo. FINANCE не читает devices/nodes/incidents.

### Trade-offs

- Узкие срезы заставляют OWNER делать кросс-доменные разборы; это цена least privilege.
- OPERATOR quarantine без OWNER ускоряет аварию (сохранено) без доступа к платежам.
- SUPPORT без платежей не сможет «увидеть, прошла ли оплата» — статус подписки для этого достаточен.

### Текст и матрица, перенесённые в owner-документ

> В MVP используются пять фиксированных ролей `OWNER`, `OPERATOR`, `SUPPORT`, `FINANCE`, `AUDITOR`, одна статическая backend-матрица и общий authorization guard. Динамические permissions, конструктор ролей и пользовательские роли не создаются. При первом запуске назначается только `OWNER`; остальные роли назначаются лишь при появлении реальных операционных обязанностей, но их deny-by-default границы и тесты действуют заранее. Разрешения проверяет только backend, deny-by-default. Кабинетная сессия не удовлетворяет admin API. Каждая роль получает только свой домен и минимальный набор полей из матрицы Stage A. Чтение не возвращает полный subscription URL, VPN credential, полный промокод и 2FA material. SUPPORT и OPERATOR не получают права OWNER и не имеют широкого cross-domain read. Назначение ролей — защищённая процедура, не self-service. Ручной `succeeded` не существует.

Вставить таблицу выше.

### Влияние на schema / API / tests

- Guards по матрице; отдельные DTO на роль, не один admin overview на всех.
- Tests: CUSTOMER/cabinet cookie → 401; OPERATOR GET payments/users/promo → 403; SUPPORT GET payments/nodes/promo → 403; FINANCE GET devices/nodes → 403; AUDITOR POST → 403; OWNER mass-revoke промо → только C-path.

### Вопросы владельцу

1. Достаточно ли SUPPORT статуса подписки без карточки платежа?
2. Нужен ли OPERATOR quarantine без OWNER (сейчас C у OPERATOR)?
3. AUDITOR: только `audit log` + агрегаты или ещё списки заказов без PII?

---

## 6. Миграция `UserRole.ADMIN` и первый OWNER

### Ограничения owner-документов

- Enum сейчас `CUSTOMER` | `ADMIN`; `ADMIN` не авторизует endpoint.
- Роли выдаются вручную через защищённую процедуру; self-promotion запрещён.
- Не редактировать применённые migrations; rollback импровизированным SQL запрещён.
- Нельзя `ADMIN` → `OWNER`.
- Ручное изменение БД в обход application validation и audit конфликтует с правилами миграций и аудита.

В тестах `ADMIN` есть как сериализуемое значение. Production-строк с смыслом admin API быть не должно.

### Варианты

1. **Forward-only abort, если есть `ADMIN`;** затем versioned application CLI (не SQL) демотирует `ADMIN` → `CUSTOMER` с audit; повторная schema-migration проходит только при нуле `ADMIN`.
2. **Тихий `ADMIN` → `CUSTOMER` внутри schema-migration.** Нет application audit; скрывает ручной флаг.
3. **`ADMIN` → `OWNER` или raw SQL membership.** Запрещены.

Bootstrap первого OWNER и recovery — не варианты «открыть psql». Только versioned CLI.

### Рекомендация (утверждена владельцем 2026-09-03)

Схема: `User.role` только `CUSTOMER`; админство — `AdminMembership(userId, role)` unique по `userId`.

**Remediation старых `ADMIN` (не импровизированный SQL):**

1. Read-only versioned command `admin:check-legacy-admin`: посчитать `ADMIN`, выйти ненулевым кодом если > 0. Этот check — **обязательный deployment preflight до** `prisma migrate deploy` (обёртка migrate-контейнера / команда в runbook). Host `infra/platform/preflight.sh` Postgres не видит и эту проверку не заменяет.
2. Versioned command `admin:demote-legacy-admin`: в одной транзакции `SELECT … FOR UPDATE`, только `ADMIN` → `CUSTOMER`, audit `legacy-admin-demoted`, никогда `OWNER`.
3. Forward-only Prisma migration **в одной явной PostgreSQL-транзакции** (`BEGIN` … `COMMIT` в SQL-файле; без операторов вне транзакции): `LOCK`, guard `RAISE` если ещё есть `ADMIN`, иначе создать `AdminMembership`, убрать значение `ADMIN` из enum. Prisma не считается атомарной без этого `BEGIN`/`COMMIT`.
4. Старые migration-файлы не менять.

SQL `RAISE` внутри уже запущенной Prisma migration **не** лечится повторным `migrate deploy`: Prisma фиксирует failed migration. `resolve --rolled-back` меняет только history и **не** восстанавливает схему. Versioned runbook без ручного SQL:

1. Read-only проверка, что частичных изменений нет: таблицы/enum/constraint этой migration отсутствуют (нет `AdminMembership`; `"User"."role"` ещё содержит `ADMIN`). Если схема частично изменена — стоп, не `resolve`, нужен отдельный разбор, не импровизированный SQL.
2. Только если rollback DDL/data подтверждён: `prisma migrate resolve --rolled-back` (не `--applied`).
3. `admin:demote-legacy-admin`.
4. Снова `admin:check-legacy-admin` (ожидается 0).
5. `prisma migrate deploy`.

Не править `_prisma_migrations` вручную.

**Первый OWNER:** versioned one-shot CLI/application command, без HTTP и без raw SQL. Под advisory lock команда `admin:bootstrap-owner`:

- если `OWNER` count ≠ 0 → отказ;
- создать `AdminMembership` OWNER для заранее переданного telegram user (user должен существовать как `CUSTOMER` либо создаётся в той же транзакции без entitlement);
- bootstrap lock/flag атомарно помечается использованным;
- сгенерировать TOTP seed и recovery codes в процессе, записать AEAD pending credential; **один раз** показать seed/QR и codes на TTY оператора (stdout TTY, не argv, не env, не Compose command, не логи, не audit payload); QR можно рисовать в TTY, файл в репозиторий не писать;
- audit `bootstrap-owner`;
- admin HTTP fail-closed: admin-сессия не выдаётся.

Отдельная команда `admin:confirm-owner-totp`: читает первый TOTP с TTY или stdin (не argv); проверяет pending seed; атомарно `pending` → `active`; audit `bootstrap-owner-totp-confirmed`. До успешного confirm `/admin/*` и admin login fail-closed. Повтор bootstrap после OWNER ≥ 1 отклоняется. Production image не содержит включённого HTTP bootstrap. HTTP enrollment 2FA (§1) существует только после первого `active` OWNER.

Потерянный вывод seed: не доставать ciphertext ключом в ad-hoc SQL; использовать `admin:recover-owner-totp`.

**Запрет удаления последнего OWNER:** application и DB constraint/trigger: `DELETE`/`UPDATE` membership, после которых count(OWNER) = 0, abort. Понижение последнего OWNER той же транзакцией abort.

**Recovery, если последний OWNER потерял TOTP или Telegram:**

- второй OWNER сбрасывает 2FA по §1, если он есть;
- если OWNER один: versioned CLI `admin:recover-owner-totp` (не HTTP, не SQL): не создаёт второго OWNER, выпускает новый pending seed, один раз показывает его на TTY, audit `recover-owner-totp`, требует physical/SSH доступ и причину; активация тем же `admin:confirm-owner-totp`; до confirm admin-сессия не выдаётся;
- замена telegram identity последнего OWNER — отдельный CLI `admin:transfer-last-owner` только при count(OWNER)=1, с причиной и audit; не обходит 2FA pending.

### Trade-offs

- CLI вместо SQL даёт validation и audit ценой того, что оператор всё же имеет runtime к БД.
- Abort schema-migration при живом `ADMIN` безопаснее silent cast, но Prisma failed migration требует подтверждённого rollback DDL **затем** `resolve --rolled-back`, а не «ещё раз deploy». Поэтому check до deploy обязателен, а SQL обязан быть в `BEGIN`/`COMMIT`.
- Recovery CLI — break-glass; его отсутствие оставляет систему без админки навсегда после потери единственного OWNER.
- Показ seed на TTY требует физической/SSH сессии оператора; это лучше HTTP enrollment до первой admin-сессии и хуже, если вывод попадёт в script/CI лог — поэтому запрет argv/non-TTY и redact logger.

### Текст, перенесённый в owner-документы

> `UserRole.ADMIN` удаляется только forward-only migration после того, как versioned application command перевёл все такие строки в `CUSTOMER` с audit. Обязательный read-only check `admin:check-legacy-admin` выполняется до `prisma migrate deploy` и не заменяется host preflight. Migration SQL явно обёрнут в PostgreSQL `BEGIN`/`COMMIT` вместе с lock, guard и schema changes. Guard под lock прерывается, если `ADMIN` ещё есть (defense-in-depth); транзакция откатывает DDL. Если Prisma всё же записала failed migration, runbook: read-only подтвердить отсутствие частичных объектов, затем `prisma migrate resolve --rolled-back`, demote CLI, повторный check, затем deploy — без ручного SQL. `resolve` схему не чинит. `ADMIN` никогда не становится `OWNER`. Админские роли живут в `AdminMembership`, не в кабинетном self-promotion. Первый OWNER создаётся versioned one-shot CLI `admin:bootstrap-owner`: advisory lock, `OWNER count = 0`, membership, pending AEAD TOTP, однократный показ seed/QR на TTY, audit; без HTTP и без raw SQL. Активация — отдельный CLI `admin:confirm-owner-totp` (TOTP с TTY/stdin, не argv); до confirm admin-сессия не выдаётся. Повтор после появления OWNER отклоняется. Нельзя удалить или понизить последнего OWNER. Потеря 2FA последнего OWNER — CLI `admin:recover-owner-totp` с новым seed на TTY; замена telegram identity — CLI `admin:transfer-last-owner`; оба с audit и причиной. Пока нет active TOTP у OWNER, `/admin/*` fail-closed. Кабинет пользователей работает.

### Влияние на schema / API / tests

- `AdminMembership`; CHECK/trigger last OWNER; bootstrap used flag.
- CLI в `apps/api` scripts, не в web, не в публичном OpenAPI: `admin:check-legacy-admin`, `admin:demote-legacy-admin`, `admin:bootstrap-owner`, `admin:confirm-owner-totp`, `admin:recover-owner-totp`, `admin:transfer-last-owner`. Обёртка migrate: check → `prisma migrate deploy`.
- Technical spec / platform runbook: обязательный legacy-ADMIN check до migrate; failed-migration runbook с `resolve --rolled-back`; seed не в systemd unit argv.
- Tests: wrapper abort при `ADMIN` **до** prisma; integration реального guard failure: `RAISE` внутри транзакции, после abort нет таблицы `AdminMembership` и enum ещё содержит `ADMIN`; только затем `resolve --rolled-back`, demote, deploy; CLI bootstrap показывает seed один раз в тесте-двойнике TTY и не пишет его в лог; confirm CLI активирует; bootstrap без confirm → admin login 401; второй bootstrap fail; delete last OWNER fail; recover не создаёт второго OWNER; нет SQL-fixture как единственного пути.

### Вопросы владельцу

1. Подтверждаете demote `ADMIN`→`CUSTOMER` только через versioned CLI, затем abort-migration если флаг остался?
2. Подтверждаете отдельную таблицу `AdminMembership`?
3. Как оператор передаёт telegram id первого OWNER на `platform-1` (не Git)?
4. Нужны ли два OWNER с самого bootstrap, чтобы не зависеть от recover-CLI?
5. Подтверждаете TTY-only показ seed (не файл, не argv) и отдельный CLI confirm до любой admin-сессии?

---

## 7. Эквайринг — только открытые поля

### Ограничения owner-документов

Продукт §6 фиксирует provider-neutral правила: order до оплаты; один payment на заказ; idempotency; return URL ничего не активирует; продление после webhook + сверки API; сверка `provider_payment_id`, order, пользователь, сумма, валюта, `succeeded`; повтор не продлевает дважды; атомарность с подпиской/audit/outbox; pending + worker; секреты только в secret storage; refund — роль + audit.

Внешняя проверка 2026-08-09: production-платежи заблокированы до письменного согласования категории и юридического заключения. Имя эквайера **не зафиксировано**.

Не утверждать в Stage A: имя провайдера, endpoints, webhook-подпись и JSON, timestamp field, method id, фискализация, SDK, confirmation URL, refund API провайдера, коды ошибок, shop id, ключи.

### Варианты

1. **Ждать письменного подтверждения эквайера и не открывать этап E.** Не добавлять payment schema и webhook route. Минимальный риск неверной подписи и преждевременных secrets. Блокирует живые платежи и может сдвинуть бота оплаты.
2. **До выбора провайдера — только provider-neutral core:** таблицы `Order`/`Payment` с `idempotency_key`, `provider_payment_id` unique nullable, amount, currency, abstract status; application port «verify and apply success»; **без** адаптера, без публичного webhook, без секретов провайдера. Этап C/D могут идти; E-адаптер — после имени в owner-документе.
3. **Speculative adapter** «как у типичного эквайера». Отклонён: выдуманный webhook, риск переделки сверки и утечки не тех secrets.

### Рекомендация (утверждена владельцем 2026-09-03)

Утверждён вариант 2 для Stage B schema only, чтобы не блокировать промо/issuer. Адаптер и webhook — только после записи имени провайдера. Вариант 3 не предлагать в код.

### Trade-offs

- Вариант 1 задерживает E и любой код, который ждёт таблицы платежей; исключает переделку колонок подписи.
- Вариант 2 позволяет unique `provider_payment_id` и идемпотентность заранее; риск, что провайдер потребует лишние колонки (обычно добавляются forward-only, не ломая нейтральное ядро).
- Ранний адаптер даёт ложную скорость и ошибочную verification.

### Текст, перенесённый в owner-документы

> Конкретный эквайер, webhook-подпись, схема payload и API сверки не входят в текущую specification. Боевой адаптер, тестовый магазин в коде и публичный webhook не добавляются, пока имя провайдера не записано сюда после письменного согласования. Инварианты продукта §6 действуют независимо от провайдера. До выбора допускается только provider-neutral ядро заказа/платежа (идемпотентность, сумма, валюта, абстрактный succeeded, уникальный provider_payment_id) без адаптера. Speculative webhook verification запрещена.

### Влияние на schema / API / tests

- Если выбран вариант 1: Stage B **без** Order/Payment.
- Если вариант 2: Stage B с нейтральными таблицами и тестами идемпотентности; без HTTP webhook.
- После провайдера: forward-only колонки под его идентификаторы, tests подписи, env secrets.

### Вопросы владельцу

1. Stage B включает нейтральные `Order`/`Payment` (вариант 2) или ждёт эквайера целиком (вариант 1)?
2. Когда ожидается письменный ответ эквайера (вне Stage A)?
3. Нужен ли `Payment.providerCode` string заранее или только вместе с адаптером?

---

## Сводка рекомендаций и статусов подтверждения

| Тема | Рекомендация |
|---|---|
| 2FA | TOTP AEAD seed + KEK вне БД; recovery HMAC; admin login = Origin + Telegram/cabinet first factor + TOTP; кабинетная cookie не авторизует `/admin/*`; первый OWNER — CLI seed/QR + CLI confirm |
| bot→API | Не TLS на `egress`. HMAC на `http://api:3001`; signing key AEAD + `BOT_SIGNING_KEK`; topology/Caddy без изменений, Compose secrets/initializer/runbook — да; KEK только API, signing key только bot, worker ни один |
| Issuer | Pending-cookie WebView; код вводит пользователь в бот; `pending.expiresAt = LEAST(challenge.expiresAt, dbNow+120s)`; confirm/complete проверяют оба TTL; Origin и fail-closed rate limit на initial/complete |
| Duration | `durationDays`; явная транзакция; abort+полный rollback если состав неизвестен; 30 только как подтверждённый data UPDATE; тест реального guard failure |
| RBAC | Подтверждено: пять фиксированных ролей, одна статическая backend-матрица и общий guard; при первом запуске назначается только OWNER; без dynamic permissions/ACL builder. Точные доменные клетки матрицы утверждены 2026-09-03 |
| `ADMIN` | Check до deploy; CLI demote; migration в `BEGIN`/`COMMIT`; `resolve --rolled-back` только после read-only проверки отсутствия частичного DDL; CLI bootstrap + CLI TOTP confirm |
| Эквайринг | Не выдумывать адаптер; ждать имя или только neutral schema/port |

После подтверждения владельца: перенести выбранные черновики в `vpn-application-implementation-tz.md` (и точечно в `vpn-service-tz.md`), затем журнал. Код этапа B — только по утверждённому тексту.
