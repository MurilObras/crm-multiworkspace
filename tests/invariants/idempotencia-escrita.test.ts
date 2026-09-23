import { beforeAll, describe, expect, it } from "vitest";
import { GOV_ORG, GOV_MANAGER, GOV_AGENT_A, seedGov, sql } from "./gov-helpers";
import { chaveDeIdempotencia, hashCanonico, idRecurso } from "@/lib/api/idempotency";

/**
 * Idempotência de escrita de POST /api/v1/messages e POST /api/v1/automation-rules.
 *
 * A duplicação é impedida pelo ID DETERMINÍSTICO do recurso (o PRIMARY KEY do
 * recurso é o árbitro atômico da concorrência e da recuperação pós-crash), não
 * por UNIQUE de texto/nome — duas regras legítimas com o mesmo texto/nome
 * continuam permitidas, desde que usem chaves diferentes. A tabela
 * `idempotency_keys` (UNIQUE organization_id+endpoint+key) guarda o hash para
 * detectar "mesma chave, payload diferente" (conflito).
 */
beforeAll(() => seedGov());

describe("idempotência de escrita (determinístico + UNIQUE)", () => {
  it("idRecurso: mesma chave → mesmo id; chave/ator/org/endpoint diferentes → ids diferentes", () => {
    const base = idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/automation-rules", "k");
    expect(idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/automation-rules", "k")).toBe(base);
    expect(idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/automation-rules", "k2")).not.toBe(base);
    expect(idRecurso(GOV_ORG, GOV_AGENT_A, "/api/v1/automation-rules", "k")).not.toBe(base);
    expect(idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/messages", "k")).not.toBe(base);
    expect(idRecurso("dddddddd-0000-4000-8000-000000000009", GOV_MANAGER, "/api/v1/automation-rules", "k")).not.toBe(base);
  });

  it("automation_rules: repetir o MESMO id determinístico colide no PK — uma regra só, retry reusa", () => {
    const id = idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/automation-rules", "k-rule");
    sql(
      `insert into automation_rules(id, organization_id, name, trigger_event, conditions, actions)
       values('${id}','${GOV_ORG}','idem','lead.created','[]','[]')`,
    );
    // Mesmo id (retry/concorrência) → unique_violation, nenhuma segunda regra.
    expect(() =>
      sql(
        `insert into automation_rules(id, organization_id, name, trigger_event, conditions, actions)
         values('${id}','${GOV_ORG}','idem','lead.created','[]','[]')`,
      ),
    ).toThrow();
    expect(sql(`select count(*) from automation_rules where id='${id}' and organization_id='${GOV_ORG}'`)).toBe("1");
    // Regra nova deliberada (chave diferente) com o MESMO nome/texto continua possível.
    const outro = idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/automation-rules", "k-rule-2");
    sql(
      `insert into automation_rules(id, organization_id, name, trigger_event, conditions, actions)
       values('${outro}','${GOV_ORG}','idem','lead.created','[]','[]')`,
    );
    expect(sql(`select count(*) from automation_rules where organization_id='${GOV_ORG}' and name='idem'`)).toBe("2");
  });

  it("idempotency_keys: (organization_id, endpoint, key) é único — colisão é parte do contrato", () => {
    const chave = chaveDeIdempotencia(GOV_MANAGER, "k-key");
    const hash = hashCanonico({ x: 1 });
    sql(
      `insert into idempotency_keys(organization_id, endpoint, key, request_hash, status_code, response_body)
       values('${GOV_ORG}','/api/v1/messages','${chave}','\\x${hash}'::bytea,201,'{}')`,
    );
    expect(() =>
      sql(
        `insert into idempotency_keys(organization_id, endpoint, key, request_hash, status_code, response_body)
         values('${GOV_ORG}','/api/v1/messages','${chave}','\\x${hash}'::bytea,201,'{}')`,
      ),
    ).toThrow();
  });

  it("isolamento entre organizações: a MESMA chave em outra org não colide", () => {
    sql(
      `insert into organizations(id, slug, legal_name, display_name)
       values('dddddddd-0000-4000-8000-000000000001','idem-b','B','B') on conflict do nothing`,
    );
    const chave = chaveDeIdempotencia(GOV_MANAGER, "k-org");
    const hash = hashCanonico({ x: 1 });
    sql(
      `insert into idempotency_keys(organization_id, endpoint, key, request_hash, status_code, response_body)
       values('${GOV_ORG}','/api/v1/messages','${chave}','\\x${hash}'::bytea,201,'{}')`,
    );
    // Mesma chave, outra organização: escopo por organization_id no UNIQUE.
    sql(
      `insert into idempotency_keys(organization_id, endpoint, key, request_hash, status_code, response_body)
       values('dddddddd-0000-4000-8000-000000000001','/api/v1/messages','${chave}','\\x${hash}'::bytea,201,'{}')`,
    );
    expect(sql(`select count(*) from idempotency_keys where key='${chave}'`)).toBe("2");
  });
});
