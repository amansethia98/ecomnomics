import sys,re,time;sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from pb import PB; from ui import Page
def select_outlet(p, rid):
    p.click('Outlets Filter', contains=True, settle=2)
    p.click('Filter by outlets', prefix=True, settle=1.5)
    d = p.snap()
    if not any(c['ntext'].startswith('Filter by outlets 0 of') for c in d['controls']):
        p.click('Select All', settle=1.5)
    d = p.snap()
    assert any(c['ntext'].startswith('Filter by outlets 0 of') for c in d['controls']), 'clear failed'
    sb = p.find('Search', role='textbox'); p.fill(sb['ref'], rid); time.sleep(2)
    d = p.snap()
    rows = [c for c in d['controls'] if re.search(r'\bRID: %s(?!\d)' % re.escape(rid), c['ntext']) and c['role'] == 'generic']
    assert rows, 'row missing'
    p.click_ref(rows[-1]['ref']); time.sleep(1.5)
    d = p.snap()
    assert any(c['ntext'].startswith('Filter by outlets 1 of') for c in d['controls']), 'not exactly one'
if __name__ == '__main__':
    import os
    container = os.environ.get('FETCH_COMPUTER_CONTAINER')
    rid = os.environ.get('SWIGGY_RID')
    if not container or not rid:
        raise SystemExit('set FETCH_COMPUTER_CONTAINER and SWIGGY_RID (do not hard-code live ids)')
    p=Page(PB(container))
    select_outlet(p, rid)
    p.click('Apply', role='button', settle=5)
    d=p.snap(); print([c['ntext'] for c in d['controls'] if 'Outlets Filter' in c['ntext']])
