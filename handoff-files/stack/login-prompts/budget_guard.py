import threading,time,subprocess,unittest
FX=85

def decision(run_usd,job_usd):
 if run_usd>=300/FX:return 'per-run loose backstop (INR300)'
 if job_usd>=600/FX:return 'job loose backstop (INR600)'
 return None
class Guard:
 def __init__(self,meter,before,job_before,state,save,stop):
  self.meter=meter;self.before=before;self.job_before=job_before;self.state=state;self.save=save;self.stop=stop;self.end=threading.Event();self.thread=threading.Thread(target=self.loop,daemon=True)
 def abort(self,reason):
  if self.state.get('guard_trigger'):return
  self.state['guard_trigger']=reason;print('GUARD_STOP',reason,flush=True)
  try:self.save('state.json',self.state)
  except Exception:pass
  # Force-stop only the separate local executors even if supported stop hangs.
  threading.Thread(target=self.safe_stop,daemon=True).start()
  subprocess.run(['sudo','-n','docker','stop','--time','1','ecomnomics-agentv1-api-1','ecomnomics-agentv1-worker-1'],capture_output=True,timeout=15)
 def safe_stop(self):
  try:self.stop()
  except Exception:pass
 def loop(self):
  failures=0
  while not self.end.is_set():
   try:
    d=self.meter();v=d['total_usage'];failures=0
    self.state['key_meter_successes']=self.state.get('key_meter_successes',0)+1
    self.state['last_key_usage_usd']=v;self.state['key_meter_epoch']=time.time()
    cost=max(v-self.before,self.state.get('cost_usd',0));suite=max(v-self.job_before,self.before-self.job_before+cost)
    why=decision(cost,suite)
    if why:self.abort(why);return
   except Exception:
    failures+=1;self.state['key_meter_failures']=self.state.get('key_meter_failures',0)+1
    if failures>=3:self.abort('key meter unavailable after three bounded attempts');return
   self.end.wait(2)
 def start(self):self.thread.start()
 def close(self):self.end.set();self.thread.join(timeout=10)
