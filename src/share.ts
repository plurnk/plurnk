import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ShareResult { readonly folder: string }

// The daemon writes the share on its host and takes only an absolute folder. A leading `~/`
// expands as it does for every explicit Plurnk path; a relative folder is the caller's.
export const shareFolder = (raw: string, cwd: string = process.cwd(), home: string = homedir()): string =>
    resolve(cwd, raw.startsWith("~/") ? join(home, raw.slice(2)) : raw);

export const formatShare = ({ folder }: ShareResult): string => [
    `share: ${folder}`,
    "share: this holds what the models saw and wrote in this workspace, unredacted; review it before sending.",
].join("\n");
