import { describe, expect, it } from "vitest";
import { consultationSettingsSchema, consultationInstructions } from "@/lib/responsibles/config";

describe("consulta silenciosa configurável",()=>{
 it("preserva o aviso nas configurações antigas e não liga encaminhamento de áudio sozinho",()=>{
   const settings=consultationSettingsSchema.parse({enabled:false,recipient_ids:[],conditions:""});
   expect(settings).toMatchObject({notify_client:true,audio_failures_to_responsible:false});
 });
 it("não promete aviso quando desligado e orienta consulta de áudio sem inventar conteúdo",()=>{
   const prompt=consultationInstructions({enabled:true,conditions:"",notify_client:false,audio_failures_to_responsible:true});
   expect(prompt).toContain("não avise o cliente"); expect(prompt).toMatch(/não invente/i);
   expect(prompt).not.toContain("O sistema avisará o cliente");
 });
});
