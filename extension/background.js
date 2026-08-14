'use strict';

import Service from './service.js';
import TaskModal from "./service.js";

console.log("background.js")

const getRuntime = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime) return chrome.runtime;
    if (typeof browser !== 'undefined' && browser.runtime) return browser.runtime;
    if (typeof self !== 'undefined' && self.chrome && self.chrome.runtime) return self.chrome.runtime;
    return null;
};

const runtime = getRuntime();

// 修改header，避免400
if (runtime && runtime.onInstalled) {
    runtime.onInstalled.addListener(() => {
        if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest) {
            chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [1, 2, 101, 102, 103, 104, 105, 106, 107]
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
                            "id": 107,
                            "priority": 10,
                            "action": {
                                "type": "modifyHeaders",
                                "requestHeaders": [
                                    { "header": "Referer", "operation": "set", "value": "https://m.douban.com/mine/doulist" }
                                ]
                            },
                            "condition": { "urlFilter": "*/rexxar/api/v2/user/*/*doulists*", "resourceTypes": ["xmlhttprequest"] }
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
            }).catch(err => console.error("declarativeNetRequest error:", err));
        }
    });
}


let service;

// 在 Service Worker 启动/唤醒时立即初始化 Service，确保 onConnect 监听器能正常注册
(async () => {
    try {
        service = await Service.getInstance();
    } catch (e) {
        console.error("Failed to initialize Service:", e);
    }
})();

if (runtime && runtime.onInstalled) {
    runtime.onInstalled.addListener(async () => {
        if (!service) {
            try {
                service = await Service.getInstance();
            } catch (e) {
                console.error("Failed to initialize Service in onInstalled:", e);
            }
        }
    });
}

// 在适当的时候保存状态
if (runtime && runtime.onSuspend) {
    runtime.onSuspend.addListener(async () => {
        if (!service) {
            try {
                service = await Service.getInstance();
            } catch (e) {}
        }
        console.log("onSuspend");
        if (service) {
            await service.saveState();
        }
    });
}