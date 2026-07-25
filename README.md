# DS Autocomplete — DeepSeek 代码自动补全

直连 DeepSeek API 的行内代码自动补全 VSCode 扩展。两种模式自动切换：代码中间用 **FIM 填空**，注释后用 **chat API 生成实现**。

> 🆕 v1.6.2：comment-to-code + 幽灵文全生命周期 + 性能优化

---

## 特性一览

| 特性 | 说明 |
|------|------|
| 🧠 **comment-to-code** | 注释后自动切 chat API——注释当指令执行生成代码 |
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
code --install-extension https://github.com/heshuren371/ds-autocomplete/releases/latest/download/ds-autocomplete-1.6.2.vsix
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

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `apiKey` | — | DeepSeek API key |
| `model` | `deepseek-v4-flash` | 模型 |
| `maxTokens` | `80` | 每次最大 token |
| `temperature` | `0` | 确定性 |
| `debounceMs` | `200` | 按键后等待 ms |
| `multiLine` | `true` | 多行补全 |
| `maxPrefixChars` | `2000` | 前缀最大字符 |
| `maxSuffixChars` | `1500` | 后缀最大字符 |
| `commentToCode` | `true` | 注释→代码模式 |
| `disabledLanguages` | `[]` | 在此语言里关闭补全 |
| `enabledLanguages` | `["*"]` | 启用补全的语言 |

---

## 更新

```bash
code --install-extension https://github.com/heshuren371/ds-autocomplete/releases/latest/download/ds-autocomplete-1.6.2.vsix
```

---

## 更新日志

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
