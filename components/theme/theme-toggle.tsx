"use client";

import { useTheme } from "@/lib/theme";
import { useHotkeys } from "react-hotkeys-hook";
import { Sun, Moon, MonitorPlay } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";

export function ThemeToggle({ menuItem = false }: { menuItem?: boolean }) {
  const t = useT();
  const { theme, setTheme } = useTheme();

  const cycle = () => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  };

  useHotkeys("mod+shift+l", cycle, { preventDefault: true, enabled: !menuItem }, [theme]);

  const Icon = theme === "dark" ? Moon : theme === "system" ? MonitorPlay : Sun;
  if (menuItem) {
    return (
      <DropdownMenuItem onSelect={cycle} className="min-h-11">
        <Icon size={16} aria-hidden />
        {t(
          theme === "dark" ? "Tema escuro" : theme === "system" ? "Tema do sistema" : "Tema claro",
        )}
      </DropdownMenuItem>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Tema: ${theme}. Cmd+Shift+L para alternar.`}
    >
      <Icon size={16} aria-hidden />
    </Button>
  );
}
