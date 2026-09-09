# Product specification: Meteora VPN

## Document authority

Источник истины для:

- MVP scope;
- user journeys;
- plans/device limits;
- payment/trial/promo product behavior;
- subscription/device UX;
- product-level readiness criteria.

Не описывает internal API, transactions, queues, node health или deployment. Для них используются:

- `vpn-application-implementation-tz.md`;
- `vpn-operations-spec.md`;
- `vpn-technical-spec.md`.

Историческая pre-consolidation версия: `archive/vpn-service-tz-pre-consolidation-2026-09-09.md`.

## 1. Цель MVP

Пользователь должен пройти простой путь:

1. открыть Telegram-бот;
2. получить entitlement через payment, trial или promo;
3. войти в кабинет без отдельной регистрации;
4. добавить Device;
5. получить персональный HTTPS subscription URL;
6. импортировать URL в Happ;
7. пользоваться VPN до окончания entitlement;
8. продолжать использовать тот же URL при замене VPN-ноды.

Пользователь не управляет VPS, Xray-конфигурацией или внутренними credentials.

## 2. Scope первой версии

### Входит

- Telegram bot;
- web cabinet;
- payment flow через один выбранный provider;
- автоматический trial;
- секретные promo codes;
- plans с configurable price/duration/device limit;
- device management;
- отдельный subscription URL на Device;
- Happ как основной клиент;
- минимум два реальных usable VPN routes для beta;
- OWNER control panel для ключевых product/operations сущностей;
- node monitoring и безопасная замена деградировавшего route;
- closed-beta operational/release evidence.

### Не входит

- собственные native VPN apps;
- хранение карты/autopay;
- referral/affiliate system;
- десятки тарифов;
- browser SSH/raw Xray editor;
- автоматическая покупка VPS;
- Kubernetes/microservices только ради масштабирования;
- обязательная полная self-healing автоматика до closed beta.

## 3. План и device limit

Стартовая product configuration:

- 200 ₽;
- 30 календарных дней;
- до 3 активных Devices.

Это данные продукта, а не hardcoded constants.

Изменение использованного тарифа создаёт новую immutable plan version. Order фиксирует snapshot цены, валюты, duration и device limit.

Уже оплаченный interval не изменяется задним числом.

Если будущий interval уменьшает device limit, система не выбирает устройства за пользователя. До payment/activation пользователь явно выбирает, какие Devices сохраняются. На границе нового interval невыбранные Devices отзываются; уже revoked selected Device не заменяется системой автоматически.

## 4. Entitlement sources

Entitlement может быть создан только утверждённым источником:

- подтверждённый payment;
- автоматический trial;
- secret promo.

Pending order, payment return page, client-side flag или сам факт существования User не дают доступа.

### Trial

- configurable enable/disable;
- разрешённая duration задаётся product configuration;
- базовый MVP: не более одного automatic trial на Telegram user;
- trial — бесплатный entitlement source, а не fake Order/Payment;
- если уже есть active paid/promo entitlement, trial по умолчанию не продлевает его;
- activation и campaign limits должны быть concurrency-safe.

### Promo

OWNER задаёт campaign, plan/device limit, duration, activation window и limit.

- один User применяет конкретный code максимум один раз;
- разные promo могут применяться последовательно;
- использованный code не hard-delete;
- disable/archive запрещает новые activations, но не отзывает уже выданный entitlement;
- массовый отзыв — отдельное критичное OWNER action с preview/reason/audit.

## 5. Payment

Provider-neutral product flow:

1. пользователь выбирает plan;
2. backend создаёт Order/Payment;
3. пользователь переходит на provider page;
4. access не выдаётся по return URL;
5. entitlement создаётся только после server-side verified payment state;
6. webhook/status replay не должен продлевать entitlement повторно.

Robokassa — главный кандидат, но не считается выбранным provider до закрытия внешнего validation gate.

Refund/chargeback должны отзывать только соответствующий immutable payment source и не выдавать прошлое время повторно. Partial refund не трактуется скрыто: для него требуется отдельная явно утверждённая product policy.

## 6. Device

Один active Device:

- занимает один slot plan;
- имеет отдельный secret subscription URL;
- может быть revoked независимо от других Devices.

Device limit не зависит от OS. Android/iOS/Windows/macOS — metadata/UX, а не отдельные типы entitlement.

Replacement Device получает новый URL после revoke старого Device и освобождения slot.

`REVOKED` Device не восстанавливается автоматически.

## 7. Subscription URL и Happ

Subscription URL:

- является secret capability конкретного Device;
- остаётся стабильным при node/route replacement;
- не должен попадать в logs, analytics, screenshots документации или Git;
- возвращает только текущие usable assigned routes.

Целевое MVP правило: **один URL — одна физическая client instance**.

До фиксации enforcement обязательна реальная Android/iOS проверка Happ:

- какие headers/HWID/client identifier доступны;
- стабилен ли identifier после restart/network change;
- можно ли его отключить;
- как ведёт себя auto-refresh;
- удаляется ли route после refresh того же URL.

IP, User-Agent и model устройства не используются как substitute identity. Raw client identifier не логируется; при хранении используется privacy-safe keyed representation.

Если Happ не даёт пригодного стабильного identifier, это оформляется как явный release/product limitation, а не заменяется IP-эвристикой.

## 8. Node replacement с точки зрения пользователя

Пользователь видит логические locations/routes, а не внутренний inventory.

При деградации:

- непригодный route исключается из новой/обновлённой выдачи;
- готовый replacement может быть promoted;
- subscription URL пользователя не меняется;
- обычный drain не должен внезапно обрывать рабочее соединение;
- если клиент не обеспечивает нужный auto-refresh, продукт честно показывает manual refresh UX и не обещает seamless failover.

Operational semantics: `vpn-operations-spec.md`.

## 9. Cabinet

Пользовательский кабинет должен позволять:

- видеть entitlement/expiry;
- видеть Devices;
- добавить Device в пределах limit;
- получить/copy subscription URL;
- revoke Device;
- получить инструкцию Happ.

До валидного entitlement новый пользователь не получает полноценную cabinet session.

## 10. OWNER panel

Для MVP нужен один OWNER с отдельной admin security boundary.

Панель должна покрывать:

- plans;
- trial;
- promo;
- users/devices/entitlements;
- orders/payments;
- providers;
- nodes/location pools;
- incidents/repair operations;
- audit/system health.

Опасные действия требуют повышенного подтверждения согласно application/operations specs.

Отдельные сложные RBAC UI для команды не являются обязательными для первого beta, но backend boundary остаётся deny-by-default.

## 11. Product behavior при отсутствии routes

Нужно различать:

- entitlement отсутствует/expired/revoked -> authorization failure;
- entitlement валиден, но usable route временно отсутствует -> availability failure.

Пользователь с действующим правом не должен превращаться в “unauthorized” только из-за аварии data plane.

## 12. Closed beta acceptance

Минимальный North Star scenario описан в `project-status.md`.

До closed beta обязательно подтверждаются:

- Telegram -> entitlement -> cabinet -> Device -> subscription end-to-end;
- реальный VPN traffic через Happ Android/iOS;
- один и тот же URL переживает replacement route;
- mobile refresh behavior;
- client identity/HWID decision;
- target-network blocking/filtering evidence;
- entitlement expiry/revoke behavior;
- production-like deployment и restore evidence.

Полный gate: `release-checklist.md`.

## 13. Что не расширять до beta

Без отдельного product decision не добавлять:

- дополнительные monetization systems;
- smart per-ISP personalized routing;
- full autonomous remediation;
- сложную dynamic RBAC;
- multi-region control plane;
- собственный VPN client;
- автоматическое provider procurement.

Любая новая feature должна закрывать текущий release gate или быть отложена после closed beta.
