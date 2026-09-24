import { describe, expect, it } from "vitest";
import { addDays, startOfMonth, startOfWeek } from "date-fns";
import { recorteDaGrade } from "./recorte-da-grade";

describe("recorte consultado cobre as células da grade", () => {
  it("outubro inclui a ocupação de 30/09 mostrada na primeira linha", () => {
    const recorte = recorteDaGrade("mes", new Date(2026, 9, 1, 12));
    const evento = new Date(2026, 8, 30, 15).toISOString();
    expect(recorte.de <= evento && evento < recorte.ate).toBe(true);
    expect(recorte.de).toBe(new Date(2026, 8, 27).toISOString());
    expect(recorte.ate).toBe(new Date(2026, 10, 8).toISOString());
  });

  it.each([1, 2, 9, 11])("cobre as seis semanas, inclusive dias fora do mês %s", (mes) => {
    const ancora = new Date(2026, mes, 15, 12);
    const recorte = recorteDaGrade("mes", ancora);
    const primeiro = startOfWeek(startOfMonth(ancora), { weekStartsOn: 0 });
    for (let dia = 0; dia < 42; dia++) {
      const instante = addDays(primeiro, dia);
      instante.setHours(23, 59, 59, 999);
      expect(instante.toISOString() >= recorte.de && instante.toISOString() < recorte.ate).toBe(true);
    }
    expect(recorte.ate).toBe(addDays(primeiro, 42).toISOString());
  });

  it("mantém dia e semana com término exclusivo à meia-noite local", () => {
    const ancora = new Date(2026, 8, 30, 15);
    expect(recorteDaGrade("dia", ancora)).toEqual({
      de: new Date(2026, 8, 30).toISOString(), ate: new Date(2026, 9, 1).toISOString(),
    });
    expect(recorteDaGrade("semana", ancora)).toEqual({
      de: new Date(2026, 8, 27).toISOString(), ate: new Date(2026, 9, 4).toISOString(),
    });
  });
});
