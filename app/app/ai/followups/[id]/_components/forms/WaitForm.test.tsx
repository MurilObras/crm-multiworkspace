import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaitForm } from "./WaitForm";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (v: string) => v }));
afterEach(cleanup);

describe("configuração da janela da espera", () => {
  it("permite ligar, personalizar e desligar sem mudar a duração", () => {
    const onChange = vi.fn();
    render(<WaitForm config={{ mode: "fixed", duration_ms: 300_000 }} onChange={onChange} />);
    const toggle = screen.getByRole("switch", {
      name: "Ajustar o fim da espera aos dias e horários",
    });
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "fixed",
      duration_ms: 300_000,
      send_window: {
        timezone: "America/Sao_Paulo",
        days: [1, 2, 3, 4, 5],
        start_hour: 8,
        end_hour: 20,
      },
    });
    fireEvent.change(screen.getByLabelText("Hora inicial"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Sábado" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        send_window: expect.objectContaining({ start_hour: 9, days: [1, 2, 3, 4, 5, 6] }),
      }),
    );
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({ mode: "fixed", duration_ms: 300_000 });
  });
  it("reabre uma configuração salva sem resetar dias, horas ou fuso", () => {
    render(
      <WaitForm
        config={{
          mode: "fixed",
          duration_ms: 600_000,
          send_window: { timezone: "UTC", days: [2, 4], start_hour: 10, end_hour: 18 },
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Hora inicial") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Hora final (exclusiva)") as HTMLInputElement).value).toBe("18");
    expect(
      (screen.getByRole("checkbox", { name: "Terça-feira" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: "Segunda-feira" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByRole("combobox", { name: "Fuso horário" }).textContent).toBe("UTC");
  });
  it("não aplica uma janela inválida e explica o erro", () => {
    const onChange = vi.fn();
    render(
      <WaitForm
        config={{
          mode: "fixed",
          duration_ms: 300_000,
          send_window: { timezone: "UTC", days: [1], start_hour: 8, end_hour: 20 },
        }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Hora inicial"), { target: { value: "22" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("O fim deve ser depois do início.")).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Segunda-feira" }) as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
