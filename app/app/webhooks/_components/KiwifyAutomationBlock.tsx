"use client";
import * as React from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, PencilSimple } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import type { Produto } from "@/lib/schemas/produtos";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import {
  useAutomationRules,
  useCreateAutomationRule,
  useUpdateAutomationRule,
  type AutomationRuleRow,
} from "@/hooks/webhooks/useAutomationRules";
import { AutomationTemplateFields } from "./AutomationTemplateFields";
import { RuleEditor } from "./RuleEditor";
import {
  buildKiwifyPurchaseAutomation,
  isKiwifyPurchaseRule,
} from "@/lib/automation/kiwify-automation";
import { useT } from "@/hooks/i18n/useT";
import { useKiwifyIntegration, useKiwifyOptions, useManageKiwifyIntegration } from "@/hooks/webhooks/useKiwifyIntegration";

const RULES_QUERY_KEY = ["automation-rules"];

export function KiwifyAutomationBlock() {
  const t = useT();
  const { data, isLoading } = useAutomationRules();
  const update = useUpdateAutomationRule();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AutomationRuleRow | null>(null);

  const rules = data?.data ?? [];
  const purchaseRules = rules.filter((r) => isKiwifyPurchaseRule(r));

  const toggleActive = (rule: AutomationRuleRow, checked: boolean) => {
    qc.setQueryData<{ data: AutomationRuleRow[] }>(RULES_QUERY_KEY, (old) =>
      old ? { data: old.data.map((r) => (r.id === rule.id ? { ...r, is_active: checked } : r)) } : old,
    );
    update.mutate(
      { id: rule.id, is_active: checked },
      {
        onSuccess: () => toast.success(checked ? t("Automação ligada.") : t("Automação pausada.")),
        onError: () => qc.invalidateQueries({ queryKey: RULES_QUERY_KEY }),
      },
    );
  };

  return (
    <section className="space-y-4" aria-label={t("Automação de compra Kiwify")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-text">{t("Automação")}</h3>
        {(
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus /> {t("Criar automação de compra")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" aria-label={t("Carregando automação")} />
      ) : purchaseRules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Ao aprovar uma compra (order_approved), envie uma mensagem automática pelo número escolhido.")}
        </p>
      ) : (
        purchaseRules.map((rule) => (
          <Card key={rule.id}>
            <CardHeader className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="truncate">{rule.name}</CardTitle>
                <Badge variant={rule.is_active ? "success" : "neutral"}>
                  {rule.is_active ? t("Ativa") : t("Pausada")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("Quando entrar um contato novo (webhook)")}
              </p>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-2">
              <Switch
                checked={rule.is_active}
                disabled={update.isPending}
                onCheckedChange={(checked) => toggleActive(rule, checked)}
                aria-label={`${rule.is_active ? t("Pausar") : t("Ligar")} ${rule.name}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(rule)}
              >
                <PencilSimple /> {t("Gerenciar automação")}
              </Button>
            </CardContent>
          </Card>
        ))
      )}

      <KiwifyPurchaseForm open={createOpen} onOpenChange={setCreateOpen} />
      <RuleEditor open={!!editing} onOpenChange={(o) => !o && setEditing(null)} rule={editing} />
    </section>
  );
}

function KiwifyPurchaseForm({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  const create = useCreateAutomationRule();
  const manage = useManageKiwifyIntegration();
  const { data: integrationData } = useKiwifyIntegration();
  const { data: optionsData } = useKiwifyOptions();
  const integrations = integrationData?.data.integrations ?? [];
  const options = optionsData?.data;
  const [integrationId, setIntegrationId] = React.useState("");
  const [agentId, setAgentId] = React.useState("");
  const [continueAi, setContinueAi] = React.useState(false);
  const [flowId, setFlowId] = React.useState("");
  const [allowScheduling, setAllowScheduling] = React.useState(false);
  const { data: sessions } = useChannelSessions();
  const productsQuery = useQuery({
    queryKey: ["catalog-products"],
    queryFn: async () => apiClient.get<{ data: Produto[] }>("/api/v1/products"),
    staleTime: 60_000,
  });
  const products = (productsQuery.data?.data ?? []).filter((p) => p.ativo);

  const [name, setName] = React.useState("");
  const [productId, setProductId] = React.useState("");
  const [channelSessionId, setChannelSessionId] = React.useState("");
  const [mode, setMode] = React.useState<"text" | "official" | "ai">("text");
  const [body, setBody] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [templateLanguage, setTemplateLanguage] = React.useState("");
  const [templateValues, setTemplateValues] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setProductId("");
    setChannelSessionId("");
    setMode("text");
    setBody("");
    setTemplateName("");
    setTemplateLanguage("");
    setTemplateValues({});
    setIntegrationId(""); setAgentId(""); setContinueAi(false); setFlowId(""); setAllowScheduling(false);
  }, [open]);

  const eligible = (sessions ?? []).filter((s) => s.status === "WORKING");
  const selectedIntegrationId = integrationId || (integrations.length === 1 ? integrations[0]?.id : "");
  const integration = integrations.find(i => i.id === selectedIntegrationId);
  const selectedAgent = options?.agents.find(a => a.id === agentId);
  const schedulingReason = !selectedAgent ? t("Selecione um agente publicado.")
    : selectedAgent.scheduling_reason ?? (!integration || !selectedAgent.pipeline_ids.includes(integration.pipeline_id) ? t("O agente não tem permissão de escrita no funil da integração.") : null);
  const mappedIds = new Set((integrationData?.data.products ?? []).filter(m => m.integration_id === selectedIntegrationId).map(m => m.product_id));
  const canSave =
    name.trim() &&
    selectedIntegrationId && productId && mappedIds.has(productId) &&
    channelSessionId &&
    (!(mode === "ai" || continueAi) || selectedAgent) &&
    (!allowScheduling || (continueAi && !schedulingReason)) &&
    (mode !== "official" ? body.trim().length > 0 : Boolean(templateName && templateLanguage));
  // Trava síncrona contra duplo clique: sem ela, um segundo clique no MESMO
  // tick (antes do re-render que aplica `create.isPending`) criaria DUAS regras
  // idênticas — a rota de automação não tem unicidade que impeça.
  const submitting = React.useRef(false);
  // Identidade da operação pendente de criação: a MESMA chave + snapshot do
  // payload são reutilizados ao recuperar uma criação com resposta perdida.
  // Mudou o payload (edição deliberada) → nova operação, nova chave.
  const pendingOp = React.useRef<{ key: string; fingerprint: string } | null>(null);

  const submit = async () => {
    if (submitting.current || !canSave) return;
    submitting.current = true;
    try {
      const payload = buildKiwifyPurchaseAutomation({
        name: name.trim(),
        productId,
        channelSessionId,
        agentId, continueAi, flowPointerId: flowId || undefined, allowScheduling,
        ...(mode === "ai" ? { aiInstruction: body.trim() } : mode === "text"
          ? { template: body.trim() }
          : { templateName, templateLanguage, templateValues }),
      });
      const fingerprint = JSON.stringify({ payload, integrationId: selectedIntegrationId });
      const key = pendingOp.current?.fingerprint === fingerprint ? pendingOp.current.key : randomId();
      pendingOp.current = { key, fingerprint };
      const created = await create.mutateAsync({ ...payload, idempotencyKey: key });
      await manage.mutateAsync({ id: selectedIntegrationId!, operation: "link", ruleId: created.data.id });
      toast.success(t("Automação criada — ligue quando estiver pronta."));
      pendingOp.current = null;
      onOpenChange(false);
    } finally {
      submitting.current = false;
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t("Automação de compra Kiwify")}</SheetTitle>
          <SheetDescription>
            {t("Quando uma compra for aprovada (order_approved) para este produto, enviar mensagem pelo número escolhido.")}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="kiwify-automation-name">{t("Nome da automação")}</Label>
            <Input
              id="kiwify-automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Aviso de compra aprovada")}
              maxLength={120}
            />
          </div>

          <div className="space-y-1">
            <Label>{t("Integração")}</Label>
            <Select value={selectedIntegrationId} onValueChange={(id) => { setIntegrationId(id); setProductId(""); setAllowScheduling(false); }}>
              <SelectTrigger aria-label={t("Integração da automação")}><SelectValue placeholder={t("Escolha a integração")} /></SelectTrigger>
              <SelectContent>{integrations.map(i => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t("Produto")}</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger aria-label={t("Produto")}><SelectValue placeholder={t("Escolha o produto")} /></SelectTrigger>
              <SelectContent>
                {products.filter(p => mappedIds.has(p.id)).map((p) => <SelectItem key={p.id} value={p.id}>{p.nome}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>{t("Número de WhatsApp")}</Label>
            <Select value={channelSessionId} onValueChange={setChannelSessionId}>
              <SelectTrigger aria-label={t("Número de WhatsApp")}><SelectValue placeholder={t("Escolha o número")} /></SelectTrigger>
              <SelectContent>
                {eligible.map((s) => (
                  <SelectItem key={s.id} value={s.id} disabled={s.status !== "WORKING"}>
                    {channelLabel(s) + (s.status !== "WORKING" ? " — desconectado" : "")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>{t("Mensagem")}</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "text" | "official" | "ai")}>
              <SelectTrigger aria-label={t("Tipo de mensagem")}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="text">{t("Texto livre")}</SelectItem>
                <SelectItem value="official">{t("Template aprovado")}</SelectItem>
                <SelectItem value="ai">{t("Mensagem escrita pela IA")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "ai" ? <Textarea aria-label={t("Instrução da mensagem inicial")} rows={4} maxLength={1000} value={body} onChange={e => setBody(e.target.value)} placeholder={t("Oriente o agente sobre a mensagem inicial.")} /> : mode === "text" ? (
            <Textarea aria-label={t("Texto da mensagem")} rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("Oi {{nome}}, obrigado pela compra!")} />
          ) : (
            <AutomationTemplateFields
              config={{ channel_session_id: channelSessionId, template_name: templateName, template_language: templateLanguage, template_values: templateValues }}
              onChange={(c) => {
                setTemplateName(c.template_name ?? "");
                setTemplateLanguage(c.template_language ?? "");
                setTemplateValues(c.template_values ?? {});
              }}
            />
          )}

          <label className="flex items-center gap-2"><Switch checked={continueAi} onCheckedChange={value => { setContinueAi(value); if (!value) setAllowScheduling(false); }} />{t("IA continua atendendo o lead")}</label>
          {mode === "ai" || continueAi ? <div className="space-y-1">
            <Label>{t("Agente publicado")}</Label>
            <Select value={agentId} onValueChange={id => { setAgentId(id); setAllowScheduling(false); }}>
              <SelectTrigger aria-label={t("Agente publicado")}><SelectValue placeholder={t("Escolha o agente")} /></SelectTrigger>
              <SelectContent>{options?.agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div> : null}
          <div className="space-y-1"><Label>{t("Follow-up existente (opcional)")}</Label>
            <Select value={flowId || "none"} onValueChange={id => setFlowId(id === "none" ? "" : id)}>
              <SelectTrigger aria-label={t("Follow-up existente")}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">{t("Sem follow-up")}</SelectItem>{options?.followups.map(f => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><label className="flex items-center gap-2"><Switch checked={allowScheduling} onCheckedChange={setAllowScheduling} disabled={!continueAi || !!schedulingReason} />{t("Permitir tentativa de agendamento")}</label>
            <p className="text-xs text-muted-foreground">{!continueAi ? t("Habilite a continuidade da IA para tentar agendar.") : t(schedulingReason ?? "A IA consulta horários reais e só agenda após a escolha do cliente. Nenhuma permissão é concedida por esta opção.")}</p>
          </div>

          <p className="rounded-sm border border-border bg-muted p-3 text-sm text-muted-foreground">
            {t("A automação nasce pausada. Revise e ligue quando estiver pronta.")}
          </p>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("Cancelar")}</Button>
            <Button type="button" onClick={submit} disabled={!canSave || create.isPending}>
              {create.isPending ? t("Salvando…") : t("Criar automação")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
