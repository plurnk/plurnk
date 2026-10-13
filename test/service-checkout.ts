import { resolve } from "node:path";

// The service checkout the client's tests drive and borrow fixtures from: PLURNK_SERVICE_CHECKOUT,
// else the sibling checkout beside this one. One knob, resolved here and nowhere else; a blank
// value is unset and a relative one is taken from the client root.
const CLIENT_ROOT = resolve(import.meta.dirname, "..");

export const serviceCheckout = (): string => {
    const configured = process.env.PLURNK_SERVICE_CHECKOUT?.trim();
    return resolve(CLIENT_ROOT, configured === undefined || configured.length === 0 ? "../plurnk-service" : configured);
};

export const servicePath = (...segments: string[]): string => resolve(serviceCheckout(), ...segments);
