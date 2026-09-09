# Application specification

## Document authority

Источник истины для:

- application boundaries;
- auth/session contracts;
- entitlement/device transaction semantics;
- outbox/queue/reconciliation contracts;
- node-agent desired/apply/ack integration;
- application security invariants;
- test obligations.

Product behavior — `vpn-service-tz.md`. Node/pool/health/failover operations — `vpn-operations-spec.md`. Deployment/secrets/backup — `vpn-technical-spec.md`.

Историческая pre-consolidation версия: `archive/vpn-application-implementation-tz-pre-consolidation-2026-09-09.md`.

## 1. Stack и boundaries

Монорепозиторий:

- `apps/api` — authoritative application API;
- `apps/web` — cabinet UI;
- `apps/bot` — Telegram bot boundary;
- `apps/worker` — outbox/queue/reconciliation;
- `apps/node-agent` — pull/apply/ack client VPN-ноды;
- `packages/contracts` — shared contracts;
- PostgreSQL — authoritative state;
- Redis/BullMQ — transport/readiness/rate-limit support, не source of truth.

Точная структура endpoints и schemas принадлежит коду/OpenAPI/Prisma, а не дублируется полностью в этом документе.

## 2. Security boundaries

Независимые security contexts:

- Telegram user identity;
- browser cabinet session;
- bot -> API credential;
- OWNER/admin session + 2FA;
- node-agent credential;
- external probe source credential;
- device subscription token.

Один boundary не даёт прав другого.

### User/cabinet

- Browser session создаётся только после server-side подтверждённого Telegram flow.
- Новый пользователь без entitlement не получает полноценный cabinet access.
- Auth challenge короткоживущий, одноразовый и привязан к ожидаемому flow.
- Origin/replay protections применяются fail-closed.
- Logout/revoke invalidates соответствующую session boundary.

### Bot -> API

- запрос аутентифицирован;
- timestamp bounded;
- nonce/replay защита атомарна;
- idempotency key с тем же key и другим payload отклоняется;
- credential rotation не создаёт окно двойного side effect.

### Admin

- Cabinet cookie не является admin session;
- CUSTOMER не может вызывать admin API;
- OWNER использует отдельную authentication/2FA boundary;
- step-up + preview + reason + audit обязательны для refund/chargeback, entitlement cancellation/manual extension, mass trial/promo revoke, plan/policy activation or rollback, quarantine, node enroll/migrate/retire, credential rotation, restore/break-glass и admin membership changes;
- отсутствие/невалидность encryption/KEK/2FA configuration в production работает fail-closed.

В closed beta назначается только `OWNER`. Зарезервированные backend roles `OPERATOR`, `SUPPORT`, `FINANCE` и `AUDITOR` остаются deny-by-default и не назначаются без отдельного решения.

### Node-agent/probe

- credentials независимы от user/admin secrets;
- provisional bootstrap credential не получает обычные user grants;
- revoked/expired credential отклоняется;
- probe ingestion принимает только authenticated source и защищается от replay/out-of-order semantics.

## 3. Time и transactions

Для entitlement, expiry, activation, device-limit boundaries и orchestration lease используется authoritative PostgreSQL time.

Нельзя принимать security/business решение по локальным часам отдельного process, если состояние может конкурировать между instances.

Business operation, которая должна быть атомарной, выполняется одной DB transaction и при необходимости создаёт outbox event в той же transaction.

Поздняя ошибка откатывает весь operation scope; partial business state не оставляется только потому, что queue/backend step уже начался.

## 4. Entitlement

Entitlement существует только из валидного source: payment, trial или promo.

Инварианты:

- pending order/payment return/client flag не создают entitlement;
- activation идемпотентна;
- concurrent replay не создаёт второй contribution;
- expiry boundary использует DB time;
- renewal не применяется дважды;
- revoked source не воспроизводится reconciliation;
- refund/chargeback отзывает только соответствующий immutable source;
- partial refund не интерпретируется без явной policy.
- contributions образуют упорядоченные неперекрывающиеся полуоткрытые intervals `[startsAt, expiresAt)`;
- refund/chargeback текущего или будущего source транзакционно перестраивает только ещё не использованный suffix; elapsed time не выдаётся повторно;
- trial/promo без active/future schedule стартуют от `dbNow`, payment — от подтверждённого provider success time; при active schedule новый contribution append-ится к его концу;
- при gap с future contributions существующий suffix сначала reflow-ится от `dbNow` без изменения порядка/duration, после чего новый contribution append-ится в конец;
- если reflow создаёт lower-device-limit boundary без explicit selection, contribution получает `AWAITING_DEVICE_SELECTION`, не расходует duration и не даёт entitlement;
- manual cancellation явно различает current-only и current-plus-scheduled scope и требует preview/step-up/reason/audit.

Payment activation после проверки provider signature/status обязана fail closed сверить `providerPaymentId`, internal `orderId`, User, amount, currency и terminal successful status с immutable Order snapshot. Mismatch не создаёт entitlement и фиксируется для reconciliation/audit без secret payload.

Если entitlement валиден, но routes отсутствуют, subscription feed возвращает availability semantics, а не маскирует ситуацию как отсутствие права.

## 5. Trial и promo

### Trial

- максимум одна automatic activation на Telegram user в базовом MVP;
- eligibility проверяется server-side;
- activation campaign limit расходуется атомарно;
- trial не создаёт fake Order/Payment;
- replay/concurrent requests возвращают один логический результат.

### Promo

- secret code не хранится/логируется в открытом виде;
- один User применяет один code максимум один раз;
- campaign limit атомарен;
- inactive/not-started/expired/unknown code отклоняется;
- disable/archive не отзывает уже выданный access;
- использованный promo не hard-delete;
- массовый revoke — отдельная OWNER operation.

## 6. Device issuance

Device issuance обязана:

1. проверить текущий entitlement под lock/transaction;
2. проверить device limit;
3. создать ровно один Device при idempotent request;
4. выпустить secret subscription token;
5. выбрать bounded eligible assignment согласно operations policy;
6. создать grants/desired state/outbox только для выбранных routes;
7. полностью откатиться, если operation не может завершиться безопасно.

Если ни в одном обязательном pool нет eligible `SERVING` route, Device/token не создаются и slot не расходуется.

Concurrent replay не занимает второй slot.

`REVOKED` Device не восстанавливается.

Device revoke:

- затрагивает только выбранный Device;
- отзывает его subscription capability/credentials;
- инициирует desired-state update для затронутых нод;
- не отнимает access у других Devices.

## 7. Subscription feed

`GET /sub/:token` является device capability endpoint.

Инварианты:

- token проверяется server-side;
- response не кэшируется публично; используется private/no-store semantics;
- полный URL/token не логируется;
- renderer выдаёт только supported confirmed profiles;
- feed содержит только assigned + converged usable routes;
- internal inventory не раскрывается;
- route replacement не меняет subscription URL;
- expired/revoked entitlement -> authorization failure;
- valid entitlement без usable route -> service availability failure.

Client-instance binding выполняется только по подтверждённому стабильному Happ identifier. IP/User-Agent/device model не являются identity substitute.

## 8. Desired state, outbox и queue

PostgreSQL содержит authoritative desired/business state.

Transactional outbox:

- event пишется вместе с business mutation;
- publisher может безопасно повторять delivery;
- queue job id/idempotency не создают второй semantic command.

BullMQ — transport, не authoritative history.

Worker:

- публикует outbox;
- обрабатывает bounded retry;
- materializes expiry;
- выполняет reconciliation текущего desired state;
- не раздаёт grants всему inventory;
- не выдаёт grants `STANDBY` только потому, что нода healthy;
- не отзывает existing grants только из-за `DRAINING`/`DISABLED`.

Reconciliation восстанавливает текущую истину, а не replay-ит устаревшее решение.

## 9. Node sync contract

Состояния нужно различать:

- desired configuration существует;
- job доставлена;
- node-agent получил snapshot;
- config applied;
- serving verification выполнена;
- acknowledgement сохранён.

`NodeSyncJob.SUCCEEDED` не означает, что Xray реально применил config.

Authoritative доказательство применения — валидный `NodeConfigAcknowledgement` для ожидаемой monotonic version/content.

Снапшот передаёт `expiresAt`, и production-нода прекращает истёкший доступ локально даже при недоступном control plane. Revoke/expiry должен быть применён и подтверждён на `HEALTHY`, `DRAINING` и доступных `DISABLED`-нодах не позднее 5 минут; недоступная нода не возвращается в serving до reconciliation.

Node-agent:

- pull-модель;
- не принимает downgrade;
- одинаковая version с другим content отклоняется;
- сохраняет local lifecycle state атомарно;
- повторяет acknowledgement после network failure идемпотентно;
- не логирует credentials;
- production adapter отдельно от simulation/local-xray.

## 10. Assignment и convergence

User grants создаются только для bounded assignment.

- generic healthy node не получает access всех пользователей;
- `STANDBY` не получает обычные grants до promotion;
- assignment детерминирован/sticky в рамках operations policy;
- route попадает в feed только после требуемого convergence;
- partial node failure не скрывает уже готовые routes других assigned nodes;
- promotion/replacement пересчитывает только affected assignment.

Operations details: `vpn-operations-spec.md`.

## 11. Plan version и device-limit transition

Order хранит immutable plan snapshot.

Если следующий interval уменьшает device limit:

- explicit retained-device selection требуется до перехода;
- система не выбирает Devices автоматически;
- selection валидируется транзакционно;
- на boundary невыбранные active Devices revoke;
- already revoked selected Device не заменяется;
- future entitlement, который ожидает selection, не считается active entitlement.

## 12. Logging и secrets

Запрещено писать в logs/errors/analytics/audit payload:

- полный subscription URL/token;
- raw promo secret;
- VPN/client credential;
- bot/node/probe credential;
- admin 2FA secret/recovery material;
- raw Happ client identifier.

Логи структурированы и содержат безопасные IDs/status/reason codes.

## 13. API/contracts

OpenAPI и shared contracts являются executable interface source. Markdown не копирует полный endpoint catalog.

При изменении API:

- обновляются contracts/OpenAPI;
- добавляются/обновляются tests;
- backward compatibility рассматривается явно;
- speculative provider-specific payment payload не публикуется до выбора provider.

## 14. Testing obligations

Вместо ручного списка каждого test case обязательны классы доказательств:

### Auth/security
- success + deny path;
- replay/concurrency;
- fail-closed rate limiting для externally exposed auth, trial/promo/order и subscription operations;
- missing/wrong credential;
- privilege boundary;
- secret leakage.

### Entitlement/device
- activation/expiry/renewal;
- concurrent idempotency;
- device limit;
- revoke isolation;
- future lower-limit selection;
- refund/chargeback source isolation.

### Orchestration
- outbox atomicity;
- lease/retry fencing;
- stale/replayed command rejection;
- desired/apply/ack distinction;
- reconciliation after crash;
- partial node convergence.

### Operations integration
- bounded assignment;
- standby exclusion;
- drain/disable/quarantine semantics;
- promotion/replacement;
- health/capacity policy boundaries.

### Release evidence
- Android/iOS real Happ;
- target-network blocking/filtering;
- production-like deployment;
- backup/restore.

Точные executable scenarios живут в test suite и release checklist.

## 15. Definition of Done

Application change считается завершённой, когда:

- behavior имеет owner-spec;
- input/access validation присутствует;
- transaction/idempotency определены для concurrent path;
- migration добавлена при schema change;
- main и error tests существуют;
- contracts/OpenAPI синхронизированы;
- secrets не раскрываются;
- CI затронутого scope проходит;
- docs обновлены только там, где реально изменилось требование.

Новая architecture/foundation работа допустима только если она напрямую закрывает текущий milestone/release gate из `project-status.md`.
