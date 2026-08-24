// NO_COLOR conformance (no-color.org, plurnk#29): ANY non-empty value disables
// color — never just "1"/"true". The one shared predicate for every ANSI gate;
// a function so cache-busted test re-imports observe the current environment.
export const colorEnabled = (): boolean => (process.env.NO_COLOR ?? "") === "";
