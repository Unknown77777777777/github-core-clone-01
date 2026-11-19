import { Store } from "./store.ts";
import { createServerApp } from "./app.ts";

// Forge entrypoint: bind an ephemeral port, register it with the harness,
// then long-poll for completion. All state lives in memory in this process.
const store = new Store();
const token = process.env.MAKEFUN_SHOP_TOKEN || "";
const envUrl = (process.env.MAKEFUN_ENV_URL || "").replace(/\/$/, "");

const server = createServerApp(store, token);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  if (!envUrl) return;
  const res = await fetch(envUrl + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ port }),
  });
  if (!res.ok) throw new Error("register failed: " + res.status);
}

async function waitForDone(): Promise<void> {
  if (!envUrl) return;
  for (;;) {
    try {
      const res = await fetch(envUrl + "/done", { method: "GET" });
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done) return;
      }
    } catch {
      // harness not ready yet; keep polling
    }
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  // Shut down cleanly if the harness stops us mid-trial.
  process.once("SIGTERM", () => {
    try {
      server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("could not determine listen port"));
    });
  });
  // Register with retries so a slow harness still sees us.
  let registered = false;
  for (let attempt = 0; attempt < 30 && !registered; attempt++) {
    try {
      await register(port);
      registered = true;
    } catch {
      await sleep(500);
    }
  }
  if (envUrl && !registered) {
    process.exitCode = 1;
    server.close();
    return;
  }
  await waitForDone();
  server.close();
  process.exit(0);
}

main().catch(() => {
  process.exitCode = 1;
  try {
    server.close();
  } catch {
    // ignore
  }
});
