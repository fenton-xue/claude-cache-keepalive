import { CcPeer } from 'cc-peer';
import { OWN_NAME } from '../core/sessions';
import type { SendReceipt, SendTarget, Sender } from '../core/types';

/**
 * 全部依赖 cc-peer 的代码都在这个文件里。cc-peer 是非官方包，协议变了只需要换这一个模块。
 *
 * 要点（均已实测，见 verify/验证结果.md）：
 * - send() 不校验目标会话号，调用方（Monitor）发送前已按 sessionId 重新读取注册文件；
 * - 用注册文件里当前的 messagingSocketPath 作为地址发送，不用 { pid }（那会拼 /tmp/cc-socks/<pid>.sock）；
 * - 不传 sessionId 选项（它会被写进信封当作发送者的会话号）；
 * - 整个运行期间保持监听，入站消息一律忽略、不回复。
 */
export class CcPeerSender implements Sender {
  private peer: CcPeer | null = null;
  ignoredInbound = 0;

  constructor(private readonly onReceipt: (r: SendReceipt) => void) {}

  async start(): Promise<void> {
    const peer = await CcPeer.create({ name: OWN_NAME });
    peer.on('receipt', (r) => {
      const receipt: SendReceipt = { origMsgId: r.orig_msg_id, status: r.status, reason: r.reason };
      if (r.drop_reason !== undefined) receipt.dropReason = r.drop_reason;
      this.onReceipt(receipt);
    });
    peer.on('message', () => {
      this.ignoredInbound += 1; // 目标会话偶尔会回复发送者，一律忽略
    });
    peer.on('idle', () => undefined);
    this.peer = peer;
  }

  async send(target: SendTarget, body: string): Promise<{ msgId: string }> {
    if (!this.peer) throw new Error('发送通道未启动');
    return this.peer.send({ address: `uds:${target.socketPath}` }, body, { fromMode: 'bypass' });
  }

  /** 退出时必须调用：清理注册文件、密钥文件和套接字 */
  async stop(): Promise<void> {
    const peer = this.peer;
    this.peer = null;
    if (peer) await peer.stop();
  }
}
