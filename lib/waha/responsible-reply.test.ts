import { describe, expect, it } from "vitest";
import { responsibleQuotedId } from "./responsible-reply";

describe("correlação de resposta ao aviso interno",()=>{
  it("usa somente replyTo.id, nunca texto ou nome do cliente",()=>{
    expect(responsibleQuotedId({body:"Resposta ao caso 123"})).toBeNull();
    expect(responsibleQuotedId({replyTo:{id:"true_5511999999999@c.us_ACK123",body:"qualquer texto"}})).toBe("ACK123");
    expect(responsibleQuotedId({replyTo:{id:9}})).toBeNull();
    expect(responsibleQuotedId({replyTo:{id:"x".repeat(513)}})).toBeNull();
  });
});
