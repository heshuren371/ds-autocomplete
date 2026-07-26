# Changelog

## 1.9.2 (2026-07-26)

- ⚡ 上下文窗口提升: maxPrefixChars 2000→8000(≈200行代码), maxSuffixChars 1500→4000(≈100行)——DeepSeek prompt 缓存让重复前缀只收 10% 费用,大上下文接近免费
- 📝 单行模式仍保持 800/200 小窗口(快优先)

## 1.9.1 (2026-07-26)

- ✨ comment-to-code token 预算提升: med 800→8000, max 2000→16000(实测官方 API 接受 40000)
- ✨ 新增 `chatMaxTokens` 覆盖项(0=自动,想要 40000 直接填,上限 128000)
- 📝 max_tokens 是上限不是消费——短回答只花几个 token,长实现不再被截断

## 1.9.0 (2026-07-26)

- ✨ 思考强度两档 `chatThinking`: `med`(默认,显式关思考) / `max`(开思考 + max_tokens 提到 2000)。实测官方 API **不传参数默认开思考**,reasoning 烧光 max_tokens 还拖慢 comment-to-code 数秒;med 档实测省 ~95% token。仅作用 chat 路径,FIM 端点实测免疫

## 1.8.0 (2026-07-26)

- ✨ 最近编辑注入(Continue recentlyEdited 轻量版):跨文件追踪刚改过的行写进 prompt 头部——改完 A 文件,B 文件补全新签名。光标 ±1 行排除防与 prefix 重复,300 字符预算硬顶

## 1.7.0 (2026-07-26)

- ✨ 作用域链注入:prompt 头部标注 `class > def` 链,长函数被 maxPrefixChars 截断后模型也知道自己在哪个函数里
- ✨ 符号大纲:文件内全部 def/class 签名入 prompt,调函数不瞎编名字
- ✨ 后处理加强:复读循环截断(同行重复 3 次) + 括号整体配平(截断丢弃/跨行闭合保留)
- 🐛 修 `unitLen` 未声明——v1.6.3 缩进修复在「光标在缩进内 + 多行补全」时异常被吞,幽灵文静默消失(生产 bug)

## 1.6.4 (2026-07-26)

- 🐛 修 6 个逻辑 bug:dedup 越界(单行文档崩溃)/chat 请求无互斥/历史无去重/postProcess 越界防护/mock URI 非幂等/T3 假阳性(测试通过竟建立在崩溃之上)

## 1.6.3 (2026-07-25)

- 🐛 去重:模型把光标后下文重抄一遍时,裁掉与 suffix 重复的前缀
- 🐛 缩进对齐重写:自动检测文档缩进风格(tabs/spaces/宽度),正负相对缩进都处理(dedent 不再被 clamp 掉)

## 1.6.2 (2026-07-25)

- 🐛 修 Cmd+Right/Cmd+Down 部分接受时 `_lastSuggestion` 被异步清空的 null.text 崩溃

## 1.6.1 (2026-07-25)

- 🌐 comment-to-code 提示词全中文(systemMsg + userMsg)

## 1.6.0 (2026-07-25)

- ✨ comment-to-code 模式:光标在注释后自动切 chat/completions,注释当指令生成实现代码(Copilot Next Edit 同款)

## 1.5.x (2026-07-24/25)

- ✨ 1.5.5 性能:模块级预编译正则 + imports 缓存 + 单行小前缀,maxPrefixChars 默认 2000
- ✨ 1.5.4 选区非空时跳过补全(Tabby 同款)
- ✨ 1.5.3 InlineCompletionItem 绑接受命令回调,100% 可靠替代光标位置推断
- ✨ 1.5.2 流式早停:5 token(单行)/8 token(多行)即展示
- ✨ 1.5.1 智能上下文:文件路径 + imports + 函数边界对齐
- ✨ 1.5.0 幽灵文接受检测 + 请求生命周期追踪 + 每语言禁用开关

## 1.4.x (2026-07-24)

- 🐛 1.4.3 放宽多行 stop token(\n\n→\n\n\n),函数体内空行不再截断 return
- 🐛 1.4.2 修 FIM 格式:删除错误的 fim token 包裹,DeepSeek 要裸文本
- ✨ 1.4.0/1.4.1 selectedCompletionInfo(Continue 同款):VSCode 权威状态替代手动追踪

## 1.3.9 (2026-07-24)

- ✨ 建议历史存档+恢复:状态被 widget/IME/竞态清除后,从历史恢复幽灵文

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
