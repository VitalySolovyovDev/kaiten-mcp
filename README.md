# Kaiten MCP Tools

MCP-сервер для чтения карточек, пространств, досок, обсуждений, документов, справочников и учёта времени Kaiten, с получением оригиналов вложений для анализа агентом.

Node.js **22.15+**, TypeScript, транспорт **stdio**. Работает с любым совместимым MCP-клиентом. Все запросы к Kaiten и файловым серверам выполняются через GET. Сервер не создаёт, не изменяет и не удаляет данные Kaiten.

## Первый запуск

1. Установите Node.js 22.15+ (поддерживаются Node.js 22 и 24).
2. Создайте API-токен в настройках профиля Kaiten, раздел интеграций/API. Доступность токенов и данных зависит от настроек вашей организации. [Документация авторизации](https://developers.kaiten.ru/).
3. Добавьте сервер в конфигурацию MCP-клиента. Укажите полный адрес вашего экземпляра Kaiten и **один** источник токена. Публичный пакет: [npm](https://www.npmjs.com/package/kaiten-mcp-tools), код: [GitHub](https://github.com/VitalySolovyovDev/kaiten-mcp-tools).

Пример для Claude Desktop (`claude_desktop_config.json`) и Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "kaiten-mcp-tools": {
      "command": "npx",
      "args": ["-y", "kaiten-mcp-tools@0.2.0"],
      "env": {
        "KAITEN_BASE_URL": "https://tasks.company.example",
        "KAITEN_API_TOKEN_FILE": "C:/Users/you/secrets/kaiten.token"
      }
    }
  }
}
```

Файл токена содержит только токен, допускаются BOM и завершающий перевод строки. Ограничьте доступ к файлу средствами ОС. Вместо `KAITEN_API_TOKEN_FILE` можно использовать `KAITEN_API_TOKEN`. Не храните секреты в репозитории и не передавайте их в аргументах команд. На Windows, если клиент не находит `npx`, укажите полный путь к `npx.cmd` либо используйте установленный пакет через `node` и полный путь к `dist/cli.js`.

Пример для Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kaiten-mcp-tools]
command = "npx"
args = ["-y", "kaiten-mcp-tools@0.2.0"]

[mcp_servers.kaiten-mcp-tools.env]
KAITEN_BASE_URL = "https://tasks.company.example"
KAITEN_API_TOKEN_FILE = "C:/Users/you/secrets/kaiten.token"
```

Перезапустите клиент или обновите соединение MCP. Попросите агента вызвать `get_current_user`, затем `get_card` по ссылке. При запуске сервера вручную он ожидает MCP-сообщения в stdin; отсутствие текста в терминале нормально. Помощь и версия доступны без токена:

```sh
npx -y kaiten-mcp-tools@0.2.0 --help
npx -y kaiten-mcp-tools@0.2.0 --version
```

Офлайн после установки: `npm install -g kaiten-mcp-tools@0.2.0`, затем задайте клиенту команду `kaiten-mcp-tools`. Зависимости публикуются с `npm-shrinkwrap.json`; интерактивных шагов установки нет.

## Настройки

- `KAITEN_BASE_URL` — обязательный полный URL, например `https://tasks.company.example` или `https://company.kaiten.ru`. Поддерживается путь развёртывания. Суффикс домена не добавляется.
- `KAITEN_API_TOKEN` **либо** `KAITEN_API_TOKEN_FILE` — Bearer-токен, ровно один источник.
- `NODE_EXTRA_CA_CERTS` — путь к PEM корпоративного центра сертификации. Задайте до запуска Node.js. Проверка TLS сохраняется.
- `KAITEN_TIMEOUT_MS` — таймаут одного запроса, по умолчанию `30000`. Временные сетевые ошибки, 429 и отдельные 5xx повторяются не более двух раз; длинный cooldown возвращается как ошибка для последующего повтора агентом.
- `KAITEN_MAX_FILE_BYTES` — максимальный размер оригинала и ответа API, по умолчанию `20971520` (20 MiB).
- `KAITEN_MAX_TEXT_CHARS` — бюджет текстовых полей ответа, по умолчанию `20000`, минимум 2 для сохранения Unicode. Служебные идентификаторы, ссылки и JSON-оболочка не обрезаются.
- `KAITEN_CACHE_TTL_MS` — кеш справочников и структурных метаданных, по умолчанию `60000`; `0` отключает кеш. Карточки, комментарии, спринты, учёт времени и файлы читаются свежими. Ошибки не кешируются.
- `KAITEN_DOWNLOAD_DIR` — каталог оригиналов, по умолчанию `kaiten-mcp-tools` в системном temp. Файлы имеют безопасные уникальные имена и записываются атомарно; после выхода сервера сохраняются. Очистку выполняет пользователь или ОС.
- `KAITEN_ATTACHMENT_ALLOWED_HOSTS` — точные имена дополнительных приватных файловых серверов через запятую. Публичные файловые хосты разрешены; приватные адреса требуют явного разрешения, кроме настроенного экземпляра Kaiten. Bearer-токен туда не передаётся.
- `KAITEN_ALLOW_HTTP=true` — явное разрешение HTTP для внутренней установки/локальных тестов. Для обычной настройки используйте HTTPS.

Один процесс обслуживает один экземпляр Kaiten и один источник токена.

## Инструменты

Доступны 37 отдельных инструмента. Для операций карточки передавайте **ровно один** параметр: `url` или положительный целочисленный `card_id`. Поддерживаются ссылки `/{id}`, `/c/{id}`, `/space/{space_id}/card/{id}` и `/space/{space_id}/boards/card/{id}`. Адрес должен совпадать с настроенным Kaiten; query и fragment не влияют на ID.

- Карточки: `get_card`, `search_cards`, `list_space_cards`, `list_board_cards`, `get_card_location_history`, `list_subtasks`.
- Обсуждения: `get_card_comments`, `get_checklist`, `list_card_members`, `list_card_blockers`, `list_card_external_links`, `list_card_tags`.
- Структура: `list_spaces`, `get_space`, `list_boards`, `get_board`, `list_columns`, `list_subcolumns`, `list_lanes`, `list_card_types`, `list_space_users`.
- Пользователи и справочники: `get_current_user`, `list_users`, `list_company_roles`, `list_workspace_tags`, `list_custom_properties`, `list_custom_property_select_values`.
- Спринты: `list_sprints`, `get_sprint`. Kaiten помечает эти маршруты как deprecated; доступ зависит от версии и прав.
- Учёт времени: `get_user_timelogs`, `get_card_timelogs`, `get_timesheet`.
- Документы: `get_document`, `get_document_group`, `list_document_children`.
- Оригиналы файлов: `list_attachments`, `download_attachment`.

Аргументы каждого инструмента объявлены в MCP input schema. Результат содержит `structuredContent` и такой же JSON в текстовом content. Сущности находятся в `item`, списки — в `items`. Списки по умолчанию `detail: "summary"`, сущности — `"full"`; объём можно выбрать явно. Отсутствующие поля остаются отсутствующими.

`get_card` получает карточку напрямую и не загружает историю комментариев. `description_format` имеет значение `unknown`, если API не указал формат описания; для известных форматов возвращается `markdown` или `html`. Доски/пространства не используются для получения карточек; применяются отдельные маршруты с актуальной пагинацией. `get_checklist` требует `checklist_id` и проверяет принадлежность карточке. Ошибка отдельных метаданных файла перечисляется в `attachment_warnings` и не скрывает текст карточки или комментария.

### Документы Kaiten

Документы раздела Documents читаются отдельно от файловых вложений:

- `get_document`: ровно один из `url` вида `/documents/d/UID` и `document_uid`. По умолчанию возвращает только метаданные, `content_available` и `content_included: false`.
- `get_document_group`: ровно один из `url` вида `/documents/g/UID` и `document_group_uid`. Возвращает метаданные группы.
- `list_document_children`: ровно один из `url` документа/группы и `parent_entity_uid`. Возвращает страницу непосредственных дочерних документов и групп. Автоматического рекурсивного обхода нет.

Адреса проверяются по настроенному экземпляру Kaiten, включая корпоративный домен и префикс пути. Текст документа запрашивается явно:

```json
{"url":"https://example.kaiten.ru/documents/d/11111111-1111-4111-8111-111111111111","include_content":true,"format":"text"}
```

Текст находится в `item.content`. Для исходной структуры задайте `format: "prosemirror"`: поддерживаются объект ProseMirror и его JSON-строка в API Kaiten. Текстовое представление сохраняет абзацы, списки, ячейки таблиц и ссылки; сложные узлы и их атрибуты доступны в ProseMirror. Длинный текст и массивы читаются через обычные `text_offsets`/`section_offsets` и `continuation`. Для содержимого используйте `detail: "full"` (по умолчанию).

Чтобы только проверить доступность, оставьте `include_content: false`: MCP не возвращает тело документа. API Kaiten может включить `data` в свой GET-ответ; сервер исключает его из ответа MCP. Документы читаются свежими; группы и списки дочерних элементов используют кеш структурных метаданных. Ссылки, изображения и файлы внутри документа автоматически не загружаются и не исполняются.

### Фильтры и страницы

Все списки: `limit` по умолчанию 50, максимум 100; `offset` по умолчанию 0. Продолжайте с `next_offset`, пока он не станет `null`. При полной последней странице возможен ещё один пустой запрос. Передавайте `page_fingerprint` предыдущей страницы в `previous_page`: повтор страницы будет явной ошибкой. У непагинируемых маршрутов MCP применяет локальные страницы (`pagination: "local"`) к полному ответу API; это ограничивает ответ агенту, но не исходный запрос.

Поиск: `query`, `search_fields`, `space_id`, `board_id`, `column_id`, `lane_id`, `owner_id`, `responsible_id`, `type_id`; массивы `owner_ids`, `member_ids`, `responsible_ids`, `type_ids`, `tag_ids`, `column_ids`, `states` (1/2/3). Поддерживаются `exclude_board_ids`, `exclude_lane_ids`, `exclude_column_ids`, `condition` (1/2/3), `archived`, `asap`, `overdue`, `done_on_time`, `with_due_date`. Даты ISO8601 с часовым поясом: `created_after/before`, `updated_after/before`, `due_date_after/before`, `first_moved_in_progress_after/before`, `last_moved_to_done_at_after/before`. Сортировка: `order_by` (поля через запятую), `order_direction: "asc" | "desc"`. Не передавайте `search_fields` без `query`. Пустые массивы фильтров не отправляются в Kaiten. Полный поиск запрашивает описание отдельным параметром API.

Учёт времени: `from` и `to` в `YYYY-MM-DD`, включительно. Для `get_user_timelogs` и `get_timesheet` обязательны; для `get_card_timelogs` опциональны парой и фильтруются локально по `for_date`. Карточный маршрут также принимает `for_date` и `personal`. Timesheet поддерживает массивы `card_ids`, `user_ids`, `group_ids`, `space_ids`, `board_ids`, `column_ids`, `tag_ids`, `visible_column_ids`; `condition`, `group_by` (0 без групп, 1 пользователи, 2 карточки), `time_precision`, `time_unit`, `with_daily_distribution` и `only_general_sum` (0/1). Итоги оболочки API сохраняются в `metadata`; единицы измерения определяются запрошенными параметрами Kaiten.

### Длинный текст и вложенные разделы

JSON никогда не обрезается. `continuation` указывает путь RFC6901, тип (`text`/`section`), текущий offset, total и `next_offset`. Для текста повторите тот же инструмент, фильтры и страницу, передав весь `next_text_offsets` как `text_offsets`. Это позволяет дочитать даже несколько длинных полей с общим бюджетом. Новые фрагменты добавляйте к прежним; завершённые поля при продолжении будут пустыми. Для вложенного массива передайте его путь и `next_offset` в `section_offsets`. В одном разделе возвращается до 100 элементов. Изменение исходных данных между запросами может потребовать повторного чтения; это не snapshot API.

### Вложения

`list_attachments` перечисляет файлы карточки и **одну выбранную страницу** комментариев: `include_comments` (по умолчанию true), `comments_offset` (0), `comments_limit` (50, максимум 100). Следуйте `comments_next_offset`, передавая `comments_page_fingerprint` как `comments_previous_page` для проверки повторов; `next_offset` относится к файлам выбранных страниц. Файлы при перечислении не скачиваются. Указаны источник, ID, имя, MIME/размер при наличии и `resource_uri`. Неизвестное имя файла возвращается как `null`; безопасное имя локального файла создаётся отдельно.

Пользователь выбирает файлы в диалоге с агентом. `download_attachment` с `attachment_id` скачивает только выбранный оригинал, проверив его принадлежность карточке или доступным комментариям; поиск файла комментария может потребовать чтения страниц. Результат: абсолютный `path`, `name`, `mime_type`, `size`, `sha256`, `resource_uri`. Сервер работает на компьютере MCP-клиента; в удалённой среде путь относится к хосту сервера.

Клиенты без доступа к этому пути читают MCP resource `kaiten://cards/{card_id}/attachments/{attachment_id}`: оригинальные байты в base64. Resources также скачиваются только по запросу. Поддержаны старые и защищённые файлы с временными ссылками; токен не передаётся файловым хостам и по перенаправлениям. Облачные документы возвращаются как `external_url`, а попытка скачать их объясняет необходимость отдельной авторизации.

Форматы не интерпретируются. PDF, изображения, архивы, Office-документы и зашифрованные файлы передаются без изменений. Для чтения содержимого агенту нужны собственные инструменты файловой системы, PDF/Office/изображений. Сервер не выполняет OCR, макросы, формулы или инструкции из файлов и не скачивает все вложения автоматически.

## Диагностика

Ошибки инструментов имеют `isError: true` и `error.code/message/status` в structuredContent. `UNAUTHORIZED` — токен; `FORBIDDEN` — права; `NOT_FOUND` — отсутствующая сущность; `UNSUPPORTED_ROUTE` — 405/410/501; `API_RESPONSE_INVALID` — несовместимая структура/JSON; `PARENT_MISMATCH` — чужой чек-лист/файл; `PAGINATION_INVALID` — повтор/нарушение страниц; `FILE_TOO_LARGE` — лимит; `EXTERNAL_ATTACHMENT` — облачная авторизация. HTTP 404 сам по себе не позволяет отличить отключённый маршрут от неизвестного ID: он возвращается как `NOT_FOUND`. Пустой успешный список не заменяет ошибку доступа.

Сервер не пишет секреты и ответы Kaiten в журнал. Диагностика запуска направлена в stderr, stdout используется для MCP. Проверьте, что токен доступен процессу клиента, URL полный, корпоративный PEM задан до запуска и каталог скачивания доступен для записи.

## Разработка и проверка

```sh
npm ci
npm run check
npm run check:lf
npm audit --omit=dev
npm run pack:release
```

Релизный архив собирается командой `npm run pack:release` во временном каталоге: он содержит только production-зависимости в `npm-shrinkwrap.json`, без devDependencies и npm scripts. Рабочий lockfile разработки сохраняется. Сборка очищает только `dist`, чтобы удалённые парсеры не попадали в архив. HTTP-клиент, адаптеры, метаданные файлов и регистрация MCP разделены; зависимости передаются явно. Тесты покрывают все инструменты, GET-only, пагинацию, кеш, ошибки, защищённые оригиналы и настоящий stdio. CI: Windows/Linux, Node.js 22/24. Проверки реального сервиса и их ограничения описаны в [VALIDATION](docs/VALIDATION.md).

MIT License. [English README](README.en.md).
