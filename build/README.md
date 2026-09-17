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
```

`build_tree.py` — первый шаг: даёт `tree.json` (дерево узлов) и
`fleet_books.json` (книга ↔ борт), которые нужны остальным.
`build_catalog.py` — второй: даёт `ekmtr_wk.json` (срез НСИ по WK),
нужный `build_stock.py`, `build_repairs.py` и `build_provision.py`.
`build_provision.py` — последний: ему нужен уже собранный `stock.json`.

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

## Известные пробелы

См. `data/quality.json` — четыре единицы парка не связаны с книгой
комплектации, два архива LinkOme неполные, 58% прайса без кода ЕКМТР.
Раздел «Качество данных» портала читает этот файл напрямую.
