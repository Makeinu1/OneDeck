#!/usr/bin/env python3
"""Live, isolated-browser publication smoke. Never reads a user's browser profile."""
import argparse
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ap = argparse.ArgumentParser()
ap.add_argument('url')
ap.add_argument('source_sha')
ap.add_argument('--output', default='smoke-results')
args = ap.parse_args()
parsed = urlparse(args.url)
if parsed.scheme != 'https' or not re.fullmatch(r'(?:[a-zA-Z0-9-]+\.)?onedeck-play\.pages\.dev', parsed.hostname or ''):
    ap.error('Only this project\'s Pages domains are accepted')
if not re.fullmatch(r'[a-f0-9]{40}', args.source_sha):
    ap.error('An exact source commit is required')
base = args.url.rstrip('/')
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
report = {'source_commit': args.source_sha, 'url': base, 'result': 'FAIL', 'checks': [], 'page_errors': [], 'http_errors': []}
started = time.monotonic()

# A normal stored deck, not a stubbed engine or fabricated GameState.
# Python add_init_script evaluates a script: it must invoke its initializer.
seed = '''(() => {
  if (!location.hostname.endsWith('onedeck-play.pages.dev')) return;
  if (!localStorage.getItem('onedeck-smoke-seeded')) {
    localStorage.setItem('phase-deck:Deployment Smoke', JSON.stringify({
      main: [{count: 99, name: 'Plains'}], sideboard: [], commander: ['Isamaru, Hound of Konda']
    }));
    localStorage.setItem('phase-active-deck', 'Deployment Smoke');
    localStorage.setItem('onedeck-smoke-seeded', 'yes');
  }
})();'''

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='en-US')
    context.add_init_script(seed)
    page = context.new_page()
    page.set_default_timeout(120000)
    page.on('pageerror', lambda error: report['page_errors'].append(str(error)[:1500]))
    def record_response(response):
        if response.status >= 400:
            u = urlparse(response.url)
            report['http_errors'].append({'host': u.hostname, 'path': u.path, 'status': response.status})
    page.on('response', record_response)
    try:
        response = page.goto(base + '/setup?format=Commander', wait_until='domcontentloaded', timeout=60000)
        assert response and response.ok, 'Direct /setup navigation failed'
        manifest = page.evaluate("async () => { const r = await fetch('/onedeck-build.json'); if (!r.ok) throw Error('Build provenance missing'); return r.json(); }")
        assert manifest['source_commit'] == args.source_sha, 'Wrong published build'
        report['checks'].append('exact published source commit read inside the browser')
        assert page.evaluate("localStorage.getItem('phase-active-deck')") == 'Deployment Smoke', 'Test deck was not seeded'
        start = page.get_by_role('button', name=re.compile(r'^Start Match', re.I))
        expect(start).to_be_enabled(timeout=180000)
        page.screenshot(path=str(out / 'setup-desktop.png'), full_page=True)
        report['checks'].append('setup renders with selected stored Commander deck')
        page.reload(wait_until='domcontentloaded', timeout=60000)
        expect(start).to_be_enabled(timeout=120000)
        report['checks'].append('direct setup reload works')
        start.click()
        page.wait_for_url(re.compile(r'/game/'), timeout=120000)
        keep = page.get_by_role('button', name=re.compile(r'^Keep', re.I)).first
        expect(keep).to_be_visible(timeout=180000)
        page.screenshot(path=str(out / 'opening-hand.png'), full_page=True)
        report['checks'].append('real WASM game initialized and opening hand offered')
        keep.click()
        expect(keep).not_to_be_visible(timeout=120000)
        page.wait_for_timeout(3000)
        text = page.locator('body').inner_text()
        assert re.search(r'Plains|Isamaru', text), 'Game board has no expected card identity'
        assert not re.search(r'Engine connection lost|Failed to initialize|Unhandled error', text, re.I), 'Game error shown'
        page.screenshot(path=str(out / 'game-started.png'), full_page=True)
        report['checks'].append('mulligan keep submitted through production UI and game board visible')
        assert not report['page_errors'], 'Uncaught browser exceptions'
        response = page.goto(base + '/setup?format=Commander', wait_until='domcontentloaded', timeout=60000)
        assert response and response.ok
        page.set_viewport_size({'width': 390, 'height': 844})
        expect(start).to_be_visible(timeout=120000)
        page.screenshot(path=str(out / 'setup-mobile.png'), full_page=True)
        assert not report['page_errors'], 'Uncaught browser exceptions after navigation'
        report['checks'].append('mobile setup route renders')
        report['result'] = 'PASS'
    finally:
        try:
            (out / 'last-screen.txt').write_text(page.locator('body').inner_text()[:16000], encoding='utf-8')
            page.screenshot(path=str(out / 'last-screen.png'), full_page=True, timeout=10000)
        except Exception:
            pass
        report['elapsed_seconds'] = round(time.monotonic() - started, 2)
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, indent=2))
        browser.close()
