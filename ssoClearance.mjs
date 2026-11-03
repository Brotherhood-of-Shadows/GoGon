// Obtain HuntedCow clearance in the same VPS Chromium environment used by guide discovery.
// The helper receives no account credentials and never persists its browser profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COOKIE_VALUE = /^[A-Za-z0-9._-]{1,4096}$/;
const TIMEOUT_MS = 100_000;
const COOKIE_NAMES = new Set(['cf_clearance', 'hcs_session_key']);

export class SsoClearanceError extends Error {
  constructor(message, code = 'SSO_CLEARANCE_ERROR') {
    super(message);
    this.name = 'SsoClearanceError';
    this.code = code;
  }
}

// Match only code-owned failure text. Never forward stderr, stdout, exception messages or causes:
// the helper's successful stdout contains short-lived authentication cookies.
function verificationFailure(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.slice(0, 16 * 1024) : '';
  const known = [
    ['Chromium is unavailable', 'chromium_missing', 'Chromium is unavailable in the container.'],
    ['ModuleNotFoundError:', 'browser_dependency_missing', 'A browser helper Python dependency is missing.'],
    ['Xvfb failed to start', 'display_failed', 'The virtual display could not start.'],
    ['Challenge image is unavailable', 'challenge_image_missing', 'The verification screenshot or checkbox template is unavailable.'],
    ['Verification checkbox did not appear', 'checkbox_missing', 'The Cloudflare verification checkbox was not found.'],
    ['HuntedCow verification did not reach the account form', 'account_page_timeout', 'The browser did not reach the HuntedCow account form after verification.'],
    ['HuntedCow verification produced no usable clearance', 'clearance_missing', 'The browser did not obtain a usable Cloudflare clearance cookie.'],
    ['GG_GUIDE_BROWSER_PROXY must be a local SOCKS5 endpoint', 'proxy_invalid', 'The browser proxy setting is invalid.'],
    ['cv2.error:', 'verification_image_failed', 'The browser verification screenshot could not be processed.'],
  ];
  let reason;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') reason = ['cancelled', 'Browser verification was cancelled.'];
  else if (error?.code === 'ENOENT') reason = ['launcher_missing', 'The browser verification launcher (xvfb-run) is unavailable.'];
  else if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reason = ['output_limit', 'The browser helper exceeded its output limit.'];
  else if ((error?.killed && error?.signal === 'SIGTERM') || error?.code === 'ETIMEDOUT') reason = ['process_timeout', 'The browser helper exceeded its 100-second time limit.'];
  else {
    const match = known.find(([text]) => stderr.includes(text));
    if (match) reason = match.slice(1);
    else if (stderr.includes('/opt/gogon-guide-python/bin/python') && /(?:not found|No such file or directory)/.test(stderr)) reason = ['python_missing', 'The browser helper Python environment is unavailable.'];
    else if (/\bTimeoutError\b/.test(stderr)) reason = ['browser_timeout', 'The browser helper timed out while waiting for verification.'];
    else if (['SIGKILL', 'SIGSEGV', 'SIGABRT'].includes(error?.signal)) reason = ['browser_terminated', `The browser helper was terminated by ${error.signal}.`];
    else reason = ['helper_failed', Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? `The browser helper exited with code ${error.code}.` : 'The browser helper failed to run.'];
  }
  return new SsoClearanceError(`HuntedCow browser verification did not complete (${reason[0]}). ${reason[1]}`, `SSO_${reason[0].toUpperCase()}`);
}

/** Return browser-issued HuntedCow cookies and the matching User-Agent after verification. */
export async function renewSsoClearance({ entryUrl = 'https://huntedcow.com/auth?game=6', signal, execFileFn = execFileAsync } = {}) {
  const url = new URL(entryUrl);
  if (url.protocol !== 'https:' || !['huntedcow.com', 'account.huntedcow.com'].includes(url.hostname)
      || url.pathname !== '/auth') throw new SsoClearanceError('Invalid HuntedCow SSO entry URL.');
  let output;
  try {
    ({ stdout: output } = await execFileFn('xvfb-run', [
      '-a', '-s', '-screen 0 1280x900x24',
      '/opt/gogon-guide-python/bin/python', '/app/scripts/control-plane/renew-sso-clearance.py', url.toString(),
    ], { encoding: 'utf8', maxBuffer: 16 * 1024, timeout: TIMEOUT_MS, signal }));
  } catch (error) {
    throw verificationFailure(error);
  }

  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new SsoClearanceError('HuntedCow browser returned an invalid response.');
  }
  if (typeof result?.userAgent !== 'string' || !result.userAgent.length || result.userAgent.length > 300
      || /[\r\n\x00-\x1f\x7f]/.test(result.userAgent) || !Array.isArray(result.cookies)
      || result.cookies.length < 1 || result.cookies.length > 4
      || !result.cookies.some(cookie => cookie.name === 'cf_clearance')
      || result.cookies.some(cookie => !COOKIE_NAMES.has(cookie?.name)
        || typeof cookie.value !== 'string' || !COOKIE_VALUE.test(cookie.value)
        || typeof cookie.domain !== 'string'
        || !['huntedcow.com', '.huntedcow.com', 'account.huntedcow.com'].includes(cookie.domain)
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 100
        || /[;\r\n\x00-\x1f\x7f]/.test(cookie.path)
        || typeof cookie.secure !== 'boolean')) {
    throw new SsoClearanceError('HuntedCow browser returned invalid credentials.');
  }
  return result;
}
