# DS Autocomplete — DeepSeek 代码自动补全

直连 DeepSeek API 的行内代码自动补全 VSCode 扩展。两种模式自动切换：代码中间用 **FIM 填空**，注释后用 **chat API 生成实现**。

> 🆕 v1.9.1：思考强度两档 + token 预算 8000/16000(可覆盖至 40000) + 最近编辑注入 + 作用域链/符号大纲 + 后处理四件套

---

## 特性一览

| 特性 | 说明 |
|------|------|
| 🧠 **comment-to-code** | 注释后自动切 chat API——注释当指令执行生成代码 |
| 🤔 **思考强度两档** | `med`(默认,关思考秒出省token) / `max`(开思考,复杂注释质量更高) |
| 🎯 **作用域链注入** | prompt 头部标注 `class > def` 链——长函数截断后模型也知道自己在哪 |
| 📇 **符号大纲** | 文件内全部 def/class 签名入 prompt——调函数不瞎编名字 |
| 🕒 **最近编辑注入** | 跨文件追踪你刚改的行——改完 A 文件,B 文件补全新签名 |
| ✂️ **后处理四件套** | 去重(防重抄下文) + 缩进重对齐(检测 tabs/spaces) + 复读截断 + 括号配平 |
| 🔍 **幽灵文全生命周期** | Tab 接受 (100% 可靠) / 光标移走拒绝 / 被覆盖忽略，全可观测 |
| 📂 **智能上下文** | 文件路径 + imports 提取 + 函数边界对齐 |
| 🚀 **流式早停** | 5-8 token 即展示，不等完整生成 |
| 💾 **缓存** | LRU + TTL，100 条缓存跨会话持久化 |
| ✂️ **逐词/逐行接受** | `Cmd+Right` 一词、`Cmd+Down` 一行 |
| 🎯 **模型切换** | 右下角点击 → V4 Flash / V4 Pro / Coder |
| 📊 **统计面板** | 接受率、缓存命中率、拒绝率 |
| 🛡️ **健壮** | 文本选中跳过、历史恢复、重试退避、空文件/字符串过滤 |

---

## 安装

```bash
code --install-extension https://github.com/heshuren371/ds-autocomplete/releases/latest/download/ds-autocomplete-1.9.2.vsix
```

`Cmd+Shift+P` → `Reload Window`。

---

## 配置 API Key

`Cmd+,` → 搜 `dsAutocomplete` → **Api Key** 粘贴 `sk-` 开头的 key。

没有 key：去 [platform.deepseek.com](https://platform.deepseek.com) 注册即可。

---

## 使用

### 触发补全

打开 Python / JavaScript / TypeScript / Go / Rust / Java / C / C++ 文件，正常打字：

```python
# 筛选偶数并存入新列表
even_list = [     ← 灰字自动出现
```

| 按键 | 行为 |
|------|------|
| **Tab** | 接受整段补全 |
| **Cmd+Right** | 接受一个词 |
| **Cmd+Down** | 接受一行 |
| **Esc** | 拒绝 |
| **继续打字** | 幽灵文自动收缩 |

### comment-to-code

在注释后另起一行，灰字出现的是对注释的实现代码（走 chat API）。

```python
# 1. 读取 CSV 文件
# 2. 按成绩排序
# 3. 输出前三名
              ← 光标在这里等补全 → 自动生成实现代码
```

`dsAutocomplete.commentToCode` 可关。

### 切换模型

右下角状态栏 → 点击 `DS V4 Flash` → 菜单选模型。

### 查看统计

`Cmd+Shift+P` → `DS Autocomplete: Show Stats`

---

## 设置

打开方式：`Cmd+,` → 搜 `dsAutocomplete`；或直接编辑 settings.json（键名前缀 `dsAutocomplete.`）。

### 思考强度（comment-to-code 专用）

写注释生成实现代码时，模型要不要"先想再写"：

| 档 | 效果 | 适合 |
|---|---|---|
| `med`（默认） | 关闭思考——秒出，实测省 ~95% token | 日常 |
| `max` | 开启思考——复杂逻辑质量更高，慢几秒 | 多步算法/复杂注释 |

**切换方法**（二选一）：

```jsonc
// settings.json
"dsAutocomplete.chatThinking": "max"   // 或 "med"(默认,删掉这行即恢复)
```

或 `Cmd+,` → 搜 `chatThinking` → 下拉选择。

> 注意：只影响**注释→代码**（chat 路径）。普通代码补全（FIM）永远不走思考——实测 DeepSeek FIM 端点免疫该参数，inline 补全要的就是快。

### 思考 token 上限

comment-to-code 的输出预算（`max_tokens`）：

| 档 | 默认预算 |
|---|---|
| `med` | 8000 |
| `max` | 16000 |

**手动覆盖**（想要更高直接填，比如 40000）：

```jsonc
"dsAutocomplete.chatMaxTokens": 40000   // 0 = 自动(8000/16000), 上限 128000
```

**关键认知：`max_tokens` 是上限不是消费。** 实测官方 API：预算填 40000 问 "1+1=?" 只花 5 个 token。拉高预算只是让长实现不被截断，短回答不多烧一分钱。

### 全部配置项

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `apiKey` | — | DeepSeek API key（[申请](https://platform.deepseek.com)） |
| `model` | `deepseek-v4-flash` | 模型（flash / pro / coder） |
| `chatThinking` | `med` | 思考强度：`med`关 / `max`开（仅 comment-to-code） |
| `chatMaxTokens` | `0` | comment-to-code 输出上限覆盖，0=自动(8000/16000) |
| `maxTokens` | `80` | FIM 单次补全最大 token |
| `temperature` | `0` | 采样温度（0=确定性） |
| `debounceMs` | `200` | 按键后等待 ms 再请求 |
| `requestTimeoutMs` | `12000` | 请求超时 |
| `multiLine` | `true` | 多行补全开关 |
| `multiLineMode` | `always` | 多行策略 |
| `commentToCode` | `true` | 注释→代码模式开关 |
| `replacePartialWord` | `false` | 补全替换光标处半个词（**别开**——会破坏幽灵文跟随收缩） |
| `triggerOnExplicit` | `true` | 手动触发也补全 |
| `skipInString` | `false` | 字符串内跳过（**别开**——会杀掉 `print("hello` 这类最需要的补全） |
| `maxPrefixChars` | `8000` | 上文字符上限(≈200行,prompt缓存重复部分仅10%费用) |
| `maxSuffixChars` | `4000` | 下文字符上限(≈100行,防模型重抄下文) |
| `stopTokens` | `[]` | 额外停止序列 |
| `enabledLanguages` | `["*"]` | 启用补全的语言 |
| `disabledLanguages` | `[]` | 在此语言里关闭（优先级高于 enabled） |
| `debug` | `false` | 日志输出到 Output 面板「DS Autocomplete」 |

---

## 更新

```bash
code --install-extension https://github.com/heshuren371/ds-autocomplete/releases/latest/download/ds-autocomplete-1.9.2.vsix
```

---

## 更新日志

### v1.9.x
- 🆕 **思考强度两档**：`med`(默认,关思考秒出省 ~95% token) / `max`(开思考,复杂注释质量更高)——实测官方 API 默认开思考白烧 token
- 🆕 **最近编辑注入**：跨文件追踪刚改的行——改完 A 文件,B 文件补全新签名
- 🆕 **作用域链 + 符号大纲**：长函数截断后模型也知道自己在哪、调函数不瞎编名字
- 🆕 **后处理四件套**：去重 + 缩进重对齐 + 复读截断 + 括号配平
- 🐛 修 `unitLen` 未声明(多行+缩进光标时幽灵文静默消失)
- 🐛 修 6 个逻辑 bug(dedup 越界/chat 互斥/历史去重等)

### v1.6.x
- 🆕 **comment-to-code**：注释后自动 chat API 生成实现
- 🆕 **幽灵文全生命周期**：接受/拒绝/忽略 追踪
- 🆕 **每语言禁用** + 状态栏语言指示
- 🆕 **智能上下文**：文件路径 + imports + 函数边界对齐
- 🆕 **流式早停**：5-8 token 立即展示
- 🆕 **文本选中跳过**（Tabby 同款）
- ⚡ 正则编译到模块顶层 + imports 缓存 + dbg 惰性
- ⚡ `maxPrefixChars` 默认降到 2000（token 节省）
- 🐛 FIM 格式修复（删错误 token 包裹）
- 🐛 Stop token 放宽（函数体内空行不截 return）
- 🐛 `Cmd+Right`/`Cmd+Down` 异步清空崩溃

### v1.1.0
- 流式 SSE、LRU 缓存、逐词/逐行接受、重试、统计面板

### v1.0.0
- 首次发布

---

MIT © 2024
