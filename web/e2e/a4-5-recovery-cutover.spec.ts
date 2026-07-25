import { expect, test } from "@playwright/test";

test("A4-5 direct Product entry and recovery-only shell stay honest", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/?mode=legacy");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page).toHaveURL("http://localhost:8792/?mode=legacy");
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByText("Legacy queue / OpenCode")).toHaveCount(0);
  await expect(page.getByText("Wind Evidence Studio")).toHaveCount(0);

  const model = page.getByRole("link", { name: "Open Model" }).first();
  await model.click();
  await expect(page.getByTestId("shell-owner-heading")).toBeVisible();
  const directOwnerUrl = page.url();
  const reload = await page.reload();
  expect(reload?.status()).toBe(200);
  await expect(page).toHaveURL(directOwnerUrl);
  await expect(page.getByTestId("shell-owner-heading")).toBeVisible();

  const retired = await page.context().request.post(
    "http://localhost:8792/api/sessions",
    { data: {} },
  );
  expect(retired.status()).toBe(404);
  expect((await retired.json()).error.code).toBe("not_found");

  await page.goto("http://localhost:8794/projects/not-loaded?conversation=not-loaded");
  await expect(page.getByRole("heading", {
    name: "Riffology is not accepting workspace changes yet.",
  })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Models, Projects, Conversations, Runs, and visual access remain unavailable.",
  );
  await expect(page.getByText("2026-07-25T00:00:00.000Z")).toBeVisible();
  await expect(page.getByTestId("shell-owner-heading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Model" })).toHaveCount(0);

  const denied = await page.context().request.get("http://localhost:8794/api/home");
  expect(denied.status()).toBe(503);
  expect((await denied.json()).error.code).toBe("recovery_required");
  expect(errors).toEqual([]);
});
