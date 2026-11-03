import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewSsoClearance, SsoClearanceError } from '../../ssoClearance.mjs';

const credentials = { userAgent: 'Chromium fixture', cookies: [
  { name: 'cf_clearance', value: 'clearance.fixture', domain: '.huntedcow.com', path: '/', secure: true },
  { name: 'hcs_session_key', value: 'session-fixture', domain: 'huntedcow.com', path: '/', secure: true },
] };

test('SSO clearance uses the Guide Chromium environment and validates returned cookies', async () => {
  const actual = await renewSsoClearance({ execFileFn: async (command, args, options) => {
    assert.equal(command, 'xvfb-run');
    assert.ok(args.includes('/app/scripts/control-plane/renew-sso-clearance.py'));
    assert.ok(args.includes('https://huntedcow.com/auth?game=6'));
    assert.equal(options.timeout, 100_000);
    return { stdout: JSON.stringify(credentials) };
  } });
  assert.deepEqual(actual, credentials);
});

test('SSO clearance rejects malformed and non-HuntedCow credentials without leaking subprocess output', async () => {
  await assert.rejects(renewSsoClearance({ entryUrl: 'https://elsewhere.example/auth', execFileFn: async () => {
    throw new Error('should not run');
  } }), SsoClearanceError);
  await assert.rejects(renewSsoClearance({ execFileFn: async () => ({ stdout: JSON.stringify({
    ...credentials, cookies: [{ ...credentials.cookies[0], domain: 'elsewhere.example' }],
  }) }) }), SsoClearanceError);
  await assert.rejects(renewSsoClearance({ execFileFn: async () => {
    throw new Error('private-cookie-value');
  } }), error => error instanceof SsoClearanceError && !error.message.includes('private-cookie-value'));
});

test('SSO browser failures identify safe actionable reasons without exposing cookies or subprocess output', async () => {
  const secret = 'private-cookie-or-proxy-value';
  const failures = [
    [{ code: 'ENOENT' }, 'SSO_LAUNCHER_MISSING'],
    [{ code: 1, stderr: 'FileNotFoundError: Chromium is unavailable' }, 'SSO_CHROMIUM_MISSING'],
    [{ code: 1, stderr: "ModuleNotFoundError: No module named 'nodriver'" }, 'SSO_BROWSER_DEPENDENCY_MISSING'],
    [{ code: 1, stderr: 'xvfb-run: error: Xvfb failed to start' }, 'SSO_DISPLAY_FAILED'],
    [{ code: 1, stderr: 'TimeoutError: Verification checkbox did not appear' }, 'SSO_CHECKBOX_MISSING'],
    [{ code: 1, stderr: 'TimeoutError: HuntedCow verification did not reach the account form' }, 'SSO_ACCOUNT_PAGE_TIMEOUT'],
    [{ code: 1, stderr: 'ValueError: HuntedCow verification produced no usable clearance' }, 'SSO_CLEARANCE_MISSING'],
    [{ code: 1, stderr: 'GG_GUIDE_BROWSER_PROXY must be a local SOCKS5 endpoint' }, 'SSO_PROXY_INVALID'],
    [{ code: 1, stderr: 'FileNotFoundError: Challenge image is unavailable' }, 'SSO_CHALLENGE_IMAGE_MISSING'],
    [{ code: 1, stderr: 'cv2.error: invalid screenshot' }, 'SSO_VERIFICATION_IMAGE_FAILED'],
    [{ code: 127, stderr: '/usr/bin/xvfb-run: /opt/gogon-guide-python/bin/python: not found' }, 'SSO_PYTHON_MISSING'],
    [{ code: 1, stderr: 'asyncio.exceptions.TimeoutError' }, 'SSO_BROWSER_TIMEOUT'],
    [{ killed: true, signal: 'SIGTERM' }, 'SSO_PROCESS_TIMEOUT'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'SSO_OUTPUT_LIMIT'],
    [{ signal: 'SIGKILL' }, 'SSO_BROWSER_TERMINATED'],
    [{ name: 'AbortError' }, 'SSO_CANCELLED'],
    [{ code: 1 }, 'SSO_HELPER_FAILED'],
    [{}, 'SSO_HELPER_FAILED'],
  ];
  for (const [failure, code] of failures) {
    const childError = Object.assign(new Error(secret), failure, { stdout: secret, stderr: `${failure.stderr ?? ''}\n${secret}` });
    await assert.rejects(renewSsoClearance({ execFileFn: async () => { throw childError; } }), error => {
      assert.equal(error.code, code);
      assert.ok(error instanceof SsoClearanceError);
      assert.match(error.message, /HuntedCow browser verification did not complete/);
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, new RegExp(secret));
      assert.equal(error.cause, undefined);
      return true;
    }, code);
  }
});

test('SSO timeout identifies the latest browser stage and page using only allow-listed labels', async () => {
  const secret = 'private-cookie-or-url-value';
  const stderr = `[SSO_STAGE:browser_start]\n[SSO_STAGE:navigation]\n[SSO_STAGE:account_wait]\n[SSO_PAGE:challenge]\n[SSO_STAGE:verification]\nasyncio.exceptions.TimeoutError\n${secret}`;
  await assert.rejects(renewSsoClearance({ execFileFn: async () => { throw Object.assign(new Error(secret), { stderr, stdout: secret }); } }), error => {
    assert.equal(error.code, 'SSO_BROWSER_TIMEOUT');
    assert.match(error.message, /Last stage: the browser verification interaction/);
    assert.match(error.message, /Last observed page: Cloudflare challenge/);
    assert.doesNotMatch(error.message, /starting Chromium|private-cookie-or-url-value/);
    return true;
  });
  await assert.rejects(renewSsoClearance({ execFileFn: async () => { throw Object.assign(new Error(secret), { stderr: `[SSO_STAGE:${secret}]\n[SSO_PAGE:${secret}]\nTimeoutError` }); } }), error => {
    assert.equal(error.code, 'SSO_BROWSER_TIMEOUT');
    assert.doesNotMatch(error.message, /Last stage|Last observed page|private-cookie-or-url-value/);
    return true;
  });
});
