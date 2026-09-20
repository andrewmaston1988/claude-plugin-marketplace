#!/usr/bin/env node
import { main } from "../scripts/swarm.mjs";

const code = await main();
setTimeout(() => process.exit(code), 150);
