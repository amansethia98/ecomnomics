"""Read-only diagnosis of the Zomato Weekly generator (no Generate click). Prints control roles/texts to stdout only."""
import json, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_night as rn, recipes
from pb import PB
from ui import Page
cfg = json.load(open(os.environ.get('RESTAURANT_CONFIG', 'restaurants/example-restaurant.template.json')))
token = open(cfg['token_env']).read().split('=', 1)[1].strip()
api = rn.Api(token, json.load(open(cfg['session_file'])))
bot = cfg['fetch_bot_id']
api.rpc('computer/boot', {'botId': bot}); api.rpc('computer/screenUrl', {'botId': bot})
for _ in range(30):
    c = rn.find_container(cfg['team_home']); d = c and rn.bot_display(c, bot)
    if d: break
    time.sleep(2)
assert rn.install_helper(c)
pb = PB(c, d); p = Page(pb)
def dump(tag):
    s = p.snap(); print('=====', tag, s['url'])
    for x in s['controls']:
        print(x['ref'], x['role'], repr(x['ntext'][:90]), x.get('value'), 'chk' if x.get('checked') else '', 'dis' if x.get('disabled') else '')
recipes.zomato_probe(p)
recipes.gclick(p, 'Business reports', settle=2)
p.wait_for('Generate report', timeout=30)
recipes.gclick(p, 'Generate report', settle=3)
p.wait_for('You are generating a report for', timeout=20)
recipes.gclick(p, 'Detailed report')
recipes.gclick(p, 'Weekly')
dump('after Weekly')
if len(sys.argv) > 1:
    recipes.gclick(p, 'Custom', settle=2); dump('after Custom')
    pb.call('screenshot', {'path': '/home/rakazo/aifb-weekly.png'}) if False else None
if len(sys.argv) > 2:
    recipes.gclick(p, 'Select weeks', settle=2); dump('after Select weeks')
    print('LINES:'); [print(' ', l[:100]) for l in p.page_lines()[-80:]]
