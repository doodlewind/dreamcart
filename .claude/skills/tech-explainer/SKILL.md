---
name: tech-explainer
description: Write an accessible, story-driven popular-science (科普) explainer for a technical topic, bug, or breakthrough in THIS project — for readers who've only heard of a few basic concepts in the domain, not experts. Use when asked to "写一篇科普/技术科普/通俗讲解/深入浅出的文章" about something the project tackled (a tricky bug, a cross-platform quirk, an algorithm, an architecture decision). Produces a complete, polished Chinese article matching the project's house explainer style.
---

# 技术科普文章 (tech-explainer)

写一篇**深入浅出、通俗**的技术科普文章。读者**只听说过该领域的几个基础概念**，
不是专家——你的任务是从他们已有的常识出发，把一个真实的技术难点讲到他们能"哦，原来
如此"。

The canonical example — **read it first and match its structure, register, and density**:
[`docs/explainers/为什么立方体会内外翻转-深度缓冲的故事.md`](../../../docs/explainers/为什么立方体会内外翻转-深度缓冲的故事.md)
(讲深度缓冲 / Reversed-Z / 跨平台深度约定如何让立方体"内外翻转")。

## 行文风格（house style）

- **语言**：中文，大白话，温度感，略带文学性。能用一句生活化的话说清的，绝不用术语。
  必须用术语时，先用比喻把它"翻译"一遍。
- **从现象开篇，不从理论开篇**。先把读者**亲眼看到的"翻车现场"/反常现象**摆出来，
  让他先觉得"这不对劲、这怎么可能"，勾住好奇心；再回头讲原理。
- **第一性原理 + 强比喻**。每个核心概念配**一个**贴切的日常比喻（例：深度缓冲=记分牌、
  投影=拍扁照片、跨平台约定=方言），并在全文**反复复用同一个比喻**，不要每段换一个。
- **比喻必须技术上正确**，不只是俏皮。要讲清真正的机制，包括**"为什么"**
  （例：为什么要用 Reversed-Z——浮点精度），不能挥手带过。
- **结构**：开头一段 blockquote 钩子；正文用"一、二、三…"逐节推进，**每节只推进一个想法**；
  中段安排一节**"慢镜头回放"**，一步步重演故障是怎么发生的；结尾一节
  **"一句话总结"**点破修复/原理，再加一节**"心法 / 带得走的"**收束（给读者能复用的几条判断）。
- **扎根真实项目故事**：用项目里**真实的 bug、真实的修复、真实的几个平台**来讲，
  具体压倒抽象。诚实地还原排查过程（"我们翻了四次车"比"这是个常见坑"动人）。
- **长度**：一篇**完整、打磨过**的文章（约 1500–2500 字），不是摘要、不是提纲。
- **不卖弄**：不堆术语、不装高深；目标是让外行读完真的懂了，并愿意读完。

## 流程

1. **先读 canonical 例子**（上面的链接），吸收它的节奏、比喻密度、收尾方式。
2. **抓住"那个反常现象"**：这次要讲的技术点，读者能看到/感受到的、最反直觉的表象是什么？
   以它开篇。
3. 把要解释的机制**拆成一条认知阶梯**：每一节只上一个台阶，后一节依赖前一节的比喻。
4. 写"慢镜头回放" + "一句话总结" + "心法"。
5. **保存位置**：
   - 若用户指定了目录（如 `~/Downloads`），存到那里，用一个**描述性的中文文件名**。
   - 若文章要**随仓库 / PR 合并**（沉淀为项目资产），存到 `docs/explainers/<中文标题>.md`。
   - 两者都要时，仓库里 `docs/explainers/` 放一份作为正式资产，另存一份到用户指定的目录。
6. 写完**自检**：外行能不能顺下来？比喻有没有技术硬伤？有没有从现象出发、有没有"慢镜头"
   和"心法"收尾？

> 这个项目（DreamCart）是一个跑在 PSP / Web / 3DS / 安卓上的同构 JS 游戏引擎，
> 技术攻关多发生在**跨平台的底层差异**（图形 API、深度/裁剪约定、定点/浮点、内存对齐、
> 各家 GPU 的方言）。科普这类问题时，"同一个意图在不同平台的不同方言"往往就是最好的故事线。
