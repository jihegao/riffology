import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TestUserAdminApp } from "./TestUserAdminApp";

afterEach(() => vi.unstubAllGlobals());

it("lets only an authenticated administrator generate a one-time test-user key", async () => {
  let authenticated = false;
  const calls: Array<{ path: string; body?: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    if (path === "/api/admin/session") {
      return Response.json({ schemaVersion: 1, authenticated });
    }
    if (path === "/api/admin/login") {
      authenticated = true;
      return Response.json({ schemaVersion: 1, authenticated: true, username: "admin" });
    }
    if (path === "/api/admin/users" && init?.method === "POST") {
      return Response.json({
        schemaVersion: 1,
        user: managedUser("new_user", 50_000),
        loginKey: "one-time-generated-login-key",
        loginKeyDisplay: "once",
      }, { status: 201 });
    }
    if (path === "/api/admin/users") return Response.json({ users: [] });
    return Response.json({ accepted: false }, { status: 404 });
  }));

  const user = userEvent.setup();
  render(<TestUserAdminApp />);
  expect(await screen.findByRole("heading", { name: "测试 key 管理" })).toBeInTheDocument();
  await user.type(screen.getByLabelText("管理员账号"), "admin");
  await user.type(screen.getByLabelText("管理员密码"), "administrator password");
  await user.click(screen.getByRole("button", { name: "管理员登录" }));
  expect(await screen.findByRole("heading", { name: "测试用户与 token 额度" })).toBeInTheDocument();
  await user.type(screen.getByLabelText("测试用户名"), "new_user");
  await user.clear(screen.getByLabelText("初始 token 额度"));
  await user.type(screen.getByLabelText("初始 token 额度"), "50000");
  await user.click(screen.getByRole("button", { name: "生成登录 key" }));
  expect(await screen.findByText("one-time-generated-login-key")).toBeInTheDocument();
  expect(calls.find((call) => call.path === "/api/admin/users" && call.body)).toMatchObject({
    body: { username: "new_user", tokenQuota: 50_000 },
  });
});

const managedUser = (username: string, limitTokens: number) => ({
  username,
  state: "active",
  quota: {
    limitTokens,
    usedTokens: 0,
    reservedTokens: 0,
    availableTokens: limitTokens,
    measurement: "estimated",
  },
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
});
