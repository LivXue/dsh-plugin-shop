/**
 * The Chinese → English query dictionary whose expansion the shelf search
 * applies (design `2026-10-08-search-query-expansion.md` §2–§4, borrowing C2
 * from `2026-09-26-market-borrowings.md`; reference: 2BingLing/dsh-market's
 * `plugin/core/src/zh-intent.ts`).
 *
 * The dictionary is a curated DATA table, not code. It lives here, in
 * `src/shared/` (mirroring `src/shared/identity.ts`), because the seam is
 * one shared filter module and a later consumer in `host/` should not have
 * to change paths to use it; today the only caller is `client/present.ts`.
 *
 * One intent is `{ key, words, terms }`:
 * - `words` are the Chinese trigger phrases. A query containing any of them,
 *   as a lowercase substring, fires the intent. They are always ≥ 2 Han
 *   characters so a stray Han in an English query never fires one.
 * - `terms` are the recall vocabulary scanned against each entry's name,
 *   `summary.en`, `summary.zh` and category key. A term prefixed with `#`
 *   is matched on a WORD BOUNDARY, not as a substring: `#ai` refuses to
 *   fire on `email`, `main`, `pipeline` and fires on `ai-chat`, `AI聊天`.
 *   The marker exists because, without it, 2BingLing measured 713 false
 *   `ai` hits in 9,145 entries; on our own 2026-10-08 catalog (14,167
 *   entries), `#ai` holds `AI大模型` to 2,760 hits instead of the many
 *   thousand the bare token would match.
 *
 * Credit: the trigger-to-recall structure, the `#` boundary marker, and
 * the "curated, defensive, every-term-measured" discipline are all from
 * 2BingLing/dsh-market's `zh-intent.ts`, read live 2026-10-08. The
 * dictionary's rows are our own, trimmed from theirs against the live
 * catalog (`2026-10-08-search-query-expansion.md` §3): the four intents
 * their data also shows to be dead in our ecosystem (`农历节日`, `Twitter`,
 * `微博`, `Notion`) were dropped because their marginal recall was 3 to 7.
 */

/** One curated intent. UI surfaces name `key` when they cite the expansion. */
export interface ZhIntent {
  /** The intent's label, always a short Chinese phrase. */
  key: string
  /** Trigger words: any substring match on the lowercased query fires it. */
  words: readonly string[]
  /**
   * Recall terms: any substring match (or word-boundary match, for a term
   * prefixed with `#`) on the lowercased entry fields recalls that entry.
   */
  terms: readonly string[]
}

/**
 * The recall side of an intent that fired for a query.
 *
 * The result is always deduplicated and ordered by the dictionary's rows;
 * the query itself, lowercased, is always the FIRST element of `terms`, so
 * the 18 author-written `summary.zh` entries today are always reachable
 * through the raw query and never depend on a dictionary expansion.
 */
export interface ZhExpansion {
  /** The user's query, trimmed and lowercased. */
  query: string
  /** The intent keys that fired, in dictionary order. */
  intents: readonly string[]
  /** The fired intents with their surviving recall terms, deduplicated. */
  expansions: readonly { intent: string; terms: readonly string[] }[]
  /** Every recall term, deduplicated, query first. */
  terms: readonly string[]
}

/** The word-boundary marker (`#`) prefix on a recall term. */
const TOKEN_MARK = '#'

/**
 * Word-boundary (token) match: `term` appears in `text` as a standalone
 * word. A non-ASCII-alphanumeric character is a boundary, so `ai-chat` and
 * `AI聊天` hit `ai` while `email`, `main` and `pipeline` do not. The text
 * must already be lowercased; the regex is cached per term because the
 * matcher runs this for every entry on every keystroke.
 */
const tokenRegexCache = new Map<string, RegExp>()
export function tokenInText(term: string, text: string): boolean {
  let re = tokenRegexCache.get(term)
  if (re === undefined) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i')
    tokenRegexCache.set(term, re)
  }
  return re.test(text)
}

/**
 * The curated dictionary. Ordered by design §3's measured marginal recall
 * (largest first). Rows trimmed from 2BingLing's eighty-four to eighty by
 * dropping the four whose marginal recall on the 2026-10-08 catalog was
 * single-digit: `农历节日`, `Twitter`, `微博`, `Notion`.
 *
 * To add a row: write the intent's key in Chinese, its triggers (≥ 2 Han
 * characters each, as a defensive rule, so an isolated Han inside someone
 * else's name never fires the intent), its recall terms with `#` where a
 * bare short Latin term would otherwise act like a substring, and one
 * comment line pointing at this document's measured table.
 */
export const ZH_INTENTS: readonly ZhIntent[] = [
  // C2's measured queries from 2026-09-26 (the report's own evidence):
  // `记忆` 159 vs `memory` 467, `主题` 156 vs `theme` 278, `搜索` 191 vs
  // `search` 761. The first three rows are those — without them the
  // dictionary fails the exact queries the borrowing was measured on.
  { key: '记忆', words: ['记忆', '记住', '想起'], terms: ['#memory', '#memories', '#remember'] },
  { key: '主题', words: ['主题', '皮肤', '外观'], terms: ['#theme', '#skin', '#appearance', '主题', '皮肤', '外观'] },
  { key: '搜索', words: ['搜索', '查找', '查找插件'], terms: ['#search', 'search-engine', '搜索', '查找'] },
  // Measured marginal recall ≥ 1000 on the 2026-10-08 catalog (§3).
  { key: '浏览器', words: ['浏览器', '网页', '上网'], terms: ['#browser', '#web', '浏览器', '网页'] },
  { key: 'AI大模型', words: ['大模型', 'llm', 'gpt', '智能体', '人工智能'], terms: ['#ai', '#llm', '#gpt', '#agent', '大模型', '人工智能'] },
  { key: '代码开发', words: ['代码', '编程', '开发'], terms: ['#code', '#coding', '#dev', '代码', '编程'] },
  { key: '文件管理', words: ['文件管理', '资源管理', '文件整理', '整理文件', '整理', '重命名'], terms: ['#file', '#files', '#explorer', '文件', '#rename', '#renamer', '重命名'] },
  { key: '聊天', words: ['聊天', '对话', '陪聊'], terms: ['#chat', '#chatbot', '聊天', '对话'] },
  { key: '搜索引擎', words: ['搜索引擎'], terms: ['#search', 'search-engine', '搜索'] },
  { key: '图片', words: ['图片', '相册', '壁纸', '水印'], terms: ['#image', '#images', '#photo', '#wallpaper', '图片', '壁纸', '相册', '视觉理解', '图像识别', '图片问答', '图像处理', '水印'] },
  { key: '待办', words: ['待办', '任务管理', '清单', 'todo'], terms: ['#todo', '#task', '#checklist', '待办', '任务', '清单', '任务看板', '#kanban'] },
  { key: '终端', words: ['终端', '命令行', 'shell'], terms: ['#terminal', '#shell', '#cli', '终端', '命令行'] },
  { key: 'Git', words: ['git', 'github', 'gitee', '提交'], terms: ['#git', '#github', '#gitee', '#commit', '版本控制'] },
  { key: '系统进程', words: ['系统', '进程', '任务管理'], terms: ['#system', '#process', '系统', '进程'] },
  { key: '阅读', words: ['阅读', '电子书', '小说'], terms: ['#read', '#reader', '#ebook', '#novel', '#epub', '阅读', '小说'] },
  { key: '记事本', words: ['记事本', '便签', '笔记本', '记事', '笔记'], terms: ['#notes', '#note', '#notepad', '便签', '笔记', 'markdown'] },
  { key: 'MCP', words: ['mcp', 'mcp服务器'], terms: ['#mcp', 'mcp-server', '#mcp-manager', '#mcp-debug'] },
  { key: '代理网络', words: ['代理', '梯子', '组网'], terms: ['#proxy', '#network', '代理', '网络', '网络代理', '内网穿透'] },
  { key: '日志', words: ['日志'], terms: ['#log', '#logs', '日志'] },
  { key: '提醒', words: ['提醒', '通知'], terms: ['#remind', '#reminder', '#notification', '#notify', '提醒', '消息通知'] },
  { key: '写作文案', words: ['写作', '文案', '改写'], terms: ['#write', '#writing', '写作', '文案', '内容创作'] },
  { key: '截图', words: ['截图', '截屏', '录屏', '屏幕录制', '长图'], terms: ['#screenshot', '#capture', '#screen', '截图', '录屏', '截图工具', '长图'] },
  { key: '提示词', words: ['提示词', 'prompt'], terms: ['#prompt', '提示词管理', '提示词优化'] },
  { key: '备份恢复', words: ['备份', '恢复'], terms: ['#backup', '#restore', '备份', '恢复'] },
  { key: '压缩', words: ['压缩', '解压'], terms: ['#zip', '#compress', '#archive', '压缩', '解压'] },
  { key: '自动化', words: ['自动化', 'rpa'], terms: ['#automation', '#automate', '#workflow', '任务编排', '桌面自动化'] },
  { key: '代码审查', words: ['审查', '评审', 'review'], terms: ['#review', 'code-review', '审查'] },
  { key: '语音合成', words: ['语音', '朗读', 'tts', '配音', '声音克隆', '克隆声音'], terms: ['#tts', '#speech', '#voice', '语音', '朗读', '声音克隆'] },
  { key: '视频', words: ['视频'], terms: ['#video', '视频', '剪辑'] },
  { key: '监控', words: ['监控'], terms: ['#monitor', '监控'] },
  { key: '办公文档', words: ['word', 'excel', 'ppt', '表格', '幻灯片', '演示'], terms: ['#excel', '#word', '#office', '#xlsx', '表格', '幻灯片', '#ppt'] },
  { key: '知识库', words: ['知识库', '维基', 'wiki'], terms: ['#wiki', '#knowledge', '知识库', '维基'] },
  { key: '网盘', words: ['网盘', '云盘'], terms: ['#cloud', '#drive', '网盘', '云盘', '#onedrive'] },
  { key: '网络诊断', words: ['ip', '端口', 'ping'], terms: ['#ip', '#port', '#tcp', '#udp', '#ping', '端口'] },
  { key: '清理', words: ['清理', '垃圾', '瘦身'], terms: ['#clean', '#cleanup', '清理', '垃圾'] },
  { key: 'PDF', words: ['pdf'], terms: ['#pdf'] },
  { key: '飞书钉钉', words: ['飞书', '钉钉', 'lark'], terms: ['#feishu', '#lark', '#dingtalk', '飞书', '钉钉'] },
  { key: '数据库', words: ['数据库', 'sql'], terms: ['#database', '#sql', 'sqlite', 'mysql', '数据库', '数据库连接'] },
  { key: '日历日程', words: ['日历', '日程', '闹钟', '时钟'], terms: ['#calendar', '#schedule', '#clock', '#alarm', '日历', '日程', '时钟'] },
  { key: '音乐', words: ['音乐', '歌曲', '听歌'], terms: ['#music', '#audio', '音乐'] },
  { key: '机器人', words: ['机器人'], terms: ['#bot', '#robot', '机器人'] },
  { key: '论文文献', words: ['论文', '文献', '学术'], terms: ['#paper', '#arxiv', '#scholar', '论文', '文献'] },
  { key: '下载', words: ['下载'], terms: ['#download', '#downloader', '下载'] },
  { key: '健康健身', words: ['健康', '健身', '体重'], terms: ['#health', '#fitness', '健康', '健身'] },
  { key: '学习背词', words: ['学习', '背单词', '单词', '英语'], terms: ['#learn', '#study', '#vocabulary', '#english', '学习', '单词', '英语'] },
  { key: '流程图', words: ['流程图', '图表', '绘图'], terms: ['#diagram', '#flowchart', '#mermaid', '流程图', '图表'] },
  { key: '报告生成', words: ['报告生成', '周报', '日报'], terms: ['#report', '报告生成', '周报', '日报'] },
  { key: '桌宠', words: ['桌宠', '桌面宠物'], terms: ['#desktop-pet', '桌宠'] },
  { key: '记账', words: ['记账', '账单', '花销'], terms: ['#expense', '#billing', '记账', '账单'] },
  { key: '微信', words: ['微信', '公众号', 'wechat'], terms: ['wechat', 'weixin', '微信', '公众号'] },
  { key: '股票基金', words: ['股票', '基金', 'a股', '行情', '炒股'], terms: ['#stock', '#finance', '股票', '基金', '行情'] },
  { key: '语音识别', words: ['语音识别', '听写', 'whisper'], terms: ['#whisper', '#asr', '#stt', '语音识别', '听写', '语音输入'] },
  { key: '白板', words: ['白板', '画布'], terms: ['#whiteboard', '#canvas', '白板', '画布'] },
  { key: '计算换算', words: ['计算器', '换算', '单位', '格式转换'], terms: ['#calculator', '#convert', '计算器', '换算', '数学计算'] },
  { key: '番茄钟', words: ['番茄钟', '专注', '计时'], terms: ['#pomodoro', '#focus', '#timer', '番茄钟', '专注', '计时'] },
  { key: '游戏', words: ['游戏', '摸鱼'], terms: ['#game', '#games', '游戏'] },
  { key: '绘画', words: ['画图', '绘画', '生图', '文生图', '画'], terms: ['#draw', '#drawing', 'stable-diffusion', '#image-generation', '绘画', '生图'] },
  { key: 'RSS订阅', words: ['rss', '订阅'], terms: ['#rss', '#feed', '订阅'] },
  { key: '多模态', words: ['多模态'], terms: ['#multimodal', '#multi-modal', '多模态'] },
  { key: 'OCR', words: ['ocr', '文字识别'], terms: ['#ocr', '文字识别'] },
  { key: '密码', words: ['密码'], terms: ['#password', '密码'] },
  { key: '翻译', words: ['翻译', 'translate'], terms: ['#translate', '#translation', '翻译'] },
  { key: '新闻资讯', words: ['新闻', '资讯', '头条', '热搜'], terms: ['#news', '#feed', '#trending', '新闻', '资讯', '热搜', '新闻聚合'] },
  { key: '简历', words: ['简历'], terms: ['#resume', '#cv', '简历'] },
  { key: '邮件', words: ['邮件', '邮箱'], terms: ['#mail', '#email', '#smtp', '邮件'] },
  { key: '随机抽签', words: ['随机', '抽签', '骰子'], terms: ['#random', '#dice', '随机'] },
  { key: '播放器', words: ['播放器'], terms: ['#player', '播放器'] },
  { key: '爬虫', words: ['爬虫', '抓取'], terms: ['#crawler', '#scraper', '#spider', '爬虫', '抓取'] },
  { key: '加密', words: ['加密', '解密'], terms: ['#encrypt', '#crypto', '加密'] },
  { key: '视频下载', words: ['视频下载', 'youtube', '油管', 'b站', 'bilibili', '哔哩'], terms: ['youtube', 'bilibili', 'yt-dlp', '哔站'] },
  { key: 'Telegram', words: ['telegram'], terms: ['telegram'] },
  { key: '数据分析', words: ['数据分析', '数据统计'], terms: ['#data-analysis', '#analytics', '数据分析', '数据统计'] },
  { key: '问卷投票', words: ['问卷', '投票', '抽奖'], terms: ['#survey', '#poll', '#quiz', '问卷', '投票', '抽奖'] },
  { key: 'Obsidian', words: ['obsidian'], terms: ['obsidian'] },
  { key: '剪贴板', words: ['剪贴板'], terms: ['#clipboard', '剪贴板'] },
  { key: '加密货币', words: ['比特币', '加密货币', '币圈'], terms: ['#bitcoin', '#crypto', '#blockchain', '加密货币'] },
  { key: '天气', words: ['天气'], terms: ['#weather', '天气'] },
  { key: '汇率', words: ['汇率', '货币'], terms: ['#exchange', '#currency', '汇率'] },
  { key: '思维导图', words: ['思维导图'], terms: ['#mindmap', '#mind', '思维导图'] },
  { key: '字幕', words: ['字幕'], terms: ['#subtitle', '字幕'] },
  { key: '娱乐', words: ['娱乐', '段子', '笑话'], terms: ['#fun', '#joke', '#meme', '娱乐', '段子'] },
  { key: '面试', words: ['面试'], terms: ['#interview', '面试'] },
  { key: 'Discord', words: ['discord'], terms: ['discord'] },
]

/**
 * Fire every intent whose trigger appears in the query (lowercase, substring),
 * deduplicate the recall vocabulary, and return the query itself first.
 *
 * The call site never has to know whether expansion happened: `terms` is
 * always at least `[query]`. The caller joins these with OR against each
 * entry's searchable fields, in the same `includes`/`tokenInText` grammar
 * as the raw query.
 */
export function expandZhQuery(rawQuery: string): ZhExpansion {
  const query = (rawQuery ?? '').trim().toLowerCase()
  if (query === '') {
    return { query: '', intents: [], expansions: [], terms: [''] }
  }
  const intents: string[] = []
  const expansions: { intent: string; terms: readonly string[] }[] = []
  const terms = new Set<string>()
  for (const it of ZH_INTENTS) {
    if (!it.words.some(w => query.includes(w))) continue
    intents.push(it.key)
    const added = [...new Set(it.terms)].filter(t => {
      const lower = t.toLowerCase()
      return lower !== '' && lower !== query && !terms.has(lower) && !terms.has(t)
    })
    for (const t of added) terms.add(t)
    expansions.push({ intent: it.key, terms: added })
  }
  return { query, intents, expansions, terms: [query, ...terms] }
}
