import sys; sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from scrub import scrub
FAKE = ['9876501234', '+91 9876501234', 'otp: 482913', 'password=hunter2xyz', 'a.b@example.com', 'ABCDE1234F',
        'UTR 123456789012', 'Bearer abc.def.ghi', 'https://x.test/?token=sekrit&a=1', '482913 is your code']
def test_no_secret_survives():
    for f in FAKE:
        out = scrub('step ok ' + f)
        for bad in ['9876501234', '482913', 'hunter2xyz', 'a.b@example.com', 'ABCDE1234F', '123456789012', 'abc.def.ghi', 'sekrit']:
            assert bad not in out, (f, out)
def test_keeps_ids_and_dates():
    s = 'outlet ${ZOMATO_RES_ID} rid ${SWIGGY_RID} window 2026-11-07..2026-11-14 sha 1a2b3c4d5e6f'
    assert scrub(s) == s
def test_scrub_obj_keeps_json_valid():
    import json
    from scrub import scrub_obj
    rec = {'code': None, 'note': 'otp: 482913 sent to 9876501234', 'n': 5}
    out = json.loads(json.dumps(scrub_obj(rec)))
    assert out['code'] is None and '482913' not in out['note'] and '9876501234' not in out['note']
