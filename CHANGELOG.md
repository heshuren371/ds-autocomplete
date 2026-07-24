# Changelog

## 1.1.2 (2026-07-24)

- 🐛 修复「一行写一半不弹补全」:上一次请求发出后 debounceMs 窗口内的击键被直接丢弃且不再调度防抖定时器 — 最后一下击键被吞,补全永远不出现。现在每次击键都重排定时器,被取代的 Promise 立即 resolve 不悬挂
- 🐛 未闭合字符串不再默认跳过补全:半行代码常带开引号(`print("hel`),FIM 原生支持字符串内补全。新增 `skipInString` 开关(默认关),想恢复旧行为可手动开
- ✨ `enabledLanguages` 默认 `["*"]` 全文件类型生效(json/yaml/markdown/shell 都有补全);仍可按语言列表收窄
- ✅ 新增 mock 宿主回归测试 `node test/mock-host-test.js`(5 例,覆盖以上修复)

## 1.1.1

- 移除预置 API key,首次启动弹窗引导用户配置

## 1.1.0

- LRU 缓存、SSE 流式提前退出、逐词接受(Cmd+Right)、失败重试、本地统计

## 1.0.0 (initial)

- 🎉 First release — DeepSeek V4 FIM inline code completion
- Status bar indicator with spinner/error feedback
- Multi-line completions with auto/custom mode
- Configurable stop tokens, temperature, model selection
- Request deduplication (cancel in-flight on new keystroke)
- Pre-seeded API key for zero-config setup
- 8 languages: Python, JavaScript, TypeScript, Go, Rust, Java, C, C++
