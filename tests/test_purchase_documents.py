import unittest, tempfile
from pathlib import Path
from datetime import datetime
import openpyxl
from build.build_stock import parse_purchase

class PurchaseDocuments(unittest.TestCase):
    def test_preserves_document_lines_and_unknown_dates(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "purchase.xlsx"
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.append(["Код услуги", "еще поставить", "Количество в пути", "Общая стоимость", "Дата поставки", "Имя поставщика", "Валюта", "Дата заявки", "Количество", "Документ закупки", "Позиция", "ЕИ"])
            ws.append(["001", 2, 1, 120, datetime(2026,10,15), "Поставщик", "RUB", datetime(2026,9,1), 3, "00450001", "00010", "шт"])
            ws.append(["001", 1, 0, 40, None, "Поставщик", "RUB", None, 1, "00450001", "00020", "шт"])
            wb.save(path); wb.close()
            result = parse_purchase(path, {"001"})["byCode"]["001"]
            self.assertEqual(result["openQty"], 3)
            self.assertEqual(result["documents"][0]["document"], "00450001")
            self.assertEqual(result["documents"][0]["deliveryDate"], "2026-10-15")
            self.assertEqual(result["documents"][1]["deliveryDate"], "")
            self.assertEqual(result["byMonth"][""], 1)
