# Tern API: технический справочник для Terngram

Этот документ описывает **локальный контракт** установленного `@oh-my-pi/pi-tui` / `@oh-my-pi/pi-wire` и способы его применения в Terngram. Интерфейс — native TSP, не HTML/CSS, не Telegram Web и не ANSI-интерфейс с картинками поверх строк. Зависимости фиксируются в [`package.json`](../package.json) и [`bun.lock`](../bun.lock); локальный SDK находится в [`pi-tui`](../node_modules/@oh-my-pi/pi-tui/package.json) и [`pi-wire`](../node_modules/@oh-my-pi/pi-wire/package.json).

**Граница доказательств.** Источники хоста Tern и нормативный `crates/tern/SURFACE_PROTOCOL.md` здесь отсутствуют. Wire-типы ссылаются на этот документ, но не заменяют проверку хоста ([`tsp.ts:1–26`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L1-L26)). Ниже «поддерживает» означает доступность API/типа в локальном SDK; фактический набор host kinds/features приходит в hello. Точная раскладка, перенос, пиксельная геометрия, анимация и pointer-поведение не подтверждаются статическими типами или mirror-деревом. Пользовательское наблюдение: объектная форма `list.max` сделала список коротким и внутренне прокручиваемым; это не универсальная гарантия геометрии остальных узлов.

## 1. Поверхности и области: main, dock, layer, native sheet

| Сущность | Контракт и назначение |
| --- | --- |
| Surface | Самостоятельная поверхность с ID; wire `o` открывает `inline` или `screen`, `x` закрывает |
| `main` | Поточный документ/transcript; при закрытии `keep: true` его можно оставить в scrollback |
| `dock` | Закреплённая снизу chrome живой поверхности: редактор, статус, компактные controls |
| `layer` | Третий wire-регион для overlay; им управляет backend, а не обычный frame provider |
| Generic overlay | `tui.showOverlay(component)`; backend оборачивает компонент узлом `overlay` в `layer` |
| Native sheet | Компонент с `nativeSheet(cx) === true`; уже сам описывает `picker`/`prefs`, поэтому попадает в `layer` **без** дополнительной рамки `overlay` |
| Fullscreen page | Отдельная `screen`-поверхность; `describeScreen(cx)` возвращает `main`, `dock`, `role` |

Источники: [`NativeSurface/NativeScreen`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts#L74-L89), [`Component.nativeOverlay/nativeSheet/describeScreen`](../node_modules/@oh-my-pi/pi-tui/src/tui.ts#L255-L283), [`backend: выбор screen/main/dock/layer`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L430-L467), [`wire regions/open/close`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L833-L884).

`NativeSurface` содержит **только** `main` и `dock`: не добавляйте поле `layer`. Terngram регистрирует приложение как frame provider в [`main.ts`](../terngram/ui/main.ts), а `describeSurface()` в [`app.ts`](../terngram/ui/app.ts) возвращает `{ main: [this.body], dock: [this] }`. История описывается отдельно от dock. Каждый чат имеет стабильный `thread-${id}`; неактивные загруженные чаты получают `hidden`, а не переносятся в popup.

Закреплён весь dock, а не произвольный editor внутри него. Последняя вертикальная область Terngram — строка editor/send. Большой список, Markdown или многострочный статус в dock увеличивают его содержимое; это не независимая панель с автоматически фиксированной высотой. Фиксированная высота и точная граница main/dock локальным SDK не установлены.

Native picker — **не** обычный `list` с другим стилем: это data-first sheet с каталогом, поиском, scopes/tabs, preview и action bar. Клавиши и фильтрация остаются у приложения. `dockedPicker()` позволяет selector, описанный внутри editor/dock, поднять в layer; его события имеют специальный keypath, который нормализует `pickerEvent`. Источник: [`picker.d.ts:1–40,58–72`](../node_modules/@oh-my-pi/pi-tui/dist/types/native/picker.d.ts#L1-L40).

## 2. Описание дерева, идентичность и кэш

Компонент предоставляет `describe(cx): NativeNode | null`; `NativeNode` имеет `k` (kind), `p` (props), `c` (дети), необязательные **верхнеуровневые** `key`, `reveal`, `scroll`. Дети могут быть узлами или компонентами. Wire-ID назначает reconciler: не подменяйте его Telegram ID. Компонент-ребёнок — отдельная describe boundary со стабильным префиксом ID и собственным владельцем событий.

- `key` идентифицирует узел **среди соседей компонента**; без него используется индекс. Для вставляемых/переставляемых сообщений, альбомов и items нужен стабильный ключ.
- `p.key` существует в общих wire-props, но не является заменой верхнеуровневого `NativeNode.key` для reconciliation.
- Тот же объект описания означает неизменность поддерева; не мутируйте уже возвращённый объект. При изменении состояния возвращайте новое описание или сбрасывайте memo.
- `Memo.get(deps, build)` сравнивает зависимости по `Object.is`; `clear()` сбрасывает кэш. `OwnerMemo` хранит memo на owner-object. Включайте все влияющие данные: selected, caret, children, appearance и внешние decorations.
- `invalidate()` очищает прикладное описание; `requestRender()` планирует кадр. Одно не заменяет другое.

Источники: [`node.ts:1–71`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts#L1-L71), [`Memo/OwnerMemo`](../node_modules/@oh-my-pi/pi-tui/src/native/memo.ts#L1-L64). В Terngram [`MessageView`](../terngram/ui/message-view.ts) кэширует карточку по членам группы, reply, selection, загрузке, avatar и preview nodes; [`ImageLoader`](../terngram/ui/image-loader.ts) возвращает стабильные image nodes. Компонент без `describe` превращается в `rows`, вызывая `render(cx.cols)`; это migration fallback, не native Markdown. Terngram явно отвергает ANSI-render для основного интерфейса.

## 3. Общие свойства и раскладка

Источник всех общих props: [`tsp.ts:83–168`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L83-L168).

| Поле | Значения/смысл |
| --- | --- |
| `role` | Семантическая роль для host styling; произвольный string, не CSS-класс |
| `tone` | `neutral/accent/info/success/warning/error/pending/muted/user` |
| `hidden` | Скрытие описанного узла |
| `grow`, `shrink` | Числовые flex-параметры |
| `basis` | `auto`, `content` или число; числовую единицу не трактуем как CSS px/колонки |
| `min`, `max` | `{ w?, h? }` с `TspExtent` |
| `TspExtent` | Строки вроде `40ch`, `10lines` или доля доступного extent, например `0.4`; **не pixels и не terminal cells** |
| `title`, `aria` | Подсказка и accessible name; `aria` особенно нужен icon-only/visual-only controls |
| `href` | Цель действия `open`: URL или `file://` |
| `actions` | `click`, `dblclick`, `menu` с action names |
| `mark` | Временная пометка `pick/drop`, не перестилизация всего узла |
| `col` | `gap`, `align: start/center/end/stretch` |
| `row` | `gap`, `align: start/center/baseline/end`, `justify: start/between/end`, `wrap` |
| Spacing | `none/xs/sm/md/lg` для `gap/size`; не произвольные пиксели |

У `row`/`col` нет общего `width`, `height`, `overflow`, `scrollTop`, CSS grid или DOM API. Дефолты flex, intrinsic minimum и точный алгоритм shrink не установлены по хосту. `grow: 1`, `shrink: 1`, `basis: 0`, `min: { w: 0 }` выражают намерение сжимаемой текстовой колонки, но не гарантируют конкретный перенос длинной строки. `cx.cols` — width in cells для rows fallback/ANSI wrap hints, **не** универсальная native pixel width.

### Практический шаблон

```ts
import type { NativeNode, NativeSurface } from "@oh-my-pi/pi-tui/native/node";

function describeChat(messages: NativeNode[], editor: NativeSurface["dock"][number]): NativeSurface {
  return {
    main: [{ k: "col", key: "thread-123", p: { gap: "sm", min: { w: 0 } }, c: messages }],
    dock: [{ k: "col", key: "dock", p: { gap: "xs" }, c: [
      { k: "text", key: "status", p: { text: "Example chat · online", truncate: "end", lines: 1 } },
      editor,
    ] }],
  };
}
```

Builders `node/col/row/text/list/item` доступны в [`native/describe.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/describe.ts); использование literal nodes тоже штатное. Действующая композиция: [`chat-dock.ts`](../terngram/ui/chat-dock.ts), [`message-view.ts`](../terngram/ui/message-view.ts), общие controls [`nodes.ts`](../terngram/ui/nodes.ts).

## 4. Полная локальная vocabulary

Ниже перечислены все kinds установленной wire-v1 vocabulary. Наличие в таблице **не** доказывает поддержку конкретным Tern: проверяйте `cx.supports(kind)` и hello. Точные optional/required поля и общие props определены в [`TspPropsByKind`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L776-L826).

### Контейнеры, текст, медиа и данные

| Kind | Основные props и назначение |
| --- | --- |
| `col`, `row` | Layout и дети; см. предыдущий раздел |
| `card` | `head`, `status: pending/running/done/error/cancelled`, `collapsible`, `collapsed`, `preview: {lines} / auto`, `selected`, `inset`, `variant: bare` |
| `section` | `head`, раскрытие, `took` в ms |
| `rule`, `spacer` | Разделитель `label`; семантический отступ `size` |
| `text` | `text` или `spans`, `wrap: word/char/none`, `truncate: end/start/middle`, `lines`, `measure: prose/fill` |
| `md` | Markdown `text`, `stream`, literal `marks`; **нет** `wrap/measure` |
| `code` | `text`, `lang`, `path`, стартовый номер `start`, `numbers`, line `marks`, `wrap` |
| `diff` | Unified `text` либо `hunks`, `path/lang`, `mode: unified/split/auto` |
| `ansi` | Raw terminal output `text` (SGR/OSC8/CR/BS), `follow`, `preview`, `cols` hint in cells |
| `math` | `text`, `display`; формат/набор реально рисуемой математики не установлен по host source |
| `image` | `blob` SHA-256 или `builtin: omp`, `alt`, intrinsic `w/h`, extent `max` |
| `kv` | Массив `{k,v}` с `TspText`, `layout: grid/inline` |
| `table` | `cols` с ID/header/alignment/truncate/priority/grow и `rows` с ID/cells |
| `tree` | Рекурсивные data nodes: ID/label/icon/open/children |
| `rows` | Предрендеренные ANSI `lines`, исходный `cols`; fallback |

Источники: [`tsp.ts:169–283`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L169-L283), [`rows`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L392-L397).

`TspText` — строка или spans `{ t, s?, fx?, href? }`. `s` содержит семантические tokens, например `strong muted code link mark`, либо theme token names; `fx` — `shimmer/pulse/none`. Icon span не требует вручную добавлять пробелы вокруг glyph. Это не arbitrary HTML/ANSI style. Источник: [`TspSpan`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L95-L118).

Native `md` и ANSI-render SDK Markdown — разные пути. Отсутствие wrap-prop нельзя исправить добавлением `md.p.wrap`; обработку непрерывных длинных строк, ссылок и внешнего Markdown нужно оценивать в реальном Tern. В Terngram текст сообщения приходит как подготовленный Markdown и помещается в `md` внутри `card`; sender/time/read/edit/forward/reply и album count — отдельные semantic nodes.

### Индикаторы, выбор и ввод

| Kind | Основные props |
| --- | --- |
| `badge`, `kbd`, `icon` | `text`; массив `keys`; `name` |
| `spinner` | `style: dots/braille/starburst/orbit`, `label` |
| `shimmer` | `text/spans`, `mode: classic/kitt`, `palette` |
| `elapsed` | `age` ms, `stopped`, `format: short/clock`; host-clocked |
| `progress`, `rate` | `value: 0..1 / null` + label; числовой value + unit |
| `list` | `selected`, `filter`, `empty`, `max: {lines} / number`, `virtual` |
| `item` | `label`, `detail`, `icon`, `hint`, `disabled`, `value` |
| `tabs` | Data `items: {id,label}[]`, `active` |
| `editor` | `text`, UTF-16 `cursor/anchor`, `decor`, `ghost`, `placeholder`, `prompt`, `mode`, `lang`, `readonly`, `maxLines` |
| `input` | Те же editor props без `maxLines`; однострочный input |
| `status`, `seg` | `transparent`; spans/icon/priority/min/side для сегмента |
| `overlay` | `anchor: center/top/bottom / {node,side} / {caret}`, `size: sm/md/lg/full`, `modal`, `head` |
| `toast` | `text`, `sub`, `ttl` |

Источник: [`tsp.ts:284–397`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L284-L397).

Для своего списка используйте **`max: { lines: N }`**, не `max: N`: объектную форму отправляет SDK [`SelectList.describe`](../node_modules/@oh-my-pi/pi-tui/src/components/select-list.ts#L298-L320). Это ограничение viewport, не разрешение обрезать данные до N items. Конкретная реализация `virtual` по host source не известна. Selection и keyboard navigation — разные слои: native list не реализует прикладную политику Tab/Enter/поиска автоматически.

### Data-first и дополнительные capabilities

| Kind | Поддерживаемая модель данных |
| --- | --- |
| `picker` | Каталог `items`, patch `itemsAdd/itemsDel`, порядок `order` с group headers, query/cursor/hits, selected/current/total, scopes/tabs/columns, preview children, actions/strip, state/message/empty/confirm/focus |
| `prefs` | Title/pages/page/lead/query/cursor/sections; focus row и editing draft. Controls: switch/choice/number/text/keys/multi/action |
| `tool` | Name/title/target и targetKind/lang/href, meta/badges, status/age/took/exit/note/intent, frame/card или inline, collapse/preview/tools |
| `checklist` | Phases/items с pending/active/done/dropped/blocked, notes/collapsed; mode full/hud/reminder |
| `agent` | Name/type/task/status/model/thinking, current tool, stats/retry/badges/depth/collapse и expanded children |
| `effort` | `level`: off/minimal/low/medium/high/xhigh/max; glyph host-clocked |
| `meter` | `value: 0..1 / null`, bar/ring/blocks, steps/parts/marks/thresholds/label/total/size |
| `chart` | Heatmap/bars/spark, cells/cols/rows/tips либо series, token/summary/size |

Точные data contracts: [`picker items/scopes/actions`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L401-L479), [`picker props`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L481-L536), [`prefs`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L538-L614), [`tool/checklist/agent`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L616-L715), [`effort/meter/chart`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L717-L774).

Terngram сейчас использует native picker для общей palette и forwarding, но не реализует настройки через prefs, charts, agent/tool/checklist UI. Это доступные локальные API, **не обещание существующей функции приложения**. `aside` — feature, при котором prefs sheet в layer может dock справа, сужая transcript; проверяется `cx.feature("aside")`, не выводится из версии пакета ([`DescribeContext`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts#L56-L71)).

## 5. Native picker: практическая интеграция

[`CommandPalette`](../terngram/ui/command-palette.ts) использует `Input`, `SelectList`, `SelectListSheet(..., { docked: false })`, возвращает `nativeSheet(cx) = cx.supports("picker")`. [`ForwardPicker`](../terngram/ui/forward-picker.ts) применяет тот же sheet helper.

1. Приложение хранит query/cursor и фильтрует данные; `items` — каталог, `order` — результат фильтрации. `hits` — UTF-16 диапазоны, отдельные от каталога, чтобы не переписывать items при каждом символе.
2. `pickerQuery(input)` связывает input text и caret. Если memo не зависит от caret, движение курсора не достигнет экрана.
3. Pointer `select` только меняет selection/preview; `activate` или action `confirm` запускает выбор. `pickerEvent` нормализует root/hoisted child keypath.
4. Action keys — **подписи keycaps**, не регистрация клавиатурных bindings. Обрабатывайте клавиатуру в `handleInput`.
5. `SelectListSheet.handle(event)` маршрутизирует selection/activation/close; `invalidate()` нужен при изменении внешних options/decorations.

Источники: [`picker.d.ts:25–48,67–123`](../node_modules/@oh-my-pi/pi-tui/dist/types/native/picker.d.ts#L25-L48).

В Terngram `Ctrl+K` открывает единую palette чатов/команд, `Ctrl+F` — только чаты, `>` ограничивает команды, `@` — чаты; query может инициировать поиск Telegram. Строка результата содержит описание сущности/действия, а текущий selected result — contextual message и availability. Disabled item не активируется приложением. `Ctrl+G` открывает справку, `Ctrl+L` — latest; F-клавиши/Home/End/Pg не обязательны. Политика клавиш находится в [`app.ts`](../terngram/ui/app.ts), справка — [`shortcut-help.ts`](../terngram/ui/shortcut-help.ts).

## 6. Фокус, действия и native events

Keyboard focus принадлежит компоненту TUI (`setFocus(component)`), а не просто строке списка. Приложение управляет Tab, возвращением в editor и modal приоритетом. Pointer wire `focus` содержит node ID; backend находит owners/field и вызывает `host.focusFromPointer`, а не доставляет его как обычный `NativeUiEvent`. Фокус может быть сохранён modal overlay. Источник: [`backend.ts:676–725`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L676-L725).

| NativeUiEvent | Содержимое и реакция |
| --- | --- |
| `toggle` | `key`, `collapsed`; хранить состояние раскрытия в приложении |
| `select` | `key`, `item`; обновить selection, не путать с подтверждением |
| `activate` | `key`, `item`; выполнить действие выбора |
| `action` | `key`, `act`, optional `value`, `mods`; scope/tab/strip/control могут передать value |
| `change` | `key`, `item`, boolean/number/string/string[]/null; null означает reset default |
| `edit` | `key`, from/to/text/cursor/len в UTF-16 |

`key` — путь узла **внутри компонента-владельца**, `""` для root, например `body/3`; не глобальный wire-ID. Backend переводит list item IDs в описанные keys; data-first picker/prefs возвращают собственные data IDs. Источник: [`node.ts:91–149`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts#L91-L149).

`actions` допускает `toggle/copy/open/zoom/select/activate` и custom strings. `open` использует `href`; local copy/open/zoom нельзя считать обязательным вызовом вашего handler. Custom action маршрутизируется в приложение. [`actionButton`](../node_modules/@oh-my-pi/pi-tui/dist/types/native/overlay.d.ts#L42-L62) связывает pointer action с той же прикладной операцией, что и клавиша; наличие keycap само не связывает клавишу. В Terngram [`nodes.ts`](../terngram/ui/nodes.ts) строит controls; [`app.ts`](../terngram/ui/app.ts) маршрутизирует действия. Деструктивные операции требуют отдельного confirmation context.

### Редактирование: UTF-16, stale edits, selection

Native editor/input получает полное описанное text и caret, а host может прислать замену диапазона `[from,to)`. Offsets и `len` — **UTF-16 code units**, не UTF-8 bytes, code points или graphemes; строки editor соединяются `\n`. `from === to` и пустой replacement допускают чистый caret move.

`resolveTextEdit(current, event, clean, widen?)` возвращает null, если `event.len !== current.length`; иначе clamps/reorders range, не разрезает surrogate pairs, очищает replacement и пересчитывает caret. Проверка длины не является content hash/version: не приписывайте ей распознавание любой same-length гонки. Источник: [`node.ts:118–207`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts#L118-L207).

Используйте SDK `Input`/`Editor`, а не текстовую имитацию editor. Native `readonly` и прикладные запреты операций нужны в своих соответствующих слоях. Terngram wrapper editor и `CommandPalette` доставляют `edit` в SDK-компонент; palette дополнительно описывает актуальный cursor. Поле password — прикладной secret input; wire tree не следует считать безопасным хранилищем секретов или включать в публичные трассы.

## 7. Overlay lifecycle

```ts
// component реализует describe/handleInput/handleNativeEvent.
const previousFocus = editor;
const handle = tui.showOverlay(component);
// При закрытии из Esc или custom close-action:
handle.hide();
tui.setFocus(previousFocus);
```

`hide()` **навсегда удаляет** overlay; повторно показывать этот handle нельзя. `setHidden(true/false)` временно скрывает/показывает, `isHidden()` проверяет временное состояние ([`OverlayHandle`](../node_modules/@oh-my-pi/pi-tui/src/tui.ts#L475-L482)). Держите handle, очищайте прикладную ссылку и возвращайте фокус в доступный компонент. Esc/close-action обрабатывает приложение; `showOverlay` не заменяет доменную отмену/reply draft policy.

Generic wrapper получает anchor/size из `nativeOverlay` либо options, modal — из focused/fullscreen; wrapper memoized по component и chrome props ([`backend.ts:733–751`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L733-L751)). Доступные native anchor/size — семантические hints, не обещание pixel offsets. `nativeSheet` не должен рисовать второй overlay frame. Для fullscreen page `describeScreen` задаёт отдельные regions; native sheet не превращается в screen только из-за fullscreen option.

В [`app.ts`](../terngram/ui/app.ts) отдельные handles для palette/help/forward/photo. Закрытие очищает popup state и восстанавливает focus; help/viewer возвращают nodes без ANSI fallback. Галерея использует generic overlay, palette/forward — native picker sheet. Разделение conversation status и composer context реализовано отдельными ролями `terngram.conversation-status` и `terngram.composer-context` в [`chat-dock.ts`](../terngram/ui/chat-dock.ts): не переносите reply/edit/confirmation в статус беседы.

## 8. Изображения, blobs, inline preview и zoom

`image.p.blob` — SHA-256 зарегистрированных bytes, **не** URL или путь. `registerNativeBlob(bytes, mime)` сохраняет content-addressed blob в глобальной Map и помечает bytes-object ID, чтобы не хэшировать его повторно; после регистрации bytes нельзя мутировать. `base64ImageNode(data, mime, props, key)` декодирует base64, регистрирует bytes и при распознанном header добавляет `w/h` в **intrinsic pixels**. `max.w/max.h` остаются extent (`ch`, `lines`, доля), не pixels.

```ts
import { base64ImageNode } from "@oh-my-pi/pi-tui/native/blobs";

const preview = base64ImageNode(data, mime, {
  alt: "Photo preview", title: "Open full photo",
  max: { w: "32ch", h: "10lines" },
  actions: { click: "photo:123" },
}, "preview-chat-42-message-123");
// handleNativeEvent(action photo:123) загружает full photo и открывает viewer.
```

Источник helpers/cache: [`blobs.ts:1–70`](../node_modules/@oh-my-pi/pi-tui/src/native/blobs.ts#L1-L70). `NativeImageCache` кэширует node по slot key и base64 payload; это не bounded cache и не memory eviction. Изменение только MIME при том же payload не перестраивает его node. Для специальных actions/max применяйте собственный node cache, как Terngram.

Перед кадром, впервые ссылающимся на blob, backend отправляет `b` с ID/MIME и base64 body. Upload дедуплицируется **на поверхность**; новый screen/surface может потребовать новую отправку ([`backend.ts:579–594`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L579-L594)). В этом API нет unregister/blob-drop; закрытие overlay и очистка прикладного cache не гарантируют освобождение глобальных bytes или host media cache.

### Два разных клика

- **Inline preview Terngram:** explicit `actions.click = photo:<message-id>` переопределяет default zoom. Приложение загружает полное фото/альбом и открывает `PhotoViewer`.
- **Full gallery image:** action не переопределён; wire contract задаёт обычному image click default `zoom`, который показывает image и соседние images в terminal viewer. Это host capability, не Telegram download/gallery API ([`TspAction`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L120-L124)).

В [`app.ts`](../terngram/ui/app.ts) `queuePreviews` запрашивает `photo(chat, id, true)` только для selected chat, максимум четыре photo nodes на album; единый размер hints для всех inline previews — `max: { w: "32ch", h: "10lines" }`. Отдельный [`ImageLoader`](../terngram/ui/image-loader.ts) ограничивает preview concurrency двумя задачами, дедуплицирует requests, берёт новые из очереди раньше старых. Avatar loader также имеет concurrency 2. На смене account и при quit loaders очищаются: очередь удаляется, session token не позволяет поздним результатам обновить UI; уже выполняющиеся RPC не отменяются самим loader. Это ограничение **фоновых превью**, не общего gallery download.

Python [`photo`](../terngram/telegram.py) выбирает наименьший dimensioned thumbnail с длинной стороной **не меньше 320 px**, иначе наибольший доступный: это целевой порог выбора, не жёсткий предел размера. Image document без thumbnail возвращает null независимо от размера — original скачивается только по явному открытию. [`message-view.ts`](../terngram/ui/message-view.ts) размещает previews в wrapping row. Кеш-ключ включает `chat_id:message_id:media_id`; замена медиа не переиспользует старые bytes.

`viewPhoto` сначала разрешает полный альбом через worker `album(chat,id)`, затем запрашивает отсутствующие full photos через Promise.all и хранит nodes с max hints `80ch/28lines`. [`PhotoViewer`](../terngram/ui/photo-viewer.ts) описывает одну фотографию, index/count, её подпись и ←/→; одиночное фото не показывает лишнюю навигацию. Компонент задаёт `nativeOverlay.size="lg"` — semantic size, не обещание конкретных пикселей. Заголовок/Close и навигация разделены; rows могут переноситься, `button` не сжимается (`shrink:0`, `basis:content`). Zoom остаётся возможностью хоста. Это не доказывает проигрывание GIF/WebM/TGS или arbitrary media по одному kind `image`.

## 9. Прокрутка, paging, latest и read state

Загрузка следующей страницы Telegram и движение viewport — разные операции. `reveal: start/end/nearest` применяется **при добавлении** узла; смена reveal на существующем node не является повторной scroll-командой. Новый key означает новую идентичность и может потерять host view state.

Для keyboard scroll сохраняйте node key, меняйте `scroll.n`:

```ts
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

function transcript(children: NativeNode[], n: number): NativeNode {
  return { k: "col", key: "thread-42", c: children,
    scroll: { by: "page-up", n } };
}
```

Варианты `by`: `line-up/line-down/page-up/page-down/start/end`. Scroller ищется на node или выше; page — viewport less a line по wire-комментарию. Свежедобавленный node не scrolls; при изменении n у существующего node reconciler повторяет последний by для накопленных нажатий, максимум 32 ops на node/frame, start/end — один раз. Операции отправляются только при `hello.features` с `scroll`. Источники: [`node.ts:31–51`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts#L31-L51), [`reconcile.ts:605–611`](../node_modules/@oh-my-pi/pi-tui/src/native/reconcile.ts#L605-L611), [`wire scroll`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L840-L859).

**Нет события фактического scroll offset, сообщения о видимых message IDs, smooth-scroll настройки или универсального auto-follow.** `visible` сообщает visibility поверхности, не viewport messages и не keyboard/pane focus; текущий backend его игнорирует. `resize` имеет cols/cell/visible на wire, но backend обновляет cols, не возвращает geometry/offset приложению ([`backend.ts:638–654`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L638-L654)). `ansi.follow` относится только к ANSI block; не переносите его на col/md/transcript.

Terngram:

- `Ctrl+U/Ctrl+D` отправляют paging **только при фокусе сообщений**, не перехватывают editor editing; история отдельно загружается action `older`/навигацией у первого сообщения.
- `Ctrl+L`/Latest делает explicit end, снимает detached, acknowledges new count и marks read. Успешная новая отправка также вызывает latest; успешное редактирование не равно новой отправке.
- Для первого latest использует keyed empty tail с reveal, поскольку только что добавленному thread scroll-команда не применяется.
- Incoming event не принуждает viewport к latest.
- `catchUp` marks incoming/read в активном selected chat, когда он не detached и был input за последние 60 секунд. Во время busy, вне стадии chats, при quit или открытой palette/help/photo/forward операция не выполняется. Presence обновляется клавиатурным input и composer `onChange`, включая native edit activity. Detached отмечается прикладным paging/history/выбором старых сообщений. **Это эвристика presence/follow, не доказательство видимости или pane focus**; trackpad scrolling не наблюдаем.

Текущая реализация: [`app.ts`](../terngram/ui/app.ts), группы/loaded/new counts: [`chat-state.ts`](../terngram/ui/chat-state.ts). Не выводите read receipt из пикселей, счётчика scroll или отсутствующего visibility callback.

## 10. TSP transport, hello, features, frames, credits, ack

TSP передаётся по pty в APC `ESC _ tsp ; verb [; key=value]* ; body ESC \\`. JSON body — UTF-8, blob body — base64. Неизвестные поля/verbs по wire-комментарию игнорируются, поэтому дополнительные поля optional; это не право рассчитывать на неadvertised capability ([`tsp.ts:1–29`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L1-L29)).

| Verb / событие | Назначение |
| --- | --- |
| `q hello` | Versions `v[]`, app/ver; запрос capabilities |
| `r hello` | Chosen v, term/ver, kinds, optional features/APC limit/credits/cols/cell/dark/reduceMotion |
| `q/r blobs` | Запрос IDs / список `have`; wire capability, не обязательный путь текущего uploader |
| `o` | Open/adopt surface ID, inline/screen, title/role/adopt |
| `t` | Resolved theme palette dark/light, token → `#rrggbb`, theme names; после open до first frame и при изменении |
| `b` | Blob ID/MIME + base64 bytes, chunked по APC limit |
| `f` | Atomic frame `{sf, s, ops}` с монотонным sequence по поверхности |
| `e ack` | Подтверждение sequence `s` поверхности |
| `x` | Close ID, `keep` main scrollback или удалить поверхность |

Источники: [`open/close/palette/query/reply`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L870-L922), [`encode.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/encode.ts). Encoder разбивает oversized messages через chunk-ID `c` и continuation `m=1`, сохраняя UTF-8 code-point boundaries. Default APC limit — 65536, credits — 2; hello может изменить их. Не разбивайте строки произвольными JS byte offsets вручную.

Frame ops: `add/set/text/splice/move/del/settle/focus/reveal/scroll/suspend/resume`. Primary text ops относятся только к `text/md/code/ansi/math/editor/input/shimmer`. Источник: [`tsp.ts:825–868`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L825-L868). Не отправляйте raw frames параллельно reconciler в той же поверхности: ownership, sequence, tree identity и ack должны иметь одного владельца.

Backend считает in-flight frames и откладывает/coalesces изменения при исчерпании credits; ack освобождает pending count, dirty surface планирует render. Локальная реализация имеет **stall recovery**: при остановке ack снимает credit блокировку и пишет warning; это SDK policy, не гарантия надёжной доставки/retry со стороны хоста. Источник: [`backend.ts:514–576`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L514-L576), [`ack handling`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L626-L636).

Hello может быть сначала optimistic (`TERM_PROGRAM=tern`): `assumedTspHello` предполагает vocabulary/defaults до реального ответа, **не подтверждает host support** ([`backend.ts:155–173`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L155-L173)). В [`main.ts`](../terngram/ui/main.ts) Terngram требует interactive Tern (`TERM_PROGRAM`, TTY stdin/stdout), затем реальный hello v1 с kinds `input` и `picker`; при отказе завершает работу. Этот guard не проверяет все kinds или наличие scroll. Adapter переименовывает open title/role в Terngram; native surfaces по-прежнему управляются SDK.

`DescribeContext` даёт `cols`, `dark`, `reduceMotion`, `supports(kind)`, `feature(name)`; это не clock. Длительность, spinner/shimmer/elapsed и другие motion-декларации рисует host. Для изменяющегося прикладного текста планируйте render по изменению данных, не вызывайте clock в describe ради каждого кадра.

## 11. Terminal events и ограничения наблюдаемости

Wire events перечислены в [`tsp.ts:924–956`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts#L924-L956): `ack`, `resize`, `theme`, `motion`, `visible`, `toggle`, `select`, `activate`, `action`, `change`, `edit`, `focus`, `error`, `gone`.

- `theme/motion` обновляют appearance/reduced motion через backend.
- `error` сообщает sf/sequence/op/message при наличии; backend логирует warning. Это не thrown application exception на каждой операции.
- `gone` означает исчезнувшие IDs; reconciler/backend обрабатывают утрату дерева/поверхности. Не считайте его событием «сообщение скрыто за viewport».
- `NativeTerminalEvent` type включает theme/motion/visible/resize, но существование типа **не** означает, что каждый такой event доставляется в `Component.handleNativeEvent` — туда маршрутизируются node UI events.

Источник: [`NativeTerminalEvent`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts#L219-L230), [`backend event dispatch`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts#L626-L727).

Нет DOM query/layout measurement API, viewport message enumeration, pointer coordinates в перечисленных action events, arbitrary CSS или самостоятельного файлового downloader. URL в href — open target, blob — bytes; изображение по URL напрямую не описывается. Не считать zoom, overlay closure, ACK или mirror proof подтверждением реальной painted geometry.

## 12. Что проверяет offline harness — и чего не проверяет

SDK `NativeBackend` с mirror хранит reference document; `document()` возвращает snapshot, `recentFrames()` — недавние кадры. [`TspDocument`](../node_modules/@oh-my-pi/pi-tui/src/native/apply.ts) применяет wire ops к дереву, **не рисует** UI. В проекте [`offline smoke harness`](../.smoke-client.ts) использует synthetic hello, controlled Telegram responses и artificial ack.

Такая проверка может подтвердить структуру surfaces/frames, keys, props, корректность операции, blob-before-frame, наличие editor/transcript, preview action и object `list.max`. Она не подтверждает:

- реальные hello/kinds/features и совместимость конкретной версии Tern;
- высоту dock, ширину карточек, перенос Markdown, размеры фото;
- scroll offset, скорость/плавность прокрутки, видимость editor;
- настоящий pointer/keyboard/zoom/host viewer;
- реальную MTProto сеть, права Telegram или доставку сообщений.

Команды проекта и условия запуска: [README](../README.md). Для геометрии нужен запуск в реальном Tern с безопасными тестовыми данными. Traces/frames/blobs могут содержать сообщения, фотографии и credentials: не публикуйте их как обезличенную диагностику без явного удаления чувствительных данных.

## 13. Карта источников для изменений

| Изменение | Где читать/менять интеграцию |
| --- | --- |
| Surface ownership, keyboard policy, action routing, popup/read/media orchestration | [`app.ts`](../terngram/ui/app.ts) |
| Transcript cards, albums, reply/forward metadata, preview row | [`message-view.ts`](../terngram/ui/message-view.ts) |
| Full album photo selection, captions, navigation and overlay size | [`photo-viewer.ts`](../terngram/ui/photo-viewer.ts) |
| Conversation status vs composer context, последний editor | [`chat-dock.ts`](../terngram/ui/chat-dock.ts) |
| Palette query/caret/filter/disabled/description | [`command-palette.ts`](../terngram/ui/command-palette.ts) |
| Native forwarding sheet | [`forward-picker.ts`](../terngram/ui/forward-picker.ts) |
| Краткие controls и copy snippets | [`nodes.ts`](../terngram/ui/nodes.ts) |
| Presence shortcuts/help | [`shortcut-help.ts`](../terngram/ui/shortcut-help.ts) |
| Background avatar/preview caching и bounded concurrency | [`image-loader.ts`](../terngram/ui/image-loader.ts) |
| Telegram data shapes/RPC | [`ui/telegram.ts`](../terngram/ui/telegram.ts), [`Python telegram.py`](../terngram/telegram.py) |
| Tern launch/hello/title/role | [`main.ts`](../terngram/ui/main.ts) |
| Authoritative local node vocabulary | [`pi-wire tsp.ts`](../node_modules/@oh-my-pi/pi-wire/src/tsp.ts) |
| SDK contract/builders/events/memo/blobs | [`native/node.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/node.ts), [`describe.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/describe.ts), [`memo.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/memo.ts), [`blobs.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/blobs.ts) |
| Protocol machinery, не host renderer | [`backend.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/backend.ts), [`reconcile.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/reconcile.ts), [`encode.ts`](../node_modules/@oh-my-pi/pi-tui/src/native/encode.ts) |

Ссылки на приложение намеренно ведут к модулю, а не к быстро устаревающим номерам строк. Локальные `node_modules` доступны после установки dependencies; это источники текущего SDK, а не публичная документация хоста. При обновлении SDK сверяйте contract и hello отдельно от пользовательской геометрии.

## 14. GIF, стикеры и custom emoji: результат исследования, не реализованная поддержка

Telegram различает семантику документа и контейнер: GIF-анимации часто являются MP4 с DocumentAttributeAnimated; static sticker — WebP; animated sticker — TGS (gzip/Lottie); video sticker — WebM/VP9 с возможным alpha. Custom emoji — MessageEntityCustomEmoji в исходном тексте, с document_id, который разрешается через messages.getCustomEmojiDocuments. Его документ может быть WebP/TGS/WebM. Premium/free ограничивает использование/отправку, а не служит основанием скрывать полученное изображение. Источники: [stickers](https://core.telegram.org/api/stickers), [custom emoji](https://core.telegram.org/api/custom-emoji).

Проверка установленной TSP vocabulary вернула `image: true`, `video: false`, `animatedMedia: []`. Image props не определяют playback/clock/seek; text spans не имеют inline image attachment. Ассоциация GIF в Info.plist установленного Tern 0.3.0 не доказывает анимацию внутри TSP. Декодирование GIF/WebP с несколькими кадрами этим хостом остаётся непроверенным.

**Рекомендуемая архитектура (предложение):**

- Приложение передаёт неизменяемый оригинальный asset один раз; Tern декодирует и воспроизводит локально. Не регистрировать и не передавать новый blob на каждый кадр: это расход транспорта, CPU и неограниченно удерживаемой памяти текущего SDK.
- Сначала app-only статические sticker images и явно обозначенные posters; WebP→PNG допускается как однократное преобразование при неподдерживаемом формате. Poster не объявляется анимацией.
- Для движения нужен feature-negotiated host media contract: format/blob/poster, play/pause, loop, intrinsic size, reduce-motion и host-owned clock. MP4/WebM — видеодекодер, TGS — rlottie-совместимый движок. Эти поля **не существуют в текущем TspImageProps** и не должны отправляться туда без расширения протокола.
- Для custom emoji нужен inline asset run с alt text, baseline, размером и tint. Сохранять исходный текст и UTF-16 entities; offsets Telegram нельзя применять к уже экранированному Markdown. Не раскладывать предложение в набор text/image rows: это меняет wrapping, selection и copy.
- Batch/dedup document IDs для emoji; общий asset/decode cache для повторяющихся экземпляров. Отдельные бюджеты encoded bytes и decoded frames; не хранить все RGBA-кадры каждой анимации. Ключ decoded variant включает размер, scale и tint.
- Autoplay только для видимых элементов активной поверхности; pause вне viewport/при потере активности. Для этого нужны реальные host visibility/focus signals, не present-input эвристика. GIF разумно начинать с явного Play, reduced-motion — poster/no-autoplay.
- Освобождение ресурсов нужно согласовать на уровне SDK/host: app LRU не освобождает глобальный blob registry. Нужны reference lifetime/release и ограниченный decoded cache.
- Premium sticker effects — отдельный TGS resource (`videoSize type=f`) с собственным once-on-visible поведением и слоем отрисовки; это не обычное бесконечное проигрывание базового sticker asset.

Без исходников/контракта playback Tern нельзя обещать app-only поддержку всех анимаций. Реализация медиа в текущей версии намеренно не выдана за такую поддержку.
