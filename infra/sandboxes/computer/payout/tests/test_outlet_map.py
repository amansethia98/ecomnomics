import unittest,tempfile,csv
from pathlib import Path
from outlet_map import FIELDS,pair,load_confirmed,normalize
class Mapping(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.path=Path(self.tmp.name)/'map.csv';self.z=dict(outlet='DEMO_OUTLET',outlet_id='ZOMATO_TEST_OUTLET');self.s=dict(outlet='DEMO_OUTLET',outlet_id='SWIGGY_TEST_OUTLET')
 def write(self,rows):
  with self.path.open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=FIELDS);w.writeheader();w.writerows(rows)
 def row(self):return dict(outlet='DEMO_OUTLET',locality='DEMO_LOCALITY',zomato_id='ZOMATO_TEST_OUTLET',swiggy_rid='SWIGGY_TEST_OUTLET')
 def test_confirmed_pair(self):
  self.write([self.row()]);self.assertTrue(pair(self.z,self.s,self.path)['confirmed'])
 def test_missing_map_uncertain(self):self.assertFalse(pair(self.z,self.s,self.path)['confirmed'])
 def test_header_only_uncertain(self):self.write([]);self.assertFalse(pair(self.z,self.s,self.path)['confirmed'])
 def test_different_city_refused(self):
  self.z['city']='CITY_ONE';self.s['city']='CITY_TWO'
  with self.assertRaisesRegex(ValueError,'Different city'):pair(self.z,self.s,self.path)
 def test_different_locality_refused(self):
  self.z['locality']='AREA_ONE';self.s['locality']='AREA_TWO'
  with self.assertRaisesRegex(ValueError,'Different locality'):pair(self.z,self.s,self.path)
 def test_conflicting_owner_ids_refused(self):
  self.write([self.row()]);self.s['outlet_id']='OTHER_TEST_OUTLET'
  with self.assertRaisesRegex(ValueError,'conflicts'):pair(self.z,self.s,self.path)
 def test_duplicate_mapping_refused(self):
  self.write([self.row(),self.row()])
  with self.assertRaisesRegex(ValueError,'duplicate'):load_confirmed(self.path)
 def test_placeholder_not_owner_confirmation(self):
  row=self.row();row['locality']='<Locality>';self.write([row])
  with self.assertRaisesRegex(ValueError,'placeholders'):load_confirmed(self.path)
 def test_normalization(self):self.assertEqual(normalize('The DEMO & Co.'),'demo and co')
 def test_different_names_refused(self):
  self.s['outlet']='OTHER_DEMO_OUTLET'
  with self.assertRaisesRegex(ValueError,'Different outlet names'):pair(self.z,self.s,self.path)
