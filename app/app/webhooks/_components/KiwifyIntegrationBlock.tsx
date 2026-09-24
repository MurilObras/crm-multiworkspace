"use client";
import * as React from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy, Plus, Trash } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { randomId } from "@/lib/random-id";
import type { Produto } from "@/lib/schemas/produtos";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import {
  useKiwifyIntegration,
  useCreateKiwifyIntegration,
  type KiwifyProductMappingInput,
} from "@/hooks/webhooks/useKiwifyIntegration";
import { webhookUrlKiwify } from "@/lib/automation/kiwify-webhook-url";
import { useT } from "@/hooks/i18n/useT";

interface MappingRow extends KiwifyProductMappingInput {
  key: string;
}

function novaLinha(): MappingRow {
  return { key: randomId(), external_product_id: "", product_id: "" };
}

/** Origem visível ao navegador — a que a Kiwify precisa chamar de fora. */
function origem(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export function KiwifyIntegrationBlock() {
  const t = useT();
  const { data, isLoading } = useKiwifyIntegration();
  const create = useCreateKiwifyIntegration();

  const { data: pipelinesRes } = usePipelines();
  const pipelines = pipelinesRes?.data ?? [];

  const [formOpen, setFormOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [storeId, setStoreId] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [pipelineId, setPipelineId] = React.useState("");
  const [stageId, setStageId] = React.useState("");
  const [mappings, setMappings] = React.useState<MappingRow[]>([novaLinha()]);
  const submitting = React.useRef(false);

  const { data: boardRes } = usePipelineStages(pipelineId || null);
  const stages = boardRes?.data?.stages ?? [];

  const productsQuery = useQuery({
    queryKey: ["catalog-products"],
    queryFn: async () => apiClient.get<{ data: Produto[] }>("/api/v1/products"),
    staleTime: 60_000,
  });
  const products = (productsQuery.data?.data ?? []).filter((p) => p.ativo);

  const [createdUrl, setCreatedUrl] = React.useState<string | null>(null);

  const integrations = data?.data?.integrations ?? [];
  const mappingsByIntegration = React.useMemo(() => {
    const map = new Map<string, KiwifyProductMappingInput[]>();
    for (const m of data?.data?.products ?? []) {
      const list = map.get(m.integration_id) ?? [];
      list.push(m);
      map.set(m.integration_id, list);
    }
    return map;
  }, [data?.data?.products]);

  const productName = (id: string) => products.find((p) => p.id === id)?.nome ?? id;

  const resetForm = () => {
    setName("");
    setStoreId("");
    setSecret("");
    setPipelineId("");
    setStageId("");
    setMappings([novaLinha()]);
  };

  const submit = async () => {
    if (submitting.current) return;
    const produtos = mappings
      .filter((m) => m.external_product_id.trim() && m.product_id)
      .map((m) => ({ external_product_id: m.external_product_id.trim(), product_id: m.product_id }));
    if (!name.trim() || !storeId.trim() || !secret || !pipelineId || !stageId || produtos.length === 0) {
      toast.error(t("Preencha nome, loja, segredo, funil, etapa e ao menos um produto."));
      return;
    }
    // Trava síncrona contra duplo clique: `create.isPending` só desabilita o
    // botão no render seguinte; um segundo clique no MESMO tick criaria duas
    // integrações (ou esbarraria no UNIQUE com um erro confuso).
    submitting.current = true;
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        store_id: storeId.trim(),
        secret,
        pipeline_id: pipelineId,
        stage_id: stageId,
        products: produtos,
      });
      // O segredo nunca volta a viver fora do envio: some do formulário na hora.
      setSecret("");
      setCreatedUrl(webhookUrlKiwify(origem(), result.data.endpoint));
      resetForm();
      setFormOpen(false);
    } finally {
      submitting.current = false;
    }
  };

  const copiar = async (url: string) => {
    const ok = await copyToClipboard(url);
    if (ok) toast.success(t("URL copiada."));
    else toast.error(t("Não foi possível copiar. Copie manualmente."));
  };

  return (
    <section className="space-y-4" aria-label={t("Integração Kiwify")}>
      {createdUrl ? (
        <Card className="border-accent">
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center gap-2">
              <Badge variant="success">{t("Integração criada")}</Badge>
            </div>
            <p className="text-sm">{t("Aponte o webhook da Kiwify para:")}</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={createdUrl} aria-label={t("URL do webhook")} />
              <Button type="button" variant="secondary" onClick={() => copiar(createdUrl)}>
                <Copy /> {t("Copiar URL do webhook")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-text">{t("Integração")}</h3>
        <Button type="button" variant="secondary" onClick={() => setFormOpen((v) => !v)}>
          <Plus /> {t("Nova integração")}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" aria-label={t("Carregando integração")} />
      ) : integrations.length === 0 && !formOpen ? (
        <p className="text-sm text-muted-foreground">
          {t("Nenhuma integração Kiwify configurada ainda.")}
        </p>
      ) : null}

      {integrations.map((int) => {
        const url = webhookUrlKiwify(origem(), int.path_token);
        const intMappings = mappingsByIntegration.get(int.id) ?? [];
        return (
          <Card key={int.id}>
            <CardHeader className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="truncate">{int.name}</CardTitle>
                <Badge variant={int.is_active ? "success" : "neutral"}>
                  {int.is_active ? t("Ativa") : t("Inativa")}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{t("Loja")}: {int.store_id}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={url} aria-label={t("URL do webhook")} />
                <Button type="button" variant="secondary" onClick={() => copiar(url)}>
                  <Copy /> {t("Copiar URL do webhook")}
                </Button>
              </div>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {intMappings.map((m) => (
                  <div key={`${m.external_product_id}:${m.product_id}`} className="flex items-baseline gap-2">
                    <dt className="text-muted-foreground">{m.external_product_id}</dt>
                    <dd>→ {productName(m.product_id)}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        );
      })}

      {formOpen ? (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="kiwify-name">{t("Nome")}</Label>
                <Input id="kiwify-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="kiwify-store">{t("Store ID")}</Label>
                <Input id="kiwify-store" value={storeId} onChange={(e) => setStoreId(e.target.value)} maxLength={128} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="kiwify-secret">{t("Secret / token da Kiwify")}</Label>
                <Input id="kiwify-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} maxLength={512} autoComplete="new-password" />
                <p className="text-xs text-muted-foreground">{t("Nunca é exibido depois de salvo nem gravado no navegador.")}</p>
              </div>
              <div className="space-y-1">
                <Label>{t("Funil")}</Label>
                <Select value={pipelineId} onValueChange={(v) => { setPipelineId(v); setStageId(""); }}>
                  <SelectTrigger aria-label={t("Funil")}><SelectValue placeholder={t("Escolha o funil")} /></SelectTrigger>
                  <SelectContent>
                    {pipelines.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("Etapa")}</Label>
                <Select value={stageId} onValueChange={setStageId} disabled={!pipelineId}>
                  <SelectTrigger aria-label={t("Etapa")}><SelectValue placeholder={pipelineId ? t("Escolha a etapa") : t("Escolha o funil primeiro")} /></SelectTrigger>
                  <SelectContent>
                    {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("Mapeamento de produtos (external_product_id → produto interno)")}</Label>
              {mappings.map((m, idx) => (
                <div key={m.key} className="flex flex-wrap items-center gap-2">
                  <Input
                    className="flex-1 basis-40"
                    placeholder={t("external_product_id")}
                    value={m.external_product_id}
                    onChange={(e) => setMappings((prev) => prev.map((r, i) => (i === idx ? { ...r, external_product_id: e.target.value } : r)))}
                    maxLength={128}
                  />
                  <Select
                    value={m.product_id}
                    onValueChange={(v) => setMappings((prev) => prev.map((r, i) => (i === idx ? { ...r, product_id: v } : r)))}
                  >
                    <SelectTrigger className="flex-1 basis-40" aria-label={t("Produto interno")}><SelectValue placeholder={t("Produto interno")} /></SelectTrigger>
                    <SelectContent>
                      {products.map((p) => <SelectItem key={p.id} value={p.id}>{p.nome}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={mappings.length === 1}
                    onClick={() => setMappings((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label={t("Remover produto")}
                  >
                    <Trash />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={() => setMappings((prev) => [...prev, novaLinha()])}>
                <Plus /> {t("Adicionar produto")}
              </Button>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setFormOpen(false)}>{t("Cancelar")}</Button>
              <Button type="button" onClick={submit} disabled={create.isPending}>
                {create.isPending ? t("Salvando…") : t("Salvar integração")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
