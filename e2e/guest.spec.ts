import { expect, test } from '@playwright/test';

test('guest books a slot, opens the manage link, and cancels', async ({ page }) => {
  const email = `guest-${Date.now()}@example.com`;

  await page.goto('/demo/intro');
  await expect(page.getByRole('heading', { level: 1, name: 'Intro call' })).toBeVisible();

  const slots = page.locator('section .slots button');
  await expect(slots.first()).toBeVisible();

  const confirm = page.getByRole('button', { name: 'Confirm booking' });
  const tries = Math.min(await slots.count(), 6);
  let held = false;
  for (let i = 0; i < tries; i++) {
    await slots.nth(i).click();
    try {
      await expect(confirm).toBeVisible({ timeout: 5_000 });
      held = true;
      break;
    } catch {
      await expect(page.getByRole('alert')).toBeVisible();
    }
  }
  expect(held).toBe(true);

  await page.getByLabel('Name').fill('Ava Guest');
  await page.getByLabel('Email').fill(email);
  await confirm.click();

  await expect(page.getByText('You are booked, Ava Guest.')).toBeVisible();
  const calendar = page.getByRole('link', { name: 'Add to calendar' });
  await expect(calendar).toHaveAttribute('href', /\/invite\.ics$/);

  await page.getByRole('link', { name: /\/manage\// }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Intro call' })).toBeVisible();
  await expect(page.getByText('confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('Ava Guest')).toBeVisible();

  await page.getByLabel('Reason').fill('Plans changed');
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText('Cancelled.')).toBeVisible();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText('Reason: Plans changed')).toBeVisible();
});
