'use strict';

import Service from './service.js';
import TaskModal from "./service.js";

console.log("background.js")

// 修改header，避免400
chrome.runtime.onInstalled.addListener(() => {
    // 移除旧规则
    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1, 2, 101, 102, 103, 104, 105, 106]
    }).then(() => {
        // 添加新规则
        chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [
                {
                    "id": 101,
                    "priority": 10,
                    "action": {
                        "type": "modifyHeaders",
                        "requestHeaders": [
                            { "header": "Referer", "operation": "set", "value": "https://m.douban.com/mine/movie" }
                        ]
                    },
                    "condition": { "urlFilter": "*/rexxar/api/v2/user/*/reviews*", "resourceTypes": ["xmlhttprequest"] }
                },
                {
                    "id": 102,
                    "priority": 10,
                    "action": {
                        "type": "modifyHeaders",
                        "requestHeaders": [
                            { "header": "Referer", "operation": "set", "value": "https://m.douban.com/mine/statuses" }
                        ]
                    },
                    "condition": { "urlFilter": "*/rexxar/api/v2/status/*", "resourceTypes": ["xmlhttprequest"] }
                },
                {
                    "id": 103,
                    "priority": 10,
                    "action": {
                        "type": "modifyHeaders",
                        "requestHeaders": [
                            { "header": "Referer", "operation": "set", "value": "https://m.douban.com/mine/statuses" }
                        ]
                    },
                    "condition": { "urlFilter": "*/rexxar/api/v2/status/user_timeline/*", "resourceTypes": ["xmlhttprequest"] }
                },
                {
                    "id": 104,
                    "priority": 10,
                    "action": {
                        "type": "modifyHeaders",
                        "requestHeaders": [
                            { "header": "Referer", "operation": "set", "value": "https://m.douban.com/mine/" }
                        ]
                    },
                    "condition": { "urlFilter": "*/rexxar/api/v2/user/*/interests*", "resourceTypes": ["xmlhttprequest"] }
                },
                {
                    "id": 105,
                    "priority": 1, 
                    "action": {
                        "type": "modifyHeaders",
                        "requestHeaders": [
                            { "header": "Referer", "operation": "set", "value": "https://m.douban.com/" }
                        ]
                    },
                    "condition": { "urlFilter": "*://*.douban.com/*", "resourceTypes": ["xmlhttprequest"] }
                },
                {
                    "id": 106,
                    "priority": 1,
                    "action": {
                        "type": "modifyHeaders",
                        "requestHeaders": [
                            { "header": "Referer", "operation": "set", "value": "https://m.douban.com/" }
                        ]
                    },
                    "condition": { "urlFilter": "*://*.doubanio.com/*", "resourceTypes": ["image", "xmlhttprequest"] }
                }
            ]
        });
        console.log("修改请求头规则已更新");
    });
});


let service;

chrome.runtime.onInstalled.addListener(async () => {
    service = await Service.getInstance();
    // Service.startup()
});

// 在适当的时候保存状态
chrome.runtime.onSuspend.addListener(async () => {
    if (!service) {
        service = await Service.getInstance();
    }
    console.log("onSuspend")
    await service.saveState();
});