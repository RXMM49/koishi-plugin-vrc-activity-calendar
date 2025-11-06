// =========================================================
// 📅 VRChat 活动日历插件 (Koishi)
// ---------------------------------------------------------
// 功能:
// - 自动抓取日本 / 中国 VRChat 活动信息
// - 自动翻译标题到中文
// - 自动生成活动图片（通过 HTML 渲染 + Puppeteer 截图）
// - 自动定时推送到指定频道
// ---------------------------------------------------------
// 作者: 日向和风（完整注释版）
// =========================================================

const { Context, Schema, segment } = require('koishi')
const { promises: fs } = require('fs')
const path = require('path')

exports.name = 'vrc-activity-calendar'
exports.using = ['puppeteer']

// =========================================================
// 🧩 插件配置结构定义
// =========================================================
exports.schema = Schema.object({
  updateInterval: Schema.number().default(30).description('自动更新间隔(分钟)'),
  maxActivities: Schema.number().default(10).description('最多显示活动数量'),
  scrapeDelay: Schema.number().default(5000).description('网页加载后等待时间(毫秒)'),

  // 翻译配置
  translation: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用翻译功能'),
    apiKey: Schema.string().default('').description('Google翻译API密钥'),
    targetLanguage: Schema.string().default('zh').description('目标翻译语言')
  }).description('翻译设置'),

  // 自动推送配置
  autoPush: Schema.object({
    japan: Schema.object({
      enabled: Schema.boolean().default(false).description('是否启用日本活动自动推送'),
      interval: Schema.number().default(60).description('日本活动自动推送间隔(分钟)'),
      target: Schema.string().default('').description('推送目标 (平台:频道ID)')
    }).description('日本活动推送'),

    china: Schema.object({
      enabled: Schema.boolean().default(false).description('是否启用中国活动自动推送'),
      interval: Schema.number().default(60).description('中国活动自动推送间隔(分钟)'),
      target: Schema.string().default('').description('推送目标 (平台:频道ID)')
    }).description('中国活动推送')
  }).description('自动推送设置')
})

// =========================================================
// 🧠 主逻辑入口
// =========================================================
exports.apply = (ctx, config) => {

  // -----------------------------------------------
  // 缓存数据结构定义
  // -----------------------------------------------
  let japanActivities = []
  let chinaActivities = []
  let japanLastUpdateTime = null
  let chinaLastUpdateTime = null
  let japanCachedImageBuffer = null
  let chinaCachedImageBuffer = null

  // 确保缓存目录存在
  const cacheDir = path.resolve(__dirname, 'cache')
  fs.mkdir(cacheDir, { recursive: true }).catch(() => {})

  // =========================================================
  // 🌐 Google 翻译初始化
  // =========================================================
  let Translate
  try {
    const translateModule = require('@google-cloud/translate')
    Translate = translateModule.v2.Translate
  } catch (error) {
    ctx.logger('vrc-activity').warn('Google翻译模块未安装:', error.message)
  }

  let translateClient
  if (Translate && config.translation?.enabled && config.translation?.apiKey) {
    try {
      translateClient = new Translate({
        key: config.translation.apiKey
      })
      ctx.logger('vrc-activity').info('✅ Google翻译已启用')
    } catch (error) {
      ctx.logger('vrc-activity').warn('Google翻译初始化失败:', error.message)
    }
  }

  // 翻译辅助函数
  async function translateText(text) {
    if (!translateClient || !text || !config.translation?.enabled) return text
    try {
      const [translation] = await translateClient.translate(text, config.translation.targetLanguage || 'zh')
      return translation
    } catch (error) {
      ctx.logger('vrc-activity').warn('翻译失败:', error.message)
      return text
    }
  }

  // =========================================================
  // 🇯🇵 抓取日本活动（VRCEVE）
  // =========================================================
  async function fetchJapanActivities() {
    const activities = await fetchFromWebpage('https://vrceve.com/')
    for (const activity of activities) {
      if (activity.title && activity.title !== '未命名活动') {
        activity.originalTitle = activity.title
        activity.translatedDescription = await translateText(activity.title)
      }
    }
    return activities
  }

  // =========================================================
  // 🇨🇳 抓取中国活动（RLVRC）
  // =========================================================
  async function fetchChinaActivities() {
    return await fetchFromWebpage('https://rlvrc.cn/event-showcase')
  }

  // =========================================================
  // 🌍 网页抓取函数（通用）
  // =========================================================
  async function fetchFromWebpage(url) {
    let page = null
    try {
      page = await ctx.puppeteer.page()
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/116.0.0.0 Safari/537.36')
      await page.setDefaultNavigationTimeout(60000)

      ctx.logger('vrc-activity').info(`正在加载页面: ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await new Promise(r => setTimeout(r, config.scrapeDelay))

      // -----------------------------------------------------
      // 🇨🇳 RLVRC 活动提取
      // -----------------------------------------------------
      if (url.includes('rlvrc.cn')) {
        await page.waitForSelector('.event-card', { timeout: 20000 })
        const activities = await page.evaluate(() => {
          const results = []
          const eventCards = document.querySelectorAll('.event-card')
          eventCards.forEach(card => {
            const title = card.querySelector('.card-title')?.textContent.trim() || '未命名活动'
            const time = card.querySelector('.card-time')?.textContent.trim() || '时间未知'
            const desc = card.querySelector('.card-description')?.textContent.trim() || ''
            results.push({ date: time, title, description: desc, link: '' })
          })
          return results
        })

        // 🧹 过滤假期日历关键字
        const invalidKeywords = [
          '祝日', '休日', '七五三', '勤労感謝', '成人の日', '建国記念', '春分の日',
          '昭和の日', '憲法記念', 'みどりの日', 'こどもの日', '海の日', '山の日',
          '敬老の日', '文化の日', '勤労感謝の日', '天皇誕生日', '日历', 'カレンダー'
        ]
        const filtered = activities.filter(a => {
          const text = `${a.title || ''} ${a.description || ''}`
          return !invalidKeywords.some(k => text.includes(k))
        })

        ctx.logger('vrc-activity').info(`过滤后剩余 ${filtered.length} 个活动`)
        return filtered
      }

      // -----------------------------------------------------
      // 🇯🇵 VRCEVE (Google Calendar 嵌入)
      // -----------------------------------------------------
      const iframes = await page.$$('iframe')
      ctx.logger('vrc-activity').info(`检测到 ${iframes.length} 个 iframe，尝试提取活动内容`)

      for (const iframe of iframes) {
        const frame = await iframe.contentFrame()
        if (!frame) continue
        if (!frame.url().includes('calendar.google.com')) continue

        await frame.waitForSelector('[data-eventchip], .chip', { timeout: 20000 }).catch(() => null)
        const activities = await frame.evaluate(() => {
          const results = []
          document.querySelectorAll('[data-eventchip], .chip').forEach(el => {
            const text = el.textContent.trim()
            if (text.length < 4) return
            let date = text.match(/(\d{1,2}):(\d{2})\s?-\s?(\d{1,2}):(\d{2})/)
            date = date ? date[0] : '日期未知'
            const title = text.replace(date, '').trim()
            results.push({ date, title, description: text, link: '' })
          })
          return results
        })
        return activities
      }

      return []
    } catch (e) {
      ctx.logger('vrc-activity').error('抓取失败:', e.message)
      return []
    } finally {
      if (page) await page.close().catch(() => {})
    }
  }

  // =========================================================
  // ⏰ 当前或最近活动筛选
  // =========================================================
  function getCurrentOrNearbyActivities(activities) {
    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    function parseTimeRange(range) {
      const match = range.match(/(\d{1,2}):(\d{2})\s?-\s?(\d{1,2}):(\d{2})/)
      if (!match) return null
      let [, sh, sm, eh, em] = match.map(Number)
      const start = sh * 60 + sm
      let end = eh * 60 + em
      if (end <= start) end += 24 * 60
      return { start, end }
    }

    const ongoing = activities.filter(a => {
      const range = parseTimeRange(a.date)
      return range && currentMinutes >= range.start && currentMinutes <= range.end
    })
    if (ongoing.length) return ongoing.map(a => ({ ...a, tag: '当前活动' }))

    const future = activities.filter(a => {
      const r = parseTimeRange(a.date)
      return r && r.start > currentMinutes
    }).sort((a, b) => parseTimeRange(a.date).start - parseTimeRange(b.date).start)

    const past = activities.filter(a => {
      const r = parseTimeRange(a.date)
      return r && r.end < currentMinutes
    })

    const result = []
    if (past[past.length - 1]) result.push({ ...past[past.length - 1], tag: '上一个活动' })
    if (future[0]) result.push({ ...future[0], tag: '下一个活动' })
    return result
  }

  // =========================================================
  // 🖼️ 生成活动图片
  // =========================================================
  async function generateCalendarImage(activities, lastUpdateTime, title) {
    const html = `
      <html>
      <head>
        <style>
          body { font-family: 'Microsoft Yahei', sans-serif; background: #111; color: #fff; padding: 24px; }
          h1 { font-size: 28px; color: #00bcd4; margin-bottom: 10px; }
          .time { color: #999; font-size: 14px; margin-bottom: 10px; }
          .card { background: #1c1c1c; padding: 12px; margin-bottom: 8px; border-radius: 8px; }
          .tag { color: #0f0; font-weight: bold; margin-right: 5px; }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        <div class="time">最后更新：${lastUpdateTime ? lastUpdateTime.toLocaleString() : '未知'}</div>
        ${activities.map(a => `
          <div class="card">
            <span class="tag">#${a.tag || '活动'}</span>
            <b>${a.title}</b> <span style="color:#ccc;">(${a.date})</span>
            <div>${a.translatedDescription || a.description || ''}</div>
          </div>`).join('')}
      </body>
      </html>
    `

    const page = await ctx.puppeteer.page()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const image = await page.screenshot({ fullPage: true })
    await page.close()
    return image
  }

  // =========================================================
  // 🇯🇵 更新日本活动数据
  // =========================================================
  async function updateJapanActivities() {
    japanActivities = await fetchJapanActivities()
    japanLastUpdateTime = new Date()
    japanCachedImageBuffer = await generateCalendarImage(
      japanActivities.slice(0, config.maxActivities),
      japanLastUpdateTime,
      '🇯🇵 日本 VRChat 活动'
    )
  }

  // =========================================================
  // 🇨🇳 更新中国活动数据
  // =========================================================
  async function updateChinaActivities() {
    chinaActivities = await fetchChinaActivities()
    chinaLastUpdateTime = new Date()
    chinaCachedImageBuffer = await generateCalendarImage(
      chinaActivities.slice(0, config.maxActivities),
      chinaLastUpdateTime,
      '🇨🇳 中国 VRChat 活动'
    )
  }

  // =========================================================
  // ♻️ 自动定时推送
  // =========================================================
  if (config.autoPush?.japan?.enabled) {
    ctx.setInterval(async () => {
      await updateJapanActivities()
      const [platform, channelId] = config.autoPush.japan.target.split(':')
      if (platform && channelId && japanCachedImageBuffer) {
        await ctx.bots[platform]?.sendMessage(channelId, segment.image(japanCachedImageBuffer))
      }
    }, config.autoPush.japan.interval * 60000)
  }

  if (config.autoPush?.china?.enabled) {
    ctx.setInterval(async () => {
      await updateChinaActivities()
      const [platform, channelId] = config.autoPush.china.target.split(':')
      if (platform && channelId && chinaCachedImageBuffer) {
        await ctx.bots[platform]?.sendMessage(channelId, segment.image(chinaCachedImageBuffer))
      }
    }, config.autoPush.china.interval * 60000)
  }

  // =========================================================
  // 🧾 指令注册区
  // =========================================================

  // 手动刷新所有活动
  ctx.command('vrc活动刷新', '手动刷新全部活动')
    .action(async ({ session }) => {
      await updateJapanActivities()
      await updateChinaActivities()
      return '✅ 活动信息已刷新完成！'
    })

  // 查看日本活动
  ctx.command('vrc活动日本', '查看日本VRChat活动')
    .action(async ({ session }) => {
      if (!japanCachedImageBuffer) await updateJapanActivities()
      return segment.image(japanCachedImageBuffer)
    })

  // 查看中国活动
  ctx.command('vrc活动中国', '查看中国VRChat活动')
    .action(async ({ session }) => {
      if (!chinaCachedImageBuffer) await updateChinaActivities()
      return segment.image(chinaCachedImageBuffer)
    })
}
