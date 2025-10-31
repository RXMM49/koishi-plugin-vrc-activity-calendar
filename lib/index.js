const { Context, Schema, segment } = require('koishi')
const { promises: fs } = require('fs')
const path = require('path')

exports.name = 'vrc-activity-calendar'
exports.using = ['puppeteer']

exports.schema = Schema.object({
  updateInterval: Schema.number().default(30).description('自动更新间隔(分钟)'),
  maxActivities: Schema.number().default(10).description('最多显示活动数量'),
  scrapeDelay: Schema.number().default(5000).description('网页加载后等待时间(毫秒)'),
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

  async function fetchJapanActivities() {
    return await fetchFromWebpage('https://vrceve.com/')
  }

  async function fetchChinaActivities() {
    return await fetchFromWebpage('https://rlvrc.cn/event-showcase')
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
          
          ctx.logger('vrc-activity').info(`从 RLVRC 提取到 ${activities.length} 个活动`)
          if (activities.length > 0) {
            ctx.logger('vrc-activity').info('示例活动:')
            activities.slice(0, 3).forEach((a, i) => {
              ctx.logger('vrc-activity').info(`#${i + 1} ${a.date} | ${a.title}`)
            })
          }
          return activities
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
               endYear, endMonth, endDay, endHour, endMinute] = dateTimeMatch.map(Number);
        
        const startDate = new Date(startYear, startMonth - 1, startDay, startHour, startMinute);
        const endDate = new Date(endYear, endMonth - 1, endDay, endHour, endMinute);
        const nowDate = new Date();
        
        if (endDate < nowDate) return null;
        
        if (startDate <= nowDate && endDate >= nowDate) {
          return { start: 0, end: 1440 };
        }
        
        const startTotalMinutes = startHour * 60 + startMinute;
        return { start: startTotalMinutes, end: startTotalMinutes + 1440 };
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
        const parts = a.date.split(' - ');
        if (parts.length === 2) {
          const endDateStr = parts[1];
          const endDate = new Date(endDateStr.replace(' ', 'T'));
          const startDateStr = parts[0];
          const startDate = new Date(startDateStr.replace(' ', 'T'));
          const nowDate = new Date();
          
          return startDate <= nowDate && endDate >= nowDate;
        }
        return false;
      }
      
      return currentMinutes >= range.start && currentMinutes <= range.end
    })

    if (ongoing.length > 0) {
      return ongoing.map(a => ({ ...a, tag: '当前活动' }))
    }

    const future = activities.filter(a => {
      const range = parseTimeRange(a.date);
      if (!range) return false;
      
      if (a.date.includes('-') && a.date.includes(':') && (a.date.match(/-/g) || []).length >= 2) {
        const parts = a.date.split(' - ');
        if (parts.length === 2) {
          const startDateStr = parts[0];
          const startDate = new Date(startDateStr.replace(' ', 'T'));
          const nowDate = new Date();
          return startDate > nowDate;
        }
        return false;
      }
      
      return range.start > currentMinutes;
    }).sort((a, b) => {
      if (a.date.includes('-') && a.date.includes(':') && (a.date.match(/-/g) || []).length >= 2) {
        const aParts = a.date.split(' - ')[0];
        const bParts = b.date.split(' - ')[0];
        const aDate = new Date(aParts.replace(' ', 'T'));
        const bDate = new Date(bParts.replace(' ', 'T'));
        return aDate - bDate;
      }
      
      const aRange = parseTimeRange(a.date);
      const bRange = parseTimeRange(b.date);
      return aRange.start - bRange.start;
    });

    const past = activities.filter(a => {
      const range = parseTimeRange(a.date);
      if (!range) return false;
      
      if (a.date.includes('-') && a.date.includes(':') && (a.date.match(/-/g) || []).length >= 2) {
        const parts = a.date.split(' - ');
        if (parts.length === 2) {
          const endDateStr = parts[1];
          const endDate = new Date(endDateStr.replace(' ', 'T'));
          const nowDate = new Date();
          return endDate < nowDate;
        }
        return false;
      }
      
      return range.end < currentMinutes;
    });

    const last = past[past.length - 1]
    const next = future[0]

    const result = []
    if (last) result.push({ ...last, tag: '上一个活动' })
    if (next) result.push({ ...next, tag: '下一个活动' })
    
    if (result.length === 0 && activities.length > 0) {
      if (future.length > 0) {
        return future.slice(0, config.maxActivities).map(a => ({ ...a, tag: '即将到来' }));
      } else if (activities.length > 0) {
        return activities.slice(0, config.maxActivities).map(a => ({ ...a, tag: '活动列表' }));
      }
    }
    
    return result
  }

  async function generateCalendarImage(activities, lastUpdateTime, title) {
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
    
    const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VRChat活动日历</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { padding: 20px; background: #f0f2f5; font-family: 'Microsoft YaHei', sans-serif; }
    .container { width: 100%; max-width: 900px; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; }
    .calendar-side { width: 100%; max-width: 300px; background: linear-gradient(135deg, #3498db, #2980b9); color: white; padding: 20px; float: left; min-height: 500px; }
    .weekdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-bottom: 10px; }
    .weekday { text-align: center; font-size: 12px; font-weight: bold; }
    .sunday { color: #e74c3c; }
    .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
    .day { text-align: center; padding: 8px; font-size: 14px; }
    .day.today { background: #e74c3c; border-radius: 50%; color: white; font-weight: bold; }
    .activities-side { margin-left: 300px; padding: 20px; max-height: 500px; overflow-y: auto; }
    .activities-title { color: #2c3e50; font-size: 20px; font-weight: bold; margin-bottom: 15px; }
    .divider { height: 2px; background: #ecf0f1; margin-bottom: 20px; }
    .activity { background: #f8f9fa; border-radius: 8px; padding: 15px; margin-bottom: 15px; border-left: 4px solid #3498db; }
    .activity-date { color: #e74c3c; font-size: 14px; font-weight: bold; margin-bottom: 5px; }
    .activity-title { color: #2c3e50; font-size: 16px; font-weight: bold; margin-bottom: 8px; }
    .activity-desc { color: #7f8c8d; font-size: 14px; line-height: 1.4; }
    .update-time { text-align: right; color: #bdc3c7; font-size: 12px; margin-top: 20px; }
  </style>
</head>
<body>
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
      <div class="divider"></div>
      ${limitedActivities.map(a => `
        <div class="activity">
          <div class="activity-date">${a.date} ${a.tag ? '(' + a.tag + ')' : ''}</div>
          <div class="activity-title">${a.title}</div>
          <div class="activity-desc">${a.description}</div>
        </div>`).join('')}
      <div class="update-time">
        最后更新: ${lastUpdateTime ? lastUpdateTime.toLocaleString('zh-CN') : '刚刚'}
      </div>
    </div>
  </div>
</body>
</html>`

    const page = await ctx.puppeteer.page()
    await page.setViewport({ width: 920, height: 540 })
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
      japanCachedImageBuffer = await generateCalendarImage(japanActivities, japanLastUpdateTime, 'VRChat 日本活动日历').catch((error) => {
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
      chinaCachedImageBuffer = await generateCalendarImage(chinaActivities, chinaLastUpdateTime, 'VRChat 中国活动日历').catch((error) => {
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
