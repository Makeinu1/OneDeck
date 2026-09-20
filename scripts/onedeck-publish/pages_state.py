#!/usr/bin/env python3
"""Read only the allowlisted public Pages deployment identity, never its variables."""
import argparse
import json
import os
import re
from pathlib import Path
import urllib.error
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--output', type=Path)
ap.add_argument('--unchanged-from', type=Path)
args = ap.parse_args()
account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '').strip()
token = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
if not re.fullmatch(r'[a-fA-F0-9]{32}', account) or not token or re.search(r'\s', token):
    raise SystemExit('Cloudflare credentials are missing or malformed; values withheld')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
url = f'https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/onedeck-play'
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
try:
    with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
except urllib.error.HTTPError as error:
    raise SystemExit(f'Pages lookup HTTP {error.code}; response and credentials withheld')
except (urllib.error.URLError, TimeoutError, OSError):
    raise SystemExit('Could not establish Pages state; no promotion is allowed')
if len(raw) > 2 * 1024 * 1024:
    raise SystemExit('Unexpected project metadata size')
data = json.loads(raw)
if not isinstance(data, dict) or data.get('success') is not True:
    raise SystemExit('Pages did not confirm successful project lookup')
project = data.get('result')
if not isinstance(project, dict) or project.get('name') != 'onedeck-play' or project.get('subdomain') != 'onedeck-play.pages.dev':
    raise SystemExit('Wrong Pages project')
if project.get('production_branch') != 'main':
    raise SystemExit('Production branch changed; publication requires reinspection')
deployment = project.get('canonical_deployment') or {}
id_ = deployment.get('id')
if not isinstance(id_, str) or not re.fullmatch(r'[a-f0-9-]{8,64}', id_):
    raise SystemExit('Cannot identify the current production deployment')
state = {'project': 'onedeck-play', 'production_branch': 'main', 'deployment_id': id_}
if args.unchanged_from:
    previous = json.loads(args.unchanged_from.read_text())
    if previous != state:
        raise SystemExit('Production changed after preview began; refusing to overwrite it')
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(state, indent=2) + '\n')
print(json.dumps(state))
