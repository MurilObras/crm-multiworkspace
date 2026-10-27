import {beforeEach,describe,it,expect,vi} from 'vitest';
import {z} from 'zod';
const mock=vi.hoisted(()=>vi.fn());
vi.mock('../edge/llm/run-model-call',()=>({runModelCall:mock}));
import {checkpointCall} from './checkpoint-call';
const schema=z.object({rolling_summary:z.string()});
const input={tenantId:'org',jobId:'job',system:'TOM COMERCIAL',messages:[],tools:{mutante:{}},model:'configured'};
const args=[{} as never,{} as never,input as never,schema,{}] as const;
beforeEach(()=>{mock.mockReset();});
describe('fechamento isolado',()=>{
 it('usa saída estruturada, preserva modelo e nunca recebe tools comerciais',async()=>{
 mock.mockResolvedValue({result:{text:'',output:{rolling_summary:'confirmado'}}});
 const call=await checkpointCall(...args);expect(call.result.text).toBe('{"rolling_summary":"confirmado"}');
 expect(mock.mock.calls[0]![2]).toMatchObject({purpose:'checkpoint',model:'configured',maxSteps:1,outputSchema:schema});
 expect(mock.mock.calls[0]![2].tools).toBeUndefined();expect(mock.mock.calls[0]![2].system).not.toContain('TOM COMERCIAL');
 });
 it('corrige formato uma única vez e não inventa resumo',async()=>{
 mock.mockResolvedValue({result:{text:'invalido'}});
 await expect(checkpointCall(...args)).rejects.toBeDefined();expect(mock).toHaveBeenCalledTimes(2);
 });
 it('não repete chamada por credencial ou orçamento',async()=>{
 mock.mockRejectedValue(new Error('budget'));await expect(checkpointCall(...args)).rejects.toThrow('budget');expect(mock).toHaveBeenCalledTimes(1);
 });
 it('usa fallback validado somente se o provedor não aceitar o formato',async()=>{
 const e=new Error();e.name='AI_UnsupportedFunctionalityError';mock.mockRejectedValueOnce(e).mockResolvedValueOnce({result:{text:'{"rolling_summary":"fato confirmado"}'}});
 expect((await checkpointCall(...args)).result.text).toContain('fato confirmado');expect(mock).toHaveBeenCalledTimes(2);expect(mock.mock.calls[1]![2].outputSchema).toBeUndefined();
 });
});
