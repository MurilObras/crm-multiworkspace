"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { FUSOS_OFERECIDOS, FUSO_PADRAO } from "@/lib/tempo/fusos";
import type { SendWindow } from "@/lib/followup/send-window";
import { waitConfigSchema } from "@/lib/followup/graph-schema";
import { MODOS_DE_ESPERA, opcoes } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import { msToMin, minToMs, type ConfigOf } from "./shared";

const WEEKDAYS = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
];

export function WaitForm({
  config,
  onChange,
}: {
  config: ConfigOf<"wait">;
  onChange: (c: ConfigOf<"wait">) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"fixed" | "smart">(config.mode);
  const [durationMin, setDurationMin] = useState(
    config.mode === "fixed" ? msToMin(config.duration_ms) : 10,
  );
  const [minMin, setMinMin] = useState(config.mode === "smart" ? msToMin(config.min_ms) : 5);
  const [maxMin, setMaxMin] = useState(config.mode === "smart" ? msToMin(config.max_ms) : 60);
  const [guidance, setGuidance] = useState(config.mode === "smart" ? (config.guidance ?? "") : "");
  const [error, setError] = useState<string | null>(null);
  const [sendWindow, setSendWindow] = useState<SendWindow | null>(
    config.mode === "fixed" ? (config.send_window ?? null) : null,
  );

  const commit = (
    next: {
      mode: "fixed" | "smart";
      durationMin: number;
      minMin: number;
      maxMin: number;
      guidance: string;
    },
    window = sendWindow,
  ) => {
    const candidate =
      next.mode === "fixed"
        ? {
            mode: "fixed" as const,
            duration_ms: minToMs(next.durationMin),
            ...(window ? { send_window: window } : {}),
          }
        : {
            mode: "smart" as const,
            min_ms: minToMs(next.minMin),
            max_ms: minToMs(next.maxMin),
            ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
          };
    const parsed = waitConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="wait-mode">{t("Como calcular a espera")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "fixed" | "smart";
            setMode(next);
            commit({ mode: next, durationMin, minMin, maxMin, guidance });
          }}
        >
          <SelectTrigger id="wait-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(MODOS_DE_ESPERA).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mode === "fixed" ? (
        <div className="space-y-2">
          <Label htmlFor="wait-duration">{t("Duração (minutos)")}</Label>
          <Input
            id="wait-duration"
            type="number"
            min={5}
            value={durationMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDurationMin(v);
              commit({ mode, durationMin: v, minMin, maxMin, guidance });
            }}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-min">{t("Mínimo (min)")}</Label>
              <Input
                id="wait-min"
                type="number"
                min={5}
                value={minMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinMin(v);
                  commit({ mode, durationMin, minMin: v, maxMin, guidance });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-max">{t("Máximo (min)")}</Label>
              <Input
                id="wait-max"
                type="number"
                min={5}
                value={maxMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxMin(v);
                  commit({ mode, durationMin, minMin, maxMin: v, guidance });
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wait-guidance">{t("Orientação (opcional)")}</Label>
            <Textarea
              id="wait-guidance"
              maxLength={500}
              value={guidance}
              onChange={(e) => {
                setGuidance(e.target.value);
                commit({ mode, durationMin, minMin, maxMin, guidance: e.target.value });
              }}
            />
          </div>
        </>
      )}
      {mode === "fixed" && (
        <section className="space-y-3 rounded-md border p-3" aria-label={t("Janela desta espera")}>
          <div className="flex items-center gap-2">
            <Switch
              id="wait-window"
              checked={sendWindow !== null}
              onCheckedChange={(enabled) => {
                const window = enabled
                  ? { timezone: FUSO_PADRAO, days: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 20 }
                  : null;
                setSendWindow(window);
                commit({ mode, durationMin, minMin, maxMin, guidance }, window);
              }}
            />
            <Label htmlFor="wait-window">{t("Ajustar o fim da espera aos dias e horários")}</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "O relógio soma a duração e escolhe o primeiro horário permitido, sem pedir à IA. As regras do canal continuam valendo no envio.",
            )}
          </p>
          {sendWindow &&
            (() => {
              const change = (patch: Partial<SendWindow>) => {
                const window = { ...sendWindow, ...patch };
                setSendWindow(window);
                commit({ mode, durationMin, minMin, maxMin, guidance }, window);
              };
              return (
                <>
                  <fieldset className="flex flex-wrap gap-3">
                    <legend className="mb-2 text-sm">{t("Dias permitidos")}</legend>
                    {WEEKDAYS.map((day, index) => (
                      <div className="flex items-center gap-1" key={day}>
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          id={`wait-day-${index}`}
                          checked={sendWindow.days.includes(index)}
                          disabled={sendWindow.days.length === 1 && sendWindow.days.includes(index)}
                          onChange={(event) =>
                            change({
                              days: event.target.checked
                                ? [...sendWindow.days, index].sort((a, b) => a - b)
                                : sendWindow.days.filter((d) => d !== index),
                            })
                          }
                        />
                        <Label htmlFor={`wait-day-${index}`}>{t(day)}</Label>
                      </div>
                    ))}
                  </fieldset>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="wait-window-start">{t("Hora inicial")}</Label>
                      <Input
                        id="wait-window-start"
                        type="number"
                        min={0}
                        max={23}
                        value={sendWindow.start_hour}
                        onChange={(e) => change({ start_hour: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <Label htmlFor="wait-window-end">{t("Hora final (exclusiva)")}</Label>
                      <Input
                        id="wait-window-end"
                        type="number"
                        min={1}
                        max={24}
                        value={sendWindow.end_hour}
                        onChange={(e) => change({ end_hour: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                  <Label htmlFor="wait-window-timezone">{t("Fuso horário")}</Label>
                  <Select
                    value={sendWindow.timezone}
                    onValueChange={(timezone) => change({ timezone })}
                  >
                    <SelectTrigger id="wait-window-timezone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(!FUSOS_OFERECIDOS.some((f) => f.codigo === sendWindow.timezone)
                        ? [
                            { codigo: sendWindow.timezone, rotulo: sendWindow.timezone },
                            ...FUSOS_OFERECIDOS,
                          ]
                        : FUSOS_OFERECIDOS
                      ).map((f) => (
                        <SelectItem key={f.codigo} value={f.codigo}>
                          {f.rotulo}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              );
            })()}
        </section>
      )}
      {error && <p className="text-xs text-error-fg">{t(error)}</p>}
    </div>
  );
}
