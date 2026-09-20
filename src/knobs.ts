// {§cli-env-defaults} — a knob is the panel's value, read from the system environment, and a flag
// is its spelling for one invocation. Nothing here carries a value of its own: a live knob the
// floor did not supply is a broken install, and a switch that is neither on nor off is a mistake.
const ON = new Set(["1", "true", "yes", "on"]);
const OFF = new Set(["0", "false", "no", "off"]);

export class KnobError extends TypeError {
    readonly knob: string;
    readonly value: string;

    constructor(knob: string, value: string, reason: string) {
        super(`${knob} ${reason}`);
        this.knob = knob;
        this.value = value;
    }
}

export default class Knobs {
    static text(name: string, env: NodeJS.ProcessEnv = process.env): string {
        const raw = env[name];
        if (raw === undefined) throw new KnobError(name, "", "is missing from the client's environment floor.");
        return raw;
    }

    // A switch. Unset is off only for an optional knob, which is what `declared` says.
    static flag(name: string, declared: "live" | "optional", env: NodeJS.ProcessEnv = process.env): boolean {
        const raw = env[name];
        if (raw === undefined || (declared === "optional" && raw.length === 0)) {
            if (declared === "optional") return false;
            throw new KnobError(name, "", "is missing from the client's environment floor.");
        }
        const folded = raw.toLowerCase();
        if (ON.has(folded)) return true;
        if (OFF.has(folded)) return false;
        throw new KnobError(name, raw, `must be one of ${[...ON, ...OFF].join(", ")}.`);
    }
}
