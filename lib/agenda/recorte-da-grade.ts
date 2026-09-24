import { addDays, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import type { VisaoDaAgenda } from "@/components/agenda/tipos";

/** Intervalo consultado pelo cliente, em instantes ISO no fuso da grade. */
export function recorteDaGrade(visao: VisaoDaAgenda, ancora: Date) {
  // GradeDaAgenda desenha seis semanas completas, incluindo dias dos meses
  // vizinhos. Consultar só o mês deixa células visíveis falsamente vazias.
  const inicio = visao === "mes" ? startOfWeek(startOfMonth(ancora), { weekStartsOn: 0 })
    : visao === "semana" ? startOfWeek(ancora, { weekStartsOn: 0 }) : startOfDay(ancora);
  const fim = visao === "mes" ? addDays(inicio, 42)
    : addDays(inicio, visao === "semana" ? 7 : 1);
  return { de: inicio.toISOString(), ate: fim.toISOString() };
}
