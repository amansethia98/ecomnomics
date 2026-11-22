import sys,re,time;sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from ui import Page, UiChanged
def pick_generic(p, pattern, step):
    d = p.snap()
    g = [c for c in d['controls'] if c['role'] == 'generic' and re.fullmatch(pattern, c['ntext'])]
    if not g: raise UiChanged(step)
    p.click_ref(g[-1]['ref'], step=step); time.sleep(1.2)
    d = p.snap()
    cb = [c for c in d['controls'] if c['role'] == 'checkbox' and re.fullmatch(pattern, c['ntext'])]
    if not cb or not cb[-1]['checked']: raise UiChanged(step + ':not_ticked')
def open_download_panel(p, brand, city, rid):
    p.click('Download Report', role='button', step='s1_download_report', settle=3)
    pick_generic(p, re.escape(brand) + r' \d+ Cit(y|ies)', 's1_brand')
    p.click('CONTINUE', role='button', step='s1_brand_continue', settle=3)
    pick_generic(p, re.escape(city) + r' \d+ Outlets?', 's1_city')
    p.click('CONTINUE', role='button', step='s1_city_continue', settle=3)
    pick_generic(p, r'.* RID: ' + re.escape(rid), 's1_outlet')
    d = p.snap()
    ticked = [c for c in d['controls'] if c['role'] == 'checkbox' and c['checked']]
    if len(ticked) != 1 or not re.search(r'RID: %s$' % re.escape(rid), ticked[0]['ntext']): raise UiChanged('s1_outlet:not_exactly_one')
    p.click('CONTINUE', role='button', step='s1_outlet_continue', settle=3)
    p.wait_text('1 Outlet Selected', step='s1_one_outlet_selected', timeout=15)
