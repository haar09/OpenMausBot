import { z } from "zod";
import { loopGuardConfigSchema, type LoopGuardConfig } from "./host/loop-guard.ts";

/** Root delegation limits loaded at server startup; progress never resets lifetime caps. */
const coordinationConfigSchema = z.object({
  depth: z.number().int().min(0).max(10).optional(),
  totalRequests: z.number().int().min(1).max(1000).optional(),
  totalExecutions: z.number().int().min(1).max(10000).optional(),
}).strict();

export const executionControlShape = {
  loopGuard: loopGuardConfigSchema.optional(),
  coordination: coordinationConfigSchema.optional(),
};

/** `config.json` execution controls; coordination changes take effect after restart. */
export interface ExecutionControlConfig {
  loopGuard?: LoopGuardConfig;
  coordination?: z.infer<typeof coordinationConfigSchema>;
}
