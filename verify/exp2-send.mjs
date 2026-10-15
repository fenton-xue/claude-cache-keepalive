// 用法: node exp2-send.mjs <pid> <sessionId> <body> <watchSec> [fromMode: bypass|prompting|none]
import { CcPeer } from "cc-peer";
import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [pidArg, sessionId, body, watchArg, modeArg = "bypass"] = process.argv.slice(2);
const pid = Number(pidArg), watchMs = Number(watchArg) * 1000;
const fromMode = modeArg === "none" ? false : modeArg;
const t0 = Date.now();
const T = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(T(), ...a);

const regPath = join(homedir(), ".claude", "sessions", `${pid}.json`);
const readReg = () => { try { return JSON.parse(readFileSync(regPath, "utf8")); } catch { return null; } };
const projects = join(homedir(), ".claude", "projects");
const findTranscript = () => {
  for (const d of readdirSync(projects)) {
    const p = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
};

let tpath = findTranscript(), toff = tpath ? statSync(tpath).size : 0;
log("transcript:", tpath ?? "(not yet)", "offset", toff);
let lastStatus = readReg()?.status; log("target status:", lastStatus, "socket:", readReg()?.messagingSocketPath);

const peer = await CcPeer.create({ name: "keepalive-verify" });
peer.on("receipt", (r) => log("RECEIPT", JSON.stringify(r)));
peer.on("idle", (n) => log("IDLE-NOTICE", JSON.stringify(n)));
peer.on("message", (m) => log("INBOUND", JSON.stringify(m)));

const sentAt = Date.now();
const { msgId } = await peer.send({ pid }, body, { fromMode });
log("SENT msgId", msgId, "fromMode", fromMode);

const brief = (o) => {
  const c = o.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text ?? x.type).join("|") : "";
  return { type: o.type, ts: o.timestamp, origin: o.origin, promptSource: o.promptSource, turnOrigin: o.turnOrigin, stop: o.message?.stop_reason, text: text.slice(0, 160) };
};
const end = Date.now() + watchMs;
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, 400));
  const st = readReg()?.status;
  if (st !== lastStatus) { log("STATUS", lastStatus, "->", st); lastStatus = st; }
  if (!tpath) { tpath = findTranscript(); if (tpath) { log("transcript found:", tpath); } }
  if (tpath) {
    const size = statSync(tpath).size;
    if (size > toff) {
      const fd = openSync(tpath, "r"); const buf = Buffer.alloc(size - toff); readSync(fd, buf, 0, buf.length, toff); closeSync(fd); toff = size;
      for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
        try { const o = JSON.parse(line); if (["user", "assistant", "attachment", "queue-operation"].includes(o.type)) log("TRANSCRIPT", JSON.stringify(brief(o))); } catch {}
      }
    }
  }
}
await peer.stop();
log("done; stopped peer");
