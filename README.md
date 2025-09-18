# koishi-plugin-vrchateventcalendar

[![npm](https://img.shields.io/npm/v/koishi-plugin-vrchateventcalendar)](https://www.npmjs.com/package/koishi-plugin-vrchateventcalendar)
[![npm](https://www.npmjs.com/package/koishi-plugin-vrchateventcalendar)](https://www.npmjs.com/package/koishi-plugin-vrchateventcalendar)

获取 VRChat 活动日历并推送给用户

## 功能介绍

这是一个用于 Koishi 机器人框架的插件，可以自动抓取 VRChat 活动信息并以美观的日历形式展示。主要功能包括：

- 自动抓取 VRChat 官方活动日历信息
- 生成带日历的活动信息图片
- 支持手动和自动推送活动信息
- 显示当前、上一个和下一个活动信息

## 安装

在 Koishi 控制台中搜索 `vrchateventcalendar` 或使用以下命令安装：


> 注意：该插件依赖 `puppeteer` 插件，请确保已安装并启用。

## 配置说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| updateInterval | number | 30 | 自动更新间隔(分钟) |
| maxActivities | number | 10 | 最多显示活动数量 |
| websiteUrl | string | https://vrceve.com/ | 目标网站URL |
| scrapeDelay | number | 5000 | 网页加载后等待时间(毫秒) |
| autoPush | boolean | false | 是否启用自动推送 |
| autoPushInterval | number | 60 | 自动推送间隔(分钟) |
| autoPushTarget | string | '' | 自动推送目标 |

## 使用方法

### 命令

插件提供以下命令：

- `vrchat活动刷新` / `活动刷新` / `vrchat活动` / `VRChat活动` - 手动获取并发送最新的活动信息

### 自动推送

启用自动推送功能后，插件会按照设定的时间间隔自动将活动信息推送到指定的目标（如群组或私聊）。

## 工作原理

1. 插件使用 Puppeteer 访问配置的网站（默认为 https://vrceve.com/）
2. 解析页面中的 Google Calendar iframe
3. 提取活动信息并缓存
4. 根据当前时间确定当前活动、上一个活动和下一个活动
5. 生成包含日历和活动信息的图片
6. 可以手动或自动将图片推送给用户

## 注意事项

- 首次运行时可能需要较长时间加载，因为需要安装 Puppeteer 的浏览器组件
- 插件依赖网络访问，确保服务器可以正常访问配置的网站
- 生成图片需要一定性能，低配置服务器可能需要较长时间
