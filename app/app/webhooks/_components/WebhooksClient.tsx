"use client";
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { SourcesTab } from "./SourcesTab";
import { RulesTab } from "./RulesTab";
import { ActivityTab } from "./ActivityTab";
import { KiwifyHistoryTab } from "./KiwifyHistoryTab";
import { CapturasTab } from "./CapturasTab";
import { useT } from "@/hooks/i18n/useT";

export function WebhooksClient({organizationId}:{organizationId:string}) {
  const t = useT();
  // Radix Tabs gera ids via useId; com SSR streamado (Next 15) os ids divergem
  // entre server e client e o React acusa hydration mismatch. Nenhuma outra
  // página do app SSRa Tabs no primeiro paint (todas montam pós-fetch) —
  // seguimos o mesmo padrão: skeleton no SSR, Tabs após mount.
  const mounted = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    () => true,
    () => false,
  );

  if (!mounted) {
    // Placeholder responsivo: a aba de acompanhamento também cabe no container.
    return (
      <div className="flex-1">
        <Skeleton className="h-9 w-full max-w-lg" />
      </div>
    );
  }

  return (
    <Tabs defaultValue="sources" className="flex-1">
      <TabsList className="h-auto flex-wrap">
        <TabsTrigger value="sources">{t("Receber dados")}</TabsTrigger>
        <TabsTrigger value="capturas">{t("Leads recebidos")}</TabsTrigger>
        <TabsTrigger value="rules">{t("Automações")}</TabsTrigger>
        <TabsTrigger value="activity">{t("Atividade")}</TabsTrigger>
        <TabsTrigger value="kiwify">Kiwify</TabsTrigger>
      </TabsList>
      <TabsContent value="sources"><SourcesTab /></TabsContent>
      <TabsContent value="capturas"><CapturasTab /></TabsContent>
      <TabsContent value="rules"><RulesTab /></TabsContent>
      <TabsContent value="activity"><ActivityTab /></TabsContent>
      <TabsContent value="kiwify"><KiwifyHistoryTab organizationId={organizationId} /></TabsContent>
    </Tabs>
  );
}
