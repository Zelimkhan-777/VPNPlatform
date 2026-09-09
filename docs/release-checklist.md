# Closed beta release checklist

Этот файл содержит только release gates. Архитектурные правила принадлежат owner-spec документам.

## Repository

- [ ] `main` зелёный.
- [ ] clean DB migrations проходят.
- [ ] typecheck, lint, unit/integration, OpenAPI, build и image smoke проходят.
- [ ] release images immutable и привязаны к проверенному commit/digest.

## Platform deployment

- [ ] control plane работает на отдельном production VPS, а не зависит от операторского ноутбука;
- [ ] DNS/TLS/public origins проверены;
- [ ] production secrets загружены вне Git;
- [ ] production preflight проходит fail-closed;
- [ ] encrypted backup создан;
- [ ] restore drill реально выполнен.

## VPN data plane

- [ ] минимум два реальных usable routes;
- [ ] node-agent/Xray apply + acknowledgement подтверждены;
- [ ] DRAINING/DISABLED/QUARANTINED поведение проверено;
- [ ] standby promotion либо безопасная ручная recovery-процедура проверена;
- [ ] route replacement работает без нового subscription URL.

## Happ / mobile

- [ ] HTTPS subscription импортируется в актуальном Happ Android;
- [ ] HTTPS subscription импортируется в актуальном Happ iOS;
- [ ] tunnel передаёт реальный тестовый трафик;
- [ ] refresh того же URL добавляет replacement route;
- [ ] refresh удаляет исключённый route;
- [ ] фактическое auto-refresh/manual-refresh поведение зафиксировано;
- [ ] реальные Happ request headers/HWID/client-instance semantics зафиксированы;
- [ ] правило one URL -> one client instance либо подтверждено, либо оформлено как явное product limitation.

## Blocking/filtering acceptance

Для closed beta:

- [ ] два целевых мобильных оператора;
- [ ] один fixed ISP;
- [ ] минимум два региона;
- [ ] Android и iOS;
- [ ] evidence хранит source/time/profile/endpoint/result;
- [ ] одна смена публичного IP не считается достаточным доказательством.

Более широкий public-release gate не блокирует старт закрытой beta.

## Entitlement

- [ ] payment/trial/promo не обходят entitlement rules;
- [ ] expiry реально отбирает доступ в заявленный SLA;
- [ ] revoke одного Device не затрагивает остальные;
- [ ] replay/concurrency не создают второй entitlement/device;
- [ ] subscription URL/credentials отсутствуют в логах.

## Telegram / cabinet

- [ ] новый пользователь без entitlement не получает кабинет;
- [ ] bot-mediated login работает end-to-end;
- [ ] challenge/replay/origin protections проверены;
- [ ] logout/revoke ведут себя ожидаемо;
- [ ] CUSTOMER не имеет admin access.

## Payment gate

До реальных платных пользователей:

- [ ] выбран provider;
- [ ] категория услуги подтверждена provider-ом;
- [ ] sandbox integration проверена;
- [ ] webhook signature/status verification реализованы по официальному контракту;
- [ ] idempotency проверена;
- [ ] refund/chargeback flow проверен;
- [ ] чек/налоговый процесс согласован;
- [ ] публичные legal/product тексты готовы.

## Operational readiness

- [ ] OWNER видит node/pool health и incidents;
- [ ] есть ручная процедура вывода деградировавшей ноды;
- [ ] есть promotion/replacement procedure;
- [ ] есть rollback/last-known-good path;
- [ ] критичные действия имеют audit;
- [ ] provider/credential recovery documented.

## Финальный критерий

Closed beta готова только когда North Star E2E из `project-status.md` проходит на реальном mobile client и production-like infrastructure без ручного изменения кода во время сценария.
