#!/usr/bin/env -S node --
import { refuseBelowFloor } from "../dist/runtime-floor.js";
refuseBelowFloor("plurnk");
const { main } = await import("../dist/dispatcher.js");
await main(process.argv);
