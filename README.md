# 用 6 行提示词给 pi 编程助手造一个"git 提交"功能 

> 本文内容基于 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 官方仓库中的扩展文档（`docs/extensions.md`）与扩展示例（`examples/extensions/`）整理。
> pi 是一个极简的终端编程助手，它的核心哲学是：**"别为我内置功能，让我自己装"**。

------

## 一、先说pi设计

很多 AI 编程工具把"子代理、计划模式、权限弹窗、TODO 列表、git 自动提交"等能力全部内置，结果就是工具越来越重、反而降低效率。

pi 恰恰相反。它的作者在 README 里写得很直白：

> Pi is aggressively extensible so it doesn't have to dictate your workflow.
> （pi 在"可扩展性"上毫不妥协，正因如此它才不必规定你的工作流。）

所以你在 pi 里找不到内置的 `git auto-commit`，但你可以用扩展（Extensions）自己造一个插件

------

## 二、提示词"一个扩展长什么样"

<img width="2880" height="1728" alt="1788501795937" src="https://github.com/user-attachments/assets/5ba67cf3-e475-4750-981a-49ef9d370682" />

.由提示词驱动pi给我们扩展出插件  pi-rollback
.关于pi插件扩展可以查看官方文档  [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 

------

## 三、使用说明

**步骤 1：初始化 Git 仓库**
确保你的项目目录已经是一个 Git 仓库。如果不是，请先运行：

```
git init
```

这是插件能够创建快照并进行回退的前提。





### 步骤 2 每轮对话前的代码"存档"

LLM 每轮可能改代码，那就让 pi 在每轮开始前先 `git stash create` 一个检查点**，以后用户 fork 到历史某条消息时，可以顺手把代码也恢复到那个时刻。

<img width="2880" height="1728" alt="1788502164006" src="https://github.com/user-attachments/assets/76233103-2827-4751-9cbf-3726067e3f2f" />



**步骤 3：使用 /rollback 命令回退代码**
当你想撤销某次 AI 的修改，恢复到之前的某个状态时，在对话输入框中输入：

```
/rollback
```

具体如上图所示,可选择性的回退
