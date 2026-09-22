"use client";
import * as React from "react";
import { Separator } from "@/components/ui/separator";
import { KiwifyIntegrationBlock } from "./KiwifyIntegrationBlock";
import { KiwifyHistoryTab } from "./KiwifyHistoryTab";
import { KiwifyAutomationBlock } from "./KiwifyAutomationBlock";
import { useT } from "@/hooks/i18n/useT";

export function KiwifyTab({ organizationId }: { organizationId: string }) {
  const t = useT();
  return (
    <div className="space-y-8 pt-4" aria-label={t("Operação Kiwify")}>
      <KiwifyIntegrationBlock />
      <Separator />
      <KiwifyAutomationBlock />
      <Separator />
      <KiwifyHistoryTab organizationId={organizationId} />
    </div>
  );
}
