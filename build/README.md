# Сборка витрин WK CRM

Все скрипты — чистый Python 3 + `openpyxl`, без сети. Каждый принимает
пути к исходникам аргументами и пишет `.json` в `data/`.

## Источники (не хранятся в `catalog-crm` — берутся из других веток/репозиториев)

| Файл | Откуда |
| --- | --- |
| `Прайс-лист ДП … Мэйлинь.xlsx`, `Прайс-лист УСО ПМ СЛ.xlsx` | ветка `main` этого репозитория |
| `Взаимозаменяемость узлов и деталей экскаваторов WK4.7.xlsx` | `rawdata/АТ майнинг/` в ветке `rawdata` |
| `Остатки_*.xlsx`, `Запас с ограниченным использованием*.xlsx`, `Закупка ALL*.xlsx` | репозиторий `for_update`, всегда самая свежая выгрузка |
| `ktg.json`, `mtr.json` | репозиторий `TOPO` (витрины ТОиР и МТР) |
| `data/<площадка>_<год>.json` | репозиторий `TOPO`, детализация «заказ → единица → материал» |
| `rawdata/LinkOme/*.zip[.NNN]` | `rawdata/LinkOme/` в ветке `rawdata` — книги ЗИП WK |

## Порядок сборки

```
python3 build/build_tree.py       <interchangeability.xlsx>                data/
python3 build/build_catalog.py    <price_dp.xlsx> <price_uso.xlsx> \
                                   <mtr.json> data/tree.json                data/
python3 build/build_stock.py      data/ekmtr_wk.json <stock.xlsx> \
                                   <restricted.xlsx> <purchase.xlsx>        data/
python3 build/build_fleet.py      <ktg.json> data/fleet_books.json         data/
python3 build/build_repairs.py    <topo_data_dir> data/ekmtr_wk.json       data/
python3 build/build_provision.py  <topo_data_dir> data/ekmtr_wk.json \
                                   data/stock.json                         data/

# необязательные — реестр документов и чертежей, не в критическом пути
git ls-tree -r -l origin/rawdata "rawdata/АТ майнинг/" \
  | python3 build/build_kb.py data/fleet_books.json                        data/
python3 build/build_kb_text.py <repo_dir> data/kb.json                     data/
git ls-tree -r -l origin/rawdata "rawdata/АТ майнинг/" \
  | python3 build/build_drawings.py data/tree.json data/catalog.json       data/

# состав узлов из LinkOme (формат LinkOne разобран — build/linkone/,
# портировано из песочницы KOMATSU_PARTS_BOOK)
python3 build/unpack_linkome.py <rawdata_dir_с_zip_LinkOme> work/linkome
python3 build/build_linkome_catalog.py work/linkome data/tree.json \
  data/catalog.json data/fleet_books.json                                  data/
```

`build_tree.py` — первый шаг: даёт `tree.json` (дерево узлов) и
`fleet_books.json` (книга ↔ борт), которые нужны остальным.
`build_catalog.py` — второй: даёт `ekmtr_wk.json` (срез НСИ по WK),
нужный `build_stock.py`, `build_repairs.py` и `build_provision.py`.
`build_provision.py` — последний: ему нужен уже собранный `stock.json`.

**Обновление данных без Python.** Вкладка портала «Обновление данных»
пересобирает `stock.json` (остатки + ограниченный запас + закупки) прямо
в браузере — `lib/xlsx_stream.js` (потоковый разбор .xlsx, без SheetJS:
лист остатков занимает сотни МБ несжатого XML, у V8 предел строки
~512 МБ) + `lib/stock_pipeline.js` (та же логика колонок и агрегации, что
в `build_stock.py`, построчно). Проверено на реальных файлах — сходится
с офлайн-сборкой день в день, до рубля. Официальный путь обновления
данных — всё равно `build_stock.py` и коммит; браузерная пересборка даёт
предпросмотр и файл на скачивание, ничего не публикует сама.

## Правила, зашитые в сборку

- **Юани — только в каталоге.** `build_catalog.py` — единственное место,
  где остаётся цена в CNY. Everywhere else — рубли, как в самой выгрузке SAP.
- **Ограниченный и блокированный запас вычитается из доступного остатка**
  и подсвечивается отдельно (`build_stock.py`: `availQty`/`availValue` —
  доступно, `restrictedQty`/`restrictedValue` — есть, но нельзя;
  `fullyRestricted` — весь остаток ограничен). `build_provision.py`
  считает обеспеченность по `availQty`, не по валовому остатку.
- **Обеспеченность считается только по номенклатуре WK** (код входит в ППЗ
  3.1.2.7) — по прочим материалам, которые расходуют единицы WK (ГСМ,
  общий крепёж), этот `stock.json` остатка не знает, они помечаются
  `status: "notWkPart"`, а не ложно засчитываются в дефицит.
- **Дубли карточек КТГ схлопываются** по паре (площадка, точное имя борта):
  `build_fleet.py` берёт запись с непустым КТГ.

## LinkOme (формат LinkOne)

`build/linkone/` — декодер контейнера LinkOne/ImageLink (LZH-сжатие
внутри, «-lh5-»), портирован из соседней песочницы `KOMATSU_PARTS_BOOK`,
где тем же кодом читаются книги Komatsu. Для WK добавлена кодовая
страница 936 (GBK — китайские иероглифы; кириллица в тех же строках
декодируется тем же `gbk`). `build_linkome_catalog.py` даёт настоящий
состав узла (номер детали, наименование, количество), а не проекцию по
именам файлов — 73,9% узлов дерева и 75,4% позиций каталога. Растровые
чертежи (.ilg) этим декодером пока не читаются — см. `data/quality.json`.

## Известные пробелы

См. `data/quality.json` — четыре единицы парка не связаны с книгой
комплектации, 58% прайса без кода ЕКМТР, растровые чертежи LinkOme (.ilg)
не декодируются (текстовая часть — состав узла — декодируется, см. выше),
104 документа .doc/.ppt не индексируются для полнотекстового поиска
(LibreOffice headless не работает в этой песочнице). Раздел «Качество
данных» портала читает этот файл напрямую.
