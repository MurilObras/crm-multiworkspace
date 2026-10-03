import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm } from "./LoginForm";

const { signIn, resend } = vi.hoisted(() => ({ signIn: vi.fn(), resend: vi.fn() }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: signIn }));
vi.mock("@/app/actions/auth/resendSignupConfirmation", () => ({
  resendSignupConfirmation: resend,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

beforeEach(() => vi.clearAllMocks());

async function login() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "pendente@example.test");
  await user.type(screen.getByLabelText("Senha"), "SenhaForte!123");
  await user.click(screen.getByRole("button", { name: "Entrar" }));
  return user;
}

describe("login de conta pendente", () => {
  it("permite reenviar o link após a recusa por confirmação pendente", async () => {
    signIn.mockResolvedValue({ ok: false, error: "email_not_confirmed" });
    resend.mockResolvedValue({ ok: true });
    render(<LoginForm />);
    const user = await login();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Confirme seu e-mail"));
    await user.click(screen.getByRole("button", { name: "Reenviar e-mail de confirmação" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("enviamos um novo link"),
    );
    expect(resend).toHaveBeenCalledWith({ email: "pendente@example.test" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("senha incorreta mantém a mensagem e não oferece reenvio", async () => {
    signIn.mockResolvedValue({ ok: false, error: "invalid_credentials" });
    render(<LoginForm />);
    await login();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Email ou senha incorretos"),
    );
    expect(screen.queryByRole("button", { name: "Reenviar e-mail de confirmação" })).toBeNull();
    expect(resend).not.toHaveBeenCalled();
  });
});
