import { CcPeer } from "cc-peer";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dirs = [join(homedir(), ".claude", "sessions"), "/tmp/cc-socks"];
const snap = () => Object.fromEntries(dirs.map((d) => [d, readdirSync(d).sort()]));
const diff = (a, b) => Object.fromEntries(dirs.map((d) => [d, {
  added: b[d].filter((x) => !a[d].includes(x)),
  removed: a[d].filter((x) => !b[d].includes(x)),
}]));

const before = snap();
const peer = await CcPeer.create({ name: "keepalive-verify" });
await new Promise((r) => setTimeout(r, 1500));
const during = snap();
const roster = await peer.roster();
console.log("pid", process.pid);
console.log("DURING diff:", JSON.stringify(diff(before, during), null, 1));
console.log("roster names:", roster.map((e) => `${e.pid}:${e.name}:${e.status}`));
await peer.stop();
await new Promise((r) => setTimeout(r, 500));
const after = snap();
console.log("AFTER diff:", JSON.stringify(diff(before, after), null, 1));
