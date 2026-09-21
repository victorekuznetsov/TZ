import importlib.util
import unittest
from pathlib import Path
from openpyxl import Workbook

spec = importlib.util.spec_from_file_location("tree", Path(__file__).resolve().parents[1] / "build/build_tree.py")
tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tree)


class InterchangeTest(unittest.TestCase):
    def test_every_excel_row_is_direct_relation(self):
        ws = Workbook().active
        headers = []
        for book in ("K1839", "K1849", "K1853", "K1866"):
            headers.extend(["Механизм", "Каталожный № узла " + book, "ZH", "RU", "qty", "id", "name"])
        ws.append(headers + ["Взаимозаменяемость", "1866&1853 Взаимозаменяемость", "Примечание"])
        row = []
        for num in ("A", "B", "C", "D"):
            row.extend([None, num, None, num, 1, None, None])
        ws.append(row + [None, "Идентичны", "Источник верен"])
        evidence = []
        tree.parse_sheet(ws, "WK-35", {}, evidence)
        groups, _ = tree.build_interchange_groups(evidence)
        self.assertEqual(groups, [["A", "B", "C", "D"]])
        self.assertEqual(evidence[0]["row"], 2)
        self.assertEqual(evidence[0]["note"], "Источник верен")
        self.assertEqual(evidence[0]["relation"], "row")

    def test_no_transitive_replacements(self):
        rows = [{"interchangeable": True, "parts": [{"num": a}, {"num": b}]} for a,b in [("A", "B"), ("B", "C")]]
        groups, _ = tree.build_interchange_groups(rows)
        self.assertEqual(groups, [["A", "B"], ["B", "C"]])

    def test_identical_numbers_keep_evidence(self):
        groups, _ = tree.build_interchange_groups([{"interchangeable": True, "parts": [{"num": "A"}, {"num": "A"}]}])
        self.assertEqual(groups, [["A"]])

    def test_row_without_yes_is_still_relation(self):
        ws = Workbook().active
        ws.append(["Механизм", "Каталожный № узла K1623", "ZH", "RU", "qty", "id", "name",
                   "Механизм", "Каталожный № узла K1626", "ZH", "RU", "qty", "id", "name",
                   "Взаимозаменяемость", "Примечание"])
        ws.append([None, "K1623.01.01.00", None, "A", 1, None, None,
                   None, "K1625.01.01.00", None, "B", 1, None, None,
                   None, "с указанным комментарием"])
        evidence = []
        tree.parse_sheet(ws, "WK-20", {}, evidence)
        groups, candidates = tree.build_interchange_groups(evidence)
        self.assertEqual(groups, [["K1623.01.01.00", "K1625.01.01.00"]])
        self.assertEqual(candidates, [])


if __name__ == "__main__":
    unittest.main()
