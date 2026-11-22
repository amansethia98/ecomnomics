import json, subprocess, base64, os
HERE = os.path.dirname(os.path.abspath(__file__))
def check(image, kind, platform, report, period_start, period_end, restaurant_id, name, city, data: bytes = None, csv_text: str = None):
    body = {'kind': kind, 'platform': platform, 'report': report, 'periodStart': period_start, 'periodEnd': period_end,
            'restaurantId': restaurant_id or '', 'name': name, 'city': city}
    if kind == 'business': body['csv'] = csv_text
    else: body['fileBase64'] = base64.b64encode(data).decode()
    r = subprocess.run(['sudo', '-n', 'docker', 'run', '--rm', '-i', '--network', 'none', '-w', '/app/apps/api',
                        '-v', f'{HERE}/identity_check.mjs:/app/apps/api/fetch-identity-check.mjs:ro', '--entrypoint', 'node', image, '/app/apps/api/fetch-identity-check.mjs'],
                       input=json.dumps(body).encode(), capture_output=True, timeout=120)
    try: return json.loads(r.stdout)
    except Exception: return {'ok': False, 'reject': 'local_check_error: no result', 'warnings': [], 'periods': []}
