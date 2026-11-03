// Obtain HuntedCow clearance in the same VPS Chromium environment used by guide discovery.
// The helper receives no account credentials and never persists its browser profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COOKIE_VALUE = /^[A-Za-z0-9._-]{1,4096}$/;
const TIMEOUT_MS = 100_000;
const COOKIE_NAMES = new Set(['cf_clearance', 'hcs_session_key']);
const DEBUG_OPERATIONS = Object.freeze({
  browser_start: 'browser startup', navigation: 'page navigation', page_content: 'reading page content',
  screenshot: 'taking screenshot', screenshot_read: 'reading screenshot', template_read: 'reading template',
  image_match: 'image matching', image_click: 'image-based click', label_lookup_en: 'English label lookup',
  label_lookup_pt: 'Portuguese label lookup', label_click: 'label-based click', verification: 'verification interaction',
  cookies: 'reading browser result', user_agent: 'reading browser identity', browser_stop: 'browser shutdown',
  profile_cleanup: 'temporary profile cleanup', page_challenge: 'page observed: challenge',
  page_account_form: 'page observed: account form', page_other: 'page observed: other',
  failure_image_saved: 'failure screenshot saved at /var/lib/gogon-sso-debug/last-failure.png (captured before lookup)',
  failure_image_unavailable: 'failure screenshot unavailable',
  failure_image_source_missing: 'failure screenshot missing from the temporary profile',
  failure_image_size_invalid: 'failure screenshot exceeds the size limits',
  failure_image_decode_failed: 'failure screenshot could not be decoded or converted',
  failure_image_format_invalid: 'failure screenshot has an unsupported image format',
  failure_image_permission_denied: 'failure screenshot could not be saved: permission denied',
  failure_image_read_only: 'failure screenshot could not be saved: debug directory is read-only',
  failure_image_io_error: 'failure screenshot could not be saved: file I/O error',
});

function debugEntry(line) {
  const match = String(line).match(/^\[SSO_DEBUG:([a-z_]+):(start|done|interrupted|observed):(\d{1,7})\]\r?$/);
  return match && Object.hasOwn(DEBUG_OPERATIONS, match[1])
    ? { operation: match[1], event: match[2], elapsed: Number(match[3]) } : null;
}

function debugEntries(stderr) {
  return String(stderr ?? '').split('\n').map(debugEntry).filter(Boolean);
}

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
    ['Browser label lookup exceeded hard deadline', 'browser_lookup_timeout', 'The browser element lookup stalled and exceeded its hard deadline.'],
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
  const stages = {
    browser_start: 'starting Chromium', navigation: 'loading the HuntedCow login page',
    account_wait: 'waiting for the account form', verification: 'the browser verification interaction',
    account_wait_after_verification: 'waiting for the account form after verification',
    cookies: 'reading the browser result', user_agent: 'reading the browser identity',
  };
  const stage = [...stderr.matchAll(/^\[SSO_STAGE:([a-z_]+)\]$/gm)].at(-1)?.[1];
  const page = [...stderr.matchAll(/^\[SSO_PAGE:(account_form|challenge|other)\]$/gm)].at(-1)?.[1];
  // Report only allow-listed labels, never browser HTML, URLs, cookies or raw subprocess output.
  const detail = stages[stage] ? ` Last stage: ${stages[stage]}.` : '';
  const pageDetail = page === 'challenge' ? ' Last observed page: Cloudflare challenge.'
    : page === 'account_form' ? ' Last observed page: account form.' : page === 'other' ? ' Last observed page: neither the challenge nor the account form.' : '';
  const entries = debugEntries(stderr);
  // Inner operations unwind before their enclosing step. Keep the first interrupted operation,
  // even when cleanup later succeeds; for a killed process use the last unmatched start.
  const pending = new Map();
  for (const entry of entries) {
    if (entry.event === 'start') { pending.delete(entry.operation); pending.set(entry.operation, entry); }
    else if (entry.event === 'done') pending.delete(entry.operation);
  }
  const stalled = entries.find(entry => entry.event === 'interrupted') ?? [...pending.values()].at(-1);
  const operationDetail = stalled ? ` Interrupted operation: ${DEBUG_OPERATIONS[stalled.operation]} (+${stalled.elapsed} ms).` : '';
  return new SsoClearanceError(`HuntedCow browser verification did not complete (${reason[0]}). ${reason[1]}${detail}${pageDetail}${operationDetail}`, `SSO_${reason[0].toUpperCase()}`);
}

/** Return browser-issued HuntedCow cookies and the matching User-Agent after verification. */
export async function renewSsoClearance({ entryUrl = 'https://huntedcow.com/auth?game=6', signal, execFileFn = execFileAsync, log = console.warn } = {}) {
  const url = new URL(entryUrl);
  if (url.protocol !== 'https:' || !['huntedcow.com', 'account.huntedcow.com'].includes(url.hostname)
      || url.pathname !== '/auth') throw new SsoClearanceError('Invalid HuntedCow SSO entry URL.');
  let output;
  let streamed = false;
  let tail = '';
  const emit = entry => log(`[GoGon_SSO_DEBUG] +${entry.elapsed}ms ${DEBUG_OPERATIONS[entry.operation]}: ${entry.event}`);
  const onStderr = chunk => {
    const lines = (tail + String(chunk)).split('\n');
    tail = lines.pop().slice(-256);
    for (const line of lines) {
      const entry = debugEntry(line);
      if (entry) emit(entry);
    }
  };
  let childStderr;
  try {
    const pending = execFileFn('xvfb-run', [
      '-a', '-s', '-screen 0 1280x900x24',
      '/opt/gogon-guide-python/bin/python', '/app/scripts/control-plane/renew-sso-clearance.py', url.toString(),
    ], { encoding: 'utf8', maxBuffer: 16 * 1024, timeout: TIMEOUT_MS, signal });
    childStderr = pending.child?.stderr;
    if (childStderr) { streamed = true; childStderr.on('data', onStderr); }
    const result = await pending;
    output = result.stdout;
    if (!streamed) debugEntries(result.stderr).forEach(emit);
  } catch (error) {
    if (!streamed) debugEntries(error?.stderr).forEach(emit);
    throw verificationFailure(error);
  } finally {
    childStderr?.removeListener('data', onStderr);
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
