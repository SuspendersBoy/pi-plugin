/**
 * pi-rollback — 以「用户消息」为粒度的代码回退扩展
 *
 * 时机：每次你发送一条消息、agent 开始改代码之前（before_agent_start），自动打一个快照。
 * 标签：每个快照用「你的消息内容 + 时间」命名，方便你知道回退到哪一句之前。
 *
 * 用法：
 *   /rollback        列出所有快照（1=最新），选择后回退
 *   /rollback <n>    直接回退到第 n 个快照
 *   /undo            一键回退到「我上一条消息发出之前」的代码状态
 *   或直接对 agent 说“撤销刚才的改动 / 回退代码”（走 rollback 工具）
 *
 * 原理：
 *   git stash create          → 生成快照 commit（不动工作区、不动索引、不污染历史）
 *   git update-ref            → 把 commit 固定到 refs/pi-rollback/<id>，防止被 GC
 *   git checkout <sha> -- .   → 回退时把工作区恢复到快照
 *   回退前 git stash push -u  → 先把当前状态存起来，可 git stash pop 反悔
 *
 * 说明：
 *   快照覆盖「已跟踪文件」；回退时会把当前所有未跟踪文件（含 agent 新建的文件）先移入
 *   git stash（不删除，可恢复）。全新无提交的仓库无法打快照，会自动跳过。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

type Snapshot = {
  id: string;
  prompt: string;
  time: number;
  sha: string;
};

export default function (pi: ExtensionAPI) {
  const REF_PREFIX = "refs/pi-rollback";
  const MAX_SNAPSHOTS = 100;
  const META_TYPE = "pi-rollback-meta";

  let gitOk = false;
  let repoRoot = "";
  let counter = 0;
  const snapshots: Snapshot[] = []; // 升序，最后一个 = 最新

  async function git(args: string[], cwd: string) {
    try {
      const r = await pi.exec("git", ["-C", cwd, ...args], { timeout: 15000 });
      return {
        stdout: String(r.stdout ?? "").trim(),
        stderr: String(r.stderr ?? "").trim(),
        code: r.code ?? 1,
      };
    } catch (e) {
      return { stdout: "", stderr: String(e), code: 1 };
    }
  }

  const shortSha = (sha: string) => sha.slice(0, 7);
  const hasChinese = (s: string) => /[\u4e00-\u9fff]/.test(s);
  const fmtTime = (t: number) => {
    if (!t) return "?";
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())} - ${p(d.getHours())}时${p(d.getMinutes())}分${p(d.getSeconds())}`;
  };
  const findSnapshot = (index: number) => snapshots[snapshots.length - index]; // 1 = 最新

  function listLines(): string[] {
    if (snapshots.length === 0) return ["（暂无快照）"];
    const lines: string[] = [];
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const s = snapshots[i];
      const idx = snapshots.length - i;
      const prompt = s.prompt || "(无内容)";
      lines.push(`${idx}. ${fmtTime(s.time)}  用户消息: ${prompt}  [${shortSha(s.sha)}]`);
    }
    return lines;
  }

  async function createSnapshot(prompt: string) {
    if (!gitOk) return;
    // 只保留包含中文的用户消息
    if (!hasChinese(prompt || "")) return;

    // 没有提交的仓库无法生成快照
    const head = await git(["rev-parse", "HEAD"], repoRoot);
    if (head.code !== 0 || !head.stdout) return;

    // stash create：生成快照 commit，但不改动工作区/索引
    const st = await git(["stash", "create"], repoRoot);
    const sha = st.code === 0 && st.stdout ? st.stdout : head.stdout;

    counter += 1;
    const id = `s${Date.now()}x${counter}`;
    await git(["update-ref", `${REF_PREFIX}/${id}`, sha], repoRoot);

    const label = (prompt || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const snap: Snapshot = { id, prompt: label, time: Date.now(), sha };
    snapshots.push(snap);

    // 把标签持久化到会话，重启/恢复后仍能看到“是哪句话之前”
    pi.appendEntry(META_TYPE, { id, prompt: label, time: snap.time });

    if (snapshots.length > MAX_SNAPSHOTS) {
      const removed = snapshots.shift();
      if (removed) await git(["update-ref", "-d", `${REF_PREFIX}/${removed.id}`], repoRoot);
    }
  }

  async function rollbackTo(index: number): Promise<string> {
    if (!Number.isInteger(index) || index < 1) return `无效快照编号：${index}`;
    const snap = findSnapshot(index);
    if (!snap) return `没有编号为 ${index} 的快照（当前共 ${snapshots.length} 个）。`;

    // 1) 安全兜底：把当前状态存入 stash（含未跟踪文件）
    const safetyMsg = `pi-rollback-safety-${Date.now()}`;
    await git(["stash", "push", "--include-untracked", "-m", safetyMsg], repoRoot);

    // 2) 恢复快照内容
    const r = await git(["checkout", snap.sha, "--", "."], repoRoot);
    if (r.code !== 0) return `回退失败：git checkout 出错：${r.stderr || r.stdout}`;

    const prompt = snap.prompt || "(无内容)";
    return (
      `已回退到「${prompt}」发出之前的代码状态。` +
      `回退前的状态已保存到 git stash（${safetyMsg}），可用 \`git stash pop\` 恢复。`
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    snapshots.length = 0;
    gitOk = false;
    repoRoot = "";

    const inside = await git(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
    if (inside.code !== 0 || inside.stdout !== "true") {
      ctx.ui.notify("pi-rollback：当前目录不是 git 仓库，扩展已禁用", "error");
      return;
    }
    const top = await git(["rev-parse", "--show-toplevel"], ctx.cwd);
    repoRoot = top.stdout || ctx.cwd;
    gitOk = true;

    // 1) 从会话里恢复标签（id -> prompt/time）
    const meta = new Map<string, { prompt: string; time: number }>();
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === META_TYPE) {
        const d = e.data as { id?: string; prompt?: string; time?: number } | undefined;
        if (d?.id) meta.set(d.id, { prompt: d.prompt ?? "", time: d.time ?? 0 });
      }
    }

    // 2) 从 git 引用恢复 sha，再与标签合并
    const refs = await git(["for-each-ref", "--format=%(refname:short) %(objectname)", REF_PREFIX], repoRoot);
    if (refs.code === 0 && refs.stdout) {
      for (const line of refs.stdout.split("\n")) {
        const m = line.match(/^pi-rollback\/(\S+)\s+(\S+)$/);
        if (!m) continue;
        const id = m[1];
        const info = meta.get(id);
        const prompt = info?.prompt ?? "";
        if (!hasChinese(prompt)) continue; // 只保留包含中文的消息
        snapshots.push({ id, prompt, time: info?.time ?? 0, sha: m[2] });
      }
    }
    snapshots.sort((a, b) => a.id.localeCompare(b.id));

    if (snapshots.length > 0) ctx.ui.notify(`pi-rollback：已恢复 ${snapshots.length} 个快照`, "info");
  });

  // 核心：你发消息之后、agent 改代码之前，自动打快照
  pi.on("before_agent_start", async (event) => {
    if (!gitOk) return;
    await createSnapshot(event.prompt);
  });

  pi.registerCommand("rollback", {
    description: "回退代码到某条消息发出之前的状态（1=最新）",
    async handler(args, ctx) {
      if (!gitOk) {
        ctx.ui.notify("pi-rollback 未启用：当前目录不是 git 仓库", "error");
        return;
      }
      if (snapshots.length === 0) {
        ctx.ui.notify("暂无快照", "info");
        return;
      }

      let index: number;
      if (args && args.trim()) {
        index = Number.parseInt(args.trim(), 10);
        if (!Number.isInteger(index)) {
          ctx.ui.notify(`无效参数：${args}`, "error");
          return;
        }
      } else if (ctx.hasUI) {
        const choice = await ctx.ui.select("选择要回退到哪条消息之前（1=最新）", listLines());
        if (!choice) return;
        index = Number.parseInt(choice.split(".")[0], 10);
      } else {
        ctx.ui.notify("非交互模式请用 /rollback <编号>", "error");
        return;
      }

      const snap = findSnapshot(index);
      if (!snap) {
        ctx.ui.notify(`无效快照编号：${index}`, "error");
        return;
      }
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "确认回退？",
          `回退到「${snap.prompt || "(无内容)"}」发出之前的代码状态？\n回退前会先把当前状态存入 git stash，可安全恢复。`
        );
        if (!ok) return;
      }

      ctx.ui.notify(await rollbackTo(index), "info");
    },
  });

  pi.registerCommand("undo", {
    description: "一键回退到上一条消息发出之前的代码状态",
    async handler(_args, ctx) {
      if (!gitOk) {
        ctx.ui.notify("pi-rollback 未启用：当前目录不是 git 仓库", "error");
        return;
      }
      if (snapshots.length === 0) {
        ctx.ui.notify("暂无快照", "info");
        return;
      }
      const snap = snapshots[snapshots.length - 1];
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("回撤？", `回退到「${snap.prompt || "(无内容)"}」发出之前的代码状态？`);
        if (!ok) return;
      }
      ctx.ui.notify(await rollbackTo(1), "info");
    },
  });

  pi.registerTool({
    name: "rollback",
    label: "Rollback",
    description:
      "列出代码快照，或把工作区回退到某条用户消息发出之前的状态。快照在每条用户消息开始处理前自动创建。index 从 1 开始，1 表示最新快照。",
    promptSnippet: "List code snapshots or roll back the working tree to before a user message",
    promptGuidelines: [
      "Use the rollback tool when the user asks to undo, revert, or go back to the code state before their previous message.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "rollback"]),
      index: Type.Optional(Type.Number({ description: "快照编号，1=最新（action=rollback 时使用）" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!gitOk) {
        return {
          content: [{ type: "text", text: "pi-rollback 未启用：当前目录不是 git 仓库。" }],
          details: {},
        };
      }
      if (params.action === "list") {
        return {
          content: [{ type: "text", text: "可用快照（1=最新）：\n" + listLines().join("\n") }],
          details: { snapshots },
        };
      }
      const index = params.index ?? 1;
      if (snapshots.length === 0) {
        return { content: [{ type: "text", text: "暂无快照。" }], details: {} };
      }
      const msg = await rollbackTo(index);
      return { content: [{ type: "text", text: msg }], details: {} };
    },
  });
}
