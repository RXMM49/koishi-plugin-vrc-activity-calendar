const { Context, Schema, segment } = require('koishi')
const { promises: fs } = require('fs')
const path = require('path')

exports.name = 'vrc-activity-calendar'
exports.using = ['puppeteer']

exports.schema = Schema.object({
  updateInterval: Schema.number().default(30).description('自动更新间隔(分钟)'),
  maxActivities: Schema.number().default(10).description('最多显示活动数量'),
  scrapeDelay: Schema.number().default(5000).description('网页加载后等待时间(毫秒)'),
  translation: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用翻译功能'),
    apiKey: Schema.string().default('').description('Google翻译API密钥'),
    targetLanguage: Schema.string().default('zh').description('目标翻译语言')
  }).description('翻译设置'),
  background: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用背景图片'),
    japan: Schema.string().default('').description('日本活动背景图片路径/URL'),
    china: Schema.string().default('').description('中国活动背景图片路径/URL'),
    opacity: Schema.number().default(0.1).min(0).max(1).description('背景图片透明度 (0-1)'),
    cardOpacity: Schema.number().default(0.95).min(0.1).max(1).description('卡片背景透明度 (0.1-1)')
  }).description('背景图片设置'),
  autoPush: Schema.object({
    japan: Schema.object({
      enabled: Schema.boolean().default(false).description('是否启用日本活动自动推送'),
      interval: Schema.number().default(60).description('日本活动自动推送间隔(分钟)'),
      target: Schema.string().default('').description('日本活动推送目标 (格式: 平台:频道ID)')
    }).description('日本活动推送设置'),
    china: Schema.object({
      enabled: Schema.boolean().default(false).description('是否启用中国活动自动推送'),
      interval: Schema.number().default(60).description('中国活动自动推送间隔(分钟)'),
      target: Schema.string().default('').description('中国活动推送目标 (格式: 平台:频道ID)')
    }).description('中国活动推送设置')
  }).description('自动推送设置')
})

exports.apply = (ctx, config) => {
  let japanActivities = []
  let chinaActivities = []
  let japanLastUpdateTime = null
  let chinaLastUpdateTime = null
  let japanCachedImageBuffer = null
  let chinaCachedImageBuffer = null

  const cacheDir = path.resolve(__dirname, 'cache')
  fs.mkdir(cacheDir, { recursive: true }).catch(() => {})

  let Translate
  try {
    const translateModule = require('@google-cloud/translate')
    Translate = translateModule.v2.Translate
  } catch (error) {
    ctx.logger('vrc-activity').warn('Google翻译模块未安装:', error.message)
  }

  let translateClient
  if (Translate) {
    try {
      if (config.translation?.enabled && config.translation?.apiKey) {
        translateClient = new Translate({
          key: config.translation.apiKey
        })
        ctx.logger('vrc-activity').info('Google翻译已启用')
      } else {
        ctx.logger('vrc-activity').info('Google翻译未配置或已禁用')
      }
    } catch (error) {
      ctx.logger('vrc-activity').warn('Google翻译初始化失败:', error.message)
    }
  }

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

  async function fetchJapanActivities() {
    try {
      ctx.logger('vrc-activity').info('正在通过 Google Calendar API 获取日本活动数据')
      
      const apiUrl = 'https://clients6.google.com/calendar/v3/calendars/0058cd78d2936be61ca77f27b894c73bfae9f1f2aa778a762f0c872e834ee621%40group.calendar.google.com/events?calendarId=0058cd78d2936be61ca77f27b894c73bfae9f1f2aa778a762f0c872e834ee621%40group.calendar.google.com&singleEvents=true&eventTypes=default&eventTypes=focusTime&eventTypes=outOfOffice&timeZone=Asia%2FTokyo&maxAttendees=1&maxResults=250&sanitizeHtml=true&timeMin=2025-11-09T00%3A00%3A00%2B18%3A00&timeMax=2026-11-09T00%3A00%3A00-18%3A00&key=AIzaSyDOtGM5jr8bNp1utVpG2_gSRH03RNGBkI8&%24unique=gc456'
      
      const response = await ctx.http.get(apiUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      })

      ctx.logger('vrc-activity').info(`Google Calendar API 响应状态: ${response ? '成功' : '无数据'}`)
      
      if (!response || !response.items || !Array.isArray(response.items)) {
        ctx.logger('vrc-activity').warn('Google Calendar API 返回数据格式异常')
        return await fetchFromWebpage('https://vrceve.com/')
      }

      const events = response.items
      ctx.logger('vrc-activity').info(`从 Google Calendar API 获取到 ${events.length} 个活动`)

      const activities = []
      
      for (const event of events) {
        if (!event || typeof event !== 'object') continue

        let dateDisplay = '时间未知'
        if (event.start && event.start.dateTime && event.end && event.end.dateTime) {
          try {
            const startDate = new Date(event.start.dateTime)
            const endDate = new Date(event.end.dateTime)
            
            dateDisplay = `${startDate.toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit'
            })} - ${endDate.toLocaleString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit'
            })}`
          } catch (e) {
            dateDisplay = `${event.start.dateTime} - ${event.end.dateTime}`
          }
        }

        const activity = {
          date: dateDisplay,
          title: event.summary || '未命名活动',
          description: event.description || '',
          link: event.htmlLink || '',
          organizer: event.organizer?.displayName || '',
          status: event.status || '',
          created: event.created || '',
          updated: event.updated || ''
        }

        if (activity.title && activity.title !== '未命名活动') {
          activity.originalTitle = activity.title
          activity.translatedDescription = await translateText(activity.title)
        }

        activities.push(activity)
      }

      const validActivities = activities.filter(a => 
        a.title && 
        a.title !== '未命名活动' &&
        a.status === 'confirmed' &&
        !a.title.includes('祝日') &&
        !a.title.includes('休日') &&
        !a.title.includes('日历') &&
        !a.title.includes('カレンダー') &&
        !a.title.includes('定例') &&
        !a.title.includes('定期')
      )

      ctx.logger('vrc-activity').info(`有效日本活动数量: ${validActivities.length}`)
      
      if (validActivities.length > 0) {
        ctx.logger('vrc-activity').info('前3个日本活动:')
        validActivities.slice(0, 3).forEach((a, i) => {
          ctx.logger('vrc-activity').info(`#${i + 1} ${a.date} | ${a.title}`)
          if (a.organizer) {
            ctx.logger('vrc-activity').info(`   组织者: ${a.organizer}`)
          }
        })
      }

      return validActivities

    } catch (error) {
      ctx.logger('vrc-activity').error('Google Calendar API 获取日本活动失败:', error.message)
      
      ctx.logger('vrc-activity').info('尝试使用网页抓取作为备选方案...')
      return await fetchFromWebpage('https://vrceve.com/')
    }
  }

  async function fetchChinaActivities() {
    try {
      ctx.logger('vrc-activity').info('正在通过 API 获取中国活动数据')
      
      const response = await ctx.http.get('https://api.rlvrc.cn/calendar/vrc/get/events/v1', {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      })

      ctx.logger('vrc-activity').info(`API 响应状态: ${response ? '成功' : '无数据'}`)
      
      if (!response) {
        ctx.logger('vrc-activity').warn('API 返回空数据')
        return []
      }

      let events = []
      if (response.Activity && Array.isArray(response.Activity)) {
        events = response.Activity
        ctx.logger('vrc-activity').info(`从 Activity 字段获取到 ${events.length} 个活动`)
      } else if (Array.isArray(response)) {
        events = response
        ctx.logger('vrc-activity').info('API 直接返回数组格式')
      } else {
        ctx.logger('vrc-activity').warn('无法识别的 API 响应格式')
        return []
      }

      const activities = events.map(event => {
        if (!event || typeof event !== 'object') {
          return null
        }

        let dateDisplay = '时间未知'
        if (event.starttime && event.endtime) {
          dateDisplay = `${event.starttime} - ${event.endtime}`
        } else if (event.time) {
          dateDisplay = event.time
        } else if (event.startdate && event.enddate) {
          dateDisplay = `${event.startdate} - ${event.enddate}`
        } else if (event.date) {
          dateDisplay = event.date
        }

        const activity = {
          date: dateDisplay,
          title: event.title || '未命名活动',
          description: event.brief || event.detail || event.tag || '',
          link: '',
          initiator: event.initiator || '',
          type: event.type || ''
        }

        return activity
      }).filter(activity => activity !== null)

      const validActivities = activities.filter(a => 
        a.title && 
        a.title !== '未命名活动' &&
        !a.title.includes('测试') &&
        !a.title.includes('Test') &&
        a.date !== '时间未知'
      )

      ctx.logger('vrc-activity').info(`有效活动数量: ${validActivities.length}`)
      
      if (validActivities.length > 0) {
        ctx.logger('vrc-activity').info('前3个有效活动:')
        validActivities.slice(0, 3).forEach((a, i) => {
          ctx.logger('vrc-activity').info(`#${i + 1} ${a.date} | ${a.title}`)
          if (a.initiator) {
            ctx.logger('vrc-activity').info(`   发起人: ${a.initiator}`)
          }
          if (a.type) {
            ctx.logger('vrc-activity').info(`   类型: ${a.type}`)
          }
        })
      } else {
        ctx.logger('vrc-activity').warn('没有找到有效活动')
        if (activities.length > 0) {
          ctx.logger('vrc-activity').info('被过滤的活动:')
          activities.slice(0, 3).forEach((a, i) => {
            ctx.logger('vrc-activity').info(`#${i + 1} ${a.date} | ${a.title} | 发起人: ${a.initiator || '无'}`)
          })
        }
      }

      return validActivities

    } catch (error) {
      ctx.logger('vrc-activity').error('API 获取中国活动失败:', error.message)
      
      ctx.logger('vrc-activity').info('尝试使用网页抓取作为备选方案...')
      try {
        return await fetchFromWebpage('https://rlvrc.cn/event-showcase')
      } catch (fallbackError) {
        ctx.logger('vrc-activity').error('备选方案也失败:', fallbackError.message)
        return []
      }
    }
  }

  async function fetchFromWebpage(url) {
    let page = null
    try {
      page = await ctx.puppeteer.page()
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36')
      await page.setDefaultNavigationTimeout(60000)

      ctx.logger('vrc-activity').info(`正在加载活动页面: ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForSelector('body', { timeout: 15000 })
      await new Promise(r => setTimeout(r, config.scrapeDelay))

      if (url.includes('rlvrc.cn')) {
        try {
          await page.waitForSelector('.event-card', { timeout: 20000 })
          
          const activities = await page.evaluate(() => {
            const results = []
            const eventCards = document.querySelectorAll('.event-card')
            
            eventCards.forEach(card => {
              const titleElement = card.querySelector('.card-title')
              const timeElement = card.querySelector('.card-time')
              const descElement = card.querySelector('.card-description')
              
              const title = titleElement ? titleElement.textContent.trim() : '未命名活动'
              const time = timeElement ? timeElement.textContent.trim() : '时间未知'
              const description = descElement ? descElement.textContent.trim() : ''
              
              results.push({
                date: time,
                title,
                description,
                link: ''
              })
            })
            
            return results
          })
          
          ctx.logger('vrc-activity').info(`从 iframe 提取到 ${activities.length} 个活动`)

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
          if (filtered.length > 0) {
            ctx.logger('vrc-activity').info('示例活动（已过滤）:')
            filtered.slice(0, 3).forEach((a, i) => {
              ctx.logger('vrc-activity').info(`#${i + 1} ${a.date} | ${a.title}`)
            })
          }

          return filtered

        } catch (err) {
          ctx.logger('vrc-activity').warn('解析 RLVRC 活动失败:', err.message)
          return []
        }
      } else {
        const iframes = await page.$$('iframe')
        ctx.logger('vrc-activity').info(`发现 ${iframes.length} 个iframe，尝试提取内容`)

        for (const iframe of iframes) {
          const frame = await iframe.contentFrame()
          if (!frame) continue

          const frameUrl = frame.url()
          ctx.logger('vrc-activity').info(`检查 iframe: ${frameUrl}`)
          if (!frameUrl.includes('calendar.google.com')) continue

          try {
            await Promise.race([
              frame.waitForSelector('[data-eventchip]', { timeout: 20000 }).catch(() => null),
              frame.waitForSelector('.chip', { timeout: 20000 }).catch(() => null),
              frame.waitForSelector('.event-summary', { timeout: 20000 }).catch(() => null)
            ])

            ctx.logger('vrc-activity').info('在 Google Calendar iframe 中检测到活动元素')

            const activities = await frame.evaluate(() => {
              const results = []

              document.querySelectorAll('[data-eventchip], .chip').forEach(el => {
                const text = el.textContent.trim()
                if (!text || text.length < 5) return

                let date = text.match(/(\d{1,2}):(\d{2})\s?-\s?(\d{1,2}):(\d{2})/)
                date = date ? date[0] : '日期未知'
                let title = text.replace(date, '').trim()

                results.push({
                  date,
                  title,
                  description: text,
                  link: ''
                })
              })

              document.querySelectorAll('tr.event-summary').forEach(row => {
                const title = row.querySelector('td.event-summary')?.textContent.trim() || '未命名活动'
                const time = row.querySelector('td.event-time')?.textContent.trim() || '时间未知'
                const desc = row.textContent.trim()

                results.push({
                  date: time,
                  title,
                  description: desc,
                  link: ''
                })
              })

              return results
            })

            ctx.logger('vrc-activity').info(`从 iframe 提取到 ${activities.length} 个活动`)
            if (activities.length > 0) {
              ctx.logger('vrc-activity').info('示例活动:')
              activities.slice(0, 3).forEach((a, i) => {
                ctx.logger('vrc-activity').info(`#${i + 1} ${a.date} | ${a.title}`)
              })
            }
            return activities
          } catch (err) {
            ctx.logger('vrc-activity').warn('解析 iframe 活动失败:', err.message)
          }
        }
      }

      ctx.logger('vrc-activity').warn('未在任何 iframe 中找到活动')
      return []
    } catch (error) {
      ctx.logger('vrc-activity').error('网页解析失败:', error.message)
      return []
    } finally {
      if (page) await page.close().catch(() => {})
    }
  }

  function getCurrentOrNearbyActivities(activities) {
    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    function parseTimeRange(range) {
      const dateTimeMatch = range.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\s*-\s*(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/)
      if (dateTimeMatch) {
        const [, startYear, startMonth, startDay, startHour, startMinute, 
               endYear, endMonth, endDay, endHour, endMinute] = dateTimeMatch.map(Number)
        
        const startDate = new Date(startYear, startMonth - 1, startDay, startHour, startMinute)
        const endDate = new Date(endYear, endMonth - 1, endDay, endHour, endMinute)
        const nowDate = new Date()
        
        if (endDate < nowDate) return null
        
        if (startDate <= nowDate && endDate >= nowDate) {
          return { start: 0, end: 1440 }
        }
        
        const startTotalMinutes = startHour * 60 + startMinute
        return { start: startTotalMinutes, end: startTotalMinutes + 1440 }
      }
      
      const match = range.match(/(\d{1,2}):(\d{2})\s?-\s?(\d{1,2}):(\d{2})/)
      if (!match) return null
      let [ , sh, sm, eh, em ] = match.map(Number)
      const start = sh * 60 + sm
      let end = eh * 60 + em
      if (end <= start) end += 24 * 60
      return { start, end }
    }

    const ongoing = activities.filter(a => {
      const range = parseTimeRange(a.date)
      if (!range) return false
      
      if (a.date.includes('-') && a.date.includes(':') && (a.date.match(/-/g) || []).length >= 2) {
        const parts = a.date.split(' - ')
        if (parts.length === 2) {
          const endDateStr = parts[1]
          const endDate = new Date(endDateStr.replace(' ', 'T'))
          const startDateStr = parts[0]
          const startDate = new Date(startDateStr.replace(' ', 'T'))
          const nowDate = new Date()
          
          return startDate <= nowDate && endDate >= nowDate
        }
        return false
      }
      
      return currentMinutes >= range.start && currentMinutes <= range.end
    })

    if (ongoing.length > 0) {
      return ongoing.map(a => ({ ...a, tag: '当前活动' }))
    }

    const future = activities.filter(a => {
      const range = parseTimeRange(a.date)
      if (!range) return false
      
      if (a.date.includes('-') && a.date.includes(':') && (a.date.match(/-/g) || []).length >= 2) {
        const parts = a.date.split(' - ')
        if (parts.length === 2) {
          const startDateStr = parts[0]
          const startDate = new Date(startDateStr.replace(' ', 'T'))
          const nowDate = new Date()
          return startDate > nowDate
        }
        return false
      }
      
      return range.start > currentMinutes
    }).sort((a, b) => {
      if (a.date.includes('-') && a.date.includes(':') && (a.date.match(/-/g) || []).length >= 2) {
        const aParts = a.date.split(' - ')[0]
        const bParts = b.date.split(' - ')[0]
        const aDate = new Date(aParts.replace(' ', 'T'))
        const bDate = new Date(bParts.replace(' ', 'T'))
        return aDate - bDate
      }
      
      const aRange = parseTimeRange(a.date)
      const bRange = parseTimeRange(b.date)
      return aRange.start - bRange.start
    })

    const past = activities.filter(a => {
      const range = parseTimeRange(a.date)
      if (!range) return false
      
      if (a.date.includes('-') && a.date.includes(':') && (a.date.match(/-/g) || []).length >= 2) {
        const parts = a.date.split(' - ')
        if (parts.length === 2) {
          const endDateStr = parts[1]
          const endDate = new Date(endDateStr.replace(' ', 'T'))
          const nowDate = new Date()
          return endDate < nowDate
        }
        return false
      }
      
      return range.end < currentMinutes
    })

    const last = past[past.length - 1]
    const next = future[0]

    const result = []
    if (last) result.push({ ...last, tag: '上一个活动' })
    if (next) result.push({ ...next, tag: '下一个活动' })
    
    if (result.length === 0 && activities.length > 0) {
      if (future.length > 0) {
        return future.slice(0, config.maxActivities).map(a => ({ ...a, tag: '即将到来' }))
      } else if (activities.length > 0) {
        return activities.slice(0, config.maxActivities).map(a => ({ ...a, tag: '活动列表' }))
      }
    }
    
    return result
  }

  async function generateCalendarImage(activities, lastUpdateTime, title, region = 'china') {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const day = now.getDate()
    const firstDay = new Date(year, month - 1, 1).getDay()
    const daysInMonth = new Date(year, month, 0).getDate()

    let displayActivities = getCurrentOrNearbyActivities(activities)
    if (displayActivities.length === 0) {
      displayActivities = [{
        date: new Date().toLocaleDateString('zh-CN'),
        title: '暂无活动',
        description: '请稍后重试或访问官网',
        link: '',
        tag: '提示'
      }]
    }
    const limitedActivities = displayActivities.slice(0, config.maxActivities)
    
    function getImageSizeByActivityCount(activities) {
      if (activities.length <= 1) {
        return { width: 920, height: 540 }
      } else if (activities.length > 3) {
        return calculateAdaptiveSizeFromText(activities)
      } else {
        return { width: 920, height: 600 }
      }
    }
    
    function calculateAdaptiveSizeFromText(activities) {
      const combinedText = activities.map(activity => 
        `${activity.title || ''} ${activity.description || ''}`
      ).join(' ')
      
      const textLength = combinedText.length
      const baseWidth = 920
      const baseHeight = 540
      
      const scaleFactor = Math.min(Math.ceil(textLength / 800), 4)
      return {
        width: baseWidth,
        height: baseHeight + (scaleFactor * 100)
      }
    }
    
    const imageSize = getImageSizeByActivityCount(limitedActivities)
    
    const bgEnabled = config.background?.enabled
    const bgUrl = region === 'china' ? config.background?.china : config.background?.japan
    const bgOpacity = config.background?.opacity || 0.1
    const cardOpacity = config.background?.cardOpacity !== undefined ? config.background.cardOpacity : 0.95
    
    let backgroundStyle = ''
    if (bgEnabled && bgUrl) {
      let backgroundUrl = bgUrl
      if (!bgUrl.startsWith('http') && !bgUrl.startsWith('file://')) {
        backgroundUrl = `file://${path.resolve(bgUrl)}`
      }
      backgroundStyle = `
        body {
          margin: 0;
          padding: 20px;
          width: ${imageSize.width}px;
          height: ${imageSize.height}px;
          background: #f0f2f5;
          font-family: 'Microsoft YaHei', sans-serif;
          position: relative;
          overflow: hidden;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .background-container {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-image: url('${backgroundUrl}');
          background-size: cover;
          background-position: center;
          background-repeat: no-repeat;
          opacity: ${bgOpacity};
          z-index: 0;
          pointer-events: none;
        }
        .content-wrapper {
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
        }
      `
    } else {
      backgroundStyle = `
        body {
          margin: 0;
          padding: 20px;
          width: ${imageSize.width}px;
          height: ${imageSize.height}px;
          background: #f0f2f5;
          font-family: 'Microsoft YaHei', sans-serif;
          overflow: hidden;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .content-wrapper {
          width: 100%;
          height: 100%;
        }
      `
    }
    
    const sponsorHtml = title.includes('中国') ? `
      <div class="sponsor">
        本活动由<span class="sponsor-highlight">咕咕日记</span>提供
        <a href="https://rlvrc.cn" class="sponsor-link">https://rlvrc.cn</a>
      </div>
    ` : ''
    
    const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VRChat活动日历</title>
  <style>
    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box; 
    }
    
    ${backgroundStyle}
    
    .container { 
      width: 100%; 
      max-width: ${imageSize.width - 40}px; 
      background: rgba(255, 255, 255, ${cardOpacity}); 
      border-radius: 12px; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.1); 
      overflow: hidden; 
      position: relative; 
      margin: 0 auto;
    }
    .calendar-side { 
      width: 100%; 
      max-width: 300px; 
      background: linear-gradient(135deg, #3498db, #2980b9); 
      color: white; 
      padding: 20px; 
      float: left; 
      min-height: ${imageSize.height - 40}px; 
      position: relative; 
      z-index: 1; 
    }
    .weekdays { 
      display: grid; 
      grid-template-columns: repeat(7, 1fr); 
      gap: 5px; 
      margin-bottom: 10px; 
    }
    .weekday { 
      text-align: center; 
      font-size: 12px; 
      font-weight: bold; 
    }
    .sunday { 
      color: #e74c3c; 
    }
    .days { 
      display: grid; 
      grid-template-columns: repeat(7, 1fr); 
      gap: 5px; 
    }
    .day { 
      text-align: center; 
      padding: 8px; 
      font-size: 14px; 
    }
    .day.today { 
      background: #e74c3c; 
      border-radius: 50%; 
      color: white; 
      font-weight: bold; 
    }
    .activities-side { 
      margin-left: 300px; 
      padding: 20px; 
      max-height: ${imageSize.height - 80}px; 
      overflow-y: auto; 
      position: relative; 
      z-index: 1; 
    }
    .activities-title { 
      color: #2c3e50; 
      font-size: 20px; 
      font-weight: bold; 
      margin-bottom: 15px; 
    }
    .divider { 
      height: 2px; 
      background: #ecf0f1; 
      margin-bottom: 20px; 
    }
    .activity { 
      background: rgba(248, 249, 250, ${Math.min(cardOpacity + 0.1, 1)}); 
      border-radius: 8px; 
      padding: 15px; 
      margin-bottom: 15px; 
      border-left: 4px solid #3498db; 
    }
    .activity-date { 
      color: #e74c3c; 
      font-size: 14px; 
      font-weight: bold; 
      margin-bottom: 5px; 
    }
    .activity-title { 
      color: #2c3e50; 
      font-size: 16px; 
      font-weight: bold; 
      margin-bottom: 8px; 
    }
    .activity-desc { 
      color: #7f8c8d; 
      font-size: 14px; 
      line-height: 1.4; 
    }
    .update-time { 
      text-align: right; 
      color: #bdc3c7; 
      font-size: 12px; 
      margin-top: 20px; 
    }
    .sponsor { 
      background: linear-gradient(135deg, rgba(255, 107, 107, ${cardOpacity}), rgba(238, 90, 36, ${cardOpacity})); 
      color: white; 
      padding: 10px 15px; 
      border-radius: 8px; 
      margin-bottom: 15px; 
      font-size: 14px; 
      text-align: center;
      box-shadow: 0 2px 8px rgba(238, 90, 36, 0.3);
      backdrop-filter: brightness(${cardOpacity > 0.8 ? 1 : 1 + (1 - cardOpacity)});
    }
    .sponsor-highlight { 
      font-weight: bold; 
      color: #fff; 
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      margin: 0 5px;
    }
    .sponsor-link { 
      color: #ffeaa7; 
      text-decoration: none; 
      margin-left: 8px;
      font-weight: bold;
    }
    .sponsor-link:hover { 
      text-decoration: underline; 
    }
    
    /* 确保文本内容保持清晰可读 */
    .calendar-side *,
    .activities-side *,
    .activity *,
    .sponsor * {
      opacity: 1 !important;
    }
  </style>
</head>
<body>
  ${bgEnabled && bgUrl ? '<div class="background-container"></div>' : ''}
  <div class="content-wrapper">
    <div class="container">
      <div class="calendar-side">
        <div class="month">${month}月</div>
        <div class="year">${year}年</div>
        <div class="weekdays">
          <div class="weekday sunday">日</div>
          <div class="weekday">一</div>
          <div class="weekday">二</div>
          <div class="weekday">三</div>
          <div class="weekday">四</div>
          <div class="weekday">五</div>
          <div class="weekday">六</div>
        </div>
        <div class="days">
          ${Array(firstDay).fill('<div class="day"></div>').join('')}
          ${Array.from({ length: daysInMonth }, (_, i) => {
            const date = i + 1
            return `<div class="day${date === day ? ' today' : ''}">${date}</div>`
          }).join('')}
        </div>
        <div style="margin-top: 20px; font-size: 12px;">共 ${activities.length} 个活动</div>
      </div>
      <div class="activities-side">
        <div class="activities-title">${title}</div>
        ${sponsorHtml}
        <div class="divider"></div>
        ${limitedActivities.map(a => `
          <div class="activity">
            <div class="activity-date">${a.date} ${a.tag ? '(' + a.tag + ')' : ''}</div>
            <div class="activity-title">${a.originalTitle || a.title}</div>
            ${a.translatedDescription && a.translatedDescription !== (a.originalTitle || a.title) ? `<div class="activity-desc">${a.translatedDescription}</div>` : ''}
          </div>`).join('')}
        <div class="update-time">
          最后更新: ${lastUpdateTime ? lastUpdateTime.toLocaleString('zh-CN') : '刚刚'}
        </div>
      </div>
    </div>
  </div>
</body>
</html>`

    const page = await ctx.puppeteer.page()
    await page.setViewport({ width: imageSize.width, height: imageSize.height })
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' })
    const screenshot = await page.screenshot({ type: 'png' })
    await page.close()
    return screenshot
  }

  async function updateJapanActivities() {
    try {
      const newActivities = await fetchJapanActivities()
      if (newActivities.length > 0) {
        japanActivities = newActivities
      } else {
        ctx.logger('vrc-activity').warn('抓取到 0 个日本活动，保留上次数据')
      }
      japanLastUpdateTime = new Date()
      japanCachedImageBuffer = await generateCalendarImage(japanActivities, japanLastUpdateTime, 'VRChat 日本活动日历', 'japan').catch((error) => {
        ctx.logger('vrc-activity').error('生成日本活动日历图片失败:', error.message)
        return null
      })
    } catch (error) {
      ctx.logger('vrc-activity').error('更新日本活动失败:', error.message)
    }
  }

  async function updateChinaActivities() {
    try {
      const newActivities = await fetchChinaActivities()
      if (newActivities.length > 0) {
        chinaActivities = newActivities
      } else {
        ctx.logger('vrc-activity').warn('抓取到 0 个中国活动，保留上次数据')
      }
      chinaLastUpdateTime = new Date()
      chinaCachedImageBuffer = await generateCalendarImage(chinaActivities, chinaLastUpdateTime, 'VRChat 中国活动日历', 'china').catch((error) => {
        ctx.logger('vrc-activity').error('生成中国活动日历图片失败:', error.message)
        return null
      })
    } catch (error) {
      ctx.logger('vrc-activity').error('更新中国活动失败:', error.message)
    }
  }

  if (config.autoPush?.japan?.enabled) {
    ctx.setInterval(async () => {
      try {
        await updateJapanActivities()
        ctx.logger('vrc-activity').info('日本活动数据自动更新成功')
        if (japanCachedImageBuffer && config.autoPush.japan.target) {
          for (const bot of ctx.bots) {
            try {
              await bot.sendMessage(config.autoPush.japan.target, segment.image(
                `data:image/png;base64,${japanCachedImageBuffer.toString('base64')}`
              ))
            } catch (e) {
              ctx.logger('vrc-activity').warn(`日本活动推送失败: ${e.message}`)
            }
          }
        }
      } catch (error) {
        ctx.logger('vrc-activity').error('日本活动数据自动更新失败:', error.message)
      }
    }, config.autoPush.japan.interval * 60 * 1000)
  }

  if (config.autoPush?.china?.enabled) {
    ctx.setInterval(async () => {
      try {
        await updateChinaActivities()
        ctx.logger('vrc-activity').info('中国活动数据自动更新成功')
        if (chinaCachedImageBuffer && config.autoPush.china.target) {
          for (const bot of ctx.bots) {
            try {
              await bot.sendMessage(config.autoPush.china.target, segment.image(
                `data:image/png;base64,${chinaCachedImageBuffer.toString('base64')}`
              ))
            } catch (e) {
              ctx.logger('vrc-activity').warn(`中国活动推送失败: ${e.message}`)
            }
          }
        }
      } catch (error) {
        ctx.logger('vrc-activity').error('中国活动数据自动更新失败:', error.message)
      }
    }, config.autoPush.china.interval * 60 * 1000)
  }

  updateJapanActivities().catch(error => {
    ctx.logger('vrc-activity').error('初始日本活动数据加载失败:', error.message)
  })

  updateChinaActivities().catch(error => {
    ctx.logger('vrc-activity').error('初始中国活动数据加载失败:', error.message)
  })

  ctx.command('vrc活动刷新', 'VRChat活动日历')
    .alias('活动刷新')
    .alias('vrc活动')
    .alias('VRC活动')
    .action(async ({ session }) => {
      try {
        await session.send('正在获取所有活动信息...')
        await updateJapanActivities()
        await updateChinaActivities()

        let result = ''
        if (japanCachedImageBuffer) {
          result += '日本活动:\n' + segment.image(`data:image/png;base64,${japanCachedImageBuffer.toString('base64')}`) + '\n'
        } else if (japanActivities && japanActivities.length > 0) {
          result += '日本活动 (文本格式):\n'
          japanActivities.slice(0, config.maxActivities).forEach((activity, index) => {
            result += `${index + 1}. ${activity.date}\n   ${activity.title}\n   ${activity.description || ''}\n\n`
          })
          result += '\n'
        }
        
        if (chinaCachedImageBuffer) {
          result += '中国活动:\n' + segment.image(`data:image/png;base64,${chinaCachedImageBuffer.toString('base64')}`)
        } else if (chinaActivities && chinaActivities.length > 0) {
          result += '中国活动 (文本格式):\n'
          chinaActivities.slice(0, config.maxActivities).forEach((activity, index) => {
            result += `${index + 1}. ${activity.date}\n   ${activity.title}\n   ${activity.description || ''}\n\n`
          })
        }
        
        return result || '暂无活动数据，请稍后重试'
      } catch (error) {
        ctx.logger('vrc-activity').error('命令执行失败:', error.message)
        return '获取活动信息失败，请稍后重试'
      }
    })

  ctx.command('vrc活动日本', '获取日本VRChat活动信息')
    .alias('活动日本')
    .action(async ({ session }) => {
      try {
        await session.send('正在获取日本活动信息...')
        await updateJapanActivities()

        if (japanCachedImageBuffer) {
          return segment.image(`data:image/png;base64,${japanCachedImageBuffer.toString('base64')}`)
        } else {
          ctx.logger('vrc-activity').warn('日本活动图片缓存为空')
          if (japanActivities && japanActivities.length > 0) {
            let textResult = 'VRChat 日本活动信息:\n'
            japanActivities.slice(0, config.maxActivities).forEach((activity, index) => {
              textResult += `${index + 1}. ${activity.date}\n   ${activity.title}\n   ${activity.description || ''}\n\n`
            })
            textResult += `最后更新: ${japanLastUpdateTime ? japanLastUpdateTime.toLocaleString('zh-CN') : '刚刚'}`
            return textResult
          }
          return '暂无日本活动数据，请稍后重试'
        }
      } catch (error) {
        ctx.logger('vrc-activity').error('获取日本活动失败:', error.message)
        return '获取日本活动信息失败，请稍后重试'
      }
    })

  ctx.command('vrc活动中国', '获取中国VRChat活动信息')
    .alias('活动中国')
    .action(async ({ session }) => {
      try {
        await session.send('正在获取中国活动信息...')
        await updateChinaActivities()

        if (chinaCachedImageBuffer) {
          return segment.image(`data:image/png;base64,${chinaCachedImageBuffer.toString('base64')}`)
        } else {
          ctx.logger('vrc-activity').warn('中国活动图片缓存为空')
          if (chinaActivities && chinaActivities.length > 0) {
            let textResult = 'VRChat 中国活动信息:\n'
            chinaActivities.slice(0, config.maxActivities).forEach((activity, index) => {
              textResult += `${index + 1}. ${activity.date}\n   ${activity.title}\n   ${activity.description || ''}\n\n`
            })
            textResult += `最后更新: ${chinaLastUpdateTime ? chinaLastUpdateTime.toLocaleString('zh-CN') : '刚刚'}`
            return textResult
          }
          return '暂无中国活动数据，请稍后重试'
        }
      } catch (error) {
        ctx.logger('vrc-activity').error('获取中国活动失败:', error.message)
        return '获取中国活动信息失败，请稍后重试'
      }
    })
}
