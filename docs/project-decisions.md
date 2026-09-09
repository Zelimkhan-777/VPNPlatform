# Устойчивые решения проекта

Этот документ хранит **активные решения, которые должны переживать рефакторинг кода**. Он не является журналом коммитов и не описывает историю реализации.

Если новое решение меняет один из пунктов ниже, сначала обновляется соответствующий owner-spec, затем этот файл при необходимости.

## Продукт

- Рабочий продукт — **Meteora VPN**.
- Клиентское VPN-приложение в MVP не разрабатывается; используется Happ и совместимые клиенты.
- Стартовый тариф: 200 ₽ / 30 дней / до 3 активных устройств. Значения являются продуктовой настройкой, а не hardcoded constants.
- Trial и promo — самостоятельные бесплатные источники entitlement; они не создают фиктивные Payment/Order.
- Robokassa остаётся главным кандидатом на эквайринг, но не считается утверждённым до внешней проверки и договора.
- Большой отдельный маркетинговый сайт не является частью MVP.

## Устройство и subscription

- Один активный Device занимает один slot тарифа.
- У каждого Device отдельный секретный subscription URL.
- Subscription URL должен сохраняться при замене backend route или VPN-ноды.
- Целевое правило — один subscription URL на одну физическую client instance; реальный Happ HWID/client identifier остаётся release gate до мобильной проверки.
- IP, User-Agent и модель устройства не используются как substitute identity.
- Полный subscription URL и VPN credentials не должны попадать в логи, analytics, errors или audit payload.

## Entitlement

- Доступ существует только при валидном entitlement.
- Payment return URL, pending order или client-side flag сами по себе доступ не выдают.
- Trial, promo и payment должны быть идемпотентными и защищёнными от concurrent replay.
- Истечение, продление, refund/chargeback и device-limit transitions используют authoritative PostgreSQL time и транзакционные границы.
- Entitlement contributions образуют неперекрывающееся расписание; refund/chargeback не выдаёт уже использованное время повторно.
- Expiry применяется нодой локально по `expiresAt`; target delivery revoke/expiry для доступной access-control ноды — не более 5 минут.
- Device revoke отключает только выбранное устройство.
- REVOKED Device не восстанавливается автоматически.

## Node lifecycle

- `DRAINING` запрещает новые назначения, но сам по себе не отзывает существующий доступ.
- `DISABLED` исключает ноду из новой выдачи, но не является emergency revoke.
- `QUARANTINED` — аварийная изоляция: маршрут исключается из feed, VPN-serving прекращается и запускается emergency revoke-all; возврат в serving требует явной recovery operation.
- Hard delete ноды не используется как обычная operational action; retirement сохраняет историю.
- `STANDBY` — тёплый резерв и не получает обычные пользовательские назначения до promotion.
- Резерв должен быть готов до аварии: runtime, TLS, node-agent, capacity и probes должны быть валидными.
- Резерв в том же provider/ASN не считается полноценной защитой от failure domain.

## Desired state и acknowledgement

- PostgreSQL — authoritative source of truth.
- Outbox event создаётся в одной транзакции с изменением business state.
- Queue delivery не является доказательством применения конфигурации.
- NodeSyncJob `SUCCEEDED` означает готовность desired state к pull, а не применение на VPN-ноде.
- Применение считается подтверждённым только после валидного NodeConfigAcknowledgement.
- Повтор/lease recovery не должен создавать новую семантически независимую команду.
- Terminal orchestration result не переписывается задним числом.

## Health и failover

- Один transient probe failure не должен немедленно менять пользовательский feed.
- Health/capacity thresholds должны быть versioned policy, а не разбросанными magic numbers.
- UNKNOWN/MIXED не превращаются автоматически в BLOCKED.
- Health decision и route eligibility — разные понятия.
- Автоматическое удаление VPS по health signal запрещено.
- Promotion резерва должна быть bounded, идемпотентной и подтверждать convergence.
- Если автоматизация не может доказать безопасное действие, допустим ручной OWNER recovery.

## Security

- User cabinet session, bot credential, node-agent credential и admin session — разные security boundaries.
- OWNER опасные действия требуют отдельной admin authentication/2FA boundary и, где указано, step-up + preview + reason.
- CUSTOMER/cabinet cookie не даёт admin access.
- Infrastructure, auth, admin и service credentials не хранятся в Git и не передаются через URLs. Device subscription capability — единственное явное URL-secret exception; он передаётся только по HTTPS, хранится как hash и не логируется.
- Production origins работают только по HTTPS.
- Missing/invalid security configuration в production должна приводить к fail-closed поведению.

## Infrastructure

- Platform/control plane и VPN data-plane nodes развёртываются независимо.
- Production release использует immutable images/digests.
- Production secrets и runtime state не коммитятся.
- Backup считается готовым только после реального restore drill.
- Локальные simulation/local-xray режимы не являются production adapters.

## Процесс

- Код не меняется только ради согласования старой формулировки документа; конфликт требований сначала эскалируется как docs inconsistency.
- Новое foundational решение не добавляется без прямой связи с текущим milestone.
- История решений хранится в archive, но не читается агентом по умолчанию.
