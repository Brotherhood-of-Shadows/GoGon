import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Python helper keeps stage/page diagnostics out of cookie stdout and preserves timeout cleanup', () => {
  // Browser dependencies are doubles: this exercises the helper itself without launching Chromium,
  // interacting with verification, submitting credentials or making any network request.
  const script = `
import asyncio, importlib.util, json, os, sys, types
sys.dont_write_bytecode = True
os.environ['GG_GUIDE_CHROMIUM_PATH'] = '/fixture/chromium'
mode = 'success'
stopped = []
class Tab:
    async def get_content(self):
        return '<form id="m-login-form">private-page-content</form>' if mode == 'success' else '<title>Just a moment...</title>private-page-content'
    async def evaluate(self, expression):
        return 'Chromium fixture'
class Cookies:
    async def get_all(self):
        return [types.SimpleNamespace(name='cf_clearance', value='private-cookie-fixture', domain='.huntedcow.com', path='/', secure=True)]
class Browser:
    cookies = Cookies()
    async def get(self, url):
        if mode == 'navigation':
            await asyncio.Future()
        return Tab()
    def stop(self):
        stopped.append(mode)
async def start(**kwargs):
    return Browser()
async def verification(tab, profile):
    await helper.account_is_loaded(tab)
    raise TimeoutError('fixture verification timeout')
sys.modules['nodriver'] = types.SimpleNamespace(start=start)
sys.modules['challenge_browser'] = types.SimpleNamespace(click_verification=verification)
sys.modules['guide_browser_environment'] = types.SimpleNamespace(prepare_browser_environment=lambda profile: None)
spec = importlib.util.spec_from_file_location('sso_fixture', 'scripts/control-plane/renew-sso-clearance.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
async def no_account(tab, seconds):
    return False
async def run():
    global mode
    await helper.renew('https://huntedcow.com/auth?game=6')
    mode = 'navigation'
    print('CASE:navigation', file=sys.stderr)
    try:
        await asyncio.wait_for(helper.renew('https://huntedcow.com/auth?game=6'), timeout=0.02)
    except TimeoutError:
        pass
    else:
        raise AssertionError('navigation timeout was swallowed')
    mode = 'verification'
    print('CASE:verification', file=sys.stderr)
    helper.wait_for_account = no_account
    try:
        await helper.renew('https://huntedcow.com/auth?game=6')
    except TimeoutError:
        pass
    else:
        raise AssertionError('verification timeout was swallowed')
    assert stopped == ['success', 'navigation', 'verification'], stopped
asyncio.run(run())
`;
  const actual = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
  const result = JSON.parse(actual.stdout);
  assert.equal(result.cookies[0].value, 'private-cookie-fixture');
  assert.doesNotMatch(actual.stderr, /private-cookie-fixture|private-page-content/);
  assert.match(actual.stderr, /SSO_PAGE:account_form/);
  const navigation = actual.stderr.split('CASE:navigation')[1].split('CASE:verification')[0];
  assert.match(navigation, /SSO_STAGE:navigation/);
  assert.doesNotMatch(navigation, /SSO_STAGE:account_wait/);
  const verification = actual.stderr.split('CASE:verification')[1];
  assert.match(verification, /SSO_STAGE:verification/);
  assert.match(verification, /SSO_PAGE:challenge/);
});
