// 同一进程、同一正文连发两次，验证回执通道
import { CcPeer } from "cc-peer";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const pid = Number(process.argv[2]);
const t0 = Date.now(); const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const reg = () => JSON.parse(readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8"));
const peer = await CcPeer.create({ name: "keepalive-verify" });
peer.on("receipt", (r) => log("RECEIPT", JSON.stringify(r)));
const a = await peer.send({ pid }, "1", { fromMode: "bypass" }); log("SENT#1", a.msgId);
await new Promise((r) => setTimeout(r, 8000)); log("status", reg().status);
const b = await peer.send({ pid }, "1", { fromMode: "bypass" }); log("SENT#2", b.msgId);
await new Promise((r) => setTimeout(r, 12000)); log("status", reg().status);
await peer.stop(); log("stopped");
