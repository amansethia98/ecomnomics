"""One bounded password login for a platform the session probe found signed out (Swiggy only).

Generic: the bot, operator session and credential env names come from the restaurant file:
  "logins": {"swiggy": {"auto": true, "username_env": "SWIGGY_USERNAME", "password_env": "SWIGGY_PASSWORD"}}
(defaults shown). Uses the proven opscheck3 method: ../live_runner_login.py (a bounded Grok login run in the
fetch bot's own computer, prompt ../login-swiggy-prompt.txt) + ../deliver_private_env.py (credentials go to the
private run-only login card; the model only uses fill_secret). Fill username, "Login with Password", fill password,
submit once. Never Resend OTP, never request or enter an OTP (the coordinator stops the run if an OTP card appears).

Rules: one attempt per restaurant+platform per IST night (marker file), cap INR 60 for the login run, only
05:30-07:30 IST unless allow_any_time (owner-started). Never logs credentials; only result codes and cost.
"""
import json, os, socket, subprocess, time
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
STACK = os.path.dirname(HERE)
IST = timezone(timedelta(hours=5, minutes=30))
CAP_INR = float(os.environ.get('ECOM_LOGIN_CAP_INR', '60'))
MAX_S = int(os.environ.get('ECOM_LOGIN_MAX_S', '900'))
SUPPORTED = {'swiggy'}
OK_RESULTS = ('SIGNED_IN', 'ALREADY_SIGNED_IN')

def _sh(*a, **k): return subprocess.run(list(a), capture_output=True, text=True, **k)

def _port_open(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0

def in_window(now=None):
    t = (now or datetime.now(IST)).astimezone(IST).time()
    return (t.hour, t.minute) >= (5, 30) and (t.hour, t.minute) < (7, 30)

def api_has_model_key(container='ecomnomics-agentv1-api-1'):
    return _sh('sudo', '-n', 'docker', 'exec', container, 'sh', '-c', 'test -n "$OPENROUTER_API_KEY"').returncode == 0

def attempt(platform, cfg, run_id, log, allow_any_time=False):
    """Returns {'attempted': bool, 'result': str, 'cost_inr': float, ...}. Never raises."""
    out = {'attempted': False, 'result': None, 'cost_inr': 0.0, 'cap_inr': CAP_INR}
    try:
        lc = {'auto': True, 'username_env': platform.upper() + '_USERNAME', 'password_env': platform.upper() + '_PASSWORD'}
        lc.update((cfg.get('logins') or {}).get(platform) or {})
        if platform not in SUPPORTED: out['result'] = 'not_supported'; return out
        if not lc.get('auto'): out['result'] = 'auto_login_off'; return out
        if not allow_any_time and not in_window(): out['result'] = 'outside_login_window'; return out
        if not (os.environ.get(lc['username_env']) and os.environ.get(lc['password_env'])): out['result'] = 'no_credentials'; return out
        if not os.environ.get('OPENROUTER_API_KEY'): out['result'] = 'no_model_key_for_meter'; return out
        if not api_has_model_key(): out['result'] = 'stack_started_without_model (rebuild with WITH_MODEL=1)'; return out
        if _port_open(8787): out['result'] = 'login_coordinator_busy'; return out
        night = datetime.now(IST).date().isoformat()
        mdir = os.path.join(HERE, 'logs', 'login-attempts'); os.makedirs(mdir, exist_ok=True)
        marker = os.path.join(mdir, f"{night}-{cfg['slug']}-{platform}.json")
        if os.path.exists(marker): out['result'] = 'already_attempted_tonight'; return out
        with open(marker, 'w') as f: json.dump({'runId': run_id, 'started': datetime.now(IST).isoformat(timespec='seconds')}, f)
        out['attempted'] = True
        rdir = os.path.join(HERE, 'logs', 'login-runs', f'{run_id}-{platform}'); os.makedirs(rdir, exist_ok=True)
        env = os.environ.copy()
        env.update({'OPSCHECK_RUN_CAP_INR': str(CAP_INR), 'OPSCHECK_JOB_CAP_INR': str(CAP_INR), 'OPSCHECK_TAG': run_id,
                    'LOGIN_OUT_DIR': rdir, 'LOGIN_BOT_ID': cfg['fetch_bot_id'], 'LOGIN_SESSION_FILE': cfg['session_file'],
                    'LOGIN_JOB_BUDGET_FILE': os.path.join(rdir, 'job-budget.json'),
                    'LOGIN_RECEIPT_FILE': os.path.join(rdir, 'private-delivery.json'),
                    'LOGIN_PROMPT_FILE': os.path.join(STACK, f'login-{platform}-prompt.txt'),
                    'LOGIN_MAX_S': str(MAX_S), 'LOGIN_DELIVERY_WAIT_S': str(min(600, MAX_S))})
        # the helpers read SWIGGY_USERNAME / SWIGGY_PASSWORD; map this restaurant's own env names onto them (env only, never argv)
        env[platform.upper() + '_USERNAME'] = os.environ[lc['username_env']]
        env[platform.upper() + '_PASSWORD'] = os.environ[lc['password_env']]
        coord_env = {k: v for k, v in env.items() if k not in (platform.upper() + '_PASSWORD',)}   # the coordinator never needs the password
        t0 = time.time()
        log.step('login_start', result='started', platform=platform, cap_inr=CAP_INR)
        with open(os.path.join(rdir, 'coordinator.log'), 'w') as clog, open(os.path.join(rdir, 'delivery.log'), 'w') as dlog:
            coord = subprocess.Popen(['python3', os.path.join(STACK, 'live_runner_login.py'), platform], cwd=STACK, env=coord_env, stdout=clog, stderr=subprocess.STDOUT)
            for _ in range(60):
                if _port_open(8787) or coord.poll() is not None: break
                time.sleep(1)
            deliv = subprocess.Popen(['python3', os.path.join(STACK, 'deliver_private_env.py'), platform], cwd=STACK, env=env, stdout=dlog, stderr=subprocess.STDOUT)
            try: coord.wait(timeout=MAX_S + 180)
            except subprocess.TimeoutExpired:
                coord.terminate(); coord.wait(timeout=30); out['stop'] = 'coordinator_timeout'
            try: deliv.wait(timeout=5)
            except subprocess.TimeoutExpired:
                deliv.terminate(); deliv.wait(timeout=10)
        out['secs'] = round(time.time() - t0, 1); out['delivery_exit'] = deliv.returncode; out['coordinator_exit'] = coord.returncode
        m = {}
        for name in ('measurement.json', 'state.json'):
            p = os.path.join(rdir, name)
            if os.path.exists(p):
                try: m = json.load(open(p)); break
                except Exception: pass
        out['cost_inr'] = round(float(m.get('cost_inr') or (m.get('cost_usd') or 0) * 85), 2)
        out['guard'] = m.get('guard_trigger'); out['stop_reason'] = m.get('stop_reason')
        text = (m.get('last_text') or '').upper()
        verdict = next((v for v in ('NEEDS_OWNER', 'ALREADY_SIGNED_IN', 'SIGNED_IN') if v in text), None)
        if m.get('needs_otp') or 'OTP' in (m.get('stop_reason') or ''): verdict = 'NEEDS_OWNER'
        out['result'] = verdict or ('guard_stop' if out['guard'] else 'no_verdict')
        with open(marker, 'w') as f: json.dump({'runId': run_id, 'result': out['result'], 'cost_inr': out['cost_inr'], 'secs': out['secs']}, f)
        return out
    except Exception as e:   # noqa: BLE001  never break the night
        out['result'] = 'login_error:' + type(e).__name__; return out
