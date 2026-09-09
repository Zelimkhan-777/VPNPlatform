# AI-agent instructions for VPNPlatform

## Purpose

Этот файл задаёт порядок работы агента с репозиторием. Он не является источником продуктовых или технических требований.

Главная цель — не тащить в контекст весь проект и его историю без необходимости.

## Обязательный порядок чтения

Перед обычной задачей:

1. прочитай `docs/project-status.md`;
2. прочитай **только owner-document текущей задачи**;
3. изучи релевантный код и текущий diff;
4. при необходимости открой `docs/project-decisions.md`;
5. архив и старый journal открывай только когда нужно восстановить происхождение решения или проверить исторический конфликт.

Не читай все ТЗ и весь архив по умолчанию.

## Document ownership

| Категория | Source of truth |
|---|---|
| Текущее состояние / следующий milestone | `docs/project-status.md` |
| Продукт, тарифы, user flows, entitlement UX | `docs/vpn-service-tz.md` |
| Application contracts, auth, transactions, outbox | `docs/vpn-application-implementation-tz.md` |
| Infrastructure, deployment, backups, secrets | `docs/vpn-technical-spec.md` |
| Nodes, pools, health, capacity, incidents, failover | `docs/vpn-operations-spec.md` |
| Устойчивые cross-cutting решения | `docs/project-decisions.md` |
| Closed-beta release gates | `docs/release-checklist.md` |
| Внешняя проверка Happ/эквайринга | `docs/vpn-external-validation-2026-08-09.md` |
| История | `docs/archive/` |

## Правило конфликтов

1. Не выбирай конфликтующее требование молча.
2. Определи категорию и owner-document.
3. Активный owner-document имеет приоритет над архивом и историческим журналом.
4. `project-decisions.md` помогает понять устойчивый cross-cutting intent, но не заменяет owner-spec.
5. Если активные owner-документы конфликтуют между собой — останови расширение scope и сообщи о docs inconsistency.
6. Не придумывай новую архитектуру только чтобы согласовать документы.

## Scope discipline

Текущий milestone и следующий практический шаг всегда бери из `docs/project-status.md`.

Новая работа должна напрямую двигать North Star closed-beta scenario или закрывать release gate. Без отдельного решения не добавляй foundational architecture, новые infrastructure layers или features вне текущего gate.

## Инженерные правила

- Не удаляй и не откатывай незакоммиченные изменения пользователя.
- Перед schema change создавай forward-only migration; уже применённые production migrations не редактируются.
- При API change синхронизируй contracts/OpenAPI/tests.
- Не хардкодь secrets, credentials, prices, device limits, domains или node IDs, если они являются configuration/product data.
- Не меняй production runtime нод вручную в обход зафиксированной operational procedure.
- Секреты, subscription URLs, raw client identifiers и credentials не логируются.
- Security-sensitive ambiguity не разрешается догадкой.
- Queue delivery не считается доказательством apply; authoritative acknowledgement semantics описаны в application/operations specs.

## Документационные изменения

При изменении поведения:

1. обнови **один** owner-document;
2. если меняется устойчивое cross-cutting решение — обнови `project-decisions.md`;
3. если меняется текущий stage/blocker — обнови `project-status.md`;
4. не копируй одно требование в несколько ТЗ;
5. не добавляй запись в исторический journal на каждый commit.

Исторический материал архивируется по этапам, а не используется как второй source of truth.

## Definition of Done

Задача завершена, когда:

- scope не расширен скрытно;
- behavior/security invariants сохранены;
- migration/contracts/tests обновлены при необходимости;
- секреты не раскрываются;
- CI для затронутого scope проходит;
- owner-document обновлён только если реально изменилось требование или поведение.

## Release review

Перед closed beta используется `docs/release-checklist.md` и отдельный read-only review release diff/evidence. Review не заменяет executable tests, production-like deployment, Android/iOS проверки и network acceptance.
