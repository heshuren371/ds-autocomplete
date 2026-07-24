# Changelog

## 1.3.2 (2026-07-24)

- 🐛 修复「跟着幽灵文打字时幽灵文被顶没」:`replacePartialWord` 给补全项设置的 `range` 会让 VSCode 原生「敲匹配字符→收缩幽灵文」机制失效,每个击键都整段打掉重查。默认改为 `false`,补全项不再携带 range,幽灵文跟随输入持续收缩显示。想恢复 mid-word 替换行为可手动开(不推荐)

## 1.3.1 (2026-07-24)

- 🐛 关掉 VSCode 词索引(`wordBasedSuggestions: off`)+ suggest widget 词项(`suggest.showWords: false`),解决自带索引压幽灵文
- ✨ debounce 默认 350→200ms,响应快 ~40%

## 1.3.0 (2026-07-24)

- ✨ 打字跟随幽灵文(instant remainder):键入字符匹配当前建议开头时立即返回剩余部分,跳过 debounce 和 API

## 1.2.0 (2026-07-24)

- ✨ 空括号(`print()`)光标停其中自动触发补全
- ✨ `inlineSuggest.suppressSuggestions: true` 幽灵文优先于 suggest widget

## 1.1.3 (2026-07-24)

- ✨ Cmd+↓ 逐行接受

## 1.1.2 (2026-07-24)

- 🐛 修复「一行写一半不弹补全」:上一次请求发出后 debounceMs 窗口内的击键被直接丢弃且不再调度防抖定时器 — 最后一下击键被吞,补全永远不出现。现在每次击键都重排定时器,被取代的 Promise 立即 resolve 不悬挂
- 🐛 未闭合字符串不再默认跳过补全:半行代码常带开引号(`print("hel`),FIM 原生支持字符串内补全。新增 `skipInString` 开关(默认关)
- ✨ `enabledLanguages` 默认 `["*"]` 全文件类型生效
- ✅ 新增 mock 宿主回归测试 `node test/mock-host-test.js`

## 1.1.1

- 移除预置 API key,首次启动弹窗引导用户配置

## 1.1.0

- LRU 缓存、SSE 流式提前退出、逐词接受(Cmd+Right)、失败重试、本地统计

## 1.0.0 (initial)

- 🎉 First release — DeepSeek V4 FIM inline code completion
