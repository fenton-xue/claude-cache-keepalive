import { CcPeer } from "cc-peer";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const pid = Number(process.argv[2]), body = process.argv[3], sec = Number(process.argv[4]);
const t0 = Date.now(); const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const reg = () => JSON.parse(readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8"));
const peer = await CcPeer.create({ name: "keepalive-verify" });
peer.on("receipt", (r) => log("RECEIPT", JSON.stringify(r)));
peer.on("message", (m) => log("INBOUND", m.body.slice(0, 100)));
let last = reg().status; log("start status", last);
await peer.send({ pid }, body, { fromMode: "bypass" }); log("SENT");
for (let i = 0; i < sec * 2; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const r = reg(); if (r.status !== last) { log("STATUS", last, "->", r.status, "updatedAt-statusUpdatedAt", r.updatedAt - r.statusUpdatedAt); last = r.status; }
}
await peer.stop(); log("stopped, final status", last);
