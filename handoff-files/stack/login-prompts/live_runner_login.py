from pathlib import Path
import requests,json,time,uuid,threading,re,sys,subprocess,os
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from dotenv import dotenv_values
import budget_guard
from budget_guard import Guard
import os
RUN_CAP_INR=float(os.environ.get('OPSCHECK_RUN_CAP_INR','220'));JOB_CAP_INR=float(os.environ.get('OPSCHECK_JOB_CAP_INR','420'))
def decision(run_usd,job_usd):
 if run_usd>=RUN_CAP_INR/85:return f'opscheck per-run cap (INR{RUN_CAP_INR:.0f})'
 if job_usd>=JOB_CAP_INR/85:return f'opscheck job cap (INR{JOB_CAP_INR:.0f})'
 return None
budget_guard.decision=decision
P=Path(__file__).parent; PLATFORM=sys.argv[1];TAG=os.environ.get('OPSCHECK_TAG','r3');OUT=Path(os.environ.get('LOGIN_OUT_DIR') or P/('login-'+PLATFORM+'-'+TAG));OUT.mkdir(parents=True,exist_ok=True)
# Generic: the nightly runner passes the restaurant's own fetch bot and operator session (LOGIN_BOT_ID / LOGIN_SESSION_FILE).
BOT=os.environ.get('LOGIN_BOT_ID') or next(b['id'] for b in json.loads((P/'bots-list.json').read_text()) if b['spawnKey']=='restaurant-template:payouts')
KEY=os.environ['OPENROUTER_API_KEY'];COOKIES=json.loads(Path(os.environ.get('LOGIN_SESSION_FILE') or P/'private'/'session.json').read_text());secrets=[];lock=threading.RLock()
state={'finished':False,'platform':PLATFORM,'run_ids':[],'per_run_cap_inr':RUN_CAP_INR,'job_cap_inr':JOB_CAP_INR}
def safe(x):
 if isinstance(x,dict):return {k:('[private]' if k in ['answer','fields','password','username'] else safe(v)) for k,v in x.items()}
 if isinstance(x,list):return [safe(v) for v in x]
 if isinstance(x,str):
  for val in secrets:
   if val:x=x.replace(val,'[private]')
 return x
def save(name,x):(OUT/name).write_text(json.dumps(safe(x),indent=2))
def rpc(path,body=None):
 r=requests.post('http://127.0.0.1:3320/rpc/'+path,headers={'Origin':'http://127.0.0.1:5523'},cookies=COOKIES,json={'json':body or {}},timeout=20);r.raise_for_status();d=r.json();return d.get('json',d)
def credits():
 r=requests.get('https://openrouter.ai/api/v1/key',headers={'Authorization':'Bearer '+KEY},timeout=(3,5));r.raise_for_status();d=r.json()['data'];return {'total_usage':d['usage'],'total_credits':d['usage']+d['limit_remaining']}
def pending(t):return [(m,b) for m in t.get('messages',[]) for b in m.get('blocks',[]) if b.get('kind')=='ask' and b.get('status')=='pending']
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps(safe(state)).encode())
 def do_POST(self):
  try:
   if self.path=='/legacy-code':
    data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
    with lock:
     if PLATFORM!='zomato' or state['finished'] or not state.get('needs_owner_code') or state.get('code_delivery_attempted'):raise ValueError()
     value=data['answer'].strip()
     if not re.fullmatch(r'[A-Za-z0-9]{6}',value):raise ValueError()
     t=rpc('threads/get',{'botId':BOT})
     if t.get('activeRuns') or pending(t):raise ValueError()
     state['code_delivery_attempted']=True;secrets.append(value)
     delivered=rpc('threads/send',{'botId':BOT,'text':value,'clientNonce':str(uuid.uuid4())})
     state['run_ids'].append(delivered['runId']);state['code_reply_delivered']=True;state['needs_owner_code']=False;state['code_reply_delivered_epoch']=time.time();save('state.json',state)
    self.send_response(200);self.end_headers();self.wfile.write(b'{"ok":true}');return
   if self.path!='/private-answer':raise ValueError()
   data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
   with lock:
    if state['finished'] or state.get('private_answered'):raise ValueError()
    t=rpc('threads/get',{'botId':BOT});asks=pending(t)
    if len(asks)!=1 or (t.get('run')or{}).get('status')!='waiting_input':raise ValueError()
    m,b=asks[0];body={'botId':BOT,'runId':t['run']['id'],'messageId':m['id'],'answer':''}
    if b.get('purpose')=='otp' or b.get('oneTimeCode'):
     if PLATFORM!='zomato':raise ValueError()
     value=data['answer'].strip()
     if not re.fullmatch(r'[A-Za-z0-9]{4,12}',value):raise ValueError()
     secrets.append(value);body['answer']=value
    elif b.get('purpose') in ['login','password'] or (b.get('credential') or {}).get('auth',{}).get('type')=='login':
     if PLATFORM!='swiggy':raise ValueError()
     fields=data['fields'];secrets.extend(f['value'] for f in fields);body.update({'fields':fields,'remember':False})
    else:raise ValueError()
    rpc('threads/answer',body);state['private_answered']=True;state['needs_otp']=False;state['needs_login']=False;state['private_answered_epoch']=time.time();save('state.json',state)
   self.send_response(200);self.end_headers();self.wfile.write(b'{"ok":true}')
  except Exception:
   self.send_response(400);self.end_headers();self.wfile.write(b'{"ok":false}')
threading.Thread(target=lambda:ThreadingHTTPServer(('127.0.0.1',8787),Handler).serve_forever(),daemon=True).start()
resume=len(sys.argv)>2 and sys.argv[2]=='resume'
previous=json.loads((OUT/'state.json').read_text()) if resume else {}
start=previous.get('started_epoch',time.time());base=credits();base['total_usage']=previous.get('baseline_usage_usd',base['total_usage']);job=Path(os.environ.get('LOGIN_JOB_BUDGET_FILE') or P/'login-pay11-job-budget.json')
if job.exists():jobbase=json.loads(job.read_text())['key_usage_before_usd']
else:jobbase=base['total_usage'];job.write_text(json.dumps({'key_usage_before_usd':jobbase,'started_epoch':start,'cap_inr':JOB_CAP_INR}))
assert base['total_usage']-jobbase<JOB_CAP_INR/85-10/85,'opscheck budget exhausted'
assert base['total_credits']-base['total_usage']>150/85,'Insufficient credits'
state.update(previous);state.update({'finished':False,'per_run_cap_inr':RUN_CAP_INR,'job_cap_inr':JOB_CAP_INR})
state.update({'started_epoch':start,'baseline_usage_usd':base['total_usage'],'job_baseline_usd':jobbase,'cost_usd':0})
guard=Guard(credits,base['total_usage'],jobbase,state,save,lambda:rpc('threads/stop',{'botId':BOT}));guard.start();save('state.json',state)
def soft_stop():
 # time limits stop only the login thread; the API stays up (budget overruns still hard-stop via the guard)
 try:rpc('threads/stop',{'botId':BOT})
 except Exception:guard.abort('soft stop failed')
last=None;us=[];injected=False
try:
 if not resume:
  rpc('threads/clear',{'botId':BOT})
  d=rpc('threads/send',{'botId':BOT,'text':Path(os.environ.get('LOGIN_PROMPT_FILE') or P/('login-'+PLATFORM+'-prompt.txt')).read_text(),'clientNonce':str(uuid.uuid4())});state['run_ids'].append(d['runId'])
 print('MONITORING opscheck',PLATFORM,'Grok4.7; run cap',RUN_CAP_INR,'job cap',JOB_CAP_INR,flush=True)
 idle=None;failures=0
 MAX_S=float(os.environ.get('LOGIN_MAX_S','2100'))
 while time.time()-start<MAX_S and not state.get('guard_trigger'):
  time.sleep(3)
  if False:
   names=subprocess.run(['sudo','-n','docker','ps','--filter','ancestor=ecomnomics/otp71-mounted-test:local','--format','{{.Names}}'],capture_output=True,text=True,check=True).stdout.splitlines()
   if len(names)==1 and subprocess.run(['sudo','-n','docker','exec',names[0],'true'],capture_output=True).returncode==0:
    con=names[0]
    try:
     subprocess.run(['sudo','-n','docker','exec',con,'mkdir','-p','/home/rakazo/.local/share/payout-reconciliation'],check=True,capture_output=True)
     for src,dst in [('/workspace/recon-skill/outlet-settings.json','zomato-settings.json'),('/workspace/recon-skill/swiggy-settings.json','swiggy-settings.json')]:
      subprocess.run(['sudo','-n','docker','exec','-i',con,'python3','-c','from pathlib import Path;import sys;Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())','/home/rakazo/.local/share/payout-reconciliation/'+dst],input=Path(src).read_bytes(),check=True,capture_output=True)
     state['container']=con;state['config_ready']=True;injected=True
    except subprocess.CalledProcessError:
     state['provisioning_failures']=state.get('provisioning_failures',0)+1
     if state['provisioning_failures']>=5:guard.abort('normal-user config provisioning failed');break
  try:t=rpc('threads/get',{'botId':BOT});usage=rpc('usage/list');failures=0
  except Exception:
   failures+=1
   if failures>=3:guard.abort('thread or local meter unavailable');break
   continue
  last=t;us=[u for u in usage if u.get('runId') in state['run_ids']];cost=sum(u.get('costUsd') or 0 for u in us);status=(t.get('run')or{}).get('status');asks=pending(t)
  if status=='waiting_takeover':state['stop_reason']='Native browser requested human takeover';rpc('threads/stop',{'botId':BOT});break
  state['needs_otp']=status=='waiting_input' and any(b.get('purpose')=='otp' or b.get('oneTimeCode') for _,b in asks)
  state['needs_login']=status=='waiting_input' and any(b.get('purpose') in ['login','password'] or (b.get('credential') or {}).get('auth',{}).get('type')=='login' for _,b in asks)
  if PLATFORM=='swiggy' and state['needs_otp']:state['stop_reason']='Swiggy unexpectedly required OTP; no code requested by coordinator';rpc('threads/stop',{'botId':BOT});break
  waiting=state['needs_otp'] or state['needs_login']
  if waiting:
   if not state.get('private_wait_started_epoch'):state['private_wait_started_epoch']=time.time();print('WAITING_PRIVATE',PLATFORM,'OTP' if state['needs_otp'] else 'LOGIN',flush=True)
   state['pending']=[{'messageId':m['id'],'purpose':b.get('purpose'),'oneTimeCode':b.get('oneTimeCode'),'login':b.get('login')} for m,b in asks]
   if time.time()-state['private_wait_started_epoch']>600:state['stop_reason']='Private-input wait timeout';soft_stop();break
  active=not waiting and (bool(t.get('activeRuns')) or status in ['running','queued','resuming'])
  botmsgs=[m for m in t.get('messages',[]) if m.get('role')=='bot'];text='\n'.join(b.get('text','') for m in botmsgs[-1:] for b in m.get('blocks',[]) if b.get('kind')=='text')
  files=[b for m in botmsgs for b in m.get('blocks',[]) if b.get('kind') in ['file','image']]
  state.update({'elapsed_s':round(time.time()-start,2),'status':status,'active':active,'cost_usd':max(cost,state.get('last_key_usage_usd',base['total_usage'])-base['total_usage']),'last_text':text[-8000:],'files':files,'models':sorted(set(u.get('model','') or u.get('modelId','') for u in us))});state['cost_inr']=state['cost_usd']*85;save('state.json',state)
  if decision(state['cost_usd'],base['total_usage']-jobbase+state['cost_usd']):guard.abort('local usage safety reserve');break
  if PLATFORM=='zomato' and not state.get('code_reply_delivered') and not active and 'AWAITING_OWNER_CODE' in text:
   state['needs_owner_code']=True
   if not state.get('owner_code_wait_started_epoch'):
    state['owner_code_wait_started_epoch']=time.time();print('WAITING_OWNER_CODE zomato',flush=True)
   save('state.json',state)
   if time.time()-state['owner_code_wait_started_epoch']>420:
    state['stop_reason']='Owner-code wait timeout';guard.abort('owner-code wait timeout');break
   idle=None;continue
  if waiting:idle=None;continue
  if not active:
   if idle is None:idle=time.time()
   elif time.time()-idle>8:break
  else:idle=None
 else:
  if time.time()-start>=MAX_S:state['stop_reason']='Task timeout';soft_stop()
except Exception:
 state['stop_reason']='Coordinator exception: fail-closed';guard.abort('coordinator exception');raise
finally:
 guard.close()
 if last:
  clean=dict(last);clean['messages']=[dict(m,blocks=[{'kind':'text','text':'[user input omitted]'}]) if m.get('role')=='user' else m for m in last.get('messages',[])];save('thread.json',clean);save('usage.json',us)
 try:
  end=credits();state.update({'remaining_after_usd':end['total_credits']-end['total_usage'],'key_usage_after_usd':end['total_usage'],'job_spend_usd':end['total_usage']-jobbase});state['cost_usd']=max(state.get('cost_usd',0),end['total_usage']-base['total_usage']);state['cost_inr']=85*state['cost_usd']
 except Exception:pass
 state['finished']=True;state['wall_s']=round(time.time()-start,3);save('measurement.json',state);save('state.json',state);print(json.dumps(safe({k:v for k,v in state.items() if k not in ['last_text','pending','files']})),flush=True)
