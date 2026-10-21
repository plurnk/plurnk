// The test files the integration and TUI tiers run at once on this host: its available cores, bounded by the files its
// available memory holds. Each file may start a real daemon and terminal fixtures; a TUI journey's process tree peaks
// near 610 MiB, an integration file's near 470 MiB.
import { availableParallelism } from "node:os";

const FILE_BYTES = 640 * 2 ** 20;

export const testConcurrency = (cores = availableParallelism(), memory = process.availableMemory()) =>
    Math.max(1, Math.min(cores, Math.floor(memory / FILE_BYTES)));

if (import.meta.main) console.log(testConcurrency());
