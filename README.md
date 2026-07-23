# DS Autocomplete — DeepSeek V4 代码自动补全

**零额度限制、零中转站**的行内代码自动补全 VSCode 扩展。直连 DeepSeek V4 FIM 端点，打字即补全。

> 🆕 v1.1.0：流式输出（首字符 0.18s）、智能缓存、逐词接受（Cmd+Right）、失败重试、接受率统计

---

## 特性一览

| 特性 | 说明 |
|------|------|
| 🚀 **流式输出** | SSE 逐字流出，第一个字符 < 0.2s 出现 |
| 💾 **智能缓存** | 相同上下文秒回，零 API 消耗 |
| ✂️ **逐词接受** | `Cmd+Right` 只收下一个词，不整行吞 |
| 🎯 **三模型切换** | 右下角点一下 → V4 Flash / V4 Pro / Coder |
| ⚡ **保守过滤** | 空文件、字符串内部不浪费请求 |
| 🔄 **失败重试** | 网络抖动/429 自动退避重试 |
| 📊 **统计面板** | 接受率、缓存命中率、token 消耗一目了然 |

---

## 安装

在终端里执行：

```bash
code --install-extension https://github.com/heshuren371/ds-autocomplete/releases/latest/download/ds-autocomplete-1.1.0.vsix
```

安装完成后重新加载 VSCode（`Cmd+Shift+P` → `Reload Window`），或直接重启 VSCode。

> ⚠️ 首次使用前请确认右下角状态栏显示 `DS V4 Flash`。如果没有，检查你是否已有 DeepSeek API 账户和 key。

---

## 使用教程

### 1. 获得补全

打开任意 Python / JavaScript / TypeScript / Go / Rust / Java / C / C++ 文件，正常打字：

```python
list1 = [1, 2, 3, 4, 5]
# 筛选偶数并存入新列表
even_list = [     ← 停在这里，灰字自动出现
```

灰色幽灵文本出现后：

| 按键 | 行为 |
|------|------|
| **Tab** | 接受整段补全 |
| **Cmd+Right**（macOS）/ **Ctrl+Right**（Windows） | 只接受一个词，剩余继续显示 |
| **Esc** | 拒绝补全 |
| **继续打字** | 补全自动消失 |

### 2. 切换模型

右下角状态栏显示当前模型（如 `DS V4 Flash`）——**直接点击**，弹出菜单三选一：

- **V4 Flash**：快、便宜、日常写码首选
- **V4 Pro**：推理更强、稍慢、复杂逻辑用
- **Coder**：代码专项模型、FIM 原生

也可以用命令面板：`Cmd+Shift+P` → `DS Autocomplete: Switch Model`。

### 3. 查看统计

`Cmd+Shift+P` → `DS Autocomplete: Show Info`

弹出信息框显示：

```
DS Autocomplete v1.1.0 · deepseek-v4-flash
补全 142 次 · 接受 98 (69%) · 缓存命中 51 (36%)
API 请求 91 次 · 重试 3 次 · 约 5200 tokens
```

所有统计数据**只保存在你本地**，不上传、不收集。

### 4. 调整设置

`Cmd+,` 打开设置，搜索 `dsAutocomplete`：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `apiKey` | *(已预填)* | DeepSeek API 密钥，去 [platform.deepseek.com](https://platform.deepseek.com) 创建 |
| `model` | `deepseek-v4-flash` | 默认模型 |
| `maxTokens` | `80` | 每次补全最大 token 数（调大 = 更长，但更慢、更贵） |
| `temperature` | `0` | 0 = 确定性最强，调高会更"发散" |
| `debounceMs` | `350` | 按键后等多少毫秒才发请求。打字快可调小（200）、嫌太频繁可调大（500） |
| `multiLine` | `true` | 是否允许多行补全 |
| `enabledLanguages` | `["python","javascript",…]` | 只在指定语言里启用 |

---

## 常见问题

### Q：装完之后右下角没有 DS 图标？

先确认 VSCode 已重新加载（`Cmd+Shift+P` → `Reload Window`）。如果还没有，打开开发者工具检查错误：Help → Toggle Developer Tools → Console 标签，看有没有红色报错。

### Q：补全不出现 / "感觉不到"？

按顺序排查：

1. **看右下角状态栏**——如果显示 `DS V4 Flash`（正常）、如果显示红色错误 → 点一下看报错
2. **确认文件语言**——默认只对 Python/JS/TS/Go/Rust/Java/C/C++ 生效。其他语言需在设置的 `enabledLanguages` 里添加
3. **确认余额**——登录 [platform.deepseek.com](https://platform.deepseek.com) 检查账户余额，余额为 0 时 API 会返回 402 错误
4. **确认 key 正确**——在 VSCode 设置里搜 `dsAutocomplete.apiKey`，检查 key 是否以 `sk-` 开头
5. **看统计面板**——`Cmd+Shift+P` → Show Info，如果 "API 请求" 计数为 0，说明根本没发出去

### Q：补全的内容不对 / 质量差？

- 切到 **V4 Pro** 试试——推理力更强
- 打更明确的"引子"——比如想生成列表推导式，先写 `result = [` 而不是只写 `r`
- 模型对空文件或非常短的上下文表现较差——先写几行框架代码，补全更准
- 调大 `maxTokens`（比如 150）让模型有更多空间"展开"

### Q：补全太慢？

- 默认已在用流式输出，首字符 ~0.2-0.4s。总补全速度取决于模型和 token 数
- 切到 **V4 Flash** 是最快的
- 减小 `maxTokens`（比如 50）可以缩短生成时间
- 如果网络到 DeepSeek 延迟高（>1s），考虑用中转站并修改 `apiBase` 设置

### Q：如何用自己的 API 中转站？

在 VSCode 设置里改 `dsAutocomplete.apiBase`：把 `https://api.deepseek.com/beta/completions` 换成你的中转站地址。如果中转站不支持 `/beta/completions` 端点，暂时无法使用（此扩展只走 FIM 端点）。

### Q：和其他补全扩展（Copilot / Continue / Fitten）冲突吗？

会冲突。VSCode 的幽灵文本通道只能同时显示一个扩展的补全。如果你同时装了多个，建议只保留一个并卸载其他的，否则会互相抢、时有时无。

### Q：我的代码会被上传到 DeepSeek 吗？

会。每次补全请求会把光标前后的代码（最多 3000 字符前缀 + 1500 字符后缀）发送到 DeepSeek API。DeepSeek 的[隐私政策](https://platform.deepseek.com/privacy)声明不会使用 API 数据训练模型。如果你有合规要求，请在 `enabledLanguages` 中限制语言，或只在非敏感项目中启用。

### Q：如何更新到最新版？

```bash
code --install-extension https://github.com/heshuren371/ds-autocomplete/releases/latest/download/ds-autocomplete-1.1.0.vsix
```

此后每次发新版只需重新执行这行命令即可自动覆盖旧版本。

release/latest 下载地址始终指向最新版，你也可以收藏这一行作为"更新命令"。

### Q：可以用在 Windows 上吗？

可以。扩展本身跨平台，安装命令在 Windows 的 PowerShell 或 CMD 中同样可用。快捷键在 Windows 上是 `Ctrl+Right` 而不是 `Cmd+Right`。

---

## 更新日志

### v1.1.0
- 🆕 流式 SSE 输出，首 chunk 延迟 < 0.2s
- 🆕 LRU 智能缓存，相同上下文秒回
- 🆕 智能 stop tokens，空行自动截断
- 🆕 `Cmd+Right` 逐词接受
- 🆕 网络失败自动退避重试
- 🆕 本地持久化统计面板
- 🆕 保守场景过滤（空文件/字符串内不触发）

### v1.0.0
- 首次发布：DeepSeek V4 FIM 行内补全
- 三模型切换（状态栏点击）
- 多行补全、API key 预填

---

## 许可证

MIT © 2024
