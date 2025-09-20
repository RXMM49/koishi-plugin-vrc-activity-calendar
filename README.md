# koishi-plugin-vrc-activity-calendar

[![npm](https://img.shields.io/npm/v/koishi-plugin-vrc-activity-calendar)](https://www.npmjs.com/package/koishi-plugin-vrc-activity-calendar)
[![github](https://img.shields.io/github/license/mashape/apistatus.svg)](https://github.com/mashape/apistatus.svg)

获取 VRChat 活动日历并推送给用户

## 支持的活动日历

- 日本
- 中国
- 其余国家待更新中......

## 功能介绍

这是一个用于 Koishi 机器人框架的插件，可以自动抓取 VRChat 活动信息并以美观的日历形式展示。主要功能包括：

- 自动抓取 VRChat 官方活动日历信息
- 生成带日历的活动信息图片
- 支持手动和自动推送活动信息
- 显示当前、上一个和下一个活动信息

## 安装

在 Koishi 控制台中搜索 `vrc-activity-calendar` 或使用以下命令安装：

```bash
npm install koishi-plugin-vrc-activity-calendar
```

> 注意：该插件依赖 `puppeteer` 插件，请确保已安装并启用。

## 配置说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| updateInterval | number | 30 | 自动更新间隔(分钟) |
| maxActivities | number | 10 | 最多显示活动数量 |
| scrapeDelay | number | 5000 | 网页加载后等待时间(毫秒) |
| autoPush | object | {} | 自动推送设置 |
| autoPush.japan | object | {} | 日本活动推送设置 |
| autoPush.japan.enabled | boolean | false | 是否启用日本活动自动推送 |
| autoPush.japan.interval | number | 60 | 日本活动自动推送间隔(分钟) |
| autoPush.japan.target | string | '' | 日本活动推送目标 (格式: 平台:频道ID) |
| autoPush.china | object | {} | 中国活动推送设置 |
| autoPush.china.enabled | boolean | false | 是否启用中国活动自动推送 |
| autoPush.china.interval | number | 60 | 中国活动自动推送间隔(分钟) |
| autoPush.china.target | string | '' | 中国活动推送目标 (格式: 平台:频道ID) |

## 使用方法

### 命令

插件提供以下命令：

- `vrchat活动刷新` - 获取中日VRChat活动信息
- `vrchat活动日本` - 获取日本VRChat活动信息
- `vrchat活动中国` - 获取中国VRChat活动信息

### 自动推送

启用自动推送功能后，插件会按照设定的时间间隔自动将活动信息推送到指定的目标（如群组或私聊）。

## 工作原理

1. 插件使用 Puppeteer 访问配置的网站（默认为 https://vrceve.com/ 与 https://rlvrc.cn/event-showcase）
2. 解析页面中的活动信息
3. 提取活动信息并缓存
4. 根据当前时间确定当前活动、上一个活动和下一个活动
5. 生成包含日历和活动信息的图片
6. 可以手动或自动将图片推送给用户

## 注意事项

- 首次运行时可能需要较长时间加载，因为需要安装 Puppeteer 的浏览器组件
- 插件依赖网络访问，确保服务器可以正常访问配置的网站
- 生成图片需要一定性能，低配置服务器可能需要较长时间
