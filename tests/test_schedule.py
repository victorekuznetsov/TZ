import json, re, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class ScheduleDataTest(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  def payload(name):
   raw=(ROOT/'data'/f'{name}.local.js').read_text();return json.loads(re.search(r'=({.*});\s*$',raw).group(1))
  cls.d=payload('schedule_manifest');cls.rows=[]
  for name in cls.d['shards']:
   part=payload(name);cls.rows += [dict(zip(part['columns'],[part['dictionaries'][k][v] if k in part['dictionaries'] else v for k,v in zip(part['columns'],row)])) for row in part['rows']]
 def test_counts_and_identifiers(self):
  m=self.d['meta'];self.assertEqual(len(self.rows),m['lines']);self.assertEqual(len({r['orderId'] for r in self.rows}),m['orders']);self.assertEqual(len({r['unitId'] for r in self.rows}),m['units']);self.assertEqual(sum(len(r['sourceRows']) for r in self.rows),m['rawRows'])
 def test_reconciles_existing_repairs(self):
  old=json.loads((ROOT/'data/repairs.json').read_text())['meta']
  self.assertAlmostEqual(sum(r['p'] or 0 for r in self.rows),old['planTotal'],places=2)
  self.assertAlmostEqual(sum(r['a'] or 0 for r in self.rows),old['factTotal'],places=2)
  self.assertEqual(sum(len(r['sourceRows']) for r in self.rows),old['rowsTotal'])
 def test_truthful_capabilities(self):
  m=self.d['meta'];self.assertFalse(m['actualWorkDatesAvailable']);self.assertFalse(m['completionStatusesAvailable']);self.assertFalse(m['dependenciesAvailable']);self.assertFalse(m['quantityUnitsAvailable'])
 def test_date_and_quantity_boundaries(self):
  for r in self.rows:
   if r['start'] and r['end'] and not r['badDate']:self.assertLessEqual(r['start'],r['end'])
   if r['remainingQty'] is not None:self.assertGreaterEqual(r['remainingQty'],0)
if __name__=='__main__':unittest.main()
