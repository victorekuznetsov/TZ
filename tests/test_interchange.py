import importlib.util
import unittest
from pathlib import Path
from openpyxl import Workbook

spec = importlib.util.spec_from_file_location("tree", Path(__file__).resolve().parents[1] / "build/build_tree.py")
tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tree)


class InterchangeTest(unittest.TestCase):
    def test_specific_flag_does_not_leak(self):
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
        self.assertEqual(groups, [["C", "D"]])
        self.assertEqual(evidence[0]["row"], 2)
        self.assertEqual(evidence[0]["note"], "Источник верен")

    def test_no_transitive_replacements(self):
        rows = [{"interchangeable": True, "parts": [{"num": a}, {"num": b}]} for a,b in [("A", "B"), ("B", "C")]]
        groups, _ = tree.build_interchange_groups(rows)
        self.assertEqual(groups, [["A", "B"], ["B", "C"]])

    def test_identical_numbers_keep_evidence(self):
        groups, _ = tree.build_interchange_groups([{"interchangeable": True, "parts": [{"num": "A"}, {"num": "A"}]}])
        self.assertEqual(groups, [["A"]])


if __name__ == "__main__":
    unittest.main()
