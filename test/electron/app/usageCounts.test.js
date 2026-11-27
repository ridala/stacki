// Daily usage counting: verify that one request carries no identifying payload,
// and that network failures cannot interrupt project editing. The date case
// pins the UTC boundary used for the local once-per-day guard.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DESKTOP_RELEASE } = require('#dist/shared/core/desktopRelease.js');
const { sendUsageCount, shouldCountUsage, usageDay, USAGE_NOTICE_VERSION } = require('#dist/electron/app/usageCounts.js');

const endpoint = 'https://usage.example.test/daily';

test('the shipped release makes no request without a configured counter', async () => {
  const controller = new AbortController();
  let sent = 0;
  const success = await sendUsageCount({ endpoint: DESKTOP_RELEASE.usageCountsURL, signal: controller.signal }, async () => {
    sent += 1;
    return new Response(undefined, { status: 204 });
  });
  assert.equal(success, false);
  assert.equal(sent, 0);
});

test('a usage count sends only an empty POST to the configured endpoint', async () => {
  const controller = new AbortController();
  let sent = 0;
  const success = await sendUsageCount({ endpoint, signal: controller.signal }, async (url, options) => {
    sent += 1;
    assert.equal(url, endpoint);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    return new Response(undefined, { status: 204 });
  });
  assert.equal(success, true);
  assert.equal(sent, 1);
});

test('offline and rejected requests cannot interrupt project editing', async () => {
  const controller = new AbortController();
  const offline = await sendUsageCount({ endpoint, signal: controller.signal }, async () => {
    throw new Error('offline');
  });
  const rejected = await sendUsageCount({ endpoint, signal: controller.signal }, async () => new Response(undefined, { status: 503 }));
  assert.equal(offline, false);
  assert.equal(rejected, false);
});

test('the local usage guard uses a UTC calendar day', () => {
  assert.equal(usageDay(new Date('2026-10-08T23:59:59.999Z')), '2026-10-08');
  assert.equal(usageDay(new Date('2026-10-09T00:00:00.000Z')), '2026-10-09');
});

test('development, opt-out, missing notice, and repeat openings send no count', () => {
  const active = {
    packaged: true,
    enabled: true,
    noticeVersion: USAGE_NOTICE_VERSION,
    lastAttemptDay: undefined,
  };
  assert.equal(shouldCountUsage(active, '2026-10-08'), true);
  assert.equal(shouldCountUsage({ ...active, packaged: false }, '2026-10-08'), false);
  assert.equal(shouldCountUsage({ ...active, enabled: false }, '2026-10-08'), false);
  assert.equal(shouldCountUsage({ ...active, noticeVersion: 0 }, '2026-10-08'), false);
  assert.equal(shouldCountUsage({ ...active, noticeVersion: 1 }, '2026-10-08'), false, 'the upstream notice precedes the fork notice');
  assert.equal(shouldCountUsage({ ...active, lastAttemptDay: '2026-10-08' }, '2026-10-08'), false);
});
