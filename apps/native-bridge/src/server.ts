import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createNativeBridgeServer, type NativeBridgeConfig } from "./bridge-server";

const BLOCKED_BROWSER_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 993, 995, 2049, 3659, 4045, 6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080, 11779]);
const args = process.argv.slice(2);
const value = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const origins = args.flatMap((item, index) => item === "--allow-origin" && args[index + 1] ? [args[index + 1]!] : []);
const configFile = value("--config");
const fromFile = configFile ? JSON.parse(await readFile(configFile, "utf8")) as Partial<NativeBridgeConfig> : {};
const pairingCode = value("--pairing-code") ?? randomBytes(32).toString("base64url");
const config: NativeBridgeConfig = { ...fromFile, pairingCode, allowedOrigins: origins.length ? origins : fromFile.allowedOrigins ?? [] };
if (!config.allowedOrigins.length) throw new Error("Pass at least one --allow-origin. The bridge never permits wildcard origins.");
const bridge = await createNativeBridgeServer(config);
const requestedPort = Number(value("--port") ?? 0);
const port = await listenOnBrowserSafePort(bridge.server, requestedPort);
console.log(JSON.stringify({ protocol: "ba-native/1", endpoint: `http://127.0.0.1:${port}`, pairingCode, expiresAt: bridge.status().pairingExpiresAt, fingerprint: bridge.status().fingerprint }));
process.on("SIGINT", () => void bridge.close().then(() => process.exit(0)));
process.on("SIGTERM", () => void bridge.close().then(() => process.exit(0)));

// Browsers reject a small set of historically sensitive TCP ports. Port 0 is retried rather
// than printing an endpoint which fetch() cannot reach (notably 11779/OpenPGP).
async function listenOnBrowserSafePort(server: import("node:http").Server, requested: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(requested || 0, "127.0.0.1", () => { server.off("error", reject); resolvePromise(); }); });
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    if (!BLOCKED_BROWSER_PORTS.has(port)) return port;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    if (requested) throw new Error(`The requested port ${requested} is blocked by browsers; choose another loopback port.`);
  }
  throw new Error("Could not allocate a browser-safe loopback port.");
}
