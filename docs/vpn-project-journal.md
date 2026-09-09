# Project change log

## Document authority

Этот файл больше не является полным рабочим журналом и не используется как source of truth.

- Текущее состояние: `project-status.md`
- Активные устойчивые решения: `project-decisions.md`
- Полная история до 2026-09-09: `archive/vpn-project-journal-through-2026-09-09.md`

Цель этого файла — хранить только **короткий rolling log значимых изменений требований/этапа**, которые ещё не были свёрнуты в следующий архивный snapshot.

AI-agent не читает этот файл по умолчанию, если текущая задача не требует свежей истории.

## Правила

Добавлять запись только когда произошло хотя бы одно из следующего:

- изменился product/application/infrastructure/operations contract;
- появился или закрыт release blocker;
- изменился текущий milestone/stage;
- получено важное внешнее validation evidence;
- принято решение, которое нужно затем отразить в owner-spec/project-decisions.

Не добавлять сюда:

- каждый commit;
- обычный refactor;
- перечень изменённых файлов;
- дублирование test output;
- повтор owner-spec текста;
- длинный transcript review.

После стабилизации этапа записи архивируются, а актуальная истина остаётся в owner-docs.

## 2026-09-09 — Documentation consolidation / architecture freeze

Feature-разработка временно заморожена.

Документация разделена на:

- product;
- application;
- infrastructure;
- operations;
- current status;
- durable decisions;
- release checklist;
- archive.

Полные pre-consolidation specs и старый journal сохранены в `docs/archive/`.

Следующий engineering milestone после разморозки — North Star closed-beta E2E из `project-status.md`. Новая foundational architecture до green `main` и закрытия текущих beta gates не добавляется.
