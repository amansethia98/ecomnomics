"""Drive the bot's own Chromium inside the restaurant's computer through rakazo-page-browser (no Playwright, no model).
Never returns or logs page text: callers get url/title/elements only (tree is dropped unless asked for in memory)."""
import json, re, subprocess, time

class PB:
    def __init__(self, container, display=':1', home='/home/rakazo'):
        self.c, self.display, self.home = container, display, home

    def _exec(self, argv, input_bytes=None, timeout=120):
        cmd = ['sudo', '-n', 'docker', 'exec', '-i', '-u', 'rakazo', '-e', f'DISPLAY={self.display}', '-e', f'HOME={self.home}',
               '-w', self.home, self.c, *argv]
        return subprocess.run(cmd, input=input_bytes, capture_output=True, timeout=timeout)

    def call(self, command, args=None, timeout=150):
        r = self._exec(['/usr/local/bin/rakazo-page-browser', command, json.dumps(args or {})], timeout=timeout)
        out = r.stdout.decode('utf-8', 'replace').strip().splitlines()
        try:
            return json.loads(out[-1]) if out else {'ok': False, 'error': 'no output'}
        except json.JSONDecodeError:
            return {'ok': False, 'error': 'unparseable helper output'}

    def navigate(self, url, downloads=None):
        a = {'url': url}
        if downloads: a['downloads'] = downloads
        return self.call('navigate', a)

    def snapshot(self, query=None):
        return self.call('snapshot', {'query': query} if query else {})

    def act(self, actions, downloads=None):
        a = {'actions': actions}
        if downloads: a['downloads'] = downloads
        return self.call('act', a)

    def wait_download(self, folder, pattern, since, timeout=120):
        return self.call('wait_download', {'dir': folder, 'pattern': pattern, 'since': since, 'timeout': timeout}, timeout=timeout + 30)

    def sh(self, script, input_bytes=None, timeout=60):
        return self._exec(['sh', '-c', script], input_bytes=input_bytes, timeout=timeout)

    def read_file(self, path, max_bytes=12_000_000):
        r = self._exec(['python3', '-c', 'import sys;p=sys.argv[1];d=open(p,"rb").read(int(sys.argv[2])+1);sys.stdout.buffer.write(d)', path, str(max_bytes)])
        if r.returncode != 0: raise RuntimeError('read failed')
        if len(r.stdout) > max_bytes: raise RuntimeError('file too large')
        return r.stdout

    def remove(self, path):
        return self._exec(['rm', '-f', '--', path]).returncode == 0

    def list_files(self, folder):
        r = self._exec(['python3', '-c', 'import os,sys,json;d=sys.argv[1];print(json.dumps([[n,os.path.getmtime(os.path.join(d,n)),os.path.getsize(os.path.join(d,n))] for n in os.listdir(d) if os.path.isfile(os.path.join(d,n))]) if os.path.isdir(d) else "[]")', folder])
        return json.loads(r.stdout or b'[]')

    def now(self):
        r = self._exec(['python3', '-c', 'import time;print(time.time())'])
        return float(r.stdout)

def controls(page):
    """[(ref, role, name, value)] from a page-browser result."""
    return [(e.get('ref'), e.get('role'), e.get('name') or '', e.get('value')) for e in (page.get('elements') or [])]

def mask(s):
    return re.sub(r'\d{6,}', lambda m: '#' * len(m.group()), s or '')
