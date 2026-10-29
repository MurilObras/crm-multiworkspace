"use client";
import { useSyncExternalStore, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";

const subscribePlatform = () => () => {};
const isApplePlatform = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const serverPlatform = () => false;

export function SearchTrigger() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const apple = useSyncExternalStore(subscribePlatform, isApplePlatform, serverPlatform);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-11 w-11 shrink-0 gap-2 px-0 text-muted-foreground md:h-9 md:w-full md:max-w-sm md:justify-start md:px-3"
        aria-label={t("Buscar...")}
        onClick={() => setOpen(true)}
      >
        <MagnifyingGlass size={14} aria-hidden />
        <span className="hidden md:inline">{t("Buscar...")}</span>
        <kbd
          aria-hidden
          className="ml-auto hidden rounded-md border bg-muted px-1.5 py-0.5 text-xs md:inline"
        >
          {apple ? "⌘ K" : "Ctrl + K"}
        </kbd>
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
