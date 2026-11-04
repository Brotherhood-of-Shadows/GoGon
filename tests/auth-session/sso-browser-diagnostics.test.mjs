import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Python helper keeps stage/page diagnostics out of cookie stdout and preserves timeout cleanup', () => {
  // Browser dependencies are doubles: this exercises the helper itself without launching Chromium,
  // interacting with verification, submitting credentials or making any network request.
  const script = `
import asyncio, importlib.util, json, os, sys, tempfile, types
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, 'scripts/control-plane')
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
async def verification(tab, profile, *, report):
    (profile / 'challenge.png').write_bytes(b'\\x89PNG\\r\\n\\x1a\\nfixture image')
    (profile / 'cookies.json').write_text('private-cookie-fixture')
    return False
sys.modules['nodriver'] = types.SimpleNamespace(start=start)
sys.modules['cv2'] = types.SimpleNamespace()
import challenge_browser
challenge_browser.click_checkbox_image = verification
challenge_browser.POLL_SECONDS = 0.01
sys.modules['guide_browser_environment'] = types.SimpleNamespace(prepare_browser_environment=lambda profile: None)
spec = importlib.util.spec_from_file_location('sso_fixture', 'scripts/control-plane/renew-sso-clearance.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
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
    helper.VERIFICATION_SECONDS = 0.05
    try:
        await helper.renew('https://huntedcow.com/auth?game=6')
    except TimeoutError as error:
        assert str(error) == 'Verification checkbox did not appear', error
    else:
        raise AssertionError('verification timeout was swallowed')
    assert stopped == ['success', 'navigation', 'verification'], stopped
with tempfile.TemporaryDirectory() as directory:
    helper.FAILURE_IMAGE_DIRECTORY = Path(directory) / 'snapshots'
    asyncio.run(run())
    saved = helper.FAILURE_IMAGE_DIRECTORY / 'last-failure.png'
    assert saved.read_bytes() == b'\\x89PNG\\r\\n\\x1a\\nfixture image'
    assert saved.stat().st_mode & 0o777 == 0o600
    assert [path.name for path in helper.FAILURE_IMAGE_DIRECTORY.iterdir()] == ['last-failure.png']
    # A missing/unwritable output directory must never replace the actual browser failure.
    source = Path(directory) / 'source'
    source.mkdir()
    (source / 'challenge.png').write_bytes(saved.read_bytes())
    helper.FAILURE_IMAGE_DIRECTORY = saved
    events = []
    helper.preserve_failure_image(source, lambda operation, event: events.append((operation, event)))
    assert events == [('failure_image_io_error', 'observed')], events
    # Actual nodriver defaults to JPEG even when its output filename is challenge.png.
    helper.FAILURE_IMAGE_DIRECTORY = Path(directory) / 'jpeg-snapshots'
    (source / 'challenge.png').write_bytes(b'\\xff\\xd8\\xfffixture jpeg')
    original = (source / 'challenge.png').read_bytes()
    png = b'\\x89PNG\\r\\n\\x1a\\nconverted fixture'
    sys.modules['cv2'] = types.SimpleNamespace(IMREAD_UNCHANGED=-1, error=RuntimeError,
        imread=lambda path, mode: object(), imencode=lambda extension, image: (True, types.SimpleNamespace(tobytes=lambda: png)))
    events.clear()
    helper.preserve_failure_image(source, lambda operation, event: events.append((operation, event)))
    assert events == [('failure_image_saved', 'observed')], events
    assert (helper.FAILURE_IMAGE_DIRECTORY / 'last-failure.png').read_bytes() == png
    assert (source / 'challenge.png').read_bytes() == original
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
  assert.match(verification, /SSO_DEBUG:failure_image_saved:observed:/);
});

test('shared checkbox step reports interruptions, clicks a matched centre and never searches page text', () => {
  const script = `
import asyncio, sys, types
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, 'scripts/control-plane')
events, clicks = [], []
state = {'mode': 'screenshot', 'score': 0.1}
image = types.SimpleNamespace(shape=(40, 80))
sys.modules['cv2'] = types.SimpleNamespace(IMREAD_GRAYSCALE=0, TM_CCOEFF_NORMED=0,
    imread=lambda path, mode: None if state['mode'] == 'missing' else image, matchTemplate=lambda *args: None,
    minMaxLoc=lambda matches: (0, state['score'], None, (100, 300)))
import challenge_browser
def report(operation, event):
    events.append((operation, event))
class Tab:
    async def save_screenshot(self, path, format='jpeg'):
        assert format == 'png', format
        if state['mode'] == 'screenshot':
            await asyncio.Future()
    async def mouse_click(self, x, y):
        clicks.append((x, y))
    async def find(self, *args, **kwargs):
        raise AssertionError('verification must not search page text')
async def run():
    try:
        await asyncio.wait_for(challenge_browser.click_checkbox_image(Tab(), Path('/tmp'), report=report), timeout=0.02)
    except TimeoutError:
        pass
    else:
        raise AssertionError('timeout was swallowed')
    assert events[-2:] == [('screenshot', 'start'), ('screenshot', 'interrupted')], events
    state['mode'] = 'missing'
    try:
        await challenge_browser.click_checkbox_image(Tab(), Path('/tmp'))
    except FileNotFoundError as error:
        assert str(error) == 'Challenge image is unavailable'
    else:
        raise AssertionError('missing image was ignored')
    state['mode'] = 'ready'
    assert await challenge_browser.click_checkbox_image(Tab(), Path('/tmp')) is False
    assert clicks == []
    state['score'] = 0.99
    events.clear()
    assert await challenge_browser.click_checkbox_image(Tab(), Path('/tmp'), report=report) is True
    assert clicks == [(140, 320)], clicks
    assert ('image_click', 'done') in events, events
asyncio.run(run())
`;
  const actual = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
  assert.equal(actual.stdout, '');
});

test('shared verification loop waits through "Verifying...", clicks only a visible checkbox and names the failure', () => {
  // Doubles only: each scenario says on which poll the page loads and on which look the checkbox shows.
  const script = `
import asyncio, sys, types
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, 'scripts/control-plane')
sys.modules['cv2'] = types.SimpleNamespace()
import challenge_browser
state = {}
async def loaded():
    state['polls'] += 1
    return state['polls'] >= state['loaded_at']
async def click(tab, profile, *, report):
    state['looks'] += 1
    if state['looks'] >= state['checkbox_at']:
        state['clicks'] += 1
        return True
    return False
challenge_browser.click_checkbox_image = click
challenge_browser.POLL_SECONDS = 0
challenge_browser.AFTER_CLICK_SECONDS = 0.01
async def scenario(loaded_at, checkbox_at, seconds=0.05):
    state.update(polls=0, looks=0, clicks=0, loaded_at=loaded_at, checkbox_at=checkbox_at)
    stages = []
    try:
        result = await challenge_browser.verify_until(None, Path('/tmp'), loaded, seconds, not_reached='fixture page not reached', stage=stages.append)
    except TimeoutError as error:
        result = str(error)
    return result, state['clicks'], stages
async def run():
    never = 10**9
    assert (await scenario(loaded_at=4, checkbox_at=never))[:2] == (True, 0), 'passes on its own after verifying'
    result, clicks, stages = await scenario(loaded_at=4, checkbox_at=2)
    assert (result, clicks) == (True, 1), 'clicks once the checkbox appears, then the page loads'
    assert stages == ['verification', 'verification', 'account_wait_after_verification'], stages
    assert (await scenario(loaded_at=never, checkbox_at=1, seconds=3))[:2] == ('fixture page not reached', 2), 'at most two clicks'
    assert (await scenario(loaded_at=never, checkbox_at=never))[:2] == ('Verification checkbox did not appear', 0)
asyncio.run(run())
`;
  const actual = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
});

test('Guide renewal uses the shared checkbox loop and returns only its clearance', () => {
  const script = `
import asyncio, importlib.util, json, os, sys, types
sys.dont_write_bytecode = True
sys.path.insert(0, 'scripts/control-plane')
os.environ['GG_GUIDE_CHROMIUM_PATH'] = '/fixture/chromium'
state = {'clicked': False, 'stopped': 0}
class Tab:
    async def get_content(self):
        return '<a href="index.php?cmd=items">items</a>' if state['clicked'] else '<title>Just a moment...</title>'
    async def evaluate(self, expression):
        return 'Chromium fixture'
class Cookies:
    async def get_all(self):
        return [types.SimpleNamespace(name='cf_clearance', value='guide.clearance-1', domain='.guide.fallensword.com')]
class Browser:
    cookies = Cookies()
    async def get(self, url):
        return Tab()
    def stop(self):
        state['stopped'] += 1
async def start(**kwargs):
    return Browser()
sys.modules['nodriver'] = types.SimpleNamespace(start=start)
sys.modules['cv2'] = types.SimpleNamespace()
sys.modules['guide_browser_environment'] = types.SimpleNamespace(prepare_browser_environment=lambda profile: None)
import challenge_browser
async def click(tab, profile, *, report):
    state['clicked'] = True
    return True
challenge_browser.click_checkbox_image = click
challenge_browser.POLL_SECONDS = 0
spec = importlib.util.spec_from_file_location('guide_fixture', 'scripts/control-plane/renew-guide-clearance.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.asyncio = types.SimpleNamespace(sleep=lambda seconds: asyncio.sleep(0))
asyncio.run(helper.renew())
assert state == {'clicked': True, 'stopped': 1}, state
`;
  const actual = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
  assert.deepEqual(JSON.parse(actual.stdout), { clearance: 'guide.clearance-1', userAgent: 'Chromium fixture' });
});

const hasOpenCv = spawnSync('python3', ['-c', 'import cv2'], { encoding: 'utf8' }).status === 0;

test('real HuntedCow widget captures: light template finds the checkbox and ignores the verifying spinner', { skip: !hasOpenCv && 'OpenCV is only installed in the container image' }, () => {
  // Frames from the production image's Chromium: a visible checkbox and the VPS "Verifying..." state.
  const script = `
import asyncio, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, 'scripts/control-plane')
import challenge_browser
class Tab:
    def __init__(self, frame): self.frame = frame
    async def save_screenshot(self, path, format='jpeg'): shutil.copyfile(self.frame, path)
async def run():
    with tempfile.TemporaryDirectory() as directory:
        found = await challenge_browser.locate_checkbox(Tab('tests/auth-session/fixtures/sso-widget-checkbox.png'), Path(directory))
        assert found and abs(found[0] - 213) <= 3 and abs(found[1] - 337) <= 3, found
        assert await challenge_browser.locate_checkbox(Tab('tests/auth-session/fixtures/sso-widget-verifying.png'), Path(directory)) is None
asyncio.run(run())
`;
  const actual = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
});
