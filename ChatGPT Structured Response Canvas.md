# ChatGPT Structured Response Canvas
## Chrome Extension MVP 产品需求文档

### 1. 项目背景

ChatGPT 在处理复杂问题时，经常会输出较长的线性文本。

当前阅读方式主要是从上到下连续阅读，存在几个问题：

- 回答较长时，读到后面容易忘记前面的内容
- 很难快速理解整篇回答的逻辑结构
- 想重新查找某个观点时，需要反复上下滚动
- 用户通常并不需要同时阅读全部细节，而是希望先看到整体结构，再深入某个部分
- Markdown 标题虽然能提供一定层级，但仍然属于线性文本阅读

因此，希望开发一个 Chrome Extension，为 ChatGPT 网页增加一个额外的「Structured Response Canvas」。

插件不改变 ChatGPT 的生成能力，而是作为一个新的阅读层，将 GPT 的长回答转换为可浏览、可展开的结构化画布。

---

# 2. 产品目标

MVP 只解决一个核心问题：

> 让用户能够在 10 秒内理解一篇较长 GPT 回复的整体结构，并快速进入自己关心的内容。

核心体验为：

**Overview → Navigate → Detail**

即：

1. 先总览回答结构
2. 根据结构快速定位
3. 再阅读具体内容

---

# 3. 产品形态

产品形式：

**Chrome Extension**

第一版仅支持：

**chatgpt.com 网页版**

插件通过 Content Script 读取 ChatGPT 当前页面中的 Assistant Response，并在网页右侧增加一个独立的 Structured Response Canvas。

原则：

> 尽量不修改 ChatGPT 原有正文结构，而是增加一个 Side Panel / Overlay Layer。

这样可以降低 ChatGPT 页面更新导致插件失效的概率。

---

# 4. MVP 核心使用流程

用户正常使用 ChatGPT：

```text
用户输入问题
    ↓
ChatGPT 生成回答
    ↓
回答生成完成
    ↓
插件识别这条 Assistant Response
    ↓
出现「Structure」按钮
    ↓
用户点击 Structure
    ↓
插件提取当前回复文本
    ↓
调用 LLM 进行结构解析
    ↓
返回 Structured JSON
    ↓
右侧打开 Response Canvas
    ↓
用户查看整体结构
    ↓
点击某个 Node
    ↓
查看详细内容
    ↓
可定位回 GPT 对应原文
```

---

# 5. MVP 页面结构

整体页面建议采用：

```text
┌────────────────────────────────────────────────────────────┐
│                     ChatGPT Web                            │
│                                                            │
│ ┌──────────────────────────────┐ ┌───────────────────────┐ │
│ │                              │ │                       │ │
│ │      ChatGPT Conversation    │ │   Response Canvas     │ │
│ │                              │ │                       │ │
│ │  User                        │ │      [核心问题]       │ │
│ │  ...                         │ │          ↓            │ │
│ │                              │ │      [核心结论]       │ │
│ │  Assistant                   │ │       ↙      ↘        │ │
│ │  ...                         │ │   [原因 A]   [原因 B] │ │
│ │                              │ │       ↓               │ │
│ │  [Structure]                 │ │    [Evidence]         │ │
│ │                              │ │                       │ │
│ └──────────────────────────────┘ └───────────────────────┘ │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

右侧 Canvas 建议宽度：

- 默认：420–480 px
- 支持拖拽调整宽度
- 支持关闭
- 支持重新打开

MVP 可以不做复杂动画。

---

# 6. 功能需求

## 6.1 Assistant Response 识别

插件需要识别 ChatGPT 页面中的每一条 Assistant Response。

目标：

- 区分 User Message 与 Assistant Message
- 获取完整 Assistant 回复文本
- 支持 Markdown 内容
- 尽量保留标题、列表、段落等基本结构
- 不读取输入框中尚未发送的内容

不建议依赖随机 CSS class。

优先通过：

- semantic attributes
- `data-*` attributes
- role
- DOM 层级
- Message container 特征

进行识别。

需要将 DOM Selector 封装成单独模块，方便后续适配 ChatGPT UI 更新。

---

# 6.2 Structure 按钮

在每条 Assistant Response 的操作区域增加一个：

**Structure**

按钮。

例如：

```text
👍  👎  Copy  Structure
```

点击后，对当前这一条回复生成结构。

按钮状态：

### 默认

`Structure`

### 解析中

`Structuring...`

禁止重复点击。

### 完成

`Open Canvas`

### 出错

`Retry`

---

# 6.3 Response Structure 生成

插件需要将 GPT 的长文本转化成：

**语义结构，而不是简单的段落结构。**

禁止直接按照：

```text
Paragraph 1
Paragraph 2
Paragraph 3
```

生成节点。

应该判断每一段内容在整篇回答中的逻辑作用。

推荐节点类型：

```text
Question
Claim
Explanation
Evidence
Example
Comparison
Limitation
Conclusion
Recommendation
Step
Definition
```

不要求每篇回答都出现所有类型。

---

# 7. 节点结构

每个 Node 至少包含：

```json
{
  "id": "node_01",
  "type": "claim",
  "title": "Motion Trigger 有明确状态变化",
  "summary": "速度和位移变化可以形成相对明确的触发边界。",
  "detail": "对应原始回答中的完整内容。",
  "parentId": "node_00",
  "sourceText": "对应 GPT 原文",
  "sourceStart": 120,
  "sourceEnd": 256
}
```

字段说明：

### id

节点唯一 ID。

### type

节点逻辑类型。

### title

短标题。

要求：

- 推荐 4–15 个中文字符
- 不直接复制整句话
- 可以快速理解该节点在讲什么

### summary

一句话总结。

默认展示在 Canvas Node 中。

推荐控制在：

30–60 个中文字以内。

### detail

该节点的详细内容。

用于 Detail Panel。

### parentId

父节点。

如果是根节点则为 null。

### sourceText

对应 GPT 原始回答中的文本。

### sourceStart / sourceEnd

用于未来实现原文定位。

如果第一版实现字符位置映射困难，可以优先使用 `sourceText` 匹配。

---

# 8. 整体 JSON Schema

LLM 返回格式建议：

```json
{
  "responseTitle": "为什么 Motion 更适合 Trigger",
  "responseSummary": "Motion 能形成较强的执行信号，但很难提供独立且稳定的取消信号。",
  "nodes": [
    {
      "id": "node_01",
      "type": "question",
      "title": "核心问题",
      "summary": "为什么 Motion Trigger 有效，但 Motion Cancel 效果较差？",
      "detail": "",
      "parentId": null,
      "sourceText": ""
    },
    {
      "id": "node_02",
      "type": "claim",
      "title": "Trigger 信号更强",
      "summary": "加速、位移等动作变化能够提供明显状态转折。",
      "detail": "...",
      "parentId": "node_01",
      "sourceText": "..."
    },
    {
      "id": "node_03",
      "type": "explanation",
      "title": "Cancel 信号不独立",
      "summary": "减速、转向等运动也可能只是正常调整，而不是取消意图。",
      "detail": "...",
      "parentId": "node_01",
      "sourceText": "..."
    }
  ]
}
```

---

# 9. Canvas 设计

Canvas 是产品核心。

第一版不需要实现完整 Miro / FigJam 式无限画布。

推荐采用：

**自动布局的 Node Graph**

可以考虑：

- React Flow / XYFlow
- Dagre
- ELK

实现树状 / DAG 自动排版。

---

# 10. Canvas Node

每个 Node 默认状态只显示：

```text
┌──────────────────────────┐
│ Claim                    │
│                          │
│ Trigger 信号更强          │
│                          │
│ 加速与位移变化可以形成     │
│ 明显的动作状态转折。       │
└──────────────────────────┘
```

内容包括：

- Type
- Title
- Summary

不要在 Node 中直接显示完整正文。

原则：

> Canvas 用于理解结构，不用于阅读长文本。

---

# 11. Node Detail

点击 Node 后，在 Canvas 内或者右侧弹出 Detail Panel。

例如：

```text
Trigger 信号更强
────────────────────

Claim

一句话总结
加速和位移变化可以形成比较明确的动作状态转折。

详细内容
Motion Trigger 的优势在于……

来源
对应 GPT 原始回答中的……
```

提供按钮：

**Locate in Response**

点击后定位到 ChatGPT 原回答位置。

---

# 12. 原文定位

这是 MVP 中非常重要的功能。

用户点击：

`Locate in Response`

ChatGPT 左侧正文自动滚动到对应内容。

对应原文短暂高亮。

例如：

- 滚动定位
- 黄色/半透明高亮
- 1–2 秒后消失

优先实现方式：

1. 根据 `sourceText` 在 Assistant Response DOM 中查找
2. 定位对应 Text Node
3. 找到最接近的父级 DOM
4. `scrollIntoView`
5. 注入临时 highlight class

第一版不要求精确到单词级。

能够定位到对应段落即可。

---

# 13. Semantic Zoom

Semantic Zoom 是产品长期的重要交互，但 MVP 只做简化版。

至少提供两档：

### Overview

Node 只显示：

```text
Title
```

### Normal

Node 显示：

```text
Type
Title
Summary
```

当画布缩放较小时自动进入 Overview。

放大时恢复 Normal。

第一版不需要在 Node 内展开全文。

---

# 14. Focus Node

点击节点：

- 当前 Node 高亮
- 与该 Node 直接相关的 Parent / Children 保持正常
- 无关 Node 降低透明度

用于减少复杂 Canvas 的认知负担。

例如：

```text
        Claim A
           │
       [FOCUS NODE]
        /        \
 Evidence 1   Evidence 2


其他 Node → opacity 30%
```

再次点击空白区域退出 Focus。

如果实现成本较高，可以放到 MVP P1。

---

# 15. Canvas 基础操作

MVP 至少支持：

- Zoom In
- Zoom Out
- Fit View
- Pan
- 点击 Node
- 自动布局

不需要：

- 用户手动画连接线
- 自定义节点
- 删除节点
- 任意拖拽重新组织逻辑
- 多人协作

节点允许拖动可以作为可选能力，但拖动后不需要保存布局。

---

# 16. Streaming 处理

ChatGPT 回答是 Streaming 输出。

MVP 不建议边生成边解析。

推荐：

```text
ChatGPT Streaming
      ↓
MutationObserver
      ↓
持续发生 DOM 更新
      ↓
debounce
      ↓
一段时间没有新增文字
      ↓
认为 Response 基本完成
      ↓
启用 Structure
```

或者更简单：

第一版永远由用户主动点击 `Structure`。

点击时直接获取当时的完整文本。

这样可以避免复杂的 Streaming 状态判断。

因此：

**MVP 推荐采用用户主动 Structure，而不是自动 Structure。**

---

# 17. LLM 调用

需要设计独立的：

`structureResponse(text)`

接口。

输入：

```json
{
  "content": "GPT 原始回复全文",
  "language": "zh"
}
```

输出：

Structured JSON。

模型具体选择不要写死在 UI 层。

需要抽象：

```text
LLMProvider
```

方便未来切换：

- OpenAI API
- 其他兼容模型
- 本地模型
- 后端服务

---

# 18. Prompt 基本要求

System Prompt 核心逻辑：

```text
You are an information structure parser.

Convert the given AI response into a compact semantic graph.

Do not simply split paragraphs.

Identify the logical role of each part of the response.

Possible node types include:
Question
Claim
Explanation
Evidence
Example
Comparison
Limitation
Conclusion
Recommendation
Step
Definition

Requirements:

1. Preserve the original meaning.
2. Do not add claims not contained in the response.
3. Create a hierarchical structure.
4. Prefer 5–10 major nodes.
5. Use short node titles.
6. Give each node a one-sentence summary.
7. Keep sourceText grounded in the original response.
8. Return valid JSON only.
```

对于特别长的回答允许超过 10 个节点，但第一版应尽量控制节点数量。

避免生成几十个 Node。

---

# 19. 节点数量策略

推荐：

### < 500 字

3–5 Nodes

### 500–1500 字

5–8 Nodes

### 1500–3000 字

7–12 Nodes

### > 3000 字

8–15 个主节点。

不要因为原文很长就无限增加 Node。

优先保持：

**高层逻辑清晰。**

---

# 20. Chrome Extension 技术结构

推荐 Manifest V3。

项目目录参考：

```text
/src

  /content
    contentScript.ts
    chatgptObserver.ts
    messageExtractor.ts
    sourceLocator.ts

  /canvas
    ResponseCanvas.tsx
    CanvasNode.tsx
    DetailPanel.tsx
    CanvasToolbar.tsx

  /services
    structureResponse.ts
    llmProvider.ts

  /types
    responseGraph.ts

  /utils
    dom.ts
    debounce.ts

  /styles
    canvas.css
    injected.css

manifest.json
```

---

# 21. 模块职责

## chatgptObserver

负责：

- 监听页面变化
- 找到 Assistant Message
- 防止重复注入按钮

---

## messageExtractor

负责：

- 获取当前 Assistant Response
- 提取纯文本
- 必要时保留 Markdown 信息

---

## structureResponse

负责：

- 调用模型
- 校验返回 JSON
- Error handling

---

## ResponseCanvas

负责：

- Node / Edge 渲染
- Zoom
- Pan
- Fit View
- Node 点击

---

## DetailPanel

负责：

- title
- type
- summary
- detail
- Locate in Response

---

## sourceLocator

负责：

```text
Node
 ↓
sourceText
 ↓
ChatGPT Response DOM
 ↓
定位对应段落
 ↓
Scroll
 ↓
Highlight
```

---

# 22. 插件打开方式

第一版推荐采用：

**注入 ChatGPT 页面右侧 Panel**

而不是使用 Chrome 官方 Side Panel。

原因：

产品本身需要与 ChatGPT 正文形成直接视觉对应。

Panel 顶部：

```text
Response Canvas             ×
──────────────────────────────
当前回复标题
```

关闭后不影响 ChatGPT 正常使用。

---

# 23. Loading 状态

用户点击 Structure 后：

右侧立即打开 Panel。

显示：

```text
Structuring response...

Finding the main ideas and relationships.
```

下面可以显示简单 Skeleton。

完成后替换成 Canvas。

---

# 24. Error 状态

例如模型接口失败：

```text
Unable to structure this response.

[Retry]
```

不要破坏 ChatGPT 原始页面。

任何插件异常，都不能阻止用户继续正常使用 ChatGPT。

---

# 25. 数据与状态

MVP 只需要保存：

```text
conversation URL
message identifier
original response hash
structured JSON
```

目的：

用户关闭 Canvas 后再次打开，不需要重新调用 LLM。

推荐使用：

Chrome Storage / IndexedDB。

如果原始 Response 内容变化，则重新计算 hash。

---

# 26. 隐私原则

第一版必须明确：

插件只在用户主动点击 `Structure` 后读取对应 Assistant Response。

不要默认读取整个 ChatGPT 对话历史。

发送给模型的内容仅包括：

**当前用户选择的 Assistant Response。**

不要发送：

- 其他对话
- 输入框内容
- 用户账号信息
- 页面 Cookie
- ChatGPT Session Token

---

# 27. 暂时不做的功能

MVP 明确排除：

### 不做多轮对话知识图谱

每次只处理一条 Assistant Response。

### 不做完整知识库

不保存跨 Conversation 的知识结构。

### 不做手动节点编辑

用户不能增删节点。

### 不做节点连接

用户不能自己建立 Edge。

### 不做 Prompt 管理

与另一个 Prompt 项目暂时独立。

### 不做多人协作

### 不做移动端

### 不做 ChatGPT Desktop App

### 不做 Claude / Gemini

架构上可以保留未来适配可能。

---

# 28. MVP 优先级

## P0 必须完成

### 1. ChatGPT 页面注入

识别 Assistant Response。

### 2. Structure Button

每条回答可主动生成结构。

### 3. Text Extraction

正确读取 GPT 回答。

### 4. LLM Structure Parser

输出稳定 JSON。

### 5. Response Canvas

Node + Edge 自动布局。

### 6. Detail Panel

点击 Node 查看详情。

### 7. Locate in Response

从 Node 返回原始内容。

### 8. Close / Reopen Canvas

Panel 基础状态管理。

---

## P1

- Semantic Zoom
- Focus Node
- Canvas 宽度拖动
- Structure Cache
-重新生成 Structure
- Markdown / Code Block 更好处理

---

## P2

未来版本考虑：

- 多轮对话合并成一个 Canvas
- 对某个 Node 继续 Ask GPT
- 新回答直接挂到 Node 下方
- 用户手动编辑 Node
- 用户建立关系
- Canvas 保存
- Canvas 导出
- 多个回答比较
- Claude / Gemini 支持
- Knowledge Graph

---

# 29. Acceptance Criteria

MVP 完成标准：

## Case 1

打开 ChatGPT 任意已有对话。

Assistant Response 下出现：

`Structure`

按钮。

---

## Case 2

点击 Structure。

右侧打开 Canvas。

最长约 1500–2000 中文字的普通回答，能够生成合理的层级节点。

---

## Case 3

Canvas 至少能够表现：

```text
Root
 ↓
Major Idea
 ↓
Supporting Idea
```

而不是简单按段落拆分。

---

## Case 4

点击 Node。

出现：

- Node Title
- Type
- Summary
- Detail

---

## Case 5

点击：

`Locate in Response`

左侧 ChatGPT 自动滚动到对应原文区域，并高亮。

---

## Case 6

关闭 Canvas 后：

ChatGPT 原网页可以正常继续使用。

---

## Case 7

插件出现任何错误：

不能导致 ChatGPT 原网页功能异常。

---

# 30. 第一版 UI 风格

视觉原则：

**保持接近 ChatGPT 原生风格。**

关键词：

- Minimal
- Neutral
- Lightweight
- Information-dense
- Low visual noise

不要设计成：

- 彩色思维导图
- Miro
- 儿童化气泡节点
- 大量渐变
- 花哨动画

Canvas 应该更接近：

```text
Notion
+
Linear
+
ChatGPT
+
轻量知识图谱
```

节点主要依靠：

- 字号
- 字重
- Border
- Background contrast
- Type Label

建立层级。

---

# 31. 产品核心原则

开发过程中始终遵循以下原则：

## Principle 1

**Structure, not summarize.**

不是简单总结 GPT 内容，而是展示它的逻辑结构。

---

## Principle 2

**Overview first, detail on demand.**

默认让用户看到整体，而不是另一篇长文本。

---

## Principle 3

**Canvas is navigation, not another document.**

画布负责理解和导航。

Detail Panel 才负责阅读。

---

## Principle 4

**Ground every node in the original response.**

每个 Node 都必须能够对应到 GPT 原回答。

---

## Principle 5

**Do not replace ChatGPT.**

插件是 ChatGPT 的 Reading Layer。

任何时候用户都应该能够回到原始回答。

---

# 32. 最终 MVP 定义

第一版只需要完整跑通这一条链路：

```text
ChatGPT Assistant Response
          ↓
      Structure
          ↓
   Extract Response
          ↓
   LLM Semantic Parse
          ↓
   Structured JSON
          ↓
     Auto Layout
          ↓
  Response Canvas
          ↓
       Node
       ↙  ↘
  Detail   Locate
            ↓
      Original Response
```

只要这条体验足够流畅，就已经能够验证这个产品最核心的假设：

> 相比从头到尾阅读 AI 的长文本回答，用户是否更愿意通过「整体结构 → 选择节点 → 阅读细节」的方式消费 AI 输出。