import { test, expect } from '@playwright/test';
const url = 'http://127.0.0.1:4173';
test('mobile and desktop questionnaire remains usable without preselected answers', async ({ page }) => {
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(url);
    const frame = page.frameLocator('#questionnaire');
    await expect(frame.getByRole('heading', { name: '第 1 轮决策问卷' })).toBeVisible();
    await expect(frame.locator('input:checked')).toHaveCount(0);
    const overflow = await frame.locator('body').evaluate(body => body.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `artifacts/questionnaire-${width}.png`, fullPage: true });
  }
});
async function fill(page: import('@playwright/test').Page) {
  const frame = page.frameLocator('#questionnaire');
  await frame.locator('input[value="mobile"]').check();
  await frame.locator('input[value="keyboard"]').check();
  await frame.locator('textarea[data-answer="constraint"]').fill('手机端可完整填写并保存答案');
  return frame;
}
test('a continuation failure keeps saved answers locked and gives a recovery message', async ({ page }) => {
  await page.goto(url + '?mode=messagefail'); const frame = await fill(page);
  await frame.getByRole('button', { name: '提交本轮', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('答案已保存');
  await expect(frame.locator('#status')).toContainText('继续');
  await expect(frame.locator('#submit')).toBeDisabled();
  await expect(frame.locator('textarea[data-answer="constraint"]')).toBeDisabled();
});
test('network retries reuse the same answer idempotency key', async ({ page }) => {
  await page.goto(url + '?mode=retry'); const frame = await fill(page);
  await frame.getByRole('button', { name: '提交本轮', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('提交失败');
  await frame.getByRole('button', { name: '提交本轮', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('提交成功');
  const calls = await page.evaluate(() => (window as any).interviewEvents.filter((e: any) => e.name === 'answers_submit'));
  expect(calls).toHaveLength(2);
  expect(calls[0].arguments.idempotency_key).toBe(calls[1].arguments.idempotency_key);
});

test('cancellation asks for inline confirmation before changing session state', async ({ page }) => {
  await page.goto(url); const frame = page.frameLocator('#questionnaire');
  await frame.getByRole('button', { name: '终止会话', exact: true }).click();
  await expect(frame.getByRole('button', { name: '确认终止', exact: true })).toBeVisible();
  const before = await page.evaluate(() => (window as any).interviewEvents);
  expect(before.filter((e: any) => e.name === 'session_cancel')).toHaveLength(0);
  await frame.getByRole('button', { name: '确认终止', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('会话已终止');
});

test('stale submitted forms lock when another device already advanced the session', async ({ page }) => {
  await page.goto(url + '?mode=stale'); const frame = await fill(page);
  await frame.getByRole('button', { name: '提交本轮', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('其他窗口更新');
  await expect(frame.locator('#submit')).toBeDisabled();
});

test('revision conflicts refresh a pending questionnaire from authoritative server state', async ({ page }) => {
  await page.goto(url + '?mode=refresh'); const frame = await fill(page);
  await frame.getByRole('button', { name: '提交本轮', exact: true }).click();
  await expect(frame.getByRole('heading', { name: '第 2 轮决策问卷' })).toBeVisible();
  await expect(frame.locator('#status')).toContainText('问卷已刷新');
  await expect(frame.locator('input:checked')).toHaveCount(0);
});
