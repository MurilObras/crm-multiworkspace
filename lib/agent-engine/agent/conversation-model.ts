/** Montagem residente e chamada do Conversador: usadas pelo worker e pelo ensaio. */
import type pg from "pg";
import { loadPlaybook } from "./playbook";
import { loadSkills, renderSkillIndex } from "./skills";
import { composeSystemPrompt, loadOrgMemory, renderOrgMemory } from "./org-memory";
import {
  runModelCall,
  type LlmEdgeConfig,
  type RunModelCallInput,
  type RunModelCallDeps,
} from "../edge/llm/run-model-call";

export async function loadConversationInstructions(
  pool: pg.Pool,
  tenantId: string,
  agentPrompt?: string,
) {
  const playbook = await loadPlaybook(
    pool,
    tenantId,
    agentPrompt === undefined ? undefined : { agentLayer: agentPrompt },
  );
  const skills = await loadSkills(pool, tenantId);
  const orgMemory = await loadOrgMemory(pool, tenantId);
  return {
    playbook,
    skills,
    systemWithMemory: composeSystemPrompt({
      playbookPrompt: playbook.prompt,
      orgMemoryBlock: renderOrgMemory(orgMemory),
      skillIndex: renderSkillIndex(skills),
    }),
  };
}

export function runConversationModel(
  pool: pg.Pool,
  config: LlmEdgeConfig,
  input: RunModelCallInput,
  deps?: RunModelCallDeps,
) {
  return runModelCall(pool, config, input, deps);
}
