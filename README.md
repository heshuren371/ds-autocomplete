# DS Autocomplete — DeepSeek V4 代码自动补全

**零额度限制、零中转站**的 VSCode 行内代码补全扩展。直连 DeepSeek V4 FIM 端点，幽灵文本补全。

## 特性

- 🚀 **DeepSeek V4 Flash** 驱动，FIM（Fill-in-the-Middle）原生补全
- 🎯 **多行补全**，不只是单行碎屑
- ⚡ **350ms 防抖** + 请求自动取消（快速打字不再排队）
- 📊 **状态栏指示器**：补全时显示 spinner，完成显示 ✓
- 🔧 **全配置化**：token 数 / 模型 / 温度 / 超时 / 语言白名单，VS Code 设置里直接调
- 🌐 **API key 预填**：开箱即用，也可随时换自己的 key
- 🏠 **纯本地扩展**：不收集数据、不上传代码

## 安装

### 方式一：VS Code 扩展市场（推荐）

1. 打开 VS Code → 扩展面板（`Cmd+Shift+X`）
2. 搜索 `DS Autocomplete`
3. 点击安装

### 方式二：从 VSIX 手动安装

```bash
# 下载 ds-autocomplete-x.x.x.vsix
code --install-extension ds-autocomplete-1.0.0.vsix
```

### 方式三：源码安装

```bash
git clone <repo-url>
cd ds-autocomplete
ln -sf $(pwd) ~/.vscode/extensions/local.ds-autocomplete-1.0.0
# 重启 VS Code
```

## 使用

1. 打开任意 Python / JS / TS / Go / Rust / Java / C / C++ 文件
2. 正常打字——代码上方出现灰色幽灵文本
3. **Tab** 接受 → 插入补全
4. **Esc** 或继续打字 → 拒绝 → 补全消失
5. 右下角状态栏显示 `DS` 运行状态

## 配置

`Cmd+,` 打开设置，搜索 `dsAutocomplete`：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `apiKey` | 你的 key | DeepSeek API 密钥 |
| `model` | `deepseek-v4-flash` | 模型选择（支持 coder） |
| `maxTokens` | 80 | 每次补全最大 token 数 |
| `multiLine` | `true` | 允许多行补全 |
| `multiLineMode` | `always` | always / auto / never |
| `debounceMs` | 350 | 按键防抖延迟 |
| `temperature` | 0 | 生成温度（0 = 确定性强） |
| `enabledLanguages` | python, js, ts, go, rust, java, c, cpp | 生效的语言 |

## 常见问题

**Q: 为什么有时候感觉不到补全？**
- 检查右下角状态栏 —— 如果有红色错误图标，点一下看报错信息
- 确认 `apiKey` 设置正确且 DeepSeek 账户余额充足
- 确认当前语言在 `enabledLanguages` 列表中
- 试试把 `debounceMs` 调小到 200ms 看是否更灵敏

**Q: 补全太短？**
- 调大 `maxTokens`（如 150）
- 确保 `multiLine: true` 且 `multiLineMode: always`

**Q: 只想在 Python 里用？**
- `enabledLanguages: ["python"]`

**Q: 觉得补全不对，想换模型？**
- 试试 `model: deepseek-coder`

## 依赖

- VS Code ≥ 1.85.0
- DeepSeek API 账户 + key

## 许可证

MIT © 2024
