# Operations specification

## Document authority

Источник истины для lifecycle VPN-нод, location pools, health/capacity policy, probes, incidents, repair operations, reserve и promotion. Infrastructure/deployment описаны в `vpn-technical-spec.md`, application/auth/transaction semantics — в `vpn-application-implementation-tz.md`.

## 1. Модель

Различаются `InfrastructureProvider -> Node -> Endpoint -> ConnectionProfile -> Probe evidence`. Lifecycle ноды, pool role, runtime health, route availability, capacity и desired/applied convergence — независимые измерения.

## 2. Lifecycle ноды

- `DRAINING`: новые назначения запрещены; существующий доступ сам по себе не отзывается.
- `DISABLED`: нода исключена из новой выдачи; существующие grants не отзываются автоматически.
- `QUARANTINED`: аварийное исключение из feed с остановкой VPN-serving и emergency revoke-all; возврат только через явную recovery operation после readiness/convergence checks.
- retirement выполняется отдельно и с audit; история grants/incidents сохраняется.
- изменение public endpoint/TLS identity/immutable profile выполняется через новый проверенный endpoint/profile, а не скрытым редактированием существующего.

## 3. Location pools

- Pool может содержать 0, 1 или несколько нод.
- Membership role: `SERVING` или `STANDBY`.
- Пользователь не получает весь inventory.
- Feed возвращает bounded персональный candidate set.
- Выбор остаётся deterministic/sticky при неизменных policy/health.
- Eligible set исключает draining, standby, unhealthy/blocked, unconverged и capacity-exhausted routes.
- Отсутствие eligible route скрывает только затронутую локацию и создаёт operational signal.

## 4. Тёплый резерв

`STANDBY` считается резервом только если заранее provisioned, имеет актуальный runtime/TLS/node-agent, проходит probes и имеет подтверждённую capacity. Для closed beta должен существовать хотя бы один usable replacement вне failure domain заменяемой ноды. Обычные user grants до promotion не выдаются.

Capacity рассчитывается по connections и throughput отдельно. Текущие численные пороги принадлежат versioned policy, а не этому документу.

## 5. Health evidence

Используются heartbeat/runtime evidence, serving verification, authenticated external probes, mobile/staging evidence и capacity metrics.

Инварианты:

- stale/отсутствующее evidence не считается успехом;
- один transient failure не должен немедленно менять feed;
- replay/out-of-order evidence не переопределяет более свежее;
- `UNKNOWN` и `MIXED` не превращаются автоматически в `BLOCKED`;
- security-critical trust failure может требовать немедленного fail-closed;
- decision сохраняет policy version.

## 6. Health/capacity policy

Policy immutable/versioned. Degradation требует устойчивого подтверждения, recovery — серии успешных evidence и cooldown. Краткий capacity spike не приводит к мгновенному stop-assignment; unknown/stale capacity не считается нулевой нагрузкой. Override ограничен по времени и пишется в audit.

## 7. Blocking/filtering

Automatic blocking decision использует authenticated fresh evidence и quorum. Один источник не должен единолично давать общий `BLOCKED`, если это явно не определено security policy.

`PARTIALLY_BLOCKED` не персонализируется по IP/ISP без отдельно проверенной privacy-safe client capability. До этого проблемный route исключается из общей новой/обновлённой выдачи.

## 8. Promotion

Promotion `STANDBY -> SERVING`:

1. повторно проверяет readiness/health/capacity;
2. атомарно меняет role;
3. пересчитывает только affected bounded assignments;
4. создаёт необходимые grants/jobs/outbox;
5. ждёт convergence;
6. получает `SUCCEEDED` только после доказанного usable replacement.

Replay идемпотентен. Timeout/terminal failure дают FAILED/partial result и не отзывают рабочий старый route без отдельной emergency/security причины.

## 9. Planned drain и migration

Обычная замена A -> C:

1. C provisioned и проверена;
2. C вводится в serving/canary;
3. A перестаёт получать новые назначения;
4. обновлённые feed переходят на replacement routes;
5. существующие соединения A не рвутся самим фактом `DRAINING`;
6. после grace/convergence выполняется controlled revoke/retirement;
7. история A сохраняется.

Emergency zero-grace — отдельная операция повышенного риска.

## 10. Incidents и repair operations

Incident фиксирует evidence, scope, impact, mitigation и result. Repair operation имеет permission, idempotency, preview/step-up для опасных действий, bounded retry, terminal result и audit.

Допустимые классы: recheck, retry delivery, reconcile, apply last known good, drain, promote standby, rotate agent credential. Arbitrary shell/raw Xray payload через admin API не допускается.

## 11. Subscription convergence

- Feed содержит только assigned + converged usable routes.
- Generic healthy inventory сам по себе не означает grant пользователю.
- `DRAINING`/`DISABLED` не отзывают существующий grant автоматически.
- `QUARANTINED` идёт по отдельному emergency path.
- Route replacement не меняет device subscription URL.
- Валидный entitlement без usable routes — availability failure, а не unauthorized.
- Expired/revoked entitlement — authorization failure.

## 12. OWNER panel

Панель показывает nodes/pools/providers, lifecycle и pool role, health/capacity evidence, desired/applied/convergence, incidents, repair operations и audit trail.

Для closed beta допустим ручной OWNER promotion готового резерва. Полная автономная self-healing система не является обязательным условием запуска.
