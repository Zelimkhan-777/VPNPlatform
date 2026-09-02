# Read-only аудит готовности application-части Meteora

**Дата:** 2026-09-02  
**Ветка / HEAD на момент чтения:** `main` @ `4f9fb57` (`docs(infra): record first GHCR release`)  
**Рабочее дерево:** чистое (незакоммиченных изменений не было)  
**Scope:** Telegram-бот, платежи, промокоды, личный кабинет, админка, RBAC и 2FA  
**Метод:** сверка кода, Prisma/миграций, contracts/OpenAPI и тестов с `docs/vpn-service-tz.md`, `docs/vpn-application-implementation-tz.md`, `docs/vpn-technical-spec.md`, `docs/vpn-project-journal.md` и `docs/vpn-external-validation-2026-08-09.md`  
**Ограничения этой задачи:** код, миграции, спецификации и журнал не изменялись. Создан только этот файл. Ничего не коммитилось и не отправлялось в `main`.  
**Правки отчёта:** 2026-09-02, после review: OWNER-управление промокодами не ставится до admin-сессии и 2FA; сценарии 20–23 разделены по этапам; миграция `ADMIN` и первый `OWNER` вынесены в документационный этап A; продуктовая длительность MVP — 30 календарных дней, открыт только формат хранения. Повторный review: в A добавлена аутентификация bot→API; этап C без публичного HTTP, пока нет утверждённого внутреннего контракта; этап B — «без новых бизнес-flow», с обновлением auth serializers.

## Короткий вывод

Application-контур **не готов к продуктовому MVP** (`vpn-service-tz.md`, раздел 11). Закрыт технический прототип кабинета и VPN-доступа: cookie-сессия по проверенному Telegram `initData`, overview/выпуск/отзыв устройства, feed, orchestration и worker. **Не закрыты** живой бот, платежный контур, промокоды, first-access gate, production issuer `AuthChallenge`, админка как продукт, роли `OWNER`/`OPERATOR`/`SUPPORT`/`FINANCE`/`AUDITOR` и 2FA.

Это совпадает с явной записью журнала от 2026-08-31 и с формулировками owner-документов: кабинет начат без оплаты; production issuer не подключён; публичный self-service challenge запрещён. Живые платежи по-прежнему заблокированы внешней проверкой эквайринга, а не только отсутствием кода.

---

## 1. Что уже реализовано

### 1.1. Каркас приложений и границы

- Монорепозиторий соответствует целевой карте: `apps/web`, `apps/api`, `apps/bot`, `apps/worker`, `packages/contracts`, Prisma, worker с transactional outbox.
- `apps/api/src/app.module.ts` подключает `auth`, `cabinet`, `orchestration`, `node-agent`, `subscription-access`, `health` и локальный `subscription-prototype`. Отдельных модулей `plans`, `billing`, `promotions`, `admin`, `users`, `notifications` нет — это прямо сказано в `vpn-application-implementation-tz.md`, раздел 4.
- Production Compose изолирует bot от PostgreSQL/Redis: бот не должен ходить в БД напрямую и обязан вызывать API. Сам HTTP-контракт для бота ещё не существует.

### 1.2. Telegram-вход кабинета (consumer-side, без бота)

Реализован безопасный **приём** Telegram Web App login, но не **выдача** первого входа:

| Требование | Где закрыто |
|---|---|
| Серверная проверка подписи `initData` | `apps/api/src/auth/telegram-init-data.ts` |
| Заранее созданная `AuthChallenge`; `start_param` + HttpOnly prelaunch cookie; общий `401` без `Set-Cookie` | `apps/api/src/auth/auth-session.service.ts`, `AuthController.signIn` |
| Нет публичного `POST /auth/challenge` | контроллеров challenge нет; issuer только внутри `TrustedPrelaunchService` |
| Cookie-сессия `HttpOnly`, `SameSite=Strict`, `Secure` в production; в БД HMAC-отпечаток | `auth.controller.ts`, модель `UserSession.tokenHash` |
| Идемпотентный logout с точным trusted `Origin` | `TrustedOriginGuard`, `POST /auth/logout` |
| Retry replay binding к `User.telegramUserId` | `auth-session.service.ts` |
| Сроки challenge/freshness по PostgreSQL `clock_timestamp()` | login-транзакция и `TrustedPrelaunchService` |
| Redis rate-limit issuer fail-closed | `TrustedPrelaunchService.issue()` |
| Клиент не берёт Telegram ID и не кладёт секреты в `localStorage` | `apps/web/app/telegram-web-app.ts`, `auth-api.ts` |
| Без bot token / session pepper вход недоступен | `NotFound` / fail-closed |

Тесты: `apps/api/src/auth/*.test.ts`, `apps/api/test/infrastructure/auth.e2e.test.ts` (10 сценариев), `apps/web/app/auth-api.test.ts`, `telegram-web-app.test.ts`.

**Важно:** `TrustedPrelaunchService.issue()` — внутренняя граница «будущей bot-mediated ceremony». HTTP для браузера нет. Production issuer не подключён; до его появления login fail-closed. Это соответствует ТЗ и README.

### 1.3. Личный кабинет (control-plane прототип)

Закрыто как начатый кабинет без оплаты, не как продуктовый MVP:

- Маршруты `/` и `/cabinet` — один и тот же cabinet container (`apps/web/app/page.tsx`, `apps/web/app/cabinet/page.tsx`).
- API: `GET /cabinet/overview`, `POST /cabinet/devices`, `POST /cabinet/devices/:deviceId/revoke`. OpenAPI: `apps/api/openapi.json`.
- Overview не содержит subscription URL, хешей и Telegram ID (`cabinet.service.ts`, contracts `cabinet.ts`).
- Эффективный статус подписки считается сразу по PostgreSQL clock, не дожидаясь expiry worker (`effectiveSubscriptionStatus`).
- Выпуск устройства: user advisory lock, entitlement + `deviceLimit` из `Plan`, атомарные grants/jobs/outbox/audit, идемпотентность, откат без `HEALTHY`-ноды (`cabinet-device.service.ts`).
- Отзыв идёт через `DeviceAccessRevoker`; чужое устройство не отзывается.
- CSRF: issue/revoke требуют точный `CABINET_ORIGIN`.
- UI: TanStack Query без module-level singleton, без background refetch/retry; URL только в локальном dialog, не в query cache; подтверждение revoke.
- Выпуск/отзыв пишут `AuditEvent` (`device.issued`, `device.revoked`).

Тесты: unit `cabinet*.test.ts` / `cabinet-device.service.test.ts`; web `cabinet-*.test.tsx`, `device-*.test.ts`; integration `test/infrastructure/cabinet.e2e.test.ts` (8 сценариев).

### 1.4. Смежная application-основа, которой кабинет уже пользуется

Не предмет этого аудита как «закрытый MVP», но это рабочий фундамент для следующих этапов:

- `Plan` / `Subscription` / `Device` с инвариантами (`Plan_priceMinor_positive`, `Plan_deviceLimit_positive`, сроки подписки, revoke timestamps).
- Entitlement/expiry/renewal-семантика grants, feed `401` vs `503`, explicit `cancelSubscriptionAccess` в `@vpn-platform/orchestration-store` (без пользовательского/admin HTTP).
- Worker: outbox → BullMQ `node-sync`, expiry materialization, reconciliation. Очередей `billing` и `notifications` нет.
- Append-only `AuditEvent` (триггер `AuditEvent_reject_mutation`).
- Safe logger / Pino redact для session, prelaunch, initData, subscription URL.

### 1.5. Что из целевого списка **не** выдавать за реализованное

Следующее существует только как scaffold, enum или внутренний helper:

- `apps/bot`: Telegraf `createBot()`, лог `active: false`, токена/polling/webhook/команд нет; `test` с `--passWithNoTests`.
- `UserRole`: только `CUSTOMER` | `ADMIN`. `ADMIN` нигде не авторизует endpoint.
- `TrustedPrelaunchService.issue()` не проверяет платёж, промокод и не привязывает challenge к пользователю в момент выдачи.
- Локальный `/prototype/subscription/:token` выключен по умолчанию и не является кабинетом/оплатой.

---

## 2. Что отсутствует

Сводка относительно продуктового этапа 2 и критерия MVP.

### 2.1. Telegram-бот

Отсутствует целиком как продукт:

- команды/клавиатуры: тариф, «Оформить подписку», ввод промокода, статус платежа, кнопка кабинета после entitlement, уведомления об окончании, поддержка;
- вызов API по внутреннему контракту (создание user/order/payment, redeem, запрос статуса, выдача `AuthChallenge`); сам контракт и межсервисная аутентификация в owner-документах не определены;
- production webhook на `api.mymeteora.ru`;
- постановка cookie+`start_param` ceremony; постоянная login-ссылка правильно не добавлялась, но одноразовый вход тоже не выдаётся;
- очередь `notifications` и шаблоны сообщений.

Файлы сейчас: `apps/bot/src/main.ts`, `apps/bot/package.json`. Тестов бота нет.

### 2.2. Платежи

Нет доменной модели и API:

- сущностей `Order` / `Payment` нет в `prisma/schema.prisma`;
- нет `GET /plans`, `POST /orders`, `GET /orders/:id`, `POST /webhooks/payment-provider`, `POST /subscription/renew`;
- нет ключа идемпотентности заказа, уникального `provider_payment_id`, сверки суммы/валюты/статуса, return URL «Проверяем оплату»;
- нет worker-очереди `billing`, reconciliation pending-платежей, refund use case;
- нет адаптера эквайера — и его нельзя выбирать догадкой: конкретный провайдер в owner-документах не зафиксирован;
- страница возврата и UI продления в web отсутствуют.

Живые платежи дополнительно заблокированы `vpn-external-validation-2026-08-09.md` и этапом 0 продукта: нет письменного согласования категории с эквайером и юридического заключения.

### 2.3. Промокоды

Отсутствует целиком:

- нет `PromoCode` / `PromoRedemption`;
- нет HMAC/хеша секрета, `maxUniqueUsers`, окна `startsAt`/`endsAt`, campaign/plan/duration/comment;
- нет `POST /promotions/redeem` и admin ` /admin/promo-codes* `;
- нет атомарной транзакции активации, unique `(promoCodeId, userId)`, preview/confirm/reason массового отзыва;
- бот не принимает код; rate-limit перебора не к чему применить.

`Plan` не содержит длительности, хотя продукт требует у тарифа «цена, длительность, device_limit», а OWNER промокода задаёт duration отдельно.

### 2.4. Личный кабинет — продуктовые дыры поверх прототипа

Есть overview, выпуск и отзыв. Нет:

- first-access gate: новый пользователь без платежа/промокода не должен видеть кабинет (`vpn-application-implementation-tz.md`, раздел 9);
- QR, инструкция Happ, перевыпуск (`POST /devices/:id/rotate` или cabinet-эквивалент);
- продление и экран «Проверяем оплату»;
- публичный бренд Meteora: layout всё ещё `VPNPlatform` / «Мой VPN»;
- корневая информационно-юридическая страница продукта (оферта, privacy, возврат, кнопка Telegram);
- Tailwind CSS + shadcn/ui + React Hook Form (зафиксированный стек); web — Next.js + кастомный `styles.css` + ручные формы;
- Playwright E2E из стека ТЗ.

`GET /cabinet/overview` отдаёт данные любому валидному session cookie, в том числе без подписки (`subscription: null`). UI показывает «Подписки пока нет» вместо отказа во входе.

### 2.5. Админка

Нет маршрутов `/admin`, layout/guard/navigation, ни одного admin HTTP:

целевые разделы overview, users, subscriptions, devices, orders, payments, promo-codes, nodes, delivery, incidents, alerts, plans, audit-log, system, backups отсутствуют.

Внутренние use case нод (`disable`/`quarantine`, cancel subscription, credential rotate) не экспортированы в admin API. ТЗ прямо говорит, что admin HTTP для quarantine в прошлый этап не входил.

### 2.6. RBAC

- Спецификация: `OWNER`, `OPERATOR`, `SUPPORT`, `FINANCE`, `AUDITOR`; backend authorization, не только UI.
- Код: `enum UserRole { CUSTOMER, ADMIN }`, роль уходит в `GET /auth/me`, проверок роли на endpoint нет.
- Нет матрицы разрешений, отдельной admin-сессии, ручной процедуры выдачи ролей, запрета SUPPORT/OPERATOR на массовый отзыв промо-доступа.

### 2.7. 2FA

В коде, схеме, contracts и OpenAPI нет ни хранения секрета, ни enrollment, ни проверки при admin-сессии, ни запрета логировать 2FA material.

Owner-документы требуют 2FA для критичных ролей, но **не фиксируют механизм** (TOTP, WebAuthn и т.д.). По `AGENTS.md` это нельзя закрыть догадкой до записи в authoritative specification.

### 2.8. Данные, очереди, тесты из разделов 6–7 и 11 ТЗ

Нет таблиц и инвариантов: уникальный `provider_payment_id`, `orders.idempotency_key`, HMAC промокода, `PromoRedemption(promoCodeId, userId)`.

Worker: одна очередь `node-sync` (`WORKER_QUEUE_NAME`). Нет `billing`, `notifications`, `health-checks`; `maintenance` как отдельная BullMQ-очередь не выделена (expiry/reconciliation — периодический in-process loop).

Обязательные тестовые сценарии 1–4, 7 (видимость в админке), 8 (admin endpoint), 19–23 из раздела 11 implementation ТЗ не имеют production-кода, который они могли бы проверять.

---

## 3. Расхождения кода и спецификаций

Ниже — факты, а не предложения «выбрать сторону». Где owner уже признал разрыв, это указано.

### 3.1. Признанные разрывы (спецификация знает, что кода нет)

| Тема | Owner | Код |
|---|---|---|
| Production issuer / first-access | Implementation §5: issuer только после платежа или промокода; пока issuer отсутствует, публичный challenge не добавлять | Issuer без HTTP и без проверки entitlement; login upsert-ит `User` при любом валидном challenge |
| Бот, billing, promotions, admin UI | Журнал 2026-08-31; продукт §9–10 | Scaffold бота; модулей нет |
| Карта backend-модулей | Implementation §4: целевая карта, не текущий путь | Совпадает с оговоркой в ТЗ |
| Admin HTTP quarantine | Implementation §8: в тот этап не входил | Внутренний use case есть, HTTP нет |

### 3.2. Расхождения, которые спецификация ещё формулирует как текущее требование

| Требование | Спецификация | Код |
|---|---|---|
| Роли администраторов | `OWNER`/`OPERATOR`/`SUPPORT`/`FINANCE`/`AUDITOR` | `CUSTOMER`/`ADMIN` в Prisma, contracts и OpenAPI |
| Длительность тарифа | Продукт §2: стартовый MVP — 200 ₽ / 30 календарных дней, значение редактируется из админки и не хардкодится; §5: у плана есть длительность | `Plan`: `priceMinor`, `currency`, `deviceLimit`; поля хранения длительности нет |
| Основные endpoint-ы | Implementation §5: Plans, Orders, Promotions, Subscription renew, Devices rotate, Admin/* | В OpenAPI есть только health, auth, cabinet, `/sub/{token}`, node-agent, prototype |
| Новый пользователь не видит `/cabinet` | Implementation §9 | `/cabinet` открывается; без сессии — приглашение открыть из бота; с сессией без подписки — пустой кабинет |
| `AuthChallenge` после entitlement | Challenge выдаётся только после платежа/промокода и не даёт вход по факту существования `User`/`Order`/`Payment` | `issue(clientIdentity)` не знает user/entitlement; `userId` пишется при consume; `User` создаётся в login |
| Стек web | Next.js + Tailwind + shadcn + RHF + Zod + TanStack Query | Next.js + TanStack Query + Zod в contracts; нет Tailwind/shadcn/RHF |
| Playwright | Implementation §2 | В workspace нет Playwright |
| Очереди | `billing`, `node-sync`, `health-checks`, `notifications`, `maintenance` | Только `node-sync` + in-process access maintenance |
| Бренд Meteora без обязательного «VPN» в UI | Продукт §1 | `metadata.title = 'VPNPlatform'`, заголовок «Мой VPN» |
| Происхождение entitlement | Подписка от платежа или промокода | `Subscription` не связана с order/payment/promo; доступно ручное INSERT (так закрытый тест и работает) |
| Отдельная admin-сессия | Implementation §5 | Одна `UserSession` на кабинет |
| CSRF на все cookie-mutating запросы | Implementation §10 п.13 | Есть на logout/issue/revoke; `POST /auth/telegram` — выдача сессии, Origin-guard нет (это согласовано с prelaunch-моделью, но rate-limit на сам login отсутствует) |
| Rate limit auth / заказы / webhook / promo | Implementation §10 п.14 | Есть на issuer и subscription feed; нет на `POST /auth/telegram`; заказов/webhook/promo нет |
| 2FA | Продукт §7, implementation §5/§10, technical spec чеклист | Механизм не специфицирован и не реализован |

### 3.3. Документационная неполнота, блокирующая реализацию без догадки

Эти пункты нельзя «просто написать в коде» до обновления owner-документа:

1. **Механизм 2FA** для критичных ролей.
2. **Конкретный эквайер** и поля webhook/API сверки (кроме общих правил: `provider_payment_id`, сумма, валюта, `succeeded`, идемпотентность).
3. **Церемония bot-mediated issuer:** как одноразовый секрет оказывается в HttpOnly cookie кабинета, если bot в production не имеет доступа к БД и не должен открывать публичный challenge. Сейчас описаны свойства (start_param + cookie, нет публичного issuer), но не application-протокол bot→API→WebApp.
4. **Технический формат хранения длительности тарифа** (например целое `durationDays` на `Plan`). Продуктовое стартовое значение MVP уже зафиксировано: 30 календарных дней, цена и лимит устройств редактируются из админки и не копируются в код. Отдельно OWNER задаёт duration конкретного промокода; это не подменяет поле тарифа. В схеме поля нет, в коде константы нет — это правильно, пока формат не введён миграцией.
5. **Матрица RBAC** по endpoint-ам (какие роли видят payments, могут replay webhook, drain node, создавать промокоды). Даны роли и отдельные запреты (массовый отзыв промо — только OWNER; ручной `succeeded` запрещён), полной матрицы нет.
6. **Миграция `UserRole.ADMIN` и первый `OWNER`.** Нельзя в коде угадать, во что превращать существующие `ADMIN`-строки и кто становится первым владельцем. Нужна защищённая внеполосная процедура назначения первого `OWNER`, явное правило для уже сохранённых `ADMIN` (включая тестовые фикстуры) и запрет оставить параллельные enum `ADMIN` и `OWNER`. Самостоятельное повышение через кабинетную сессию недопустимо.
7. **Аутентификация bot→API.** ТЗ говорит, что бот вызывает API по внутреннему контракту и не решает entitlement сам, но не фиксирует, как API отличает бота от браузера, как запрос привязывается к Telegram-пользователю и как ротируется межсервисный credential. `telegramUserId` в JSON body недоверенный: у пользователя до first-access нет кабинетной сессии, а живой бот появляется только на этапе F. То же касается `POST /orders` и выдачи `AuthChallenge`. Механизм (отдельный service credential, mTLS, подписанный Telegram update и т.д.) **не выбирать в этом отчёте**.

---

## 4. Security и data-integrity риски

Риски ниже — про **текущий код и будущий неверный wiring**, не про призыв ослабить fail-closed.

### 4.1. First-access gate не исполняется

Спецификация: новый пользователь получает кабинет только после серверно подтверждённого платежа или атомарного промокода. `User`/`Order`/`Payment` до оплаты права входа не дают.

Факт: `signInWithTelegram` при валидном challenge делает `user.upsert` без проверки entitlement. `TrustedPrelaunchService.issue()` не требует ни user, ни подписки. Сейчас это сдерживается отсутствием production issuer: без заранее созданного challenge login не ставит cookie.

Риск при подключении бота: если bot/API выдаст challenge до webhook/promo, first-access будет обойдён без изменения login-кода. Testharness уже выдаёт challenge любому `clientIdentity`.

### 4.2. Challenge не привязан к пользователю в момент выдачи

`AuthChallenge.userId` nullable и заполняется при consume. До этого любой, кто одновременно имеет `launchId` (как Telegram `start_param`) и prelaunch cookie, может войти под своим Telegram ID.

Пока ceremony нет, окно не эксплуатируется из браузера. При реализации issuer challenge должен связываться с уже проверенным `telegramUserId`/user **до** открытия WebApp.

### 4.3. Грубая роль `ADMIN` без authorization layer

Поле существует и сериализуется клиенту. Сейчас admin endpoint-ов нет, поэтому `role=ADMIN` в БД ничего не открывает. Когда появятся `/admin/*`, легко ошибочно принять этот enum за RBAC. Нужна замена на специфицированные роли **до** первого admin use case, а не флажок в UI. Как именно преобразовать уже сохранённые `ADMIN` и как безопасно назначить первого `OWNER`, фиксируется в этапе A; миграция этапа B только исполняет это решение.

### 4.4. Ручная подписка = полный VPN-доступ

Issuance доверяет persisted `Subscription` + `hasEntitlement`. Это корректно для data plane и опасно как продуктовый вход: оператор/тест может вставить `ACTIVE` подписку и выдать устройства без платежа. Продукт это прямо не считает заменой этапа 2. Для MVP нужна прослеживаемость entitlement (payment id или promo redemption) и issuer, который смотрит на неё, а не только на факт строки `Subscription`.

### 4.5. Нет rate-limit на `POST /auth/telegram`

Issuer ограничен Redis. Сам login — нет. При появлении bot-issued challenge остаётся поверхность перебора/replay на endpoint входа. Спецификация требует rate limit на auth.

### 4.6. Платёжный контур отсутствует → нет инвариантов денег

Пока таблиц нет, двойной webhook, return URL и повтор «Оплатить» не на чём исполнить. Главный integrity-риск **после** появления кода: реализовать активацию по return URL или клиентскому флагу; ТЗ это запрещает. Второй риск — продление от времени обработки webhook, а не от immutable provider timestamp / первой серверной верификации.

`Plan_priceMinor_positive` запрещает нулевую цену. Промокод не должен обходить это фиктивным заказом с ценой 0; он должен быть отдельной сущностью. Это согласовано с ТЗ, если не появится «бесплатный Plan».

### 4.7. Промокоды: будущие типовые ошибки

Их ещё нет; при реализации обязательны:

- хранить только HMAC/хеш; полный код один раз OWNER;
- не логировать код и не класть в audit payload / URL;
- атомарный `maxUniqueUsers` под lock;
- disable/archive ≠ revoke;
- ответы не должны помогать перебирать коды (общий отказ, rate limit).

### 4.8. 2FA и admin session

Без отдельной admin-сессии и 2FA компрометация кабинетной cookie пользователя с ролью администратора (когда роли появятся) даст критичные операции. Сейчас критичных HTTP-операций нет. Нельзя «временно» пустить admin UI или OWNER-endpoints промокодов на той же cookie «до 2FA»: одного RBAC-guard на кабинетной сессии недостаточно. Create/disable/archive и массовый отзыв промокодов ждут этап H.

### 4.9. Утечки и прототип-feed

- Выпуск устройства аудитирует `platform`, не URL; OpenAPI и logger это покрывают.
- `/prototype/subscription/:token` в production-конфиге должен оставаться выключенным (`LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED` отвергается в production environment validation). Риск — включить его в неверном окружении.
- Web заголовок «VPNPlatform» / «Мой VPN» — продуктовый/legal риск позиционирования, не дыра auth.

### 4.10. Data integrity схемы для следующего этапа

Сейчас нельзя соблюсти минимальные инварианты §6 implementation ТЗ для платежей и промо: соответствующих unique/check нет. `Subscription` не хранит источник права (payment vs promo vs ручная запись). Expiry/cancel уже атомарны и не должны ломаться будущими биллинг-транзакциями: подтверждённый платёж обязан идти в одной PostgreSQL-транзакции вместе с subscription/grants/audit/outbox.

### 4.11. Нельзя принимать `telegramUserId` из body

Redeem, создание заказа и выдача `AuthChallenge` происходят до кабинетной cookie. Публичный HTTP, который берёт Telegram ID из тела запроса, позволяет выдать entitlement или login-контекст чужому идентификатору. Пока в owner-документе нет внутреннего bot-контракта с аутентификацией бота, binding к пользователю, replay protection, idempotency и ротацией credential, эти use case остаются application/domain services без публичного HTTP. Кабинетная сессия сюда не подставляется: её ещё нет у нового пользователя.

---

## 5. Рекомендуемый порядок следующих application-этапов

Один согласованный этап за раз. Не смешивать с HTTPS/iOS, Poland node audit и deployment `platform-1`. Живой эквайринг и юридическая модель — precondition продуктового этапа 0; без них **не подключать** боевой платёжный адаптер и не объявлять MVP.

Механизм 2FA, имя эквайера и межсервисную аутентификацию bot→API **не выбирать в коде**, пока их нет в owner-документе.

Порядок ниже стыкует журнал («сначала contracts, forward-only migrations и тесты») с зависимостями этапа 2 продукта.

### Этап A. Документационные unblocker-ы (не код)

Зафиксировать в owner-документах, затем журнал:

- механизм 2FA критичных ролей;
- церемония bot→API issuer (как одноразовый секрет оказывается в HttpOnly cookie; внутренний контракт, не публичный challenge) с binding к `telegramUserId`;
- **аутентификация bot→API** до любого redeem/order/issuer HTTP:
  - как бот доказывает API, что запрос идёт от control-plane bot, а не от браузера;
  - как запрос привязывается к Telegram-пользователю; `telegramUserId` из body недоверенный;
  - replay protection, idempotency и ротация межсервисного credential;
  - credential не в Git, не в frontend, bot в production по-прежнему без прямого доступа к PostgreSQL/Redis;
- технический формат хранения длительности тарифа (например `durationDays`); продуктовый старт MVP уже равен 30 календарным дням и не выбирается заново. Отдельно — поле duration промокода;
- черновая RBAC-матрица endpoint-ов;
- миграция `UserRole.ADMIN`: что делать с существующими строками, как внеполосно назначить первого `OWNER`, что считать fail-closed, если `OWNER` ещё нет. Нельзя молча повышать всех `ADMIN` до `OWNER`;
- после письменного ответа эквайера — имя провайдера и поля сверки.

Без A.2 (церемония cookie/start_param) нельзя безопасно делать этап D. Без A.3 (bot→API auth) нельзя публиковать HTTP redeem, `POST /orders` и выдачу `AuthChallenge`; этап C тогда только in-process service. Без A.1 и процедуры первого `OWNER` нельзя делать этап H и любые OWNER HTTP. Без решения по миграции `ADMIN` нельзя делать этап B. Без эквайера нельзя делать боевой этап E.

### Этап B. Схема и contracts без новых бизнес-flow

Forward-only Prisma migration + Zod/OpenAPI **без** redeem/order/issuer HTTP, без живого бота и без admin UI. Замена роли — не новый flow, но это **ломающее изменение текущего auth JSON**:

- поле длительности тарифа в формате из A; стартовое продуктовое значение 30 календарных дней читается из данных тарифа, не из константы кода;
- `Order` / `Payment` и инварианты идемпотентности / `provider_payment_id`;
- `PromoCode` / `PromoRedemption` (секрет только как HMAC/хеш, unique `(promoCodeId, userId)`);
- замена `UserRole.ADMIN` на специфицированные admin-роли **или** отдельная модель membership — строго по решению A, без параллельного enum `ADMIN` и `OWNER`;
- обновление auth serializers, contracts и OpenAPI для `GET /auth/me` и `POST /auth/telegram` (`authenticatedUserSchema`, `AuthController`, `serializeUser`);
- заготовка admin-сессии / 2FA-хранения только после A.1, иначе не выдумывать колонки.

Проверки: migration e2e, включая выбранное правило преобразования `ADMIN`; contracts tests; регенерация OpenAPI; существующие auth unit/e2e и web `auth-api.test.ts` под новый enum ролей. Кабинетные бизнес-flow (выпуск устройства, login ceremony) не расширять. Admin HTTP и публичный redeem не появляются.

### Этап C. Пользовательская активация промокода как domain/application service

Одна PostgreSQL-транзакция redeem: один `dbNow`, locks, лимит, продление от `expiresAt` или `dbNow`, grants без смены device identity, audit/outbox. Коды в тестах создаются фикстурой/Prisma с уже сохранённым HMAC, не через OWNER API.

**Публичного `POST /promotions/redeem` на этом этапе нет.** API не может доверять `telegramUserId` из body, кабинетной сессии ещё нет, живой бот — этап F. Пока этап A не утвердил внутренний bot-контракт, C — только service + тесты, вызывающие его in-process. Если контракт из A уже записан в owner-документ, C может добавить **только** этот аутентифицированный внутренний endpoint, не браузерный self-service.

OWNER create/disable/archive, hard-delete policy для использованного кода, однократное раскрытие полного кода и массовый отзыв с preview/confirm/reason **не входят** в этот этап: одного RBAC-guard на кабинетной сессии недостаточно, см. §4.8. Эти операции ждут этап H (отдельная admin-сессия и 2FA).

Этап закрывает пользовательский источник бесплатного entitlement и сценарии 20–21 раздела 11 ТЗ на уровне application service. Сценарий 22 и операция создания из сценария 23 относятся к H. Полный сценарий 23 нельзя закрыть до появления 2FA.

### Этап D. First-access gate и bot-mediated issuer

- `TrustedPrelaunchService.issue` только для пользователя с подтверждённым платежом **или** успешной активацией промокода; повторный вход после expiry — да, devices/feed — нет.
- Привязка challenge к telegram user до открытия WebApp.
- Login не создаёт first-access «с нуля» для пользователя без предшествующего entitlement.
- По-прежнему нет публичного `POST /auth/challenge`.
- HTTP выдачи challenge — только внутренний bot-контракт из A.3; без него issuer остаётся in-process service.
- Rate limit на `POST /auth/telegram`.

Живой Telegraf-бот на этом этапе не обязателен: тонкий клиент контракта появляется на этапе F.

### Этап E. Платёжный application-контур

Только после имени провайдера в owner-документе (или явно тестового контура, описанного там же):

- `GET /plans` как безопасный каталог, если продукт разрешает его без сессии;
- `POST /orders` только через внутренний bot-контракт из A.3 (не trust `telegramUserId` из браузера, не кабинетная cookie нового пользователя);
- webhook + серверная сверка; return URL ничего не активирует;
- worker `billing`; атомарное продление + outbox в одной транзакции;
- запрет ручного `succeeded` без сверки.

Не подменять это заглушкой «оплата всегда успешна».

### Этап F. Живой Telegram-бот

Команды продукта: тариф, старт оплаты, промокод, статус, кнопка кабинета после issuer, уведомления. Bot вызывает уже утверждённый внутренний API-контракт из A.3, не пишет в PostgreSQL/Redis (как в production Compose) и не передаёт недоверенный `telegramUserId` как единственное доказательство личности. Токен/webhook и межсервисный credential — конфигурация, не Git.

### Этап G. Кабинет до продукта

QR, Happ-инструкция, rotate, продление, статус «Проверяем оплату», бренд Meteora, скрытие кабинета без first entitlement, сохранение входа после expiry только для ранее допущенных. Не тащить сюда admin.

### Этап H. Админка, RBAC enforcement, 2FA, audit UX, OWNER-промокоды

Отдельный `/admin` layout/guard. Backend проверяет роли. Критичные роли — отдельная admin-сессия и 2FA по A.1; кабинетная cookie для этих операций не принимается. Разделы из продукта §4, включая `/admin/promo-codes`, disable/archive, отказ hard-delete использованного кода и отдельный массовый отзыв с preview/confirm/reason/audit. Полный промокод показывается OWNER один раз на создании и не попадает в логи, analytics, errors и audit payload. Администратор не читает current credential и полный subscription URL.

Этот этап закрывает сценарий 22 и оставшуюся часть сценария 23, включая отсутствие 2FA material в логах. Playwright ключевых сценариев — перед staging, не вместо API-тестов.

---

## 6. Файлы и тесты, которые затронет каждый этап

Оценка по текущей структуре. Новые файлы — по целевой карте `apps/api/src/modules/` **или** существующему плоскому `apps/api/src/` (сейчас код плоский; новый каталог `modules/` не обязателен, если этап не делает такой перенос).

### Этап A (документы)

- `docs/vpn-application-implementation-tz.md`, `docs/vpn-service-tz.md`, при необходимости `docs/vpn-technical-spec.md`
- `docs/vpn-project-journal.md`
- Обязательные решения до кода: механизм 2FA; формат `Plan` duration; миграция существующих `ADMIN`; внеполосная процедура первого `OWNER`; **аутентификация bot→API** (доказательство бота, binding к Telegram-пользователю, replay/idempotency, ротация credential)
- Тесты кода не трогать

### Этап B (схема и contracts, без новых бизнес-flow)

**Файлы:** `prisma/schema.prisma`; новая forward-only `prisma/migrations/<timestamp>_*/migration.sql`; `packages/contracts/src/` (`plans.ts`, `billing.ts`, `promotions.ts`, расширение `auth.ts` — enum ролей); `packages/contracts/src/index.ts`; `packages/contracts/test/*`; `apps/api/src/auth/auth.controller.ts` и serializer сессии; `apps/api/scripts/generate-openapi.ts`; `apps/api/openapi.json`.

**Тесты:** `apps/api/test/infrastructure/migration.e2e.test.ts`, включая правило преобразования существующих `ADMIN` из этапа A; `apps/api/src/auth/auth.controller.test.ts`, `auth-session.service.test.ts`, `apps/api/test/infrastructure/auth.e2e.test.ts`; `apps/web/app/auth-api.test.ts`, если проверяет `CUSTOMER`/`ADMIN`; новые contract tests. Admin/OWNER HTTP и публичный redeem не добавлять.

### Этап C (domain/application redeem, без публичного HTTP)

**Файлы:** `apps/api/src/promotions/` (application service, HMAC helper, транзакция); регистрация провайдера в module без публичного controller, пока нет контракта A.3; worker только если outbox topic новый. Без `POST /promotions/redeem` для браузера, без `/admin/promo-codes*`. Внутренний bot HTTP — только если A.3 уже утверждён в owner-документе.

**Тесты:** сценарии 20–21 через прямой вызов service (happy path, replay, concurrent `maxUniqueUsers`, inactive/not-yet-started/expired/unknown, повтор того же кода, последовательные разные коды, старт от `dbNow`, продление от текущего `expiresAt`); код не появляется в логах redeem-пути. PostgreSQL integration без публичного маршрута. Не утверждать закрытие 22–23. Фикстуры создают уже хешированный код без OWNER API. Если A.3 есть — отдельные тесты, что неаутентифицированный и body-only `telegramUserId` отклоняются.

### Этап D (issuer / first-access)

**Файлы:** `apps/api/src/auth/trusted-prelaunch.service.ts`, `auth-session.service.ts`; cabinet UI gate в `apps/web/app/cabinet-queries.ts` / `cabinet-page-view.tsx`; contracts auth, если появится issuer DTO. Публичного challenge controller нет. Bot-facing issuer HTTP — только по A.3.

**Тесты:** расширить in-process issuer и `apps/api/test/infrastructure/auth.e2e.test.ts` (сценарий 19 раздела 11 ТЗ: challenge не выдаётся до платежа/промокода); `trusted-prelaunch.service.test.ts`; `auth.controller.test.ts` только если меняется login fail-closed; web `cabinet-page-view.test.tsx`, `cabinet-queries.test.tsx`. Запросы с поддельным `telegramUserId` без bot-credential отклоняются, если HTTP по A.3 уже есть.

### Этап E (платежи)

**Файлы:** `apps/api/src/billing/` (orders application service, webhook, renewal); `apps/api/src/plans/`; `apps/worker/src/` consumer очереди `billing` + `environment.ts`; возможно `apps/web` return-status page; конфиг секретов провайдера только через env, не Git. `POST /orders` не принимать от браузера по `telegramUserId` в body.

**Тесты:** сценарии 1–4, 17 раздела 11; новый integration suite `billing`; worker integration; запрет активации по return URL; идемпотентность webhook; создание заказа без bot-credential отклоняется.

### Этап F (бот)

**Файлы:** `apps/bot/src/**` (Telegraf handlers); клиент внутреннего API-контракта из A.3; `apps/bot` tests; env для bot token и межсервисного credential; bot-facing controllers API, если их ещё не добавили после утверждения A.3; `apps/worker` `notifications` при выносе уведомлений в очередь.

**Тесты:** unit команд (тариф, повтор оплатить, redeem, отказ без entitlement на кабинет-кнопку); контрактные тесты клиента API с валидным и невалидным service credential; e2e без реального Telegram можно на fake update + test API. `--passWithNoTests` убрать.

### Этап G (кабинет-продукт)

**Файлы:** `apps/web/app/cabinet-overview-view.tsx`, `issued-subscription-url.tsx`, новые QR/Happ/rotate/renew/payment-status компоненты; `apps/web/app/layout.tsx` (бренд); `packages/contracts/src/devices.ts`; `apps/api/src/cabinet/cabinet.controller.ts` + rotate/renew orchestration; `apps/web/app/styles.css` или Tailwind, **только если** этап одновременно принимает стек из ТЗ (иначе не раздувать UI-миграцией).

**Тесты:** существующие web cabinet/device tests + новые rotate/QR (URL не в cache); API cabinet e2e; не ломать revoke/idempotency.

### Этап H (админка / RBAC / 2FA / OWNER-промокоды)

**Файлы:** `apps/web/app/admin/**` (отдельный layout/nav/guard); `apps/api/src/admin/**`; guards/decorators ролей, отдельной admin-сессии и 2FA по A.1; `apps/api/src/promotions/` OWNER create/disable/archive и preview/confirm массового отзыва; audit list API; запрет раскрытия credential, полного subscription URL, полного промокода после создания и 2FA material в DTO/логах/audit.

**Тесты:** сценарий 8 раздела 11 (CUSTOMER и кабинетная сессия не вызывают admin, в том числе promo OWNER endpoints); матрица ролей; 2FA fail-closed; сценарий 22 (disable/archive не отзывают доступ, hard delete использованного кода отклонён, массовый отзыв — только OWNER, preview, повторное подтверждение, причина, audit); сценарий 23 (полный код один раз на создании; промокод, URL, credential и 2FA material отсутствуют в логах, analytics, errors и audit payload); audit append-only на уровне БД; Playwright admin smoke перед staging.

### Что этим порядком сознательно не трогать

- `apps/node-agent/**`, `infra/vpn-node/**`, production Compose topology, GHCR workflow;
- SQL/порядок locks grant/revoke/expiry, кроме добавления вызовов из billing/promo транзакций;
- уже применённые Prisma migrations;
- публичный challenge endpoint;
- публичный redeem/order/issuer HTTP, который доверяет `telegramUserId` из body.

---

## Критерий MVP (ещё не выполнен)

Из `vpn-service-tz.md` §11: новый пользователь из Telegram оплачивает картой/СБП **или** применяет промокод → серверное подтверждение → первый одноразовый вход → активная подписка → до N устройств по тарифу → Happ. Без entitlement кабинета нет.

На `main` @ `4f9fb57` этот путь нельзя пройти: нет бота, нет оплаты, нет промокода, нет issuer, кабинет открывается только если challenge уже создан вручную/тестами, а подписка записана в БД вручную.
