import { createScryptPasswordHash } from "../src/test-user-access.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const password = Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/u, "");
if (!password) throw new Error("Read the administrator password from standard input.");
process.stdout.write(`${createScryptPasswordHash(password)}\n`);
