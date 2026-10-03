# Terngram: технический справочник приложения

Этот документ описывает **реализованное native-приложение**, а не веб-интерфейс и не план возможностей Telegram. Источник истины — `terngram/ui/`, `terngram/telegram.py`, `terngram/worker.py` и тесты. Формат TSP, правила native-узлов, событий, blob и ограничения локального SDK вынесены в [tern-api.md](tern-api.md).

## Запуск и границы модулей

`uv run terngram` запускает Python entry point, который находит Bun и установленный `@oh-my-pi/pi-tui`, затем заменяет себя процессом `ui/main.ts`, передав текущий Python и приватный каталог данных. Фронтенд требует интерактивные stdin/stdout и `TERM_PROGRAM=tern`. Hello хоста должен подтвердить TSP v1 и виды `input`/`picker`; неподходящий хост завершает клиент с кодом 2. ANSI fallback отсутствует: `render`, `renderFrame` и ANSI history намеренно выбрасывают ошибку.

| Модуль | Ответственность |
| --- | --- |
| `terngram/__main__.py` | CLI, поиск Bun, пути, запуск frontend тем же Python окружением |
| `ui/main.ts` | ProcessTerminal/TUI, имя и роль поверхности `terngram`, проверка hello, обработка сигналов и EOF |
| `ui/app.ts` | Авторизация, жизненный цикл worker, состояние аккаунта и разговоров, RPC, команды, фокус, overlay, сохранение и защита от устаревших ответов |
| `ui/chat-state.ts` | Сортированная история, ревизии, слияние страниц, альбомы, draft/reply/edit и монотонный исходящий read maximum |
| `ui/chat-navigation.ts` | История посещений назад/вперёд, пять уникальных recent chats, распознавание двойных стрелок без таймеров |
| `ui/chat-dock.ts` | Чистое описание статуса разговора и контекста редактора; без Telegram-вызовов |
| `ui/message-view.ts` | Карточки, стабильные ключи, кеш описаний, подписи и превью |
| `ui/photo-viewer.ts` | Одна фотография альбома, текущая подпись, счётчик, ←/→ и сохранение выбора при обновлении |
| `ui/image-loader.ts` | Дедупликация, ограничение параллелизма и аккаунтная изоляция фоновых изображений |
| `ui/read-receipts.ts` | Монотонные confirmed/requested ID, один read RPC на чат, объединение точных границ, изоляция аккаунтов |
| `ui/reader-counts.ts` | On-demand кеш количества читателей: single-flight, 30-секундный минимум, server retry-after, максимум 256 записей |
| `ui/request-cooldowns.ts` | Монотонные server-directed deadlines по RPC-методу или method+peer, без автоматического retry |
| `terngram/readers.py` | Runtime appConfig, eligibility малых групп/возраста сообщения и GetMessageReadParticipants |
| `ui/command-palette.ts` | Input + SelectList + native SelectListSheet, фильтр, выбор/активация, описание результата |
| `ui/forward-picker.ts` | Получатель пересылки среди загруженных writable-диалогов |
| `ui/shortcut-help.ts` | Отдельная контекстная справка, без Telegram-логики |
| `ui/nodes.ts` | Общие label/button/line/preview, однострочное усечение и доступные имена |
| `ui/telegram.ts` | Типы данных, Bun subprocess, JSON-lines RPC, pending promises и события worker |
| `terngram/worker.py` | Allowlist RPC, диспетчер asyncio, барьер авторизации, безопасные ошибки и shutdown |
| `terngram/telegram.py` | Telethon, разрешение peer, авторизация, диалоги/история/действия/медиа, локальные приватные файлы |
| `terngram/formatting.py` | Telegram entities ↔ Markdown с UTF-16 offsets и защитой литеральных символов |

Общего «движка сущностей» нет: конкретным объектам принадлежат конкретные компоненты и действия. Редкие действия находятся в палитре, текущий контекст — рядом с объектом.

## Поверхность и дерево компонентов

`TerngramApp.describeSurface()` возвращает `main: [Body]`, `dock: [TerngramApp]`. Body кеширует описание до invalidation; изменение текста редактора может обновлять dock без перестройки истории.

```text
native surface: title/role = terngram
├─ main → Body
│  ├─ до входа / подтверждение выхода: title + welcome card
│  └─ chats: col terngram.client
│     ├─ подсказка выбора разговора, если selectedId отсутствует
│     └─ thread-<chat_id> для загруженных/загружаемых разговоров
│        ├─ hidden=true для неактивных разговоров
│        ├─ Load earlier messages / empty / loading
│        ├─ message-<chat_id>-<id> либо album-<chat_id>-<grouped_id>
│        │  ├─ portrait: avatar либо initials badge; selection reveal anchor
│        │  └─ card terngram.message: header, forward, reply, album count,
│        │     inline image previews, md-подписи, View photo(s)
│        └─ tail anchor для повторяемого reveal=end
├─ dock
│  ├─ до входа: native поля, submit/back/quit, spinner, status
│  └─ chats: col terngram.dock
│     ├─ row terngram.conversation-status
│     ├─ row terngram.composer-context
│     ├─ временная notice + Dismiss, если есть status/busy
│     └─ row terngram.composer: native Editor + Send/Save (если writable)
└─ временные overlay
   ├─ CommandPalette: native picker
   ├─ ForwardPicker: native picker
   ├─ ShortcutHelp
   └─ PhotoViewer: terngram.gallery
```

Список чатов, управление сессией и полная справка не занимают постоянное место. Редактор — последний постоянный блок dock; в read-only разговоре его нет. Статус разговора **не заменяется выбранным сообщением**: название, тип, unread, read-only, offline, загрузка/отправка принадлежат разговору. Composer-context содержит выбор сообщения, подтверждение удаления, reply/edit либо обычный ввод. Ошибка — отдельная строка notice, а не подмена объекта.

Однострочные названия/превью имеют полное значение в `title`. `min/max`, `grow/shrink`, wrap и image bounds описывают намерение компоновки; реальную геометрию, zoom и отрисовку определяет хост. `Telegram disconnected` — транспортный статус, **не** online-статус собеседника. Для personal chat отдельно показывается Telegram-provided presence; временные peer actions идут отдельной строкой dock.

Статус также показывает marked Telegram `ID` и количество участников (`members`) либо подписчиков канала (`subscribers`). `chat_info(chat_id)` запрашивается лениво при открытии чата; Ctrl+R обновляет число. Для channel/supergroup используется GetFullChannel, для basic group — GetFullChat; user/bot/saved возвращают null без запроса полного профиля. Недоступное количество не заменяется нулём. Кеш и in-flight identity изолированы аккаунтом.

Верхний закреплённый статус отдельно исследован: NativeSurface не предоставляет header/top-dock. По согласованию с пользователем информация о чате оставлена в текущем нижнем dock; исчезающий при прокрутке заголовок и перекрывающий историю overlay не используются как подмена.

## Сущности и действия

| Сущность | Контекст | Реализованные действия |
| --- | --- | --- |
| Разговор: `user`, `bot`, `group`, `channel`, `saved` | Название, тип, непрочитанные, writable, соединение | Открыть, ранняя история, последние, mark read, refresh |
| Сообщение | Автор, локальное время, Markdown, edited; исходящее sent/read; forward/reply | Выбрать; ответить; переслать; редактировать собственное без фото; запросить удаление собственного; открыть фото |
| Альбом | Общий стабильный ключ, число загруженных элементов, подписи и фото | Одна единица выбора; server-resolved gallery; forward/delete полного альбома |
| Черновик | Текст каждого разговора в одном Editor | Отправить, новая строка, сохранить при переключении |
| Reply/edit | Целевое сообщение, автор/превью, режим | Send/Save; отмена. Cancel edit возвращает исходный draft и прежний reply target |
| Фото / image document | До четырёх превью в карточке; одна полная фотография с подписью в gallery | Click preview, View photo(s), P; ←/→ по альбому; host zoom; Esc/Close |
| Результат палитры | Название, назначение/превью, Current, Draft, unread, доступность | Фильтровать, выбрать без исполнения, активировать |
| Получатель пересылки | Только writable загруженные диалоги | Локальный поиск, forward, cancel |
| Сессия | Аккаунт, соединение, отдельная ошибка | Reconnect; подтверждённый logout; quit без отзыва сессии |
| Справка | Клавиши по контекстам | Ctrl+G / команда, Esc / Ctrl+G закрывает |

Карточка имеет click для выбора и double-click для reply. Незагруженный reply показывается как номер сообщения. Локальная история группирует по `chat_id` и строковому `grouped_id`; это не доказательство полноты группы. Перед полной галереей вызывается `album(chat,id)`. Worker проходит соседнюю **историю peer** в обе стороны до другого grouped_id/края; числовой диапазон ID не используется, поскольку private IDs имеют разрывы. Telegram-альбом ограничен десятью элементами; чужие, недоступные или oversized группы отвергаются. Forward/delete независимо расширяют входные ID до полных альбомов и дедуплицируют их до любого изменения сервера.

## Состояние и время жизни

### Только в памяти

В приложении живут stage (`credentials`, `phone`, `code`, `password`, `chats`, `logout`), account/online/status/error, список диалогов и cursor, selectedId, maps threads/scrolls, detached, lastInput, выбранное сообщение и подтверждение удаления, overlay и возврат фокуса, pending/dedup sets, кеши изображений и описаний. `busy` блокирует авторизацию/reconnect, а не все chat-запросы: история и send не замораживают навигацию и ввод.

Каждый ChatState хранит messages, loaded/loading/more, draft, replyTo, editing snapshot, sending, множество новых входящих, revision и изменения по ID, исходящий read maximum и кеш групп. История, scroll и reply/edit переживают переключение разговора в рамках процесса. Выбор карточки/подтверждение удаления сбрасываются при переключении. Переходы данных защищены `generation`, идентичностью connection/thread и версиями поиска, чтобы поздний ответ старого аккаунта не перезаписал новый.

### На диске

Сохраняются API credentials, Telethon session и `{drafts, selected_id, pending_sends}`. PendingSend содержит текст, reply_to и десятичный random_id незавершённой отправки; он сохраняется **до** сетевого send и восстанавливается после перезапуска. Старый state.json без pending_sends читается с пустой map. Reply/edit обычного черновика, история, scroll, detached, фото и overlay после перезапуска не восстанавливаются. При редактировании сохраняется исходный draft, а не текст edit. Обычные drafts сохраняются с debounce 250 мс и последовательной promise chain; обязательная запись перед send пробрасывает ошибку и не допускает сетевой send при сбое диска. Это локальные черновики, не cloud draft sync.

## Команды и доступность

Без запроса native `picker.order` разделяет последние пять посещённых чатов и остальные чаты/команды заголовками групп. Элементы не дублируются. При непустом текстовом запросе заголовки исчезают: единый поиск по всем доступным элементам, без отдельной секции/метки Recent. `>` ограничивает команды, `@` — чаты. Ctrl+F открывает тот же picker в chats-only режиме. Back/Forward используют сессионную историю посещений, а не порядок диалогов.

| Команда | Когда доступна / эффект |
| --- | --- |
| Back to previous chat / Forward in chat history | В текущей сессионной истории есть доступный предыдущий/следующий чат; используются те же переходы, что у двойных стрелок |
| Keyboard shortcuts | Всегда среди chat-команд; открывает отдельную справку |
| Hide contextual hints / Show contextual hints | Переключатель без хоткея, действует до завершения процесса. Убирает Commands/Keys, обычную строку подсказки редактора, его shortcut-placeholder и Close/zoom hints в gallery; сохраняет данные объектов, reply/edit, ошибки и подтверждения |
| Latest messages | Есть текущий thread; end scroll, выход из detached, acknowledge + mark read |
| Reply | Есть выбранное сообщение, writable, не sending |
| Forward | Есть выбранное сообщение; получатель выбирается отдельным picker |
| View selected photo | Выбранное сообщение имеет `photo` |
| Edit | Выбранное собственное сообщение без фото, не sending |
| Delete… | Выбранное собственное сообщение; отдельное необратимое подтверждение |
| Cancel reply / edit | Есть режим, не sending; сохраняет черновик |
| Refresh | Нет refreshDialogs и загрузки текущей истории |
| Reconnect Telegram | Заново создаёт worker, используя сохранённую сессию |
| Sign out… | Открывает подтверждение; только успешный logout очищает аккаунт |
| Quit | Сохранение и shutdown, без logout |

Палитра открывается только на stage chats, не во время busy и не поверх gallery/forward/help. Disabled строки не выбираются и не активируются; confirm отключён без доступного результата. Native `select` меняет выбор/контекст, `activate` либо confirm исполняет действие. Дополнительные guards в обработчиках блокируют пустой send, send/reply в read-only, повторный send и повторную операцию над тем же сообщением. Ошибки прав/сроков редактирования Telegram остаются ошибками worker; UI не обещает, что каждое собственное сообщение сервер разрешит изменить/удалить.

Поиск по именам **локальный**; сетевой поиск контактов полностью удалён из worker/frontend. Недостающий каталог диалогов догружается последовательными страницами по 60, без отдельного запроса на каждый текст. Одновременные вводы/открытия используют один in-flight page request. Закрытие/очистка запроса останавливает дальнейшую цепочку, уже начатая страница остаётся полезным кешем. Исчерпанный cursor=null не сбрасывается очередным refresh первой страницы. В обычном списке/forward picker следующая страница запрашивается при приближении выбора к последним пяти результатам. Палитра Ctrl+K/Ctrl+F сохраняет `picker.state=ready`: загрузка чатов отмечается в message, а не заменяет готовые результаты скелетоном. Команды и настройки фильтруются сразу, без префикса `>`; `>` только ограничивает поиск командами и скрывает статус загрузки чатов. Forward picker по-прежнему отражает загрузку в picker.state. Older history загружается через ↑ на первом сообщении или кнопку у края transcript; Latest явно подтверждает чтение. Отдельных служебных команд пагинации и read в палитре нет.

### Сетевая дисциплина и инвалидация

- FloodWait/FloodPremiumWait/SlowMode передают `retry_after` и `retry_scope`. `Telegram.call` проверяет общий RequestCooldowns **до** записи RPC в worker: метод для FloodWait, method+peer для SlowMode. Дедлайны монотонные, их нельзя укоротить новым меньшим сроком; они переживают переподключение worker в рамках аккаунта. Logout/смена аккаунта очищает их. Нет фиксированного retry-таймера или автоматической повторной отправки.
- Сам Telethon также не отправляет TL-request с действующим `_flood_waited_requests` по constructor ID. `flood_sleep_threshold=0` оставлен намеренно: UI получает server wait, не скрыто зависает внутри долгого сна.
- `dialog_changed` — targeted update, не периодический refresh всех чатов. Raw name/chat/channel/member/rights updates и служебные сообщения инвалидируют только затронутый peer. Готовое title применяется сразу и меняет локальный поиск без RPC; неизвестное title/права становятся dirty и обновляются по необходимости. Очередь dirty-peer refresh последовательная.
- Version/request-identity guards не дают старому full-info/dialog ответу вернуть прежнее имя или удалить маркер нового запроса. Metadata имена отправителей передаются renderer отдельно: rename не притворяется edit сообщения и не меняет его revision.
- Participant count/full metadata кешируются в worker с single-flight и инвалидируются peer updates; явный Ctrl+R может принудительно обновить их. Own-membership/admin/default-rights changes отдельно помечают permissions_changed. Неизвестная новая группа добавляется после targeted dialog lookup; недоступный dialog удаляется из индекса, чтобы каждое открытие палитры не повторяло бессмысленный запрос.
- Refresh не ставит повторный запрос в очередь от каждого нажатия, а явные Kitty repeats Enter/Esc/refresh/modal hotkeys не исполняют повторное действие. Нет второго refresh из connection callback во время явного reconnect.
- Аватары/превью ставятся в очередь для текущего чата; смена чата отбрасывает ещё не начатую работу старого чата, сохраняя готовый/активный кеш. Полнота уже разрешённого альбома переиспользуется до refresh/reconnect/gap; forward/delete всё равно проверяют актуальный состав на сервере перед изменением.

Ориентиры Desktop: [локальная фильтрация IndexedList](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/dialogs/dialogs_inner_widget.cpp), [отдельный server-search cache](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/dialogs/dialogs_widget.cpp), [peer photo flags](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_peer.cpp), [member-count flags](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_channel.cpp). Это сокращает лишние запросы, но не обещает невозможность любого будущего FloodWait: лимиты задаёт Telegram.

## Клавиатура и приоритет событий

Используется **Control**, не Command. Основные сценарии доступны на MacBook Air без F1–F12, Home/End и Page Up/Down.

| Контекст | Клавиши |
| --- | --- |
| Глобально | Ctrl+Q / Ctrl+C — quit, в том числе из overlay |
| Без overlay, не busy | Ctrl+G — справка; Tab / Shift+Tab — следующий/предыдущий focus target |
| Chats без overlay | Ctrl+K — chats+commands; Ctrl+F — chats-only; Ctrl+R — refresh; Ctrl+L — latest |
| Messages или пустой Editor, без overlay/busy/delete confirmation | Двойное ← / → в пределах 350 мс — назад / вперёд по истории посещений; непустой Editor сохраняет обычную навигацию |
| Фокус messages | Ctrl+U / Ctrl+D — page-up/page-down; ↑/↓ — карточка/альбом; ↑ на первом загруженном — older |
| Выбранное сообщение, messages focus | Enter/R — reply; E — edit; F — forward; P — фото; X, backspace или delete — запрос удаления собственного |
| Editor | Enter / Ctrl+Enter — send/save; Shift+Enter — новая строка; ↑ в пустом Editor — edit последнего собственного без фото |
| Picker | Ввод — фильтр; ↑/↓ — выбор; Enter — activation; Esc — cancel |
| Gallery | ←/→ — текущая фотография альбома; Esc / Close — закрыть; zoom принадлежит хосту |
| Help | Esc / Ctrl+G — закрыть |
| Delete confirmation | Enter — delete; Esc — снять подтверждение; обычный ввод поглощается |
| Logout confirmation | Enter — logout; Esc / Cancel — вернуться в chats |
| Авторизация | Tab — поля; Enter — submit; кнопка Back возвращает к phone для нового кода |


ChatNavigation хранит entries и текущую позицию; новое посещение после возврата отбрасывает forward branch. Back/Forward не добавляют новую запись в эту ветку, но обновляют MRU-пятёрку. Недоступные диалоги пропускаются. Повторный выбор текущего чата не создаёт дубликат. История сессионная, clearAccount её удаляет; черновики остаются в ChatState. Одиночная стрелка не задерживается. Kitty key-release игнорируется до обработки shortcuts, explicit repeat не считается двойным нажатием; в legacy input без метки repeat физическое удержание неотличимо от последовательных нажатий.
Порядок app interceptor: игнорировать key-release → обновить presence/catchUp → распознать double-tap только в разрешённом контексте → глобальный quit → передать ввод верхнему overlay → busy/help/stage/chat shortcuts → Esc/delete-confirmation → editor submit/edit → Tab → input сфокусированного компонента. Команды скрытого разговора не выполняются из picker/gallery/help; буквы R/E/F/P/X и стрелки в непустом Editor остаются редактору. Ctrl+U/D пейджат историю только при message focus.

Без overlay Esc снимает сначала delete confirmation, затем selection, затем reply/edit; обычный draft не очищает. Подтверждение удаления блокирует обычный ввод/submit, но глобальные chat shortcuts обрабатываются раньше него. Tab в writable чате переключает messages ↔ Editor; read-only имеет только messages. Picker/help/gallery восстанавливают сохранённый focus target. Native action маршрутизируется отдельно; mouse выбор старой карточки также включает detached.

## Telegram worker: транспорт и схемы

Это **второй протокол**, не TSP: UI ↔ локальный Python по stdin/stdout subprocess. Одна UTF-8 JSON-запись на строку; сообщения могут приходить частями, frontend буферизует до newline.

```json
{"id": 1, "method": "history", "args": [123, 0, 50]}
{"id": 1, "result": []}
{"id": 2, "error": "User-facing safe error", "error_code": "ValueError @ users.py:475"}
{"event": "connection", "connected": true}
{"event": "update", "kind": "read", "chat_id": 123, "max_id": 42, "outbox": false}
```

`id` — последовательное целое frontend; `method` — строка allowlist; `args` — позиционный массив. Worker проверяет форму и методы, service — значения. Результаты сопоставляются pending promises по ID и могут завершаться не в порядке запроса. Неожиданная ошибка отдаёт общее сообщение без Telegram inputs; ClientError — безопасный текст для UI. stderr subprocess игнорируется. EOF/ошибка parsing/выход worker отклоняют все pending и показывают offline; RPC timeout сам по себе не реализован. Close завершает stdin и ждёт процесс, через 2 секунды допускает kill.

Обычные запросы выполняются конкурентно. `connect`, `request_code`, `sign_in_code`, `sign_in_password`, `logout`, `close` эксклюзивны: ждут все активные запросы, не пропускают новые обычные перед ожидающим переходом. События Telegram продолжают поступать независимо. EOF отменяет задачи и закрывает service.

### Типы данных

| Тип | Поля |
| --- | --- |
| `Dialog` | `id: number`, `title`, `preview`, `unread_count`, `writable`, `last_message_id: number|null`, `kind: user|bot|group|channel|saved`, optional `presence: PeerPresence|null` |
| `DialogCursor` / `DialogPage` | cursor `{date, id, peer_id}`; page `{dialogs: Dialog[], cursor: DialogCursor|null}` |
| `ChatMessage` | `id`, `chat_id`, `sender`, `sender_id: number|null`, `text`, `markdown`, `time`, `outgoing`, `reply_to: number|null`, `edited`, `photo`, `media_id: string|null`, `forwarded: string|null`, `read`, `grouped_id: string|null` |
| `Photo` | `data` — base64, `mime`, `width`, `height`; preview/avatar могут вернуть null |
| `PendingSend` / `ClientState` | pending `{text, reply_to: number|null, random_id: string}`; state `{drafts: Record<string,string>, selected_id: number|null, pending_sends: Record<string,PendingSend>}` |
| `PeerPresence` | `state: online|offline|recently|last_week|last_month|unknown`; optional `expires`, `was_online` — epoch seconds |
| update presence | `{kind:"presence", chat_id, presence:PeerPresence}` |
| update typing | `{kind:"typing", chat_id, sender_id, sender, action, expires_in}` — Telegram action constructor name, срок 6 секунд |
| update message | `{kind:"message", chat_id, message}` — новое либо edited/повторное сообщение |
| update delete | `{kind:"delete", chat_id, ids:number[]}`; chat_id=0 допускает неизвестный private/small-group origin |
| update read | `{kind:"read", chat_id, max_id, outbox:boolean}` |
| update metadata | `{kind:"dialog_changed", chat_id, title?, participants_changed?, avatar_changed?, permissions_changed?}` |
| update refresh | `{kind:"refresh", chat_id}` — требуется обновление данных |

Chat ID — marked peer ID, не ноль, целое в безопасном диапазоне JS. Message ID — положительное целое меньше 2³¹. 64-битный album ID переносится **строкой**, не JS number. Перед reply/edit/delete/forward/photo worker заново проверяет наличие сообщения именно в этом chat: account-wide ID личных чатов не должен попасть в другой разговор или пересечься с channel ID.

### RPC методы

| Метод и позиционные аргументы | Результат / назначение |
| --- | --- |
| `has_credentials()` | boolean |
| `connect(api_id?, api_hash?)` | boolean authorized; без аргументов читает приватные credentials |
| `request_code(phone)` | null; запрос кода |
| `sign_in_code(code)` | boolean: true authorized, false требует 2FA |
| `sign_in_password(password)` | null |
| `me()` | строковое имя аккаунта |
| `dialogs(cursor=null, limit=60)` | DialogPage; limit 1…100 |
| `dialog(chat_id)` | Dialog либо null |
| `chat_info(chat_id, refresh=false)` | кешированный `{participants_count: number|null}`; недоступность metadata — null, сетевые ошибки не маскируются |
| `message_readers(chat_id, message_id)` | `number|null`: длина подтверждённого списка читателей либо недоступно |
| `history(chat_id, before_id=0, limit=50)` | ChatMessage[] по возрастанию ID |
| `send(chat_id, text, reply_to, random_id)` / `edit(chat_id, message_id, text)` | подтверждённый ChatMessage; send требует каноническую строку random_id от 1 до 2⁶³−1 |
| `album(chat_id, message_id)` | ChatMessage[] полного альбома по возрастанию ID, либо singleton |
| `delete(chat_id, message_ids)` | null; server-side расширение альбомов, revoke=true, delete update с полными ID |
| `forward(chat_id, message_ids, destination_id)` | ChatMessage[]; расширяет альбомы и проверяет подтверждение всех отправленных членов |
| `mark_read(chat_id, max_id)` | null; после подтверждения Telegram — inbox read update |
| `photo(chat_id, message_id, preview=false)` | Photo; preview может вернуть null |
| `avatar(sender_id)` | Photo либо null |
| `select_peer(chat_id:number|null)` | null; выбранный загруженный разговор, смена отменяет прежний typing |
| `typing(chat_id, active:boolean)` | null; SetTyping/CancelAction только для выбранного writable peer, без draft text |
| `activity()` | null; observed input → собственный account.updateStatus, не факт host foreground |
| `load_state()` / `save_state(state)` | ClientState / null |
| `logout()` / `close()` | null; отзыв сессии / только disconnect |

## Потоки авторизации и сообщений

Start → has_credentials → credentials либо connect → phone либо authorized. Credentials intro явно сообщает, что Terngram — неофициальный клиент, использующий Telegram API, и содержит ссылку на my.telegram.org/apps. Форма передаёт введённые API ID/hash; корректная форма реквизитов **не доказывает**, что разработчик зарегистрировал собственный ID приложения для выпуска. Phone запрашивает код; code может вести к password; после входа `me`, `dialogs` и `load_state` восстанавливают аккаунт и выбор, при необходимости `dialog(selected_id)` загружает отсутствующий разговор. API hash/code/password поля очищаются при передаче значений; маска — свойство native Input.

`initConnection` использует реальную идентификацию: `device_model=Desktop (<архитектура>)`, `system_version` из ОС (macOS version при доступности), `app_version=Terngram <версия установленного пакета>`, `lang_code=en` (текущий английский UI), двухбуквенный `system_lang_code` из locale процесса либо fallback `en`. Не передаются hostname, username/серийный номер; официальные `lang_pack`, версия/устройство и API ID не имитируются. Это не гарантия отсутствия бана или полного соответствия Terms; полный статус — [матрица API Terms](desktop-parity.md#соответствие-telegram-api-terms).

Выбор чата сразу ставит selectedId, восстанавливает draft и фокус, планирует persist, очереди previews; историю ждёт только если thread ещё не loaded. Начальная history — последние 50; older использует минимальный загруженный ID как offset. `more` при первой/older загрузке равно `page.length===50`. Запрос фиксирует revision; поздняя страница не отменяет live edit/read/delete. Refresh запускает dialogs и latest history параллельно, заменяет актуальный хвост истории, сохраняя ранние страницы и изменения после старта запроса. Диалог refresh не затирает более новый live preview; повтор refreshDialogs коалесцируется.

Send/edit не создаёт фиктивно успешное сообщение: UI ждёт Telegram и пропускает ответ через receive; live и ответ дедуплицируются по ID. Send записывает PendingSend на диск и отправляет raw `messages.SendMessageRequest` с его random_id. Повтор того же текста/reply использует тот же ID, в том числе после перезапуска; изменение текста/reply означает новую попытку. Подтверждённая отправка удаляет pending record. Неясный исход сохраняет его; автоматического resend нет. Ошибка записи до сети восстанавливает предыдущий pending record и не портит сохранение других черновиков. Это не полноценный offline outbox: хранится последняя попытка на чат, нет фоновой очереди множества сообщений. Draft очищается только если текст/режим/reply не изменились во время RPC; обычный успешный send текущего чата делает jumpBottom, edit — нет.

Композиция поддерживает bold (`**`/`__`), italic (`*`/`_`), strike, inline/fenced code с языком и Markdown links; reverse rendering сохраняет Telegram entities и экранирует литеральный Markdown. Лимит — 4096 UTF-16 units содержимого после parsing, без обрезания. Entities передаются явно: send через raw request с `no_webpage=True`, edit через Telethon с `parse_mode=None`, `link_preview=False`.

Receive вставляет сообщения по ID, обновляет revision, авторов и previews. Новое входящее unread увеличивает локальный счётчик только однажды: own/duplicate/edit/already-read не считаются новыми. Новое последнее сообщение передвигает диалог к началу. Delete удаляет сообщения, очищает связанные reply/edit targets, обновляет preview и при необходимости галерею. Неизвестный chat_id=0 применяется только к non-channel IDs; одинаковый channel message ID не должен удалиться. Read outbox меняет sent→read монотонно; inbox обновляет unread диалога, при более новом хвосте запрашивает dialog.

## Read, presence и detached: точная политика

`newMessages` — локальное множество входящих, ожидающих acknowledge UI; это **не** Telegram `unread_count`. Исходящий `read` — Telegram outbox read receipt, не факт собственной прокрутки.

1. Первая успешная загрузка текущего чата задаёт end scroll, acknowledge новых и `mark_read` до последнего загруженного ID.
2. Ctrl+L / Latest / кнопка «N new» явно задают end, снимают detached, acknowledge и вызывают mark_read. Успешный обычный send в текущем чате делает то же.
3. Older, Ctrl+U/D (оба направления), выбор не последней группы клавиатурой или click старого сообщения устанавливают detached для данного чата. Переключение туда-обратно detached не снимает; выбор последней карточки сам по себе тоже не снимает.
4. `catchUp(chat_id)` подтверждает новые/непрочитанные только на stage chats, без busy/quitting и без palette/help/gallery/forward overlay, если чат выбран, **не detached**, и последний app input был не более **60 секунд** назад. Вызывается на новом входящем, выборе loaded-чата, клавиатурном вводе и изменении composer. Keyboard interceptor и composer onChange обновляют presence до catchUp, поэтому native editor edits также учитываются; native action обновляет lastInput, но не каждый picker event проходит обработчик приложения.
5. Mark read фиксирует maximum загруженного сообщения **в момент решения прочитать**. `ReadReceipts` хранит `confirmed` и `requested` отдельно; один RPC на чат, новые запросы объединяются по максимальному явно переданному ID. Завершение RPC не перечитывает конец истории: сообщение, пришедшее после ухода пользователя из чата, не попадает в прежнюю заявку. Уже подтверждённая граница повторно не отправляется. Ошибка не продвигает confirmed; повтор возможен при следующем явном решении. Account clear, reconnect и quit отсоединяют старую очередь.
6. Unread UI обнуляется только если подтверждённый maximum покрывает last_message_id. Подтверждение очищает локальные новые сообщения до этого ID. Пользовательский явный путь — Latest / Ctrl+L; отдельной команды mark-read в палитре нет.

Ответ `False` от channels.readHistory — не исключение RPC. После завершившегося `send_read_acknowledge` backend продвигает inbox maximum независимо от Bool; при RPC/network exception maximum не меняется. Неверная проверка truthiness была причиной пользовательского `mark_read` notice и удалена.

**Ограничение:** TSP не сообщает приложению настоящие viewport position, visibility и focus pane. Detached — модель известных действий, presence — recent input, не доказательство прочтения. Trackpad/mouse scrolling хоста не наблюдается; пользователь мог физически уйти в историю без установки detached. Incoming event не посылает принудительный scroll/reveal и не выбрасывает пользователя из истории. Нельзя утверждать «помечаем прочитанным только реально видимые пиксели/сообщения» или «pane был активен».

### Сравнение read-стратегий с исходниками Telegram

- [Telegram Desktop: Histories::readInboxTill / sendReadRequest](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_histories.cpp#L248-L348): отдельные `willReadTill` и `sentReadTill`, дедупликация границ, отложенная отправка до 3 секунд при частичном чтении; достижение конца/force отправляет сразу. [newItemAdded](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/history/history_widget.cpp#L4463-L4506) проверяет положение scroll и `markingMessagesRead`; отправляемое сообщение перемещает историю вниз.
- [Telegram Web A: useMessageObservers](https://github.com/Ajaxy/telegram-tt/blob/master/src/components/middle/hooks/useMessageObservers.ts): IntersectionObserver для нижнего маркера сообщения, максимальный видимый ID, throttle 150 мс; quick preview не читает чат. [useBackgroundMode](https://github.com/Ajaxy/telegram-tt/blob/master/src/hooks/window/useBackgroundMode.ts) использует document.hasFocus и window blur/focus.
- [Web A: markMessageListRead](https://github.com/Ajaxy/telegram-tt/blob/master/src/api/gramjs/methods/messages.ts): основной канал → channels.readHistory, обычный peer → messages.readHistory, discussion/topic → messages.readDiscussion. Прочтение содержимого/упоминаний — отдельная операция.
- Terngram использует установленный [Telethon send_read_acknowledge](../.venv/lib/python3.14/site-packages/telethon/client/messages.py#L1340-L1425) с явным `max_id`; библиотека выбирает channels/messages.readHistory. Topics/discussions и отдельное чтение reactions/mentions сейчас не представлены.

Заимствована точная монотонная граница и single-flight, но не таймер в 3 секунды: для текущего потока достаточно объединения запросов во время RPC. Presence60s/detached — компромисс отсутствующего viewport/focus API, а не эквивалент desktop visibility. Перед заменой эвристики нужны реальные события видимости сообщений и активности pane от Tern.

### Typing и Telegram user presence

Это отдельный контракт от read-эвристики `lastInput`/detached и транспортного `connected`.

- **Исходящий typing:** пользовательский composer onChange с непустым текстом в выбранном writable чате вызывает `typing(chat_id,true)` не чаще раза в **4 секунды**; backend повторяет throttle и selected-peer guard. Программное восстановление draft не считается вводом. Пустой ввод, **5 секунд** без edits, смена чата, send/edit, переход к подтверждению logout, disconnect/reconnect/account reset и quit останавливают transient state/отправляют CancelAction при возможности. Backend также отменяет перед send/edit и shutdown. Для Saved Messages/bot peer backend не отправляет typing. Текст draft не входит в RPC.
- **Входящие actions:** Raw `UpdateUserTyping`, `UpdateChatUserTyping`, `UpdateChannelUserTyping` передают chat/sender/action в worker event. UI хранит по chat+sender только в памяти, удаляет по cancel, сообщению отправителя либо через **6 секунд**, показывает в dock активного чата sender + “typing…”, recording/uploading/choose sticker и другие известные действия; неизвестный action — “active…”. Own incoming actions игнорируются. Никакой typing-карточки в истории/на диске нет.
- **Presence собеседника:** entity status входит в `Dialog.presence`; `UpdateUserStatus` обновляет его. Personal chat показывает `online` только до server `expires`; после — unknown, не выдуманный exact last seen. `offline.was_online` отображается как локальная дата, privacy-filtered `recently`/`last_week`/`last_month` сохраняются грубыми. Empty/неизвестное — unknown. Нельзя вычислять точный last-seen из грубого статуса или смешивать presence с соединением.
- **Собственная activity:** keyboard/native actions и composer edits вызывают `activity()` не чаще раза в **5 секунд**. Backend отправляет `account.updateStatus(offline=false)`, refresh не чаще **55 секунд**, после **60 секунд** отсутствия наблюдаемого ввода — offline; close/logout отправляют offline при возможности. Это normal observed-input policy, не ghost switch, но **не точное foreground/focus**: хост не предоставляет достоверную активность pane.
- **Ошибки transient RPC:** 5-секундный timeout, server retry-after/per-method cooldown от момента получения ответа; non-wait failure/Bool false подавляют повтор на 5 секунд. Автоматических typing retries нет. Typing/status best-effort не превращаются в ложный send success и не создают notice на каждую клавишу. Сетевой сбой не гарантирует доставку cancel/offline. Смена аккаунта/worker изолирует поздние события/заявки через generation/connection identity.

Источники: [messages.setTyping](https://core.telegram.org/method/messages.setTyping), [SendMessageAction](https://core.telegram.org/type/SendMessageAction), [account.updateStatus](https://core.telegram.org/method/account.updateStatus), [UserStatus](https://core.telegram.org/type/UserStatus). Наличие этих путей не закрывает TTL, read-visibility и sponsored gaps — [полная матрица](desktop-parity.md#соответствие-telegram-api-terms).

### Количество читателей у своих сообщений

При выборе собственного **уже прочитанного** сообщения в группе после паузы 300 мс запрашивается `message_readers`. Это не сканирование всей истории и не polling; быстрая навигация стрелками отменяет не начатый запрос предыдущего выбора. Результат отображается в header как `read N`. Неизвестно/недоступно — обычный read/sent без числа; 0 допустим только из реально пустого server vector.

Backend проверяет outgoing/group/обычное сообщение, hidden participants/monoforum и размер группы. Порог/срок берутся из hash-based `help.getAppConfig` (`chat_read_mark_size_threshold`, `chat_read_mark_expire_period`). Документация Telegram называет обычные defaults 100/7 дней; при отсутствии значения используем более консервативный fallback текущего Desktop — **50/7 дней**. Runtime config всегда имеет приоритет. Граница включительная (`count <= configured_max`), не жёсткое `<100`. Config кешируется час и инвалидируется UpdateConfig. Неподходящий размер отсекается до дополнительной загрузки сообщения, когда full-info уже кешировано.

`messages.getMessageReadParticipants` возвращает вектор ReadParticipantDate; число равно его длине, без вычитания автора или вывода из outbox_max. Ожидаемые CHAT_TOO_BIG/MSG_TOO_OLD/MSG_ID_INVALID/PEER_ID_INVALID означают недоступность, не «0»; FloodWait и сетевые исключения остаются ошибками. Frontend хранит максимум 256 записей, не опрашивает фоновые чаты и не обновляет один message чаще 30 секунд после завершения; более длинный retry-after имеет приоритет. Invalidation убирает значение, но не обнуляет защитный интервал.

Источники: [Desktop WhoReadExists / WhoReadIds](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/api/api_who_reacted.cpp), [Telegram appConfig](https://core.telegram.org/api/config#chat-read-mark-size-threshold), [getMessageReadParticipants](https://core.telegram.org/method/messages.getMessageReadParticipants).

## Изображения: preview и gallery

### Автоматические превью и аватары

После history/receive/selectChat приложение ставит в очередь **только фото выбранного чата**, до четырёх на каждую известную группу. Это очередь по загруженной истории, не lazy loading по видимому viewport. Preview RPC использует `photo(chat,id,true)`; кликабельный image имеет action `photo:<id>` и title «Open full photo». Bounds одинаковы для одиночных фото и альбомов: `32ch × 10lines`; row wrap. Даже без превью остаётся View photo(s).

Python не ресайзит оригинал локально. Для Telegram photo выбирается минимальный доступный размер с длинной стороной ≥320, иначе наибольший; stripped/path sizes без размеров исключаются. Для image document используется thumbnail; при её отсутствии preview возвращает null **при любом размере файла**. Оригинальный документ скачивается только по явному открытию. MIME: JPEG, PNG, GIF, WebP, BMP; проигрывание анимации зависит от хоста.

Отдельные ImageLoader для previews и avatars имеют concurrency 2 каждый. Превью и full-photo caches используют ключ `chat_id:message_id:media_id`; media_id — строковый Telegram photo/document ID, поэтому замена медиа под прежним message ID не сохраняет старое изображение. При live-замене старый ключ инвалидируется, при удалении очищается; открытая галерея обновляется. Аватары используют sender ID. Очередь дедуплицирует requests и берёт новые ожидающие первыми; node/null кешируются, ошибка показывается в notice и допускает повтор при новом request.

ImageLoader хранит идентичность entry: invalidate удаляет cached/queued ключ, а поздние success/failure/finally старой записи не публикуют данные и не меняют новую запись того же ключа. Clear сбрасывает все записи аккаунта; уже выполняющийся RPC занимает слот до завершения, но его результат не принимается. Очереди очищаются при clearAccount/quit. Full-gallery loading markers также очищаются при account reset; finally удаляет marker только своей request identity.

`cancelQueued()` при переключении чатов не удаляет уже завершённые изображения и не запускает оставшуюся очередь невидимого чата. Это ограничение лишних скачиваний, не подтверждённая viewport-lazy стратегия: настоящий viewport TSP не сообщает.

Для аватара backend использует **entity отправителя**, сохранённый при получении сообщения/диалога, а не повторно разрешает голый ID. Telethon допускает min entities для profile-photo download, хотя get_input_entity такого ID может завершиться ValueError. Отсутствуют метаданные неизвестного/удалённого sender — avatar=null и initials; настоящее исключение загрузки по-прежнему видно пользователю.

### Полная галерея

При первом полном просмотре альбома `album(chat,id)` разрешает состав независимо от загруженных страниц. Снимок полноты кешируется в аккаунте; live members дополняют локальную группу, а refresh/reconnect/gap сбрасывают отметку. Повторное открытие не повторяет album RPC без причины. Metadata сливается с revision guard; отсутствующие full photos загружаются отдельно от thumbnails.

Full nodes имеют bounds `80ch × 28lines`, кешируются по идентичности медиа. В пределах альбома отсутствующие изображения запрашиваются через Promise.all; это максимум десять Telegram-членов, но не lazy full download по текущему индексу. Ответ со старым media_id не подменяет новое изображение. Generation изолирует аккаунт; другой открытый picker/help не вытесняется завершившейся загрузкой.

PhotoViewer показывает **одну** фотографию, `index/count` и её подпись. ←/→ и Previous/Next переключают внутри альбома с ограничением границ, Esc закрывает; обычный image click делегирует zoom хосту. setContent сохраняет выбранный ключ при добавлении/перестановке, иначе ограничивает индекс. Delete оставляет доступные члены или закрывает gallery; закрытие возвращает предыдущий фокус. Общей shared-media галереи по всем фотографиям чата нет.

Начальный выбор — фотография, по которой нажали, не всегда первый член альбома. Wire-key full image стабилен по chat/message, cache-key включает media_id: замена bytes сохраняет выбор. Request intent отделён от account generation: поздняя первая загрузка не заменяет более поздний выбор, Escape отменяет ожидающее открытие до reply/edit context, переход в другой чат/палитру/help не допускает позднего popup.

PhotoViewer использует semantic overlay size `lg`. Статус/Close находятся в заголовке, навигация и подсказка zoom — отдельной строкой; rows допускают перенос. Общие кнопки имеют `shrink:0`, `grow:0`, `basis:content`, чтобы сначала сокращался описательный текст, а не клавиша действия. Навигации Previous/Next нет при единственном фото.

Кеши не имеют TTL, LRU или дискового media cache. SDK blob registry не предоставляет удаления уже зарегистрированных bytes; удаление app cache entry не доказывает освобождение blob. Память зависит от просмотренной/загруженной истории.

## Persistence и безопасность

Каталог по умолчанию — `$XDG_DATA_HOME/terngram` либо `~/.local/share/terngram`; CLI `--data-dir` заменяет его. Он находится вне проекта, проверяется на владельца и отсутствие symlink, mode 0700. JSON читается с `O_NOFOLLOW`, проверкой private regular file и владельца; запись — временный 0600 файл, flush/fsync и atomic replace. Файлы: `credentials.json` (собственный API ID/hash), `state.json` (drafts/selection), `account.session` (Telethon SQLite сессия и её возможные sidecars). Сессию нельзя передавать другим: она даёт доступ к аккаунту.

Это приватные локальные файлы по Unix permissions, **не шифрование at rest**. Drafts содержат текст. Telethon session — не обещание отсутствия любых метаданных на диске; приложение не сохраняет историю сообщений и media в state.json. Маски API hash/login code/2FA password защищают отображение, не делают JSON-lines или память «без секретов»: значения реально передаются локальному worker. 2FA password не сохраняется приложением. Диагностический stdout worker занят RPC; общие ошибки не включают входной текст/credentials. Native поверхность и blobs передают содержимое Tern-хосту, которому нужно доверять.

Quit ожидает сохранение, очищает previews/avatars ImageLoader, закрывает overlay, очищает секретные поля, disconnect worker и останавливает TUI; не отзывает сессию. SIGINT/SIGTERM/SIGHUP и stdin EOF ведут к app.quit. Reconnect сохраняет draft, увеличивает generation, заменяет worker и обновляет выбранную историю; in-memory chat state сохраняется. Logout сначала требует подтверждение и успешный `log_out()`, затем удаляет state.json и session/sidecars, очищает аккаунт frontend и переходит к phone. API credentials остаются для следующего входа. При неуспехе logout локальные данные не выдаются за удалённые.

### Безопасная диагностика

RPC error связан с исходным `method`; UI показывает `operation [exception @ file:line]: safe message`. Backend сохраняет только последнюю ошибку в приватном атомарном `last-error.json`: operation, класс первопричины и до 12 stack locations (basename/function/line). Не сохраняются exception values, аргументы, локальные переменные, сообщения, токены и полные пути. Диагностика не подавляет исходную ошибку; невозможность записать файл не мешает доставить её UI. Старые процессы до введения этой записи не позволяют восстановить причину ретроспективно.

## Тесты, runtime proof и границы доказательств

Команды проекта: `bun run check` (TypeScript), `bun run test` (Bun tests и Python unittest), `bun .smoke-client.ts` (runtime smoke native backend/document). Этот справочник описывает назначение проверок, **не утверждает успешный запуск после последних изменений**. Обзор Terms не запускал gates/formatters и не использовал live Telegram.

Runtime smoke дополнительно проверяет многократный поиск без search RPC, single-flight заполнение каталога, targeted rename/member/rights invalidation, отсутствие повторных lookup недоступного peer, read N после selection debounce, кеш альбома, отмену/порядок фото, сохранение caret при фоновых удалениях и отсутствие submit от Enter repeat. Python регрессия проверяет также ShortSentMessage для Saved Messages: InputPeerSelf нельзя напрямую преобразовывать utils.get_peer.

| Набор | Что проверяет код тестов |
| --- | --- |
| `tests/history.test.ts` | Слияние, edit/delete races, read monotonicity, draft restore, album pagination/realtime, входящий счётчик |
| `tests/chat-navigation.test.ts` | Back/Forward и новая ветка, пять уникальных MRU, пропуск недоступных, account reset, точные границы double-tap без wall-clock timers |
| `tests/palette.test.ts` | select≠activate, prefix/chats-only, input/caret/stale edits, обновления списка, disabled и cancel |
| `tests/images.test.ts` | Дедупликация/лимит/LIFO, clear старого аккаунта, ошибка и повтор запроса |
| `tests/photo-viewer.test.ts` | Выбор/границы ←/→, подпись, сохранение текущей фотографии при обновлении и удалении |
| `tests/read-receipts.test.ts` | Точные границы requested/confirmed, дедупликация, отказ RPC без ложного успеха, изоляция старого аккаунта |
| `tests/reader-counts.test.ts` / `tests/test_readers.py` | Demand cache/throttle/deadline/invalidations, конфиг, размер/expiry/privacy gates, actual vector cardinality и отсутствие выдуманного нуля |
| `tests/request-cooldowns.test.ts` | Server deadline, method vs peer scope, отсутствие раннего retry и очистка при смене аккаунта |
| `tests/test_telegram.py` | Приватность/symlink, peer/ID isolation, metadata/read, фото/document thumbnails и full sizes, страницы/connection, state, worker concurrency/auth barrier/EOF |
| `tests/test_formatting.py` | UTF-16/emoji entities, links/code language, литеральный Markdown, лимит содержимого |
| `.smoke-client.ts` | Native frames/tree/actions, dock/editor порядок, focus, keyboard paging/reveal/latest, reply/edit/delete/forward, history/live races, photo previews/gallery, read policy и persistence |

Smoke использует NativeBackend/TspDocument, детерминированные изолированные диалоги и подменённые Telegram chat RPC, а для сохранения черновиков — настоящий локальный worker. Он доказывает форму native frames, маршрутизацию и переходы состояния, **не** выполнение всех операций реальным аккаунтом на Telegram и **не** окончательную отрисовку окна Tern. Маленькие test images проверяют transport/tree, не качество фото. Реальная ширина, clipping, zoom, trackpad, узкие окна, host focus и пиксельная геометрия требуют наблюдения в хосте; не объявляются проверенными по smoke.

## Не реализовано и не следует подразумевать

Нет веб/ANSI интерфейса, secret chats, звонков, отправки файлов/фото, audio/video player, stickers/reactions/polls, управления участниками/правами, multi-account переключателя, cloud draft sync, глобального поиска людей и поиска сообщений. Нет profile/details surfaces; Telegram-provided online/last-seen personal peer и transient typing уже представлены в dock. Число участников доступно через chat_info. **Не реализованы TTL/expiry/self-destruct lifecycle и official sponsored messages** при доступных каналах/bot chats. Нет настоящего viewport-based read/lazy-media, полной offline outbox/history database, галереи всей shared media истории или ограниченного LRU blob cache. Сравнение с Desktop и открытые Terms-пункты — [desktop-parity.md](desktop-parity.md#соответствие-telegram-api-terms); статус соединения/writable не гарантирует успех следующей серверной операции.
