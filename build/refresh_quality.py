#!/usr/bin/env python3
"""Refresh audit statements whose source logic is implemented by builders."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "quality.json"


def main():
    data = json.loads(PATH.read_text(encoding="utf-8"))
    issues = [x for x in data["issues"] if x.get("area") != "Парк — источник площадки"]
    data["issues"] = issues
    for item in issues:
        if item.get("area") == "Взаимозаменяемость":
            item["issue"] = (
                "Все 1 747 строк ведомости, содержащие не менее двух книг, прочитаны "
                "как прямые построчные связи. Признак «Да» не требуется: отметки и "
                "187 комментариев сохранены как доказательство и ограничение применения."
            )
            item["impact"] = (
                "Замены не теряются из-за пустого признака. Транзитивное объединение "
                "разных строк отключено, поэтому цепочка A=B и B=C сама по себе не "
                "объявляет A=C. Одинаковый номер в разных книгах хранится как идентичность."
            )
        elif item.get("area") == "Обеспеченность — границы расчёта":
            arr = item.get("issue") if isinstance(item.get("issue"), list) else [item.get("issue")]
            arr = [x for x in arr if x and "частичн" not in x.lower()]
            arr.append(
                "Частичное выполнение учитывается по остатку количества: открытая потребность "
                "равна max(план − факт, 0), а плановая стоимость уменьшается пропорционально."
            )
            item["issue"] = arr
            item["impact"] = (
                "Цифры обеспеченности верны в пределах перечисленных допущений по номенклатуре WK; "
                "частично выполненные строки больше не исключаются и не завышаются."
            )
        elif item.get("area") == "LinkOme ↔ Тех парк — новая книга K1861":
            item["issue"] = str(item["issue"]).replace("площадке 1200 (Сухой Лог)", "площадке 2400 (Сухой Лог)")
    issues.insert(1, {
        "area": "Парк — источник площадки",
        "issue": (
            "Для Сухого Лога и Вернинского принадлежность машины определяется заказами ТОРО/TOPO. "
            "Поле БЕ листа «Тех парк» не переопределяет площадку; оно используется только как подсказка."
        ),
        "impact": (
            "Парк, план-факт и обеспеченность используют единый код площадки из ТОРО. "
            "Excel связывает модель и гаражный номер с книгой и заводским номером только при однозначном совпадении."
        ),
    })
    PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
