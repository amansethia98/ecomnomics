"""Read a masked-card environment value in a NEW process; never persist or display it."""
import os,sys,time,json,requests
from pathlib import Path
from urllib.parse import urlparse
P=Path(__file__).parent
platform=sys.argv[1]
name={'swiggy':'SWIGGY_PASSWORD','zomato':'ZOMATO_OTP'}[platform]
value=os.environ.get(name)
if not value:print('Required masked-card environment value is unavailable');sys.exit(2)
# Only public account identifier; the password/code never appears in this source.
phone=os.environ.get('SWIGGY_USERNAME')
cookies=json.loads(Path(os.environ.get('LOGIN_SESSION_FILE') or P/'private'/'session.json').read_text())
bot=os.environ.get('LOGIN_BOT_ID') or next(b['id'] for b in json.loads(P.joinpath('bots-list.json').read_text()) if b['spawnKey']=='restaurant-template:payouts')
def rpc(path,body):
 r=requests.post('http://127.0.0.1:3320/rpc/'+path,headers={'Origin':'http://127.0.0.1:5523'},cookies=cookies,json={'json':body},timeout=10)
 r.raise_for_status();d=r.json();return d.get('json',d)
end=time.monotonic()+float(os.environ.get('LOGIN_DELIVERY_WAIT_S','600'))
while time.monotonic()<end:
 try:
  t=rpc('threads/get',{'botId':bot});asks=[b for m in t.get('messages',[]) for b in m.get('blocks',[]) if b.get('kind')=='ask' and b.get('status')=='pending']
  if (t.get('run') or {}).get('status')=='waiting_input' and len(asks)==1:
   b=asks[0];origin=(b.get('oneTimeCode') or b.get('credential') or {}).get('origin','');u=urlparse(origin);domain='swiggy.com' if platform=='swiggy' else 'zomato.com'
   if u.scheme!='https' or not (u.hostname==domain or (u.hostname or '').endswith('.'+domain)):raise ValueError('wrong destination')
   if platform=='swiggy':
    if (b.get('credential') or {}).get('auth',{}).get('type')!='login':raise ValueError('unexpected secret request')
    fields=[]
    for label in b.get('loginFields') or ['Username','Password']:
     if label.lower()=='password':fields.append({'label':label,'value':value,'hidden':True})
     elif label.lower() in ['username','phone','phone number','mobile','mobile number']:fields.append({'label':label,'value':phone,'hidden':False})
     else:raise ValueError('unexpected login field')
    if not any(f['hidden'] for f in fields):raise ValueError('no password field')
    if any(not f['value'] for f in fields):raise ValueError('missing username environment value')
    body={'fields':fields}
   else:
    if b.get('purpose')!='otp' or not b.get('oneTimeCode'):raise ValueError('unexpected code request')
    body={'answer':value.strip()}
   receipt=Path(os.environ.get('LOGIN_RECEIPT_FILE') or P/(platform+'-private-delivery.json'))
   if receipt.exists() and json.loads(receipt.read_text()).get('runId')==t['run']['id']:raise ValueError('already delivered for this run')
   message=next(m for m in t['messages'] if b in m.get('blocks',[]))
   answer={'botId':bot,'runId':t['run']['id'],'messageId':message['id'],'answer':''}
   if platform=='swiggy':answer.update(body);answer['remember']=False
   else:answer.update(body)
   response=requests.post('http://127.0.0.1:8787/private-answer',json=body,timeout=20)
   if not response.ok or not response.json().get('ok'):raise ValueError('private input refused')
   receipt.write_text(json.dumps({'delivered':True,'origin':origin,'runId':t['run']['id'],'delivered_epoch':time.time()}))
   print('Private environment value accepted by the supported card endpoint; no secret displayed or saved.');sys.exit(0)
  if (t.get('run') or {}).get('status') in ['cancelled','failed','completed']:print('Run ended without accepting a private value');sys.exit(3)
 except requests.ConnectionError:pass
 except Exception:print('Private delivery refused; no automatic replay');sys.exit(4)
 time.sleep(2)
print('Private card did not become ready within delivery wait');sys.exit(5)
