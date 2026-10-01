import type { FunctionalityFamily } from "./commands.ts";
import { handleMcp } from "./mcp.ts";
import { handleSkills } from "./skills.ts";
import { handleA2a } from "./a2a.ts";
import { handleMembers } from "./members.ts";
import { handleEnv } from "./env.ts";
import { handleSchedule } from "./schedule.ts";

export const FAMILY_HANDLERS: Readonly<Record<FunctionalityFamily, typeof handleMcp>> = {
    mcp: handleMcp,
    skills: handleSkills,
    a2a: handleA2a,
    members: handleMembers,
    env: handleEnv,
    schedule: handleSchedule,
};

export const isFamily = (name: string): name is FunctionalityFamily => Object.hasOwn(FAMILY_HANDLERS, name);
