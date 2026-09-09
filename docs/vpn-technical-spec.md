# Infrastructure specification

## Document authority

Источник истины для:

- production placement;
- Docker/release/deployment;
- DNS/TLS/network boundaries;
- secrets;
- backups/restore;
- host hardening;
- observability;
- infrastructure automation.

Node lifecycle, pools, health/capacity и failover принадлежат `vpn-operations-spec.md`. Application/auth/outbox — `vpn-application-implementation-tz.md`.

Историческая pre-consolidation версия: `archive/vpn-technical-spec-pre-consolidation-2026-09-09.md`.

## 1. Целевая схема

Разделяются:

### Platform/control plane

- API;
- web;
- bot;
- worker;
- PostgreSQL;
- Redis;
- reverse proxy/TLS;
- monitoring/backup support.

Platform production не должен зависеть от операторского ноутбука.

### VPN data plane

Отдельные VPS:

- Xray;
- node-agent;
- TLS/runtime config;
- минимально необходимая observability.

Control plane и data plane имеют независимые failure domains и credentials.

## 2. Production deployment

Production deployment должен быть versioned и reproducible.

- application images публикуются отдельно от обычного dev push;
- deploy использует immutable digest/tag policy;
- production host не собирает произвольный код из рабочей директории;
- release artifact связан с конкретным commit;
- rollback возвращает заранее известный last-known-good artifact;
- local simulation/local-xray не используются как production mode.

Deployment automation должна быть идемпотентной и fail-closed на missing mandatory configuration.

## 3. Platform host baseline

Минимум:

- supported Ubuntu LTS;
- отдельный non-root operator user;
- SSH key auth;
- root/password login отключены после проверки доступа;
- firewall default deny incoming;
- открыты только необходимые public service ports;
- security updates и clock synchronization;
- Docker/Compose из контролируемого installation path;
- secrets/runtime data вне Git.

Host bootstrap не должен удалять пользовательские данные или произвольно менять firewall/SSH без явной процедуры.

## 4. DNS и TLS

Public production origins используют HTTPS.

- DNS records проверяются до deployment switch;
- certificate issuance/renewal автоматизированы;
- private/internal credentials не попадают в certificate hooks/logs;
- production app origins валидируются строго;
- localhost HTTP допустим только для dev/test;
- SNI/public endpoint изменения выполняются как versioned migration, а не скрытая ручная правка.

## 5. Containers

Минимальные production services определяются текущим compose/deployment code. Этот документ не дублирует полный compose manifest.

Обязательные свойства:

- restart policy;
- health/readiness checks;
- resource/log limits там, где это требуется;
- persistent volumes только для stateful components;
- no secrets baked into image;
- least-privilege runtime;
- predictable network names/ports;
- immutable application images.

## 6. Secrets

Запрещено хранить в Git:

- production DB/Redis credentials;
- Telegram bot secret;
- auth/session peppers;
- subscription token pepper;
- node/probe credentials;
- TLS private keys;
- VPN client credentials;
- admin 2FA/KEK material;
- backup encryption keys.

Production startup должен fail-closed при missing/invalid mandatory secret.

Секреты не передаются в command line там, где они могут попасть в process list/history, если доступен безопасный env/file/secret mechanism.

Rotation выполняется контролируемо и не создаёт необоснованный период совместного действия старого и нового credential.

## 7. PostgreSQL и Redis

PostgreSQL — authoritative state.

Требования:

- persistent storage;
- migrations до application start по контролируемой процедуре;
- backup;
- restore test;
- connection limits/timeouts;
- monitoring disk/availability.

Redis не является единственным хранилищем authoritative business state. Потеря Redis может нарушить queue/rate-limit/readiness, но не должна сама по себе переписать entitlement/node truth.

## 8. Backups

Backup считается operationally готовым только если:

1. создаётся автоматически/повторяемо;
2. шифруется;
3. имеет retention policy;
4. можно идентифицировать source/version/time;
5. restore выполняется в изолированное окружение;
6. restore drill реально проходит;
7. результат drill фиксируется как release evidence.

Наличие backup-файла без проверенного restore не закрывает release gate.

## 9. Observability

Нужно видеть минимум:

### Platform
- liveness/readiness;
- API errors/latency;
- DB/Redis availability;
- worker queue health;
- failed orchestration jobs;
- bot health;
- disk/resources.

### VPN node
- heartbeat;
- node-agent status;
- Xray/runtime health;
- applied/ack version;
- external probe evidence;
- capacity metrics;
- TLS expiry.

Logs не содержат secrets, subscription URLs или raw client identifiers.

Operational interpretation health evidence принадлежит `vpn-operations-spec.md`.

## 10. VPN node bootstrap

Новая VPN-нода проходит controlled provisioning:

1. базовый OS/security setup;
2. clock sync;
3. Xray/node-agent installation;
4. TLS/runtime configuration;
5. provisional enrollment;
6. serving verification;
7. credential finalization;
8. health/probe validation;
9. только после этого eligibility для pool role.

Interrupted provisioning не должен автоматически делать ноду SERVING.

Bootstrap secrets одноразовые/ограниченные и не дают обычный user access.

## 11. Network exposure

- PostgreSQL/Redis не публикуются в Internet без отдельной необходимости и защиты.
- Node-agent pull/API communication использует authenticated HTTPS.
- Public API exposure ограничено требуемыми endpoints.
- Admin surface не открывается как unauthenticated public control plane.
- Firewall rules versioned/documented.
- Emergency access не превращается в постоянный broad allow.

## 12. Production changes

Запрещено использовать как обычный способ управления:

- ручное редактирование generated Xray runtime config;
- SSH shell из admin UI;
- arbitrary remote commands из API;
- ручное изменение DB state вместо application operation;
- mutable image replacement под тем же release identity.

Break-glass procedure допускается только отдельно, с reason/evidence и последующим reconciliation.

## 13. Capacity и scaling

Scaling выполняется по наблюдаемой нагрузке и operational policy, а не заранее ради архитектурной красоты.

До closed beta не требуется:

- Kubernetes;
- multi-region control plane;
- service mesh;
- automatic VPS purchasing;
- сложная global traffic orchestration.

Добавление infrastructure layer требует конкретного измеренного bottleneck или release requirement.

## 14. Disaster scenarios

Обязательные runbooks/evidence:

- Platform host restart;
- PostgreSQL restore;
- Redis loss/restart;
- failed deployment rollback;
- VPN node unavailable;
- TLS renewal failure;
- node credential compromise/rotation;
- provider/VPS loss.

Node replacement/failover semantics описываются в operations spec.

## 15. Closed beta infrastructure gate

Перед beta:

- production Platform VPS готов;
- DNS/TLS verified;
- secrets loaded safely;
- clean deploy reproducible;
- application images smoke-tested;
- backup + restore drill passed;
- минимум два usable VPN routes;
- node-agent apply/ack evidence;
- monitoring/incident visibility;
- rollback procedure verified.

Полный список: `release-checklist.md`.

## 16. Scope freeze

До завершения documentation consolidation и green `main` новые infrastructure layers не добавляются. После разморозки infrastructure work допустима только для закрытия конкретного release gate или доказанного bottleneck.
