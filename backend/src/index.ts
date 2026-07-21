import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpMesaAdapter, UnavailableMesaAdapter } from "./mesa-adapter.ts";
import { BackendApp } from "./server.ts";

const root = join(fileURLToPath(new URL("..", import.meta.url)), ".riff-workspaces");
const mesa = process.env.MESA_SERVICE_URL ? new HttpMesaAdapter(process.env.MESA_SERVICE_URL) : new UnavailableMesaAdapter();
const port = Number(process.env.PORT ?? 8787);
const app = new BackendApp({
  mesa,
  workspaceRoot: process.env.WORKSPACE_ROOT ?? root,
});

await app.initialize();
const address = await app.listen(port);
console.log(`Riff demo backend listening at http://${address.host}:${address.port}`);
