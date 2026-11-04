import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { managedImageDockerfile } from "../server/container-computer.ts";

const target = resolve(process.argv[2] ?? ".omb-scratch/dmxo/desktop.Dockerfile");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, managedImageDockerfile());
