import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { UserMenu } from "@/components/shell/UserMenu";
import { ThemeProvider } from "@/lib/theme";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ full_name: "Operador", email: "operador@example.test" }),
  useAuth: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/components/workspace/CreateWorkspaceDialog", () => ({
  CreateWorkspaceDialog: () => null,
}));
vi.mock("@/app/actions/settings/trocarIdioma", () => ({ trocarIdioma: vi.fn() }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("alcança idioma e tema pelas setas e devolve o foco ao fechar", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  localStorage.setItem("deskcomm-theme", "light");
  const user = userEvent.setup();
  render(
    <IdiomaProvider locale="pt-BR">
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>
    </IdiomaProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Menu do usuário" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const portugues = await screen.findByRole("menuitem", { name: "Português (BR)" });
  await waitFor(() => expect(portugues).toHaveFocus());
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Español" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Tema claro" })).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard("{Enter}{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
});
