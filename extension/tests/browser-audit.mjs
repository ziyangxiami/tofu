// Isolated Chromium profile; every external request is blocked. No real accounts.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node extension/tests/browser-audit.mjs
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, cp, appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {zipSync, unzipSync, strToU8, strFromU8} = await import(pathToFileURL(resolve(root,'vendor/fflate.js')).href);
const output = resolve(root, '../outputs/refactor-2026-11-13');
await mkdir(output, {recursive: true});
const profile = await mkdtemp(join(tmpdir(), 'tofu-browser-audit-'));
const extensionRoot = join(profile, 'extension');
await cp(root, extensionRoot, {recursive:true, filter: source => !source.includes('/tests')});
await appendFile(join(extensionRoot, 'background.js'), '\nimport AuditStorage from \'./storage.js\'; self.testStorage = AuditStorage; self.testServiceReady = Service.getInstance();\n');
const context = await chromium.launchPersistentContext(join(profile, 'browser'), {
    channel: 'chromium', executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true, viewport: {width: 1440, height: 1100},
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
});
const errors = [], checks = [];
const check = async (name, run) => { await run(); checks.push(name); console.log('PASS', name); };
context.on('page', page => page.on('pageerror', error => errors.push({url: page.url(), message: error.message})));
await context.route(/^https?:/, route => route.abort());
try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host, base = `chrome-extension://${id}/`;
    await worker.evaluate(async () => {
        const Storage = self.testStorage;
        const service = await self.testServiceReady;
        self.testService = service; self.originalCreateJob = service.createJob.bind(service); self.originalStart = service.start.bind(service); self.createdJobs = [];
        service.createJob = async (...args) => { self.createdJobs.push(args); await new Promise(r => setTimeout(r, 350)); return {tasks: args[2]}; };
        service.previewMigration = async (userId, tasks) => ({sourceUserId: userId, sourceName: '测试档案', destinationUserId: 999, destinationName: '测试目标', selections: tasks.map(task => ({name: task.name, label: task.name, count: 3, version: 1}))});
        self.fetch = async () => { throw new Error('External requests disabled by browser audit'); };
        const storage = new Storage(123);
        await storage.global.account.bulkPut([
            {userId: 123, username: '林间来信', userSymbol: 'forest-letters', updated: Date.UTC(2026,10,13,9), userInfo: {reg_time: '2012-06-18'}},
            {userId: 456, username: '周末放映室', userSymbol: 'weekend-cinema', updated: null, userInfo: {}},
        ]);
        await storage.local.table('version').bulkPut(['note','review','interest','following','follower','blacklist','photo','annotation'].map(table => ({table, version: 1})));
        const subject = (id, title) => ({id, title, pic: {}, rating: {value: '8.5', count: 128}, url: 'https://book.douban.com/subject/'+id, card_subtitle: '关于生活与记忆'});
        await storage.local.note.bulkPut(Array.from({length: 360}, (_, i) => ({id: i+1, version: 1, note: {id: i+1, title: `日记 ${i+1} · 一些想留下的瞬间`, abstract: '读完一本书，记下沿途的风景。让普通的一天，也有可以回望的片段。', fulltext: '<p>安全正文 <strong>值得留下的文字</strong></p><script>window.pwned=1</script><img src=x onerror="window.pwned=2"><a href="javascript:alert(1)">恶意链接</a><form action="https://example.com">禁止表单</form>', url: 'https://www.douban.com/note/'+(i+1), create_time: '2026-11-12', comments_count: 3, read_count: 128}})));
        await storage.local.status.bulkPut(Array.from({length: 12}, (_, i) => ({id: i+1, status: {id: i+1, author: {name: '林间来信', uid: 'forest-letters', avatar: ''}, text: ['秋天的光线，是不用修饰的滤镜。','周末计划：一本书，一场电影，一次长长的散步。','把生活里那些小小的喜欢认真存好。'][i%3], create_time: '2026-11-13 10:20', activity: '说', like_count: i*3, reshares_count: 0, comments_count: 2, images: []}})));
        await storage.local.interest.bulkPut(['movie','book','music'].flatMap((type,j) => Array.from({length: 3},(_,i) => ({id:j*10+i+1, subject:j*10+i+1, type,status:'done', version:1, interest:{subject:subject(j*10+i+1,type+' · 收藏 '+i),comment:'一部值得回味的作品',create_time:'2026-11-12',tags:['生活'],rating:{value:5}}}))));
        await storage.local.review.put({id:1,type:'movie',version:1,review:{subject:subject(50,'电影手记'),title:'那些细微的瞬间',fulltext:'<p>影评正文</p>',rating:{value:5}}});
        await storage.local.annotation.put({id:1,subject:42,version:1,annotation:{title:'读书笔记',chapter:'第一章',page:12,fulltext:'<p>笔记正文</p>'}});
        await storage.local.following.put({id:1,version:1,user:{name:'关注 A',uid:'following-a',avatar:''}});
        await storage.local.follower.put({id:1,version:1,user:{name:'粉丝 B',uid:'follower-b',avatar:''}});
        await storage.local.blacklist.put({id:1,version:1,user:{name:'黑名单 C',uid:'blocked-c',avatar:''}});
        await storage.local.album.put({id:1,version:1,album:{title:'秋日相册',photos_count:1,url:'https://www.douban.com/photos/album/1',description:'秋天的记忆'}});
        await storage.local.photo.put({id:1,album:1,version:1,photo:{description:'秋日照片',cover:'',raw:''}});
        await storage.local.doulist.put({id:1,type:'owned',version:1,doulist:{title:'周末片单',owner:{name:'林间来信'},tags:[],items_count:1}});
        await storage.local.doulistItem.put({id:1,doulist:1,item:{title:'片单条目',extra:{}}});
        await storage.local.doumailContact.put({id:1,rank:1,user:{name:'豆友',avatar:''},contact:{name:'豆友'}});
        await storage.local.doumail.put({id:1,contact:1,sender:{name:'豆友',avatar:''},datetime:'2026-11-13',content:'<p>问候消息</p>'});
        await storage.local.board.put({id:1,sender:{name:'来访豆友',avatar:''},message:'好久不见',sendTime:'2026-11-12'});
        storage.local.close(); storage.global.close();
    });
    const page = await context.newPage();
    await page.goto(base+'backup.html');
    await check('backup dashboard and account search', async () => {
        await page.locator('.account').first().waitFor(); assert.equal(await page.locator('.account').count(),2);
        await page.screenshot({path:join(output,'backup-desktop.png'),fullPage:true});
        await page.locator('#account-search').fill('weekend'); assert.equal(await page.locator('.account:visible').count(),1);
        assert.match(await page.locator('.account:visible').innerText(),/尚未完成备份/);
        await page.locator('#account-search').fill('missing'); await page.locator('.search-empty').waitFor();
        await page.locator('#account-search').fill('');
    });
    await check('task validation, partial select-all, dialog keyboard and duplicate-submit guard', async () => {
        await page.locator('#new-task').click(); await page.locator('#task-modal.is-active').waitFor();
        await page.locator('#task-modal input[value="Note"]').check();
        assert(await page.locator('#task-modal .select-all').evaluate(el=>el.indeterminate));
        await page.locator('.enable-target-user').check();
        await page.locator('[name="user-homepage"]').fill('https://evil.example/?https://douban.com/people/test');
        await page.locator('#task-modal .new').click(); await page.locator('#task-error:not(.is-hidden)').waitFor();
        assert.equal(await worker.evaluate(()=>self.createdJobs.length),0);
        await page.keyboard.press('Escape'); assert.equal(await page.locator('#task-modal.is-active').count(),0);
        assert(await page.locator('#new-task').evaluate(el=>el===document.activeElement));
        await page.locator('#new-task').click(); await page.locator('.enable-target-user').uncheck();
        await page.screenshot({path:join(output,'task-dialog.png'),fullPage:true});
        await page.locator('#task-modal .new').evaluate(el=>{el.click();el.click();});
        await page.waitForURL('**/options.html#service');
        assert.equal(await worker.evaluate(()=>self.createdJobs.length),1);
    });
    await check('service recent result and failure reason', async () => {
        await worker.evaluate(() => { self.testService._lastJob={tasks:[{taskType:'Note',name:'日记',completion:80,total:100},{taskType:'Status',name:'广播',completion:12,total:12}],completedTaskTypes:['Status'],failedTasks:[{task:'日记',error:'测试：正文读取失败'}],finishedAt:Date.now()};self.testService.dispatchEvent(new Event('progress')); });
        await page.getByText('最近任务 · 1 / 2 项已完成 · 1 项失败', {exact:false}).waitFor();
        assert.match(await page.locator('.job').innerText(),/失败/);
        await page.getByText('测试：正文读取失败',{exact:true}).waitFor();
        await page.screenshot({path:join(output,'service-desktop.png'),fullPage:true});
    });
    await check('background disconnect preserves progress and reconnect restores controls', async () => {
        await worker.evaluate(() => { for(const port of self.testService._ports.values()) port.disconnect(); });
        await page.locator('.service-refresh-error:not(.is-hidden)').waitFor();
        assert.equal(await page.locator('.job tr').count(),2);
        await page.locator('[name="reconnect"]').click();
        await page.locator('.service-refresh-error.is-hidden').waitFor({state:'attached'});
        assert.match(await page.locator('.job').innerText(),/失败/);
    });
    await check('database maintenance lease excludes backend enqueue and start', async () => {
        await page.evaluate(() => {
            window.maintenance = navigator.locks.request('tofu-database-maintenance', async () => {
                window.maintenanceHeld=true; await new Promise(resolve=>window.releaseMaintenance=resolve);
            });
        });
        await page.waitForFunction(()=>window.maintenanceHeld);
        const result = await worker.evaluate(async () => {
            const results=[];
            for(const operation of [()=>self.originalStart(),()=>self.originalCreateJob(null,null,[{name:'Note'}])]) {
                try { await operation(); results.push('unexpected success'); } catch(error) { results.push(error.message); }
            }
            return results;
        });
        assert(result.every(message=>message.includes('数据库正在')));
        await page.evaluate(async () => { window.releaseMaintenance(); await window.maintenance; });
    });
    await check('settings validation and persisted value', async () => {
        await page.locator('a[href="#general"]').click();
        await page.locator('[name="service.requestInterval"]').fill('-2'); await page.locator('[name="save"]').click();
        await page.getByRole('alert').filter({hasText:'0.1'}).waitFor();
        await page.locator('[name="service.requestInterval"]').fill('2.5'); await page.locator('[name="save"]').click();
        await page.getByText('设置已保存并应用').waitFor();
        assert.equal(await worker.evaluate(async()=> (await chrome.storage.sync.get('service.requestInterval'))['service.requestInterval']),2500);
        await page.screenshot({path:join(output,'settings-desktop.png'),fullPage:true});
    });
    await page.goto(base+'explorer.html?123#note');
    await check('pagination reaches intermediate and last pages, enter-to-jump', async () => {
        await page.locator('[name="note"] .archive-summary').waitFor();
        assert.equal(await page.locator('[name="note"] article.note').count(),50);
        await page.locator('[name="note"] .pagination-goto').fill('4'); await page.locator('[name="note"] .pagination-goto').press('Enter');
        await page.locator('[name="note"] .archive-summary strong').filter({hasText:'第 4 / 8 页'}).waitFor();
        await page.locator('[name="note"] .pagination-next').click();
        await page.locator('[name="note"] .archive-summary strong').filter({hasText:'第 5 / 8 页'}).waitFor();
        await page.locator('[name="note"] .pagination-goto').fill('8'); await page.locator('[name="note"] .pagination-goto').press('Enter');
        await page.locator('[name="note"] .archive-summary strong').filter({hasText:'第 8 / 8 页'}).waitFor();
        assert(await page.locator('[name="note"] .pagination-next').isDisabled());
        assert.equal(await page.locator('[name="note"] article.note').count(),10);
    });
    await check('safe rich text, modal focus, page-size and current-page filter', async () => {
        await page.locator('[name="note"] select').selectOption('25');
        await page.locator('[name="note"] .archive-summary strong').filter({hasText:'第 1 / 15 页'}).waitFor();
        await page.locator('#archive-search').fill('missing'); await page.locator('.filter-empty').waitFor();
        await page.locator('#archive-search').fill('');
        await page.locator('[name="note"] article.note .title').first().click();
        await page.locator('#minor-modal.is-active').waitFor();
        assert.equal(await page.locator('#minor-modal script, #minor-modal form, #minor-modal [onerror], #minor-modal a[href^="javascript:"]').count(),0);
        assert.equal(await page.evaluate(()=>window.pwned),undefined);
        await page.keyboard.press('Escape'); assert.equal(await page.locator('#minor-modal.is-active').count(),0);
    });
    await check('closing a slow article cannot reopen the detail dialog', async () => {
        await page.evaluate(async () => {
            const panel=document.querySelector('[name="note"]')._panel;
            let resolveRead;const read=new Promise(resolve=>resolveRead=resolve);
            Object.defineProperty(panel,'storage',{configurable:true,get:()=>({local:{table:()=>({get:()=>read})},_local:{close(){}}})});
            const request=panel.article('note',1);
            document.querySelector('#minor-modal').classList.remove('is-active');
            resolveRead({note:{title:'late stale article',fulltext:'late'}});await request;
            delete panel.storage;
        });
        assert.equal(await page.locator('#minor-modal.is-active').count(),0);
        assert(!await page.locator('#minor-modal').innerText().then(text=>text.includes('late stale article')));
    });
    await check('all ten archive categories render and subcategories switch', async () => {
        for (const tab of ['status','interest','review','annotation','note','photo','follow','doumail','doulist','board']) {
            await page.locator(`.page-tab-link[data-tab="${tab}"] a`).click();
            await page.locator(`.page-tab-content[name="${tab}"] .archive-summary, .page-tab-content[name="${tab}"] .empty-state, .page-tab-content[name="${tab}"] .state-message.is-danger`).waitFor();
            assert.equal(await page.locator(`.page-tab-content[name="${tab}"] .state-message.is-danger`).count(),0, tab+' load failure');
        }
        await page.locator('a[href="#follow"]').click();
        await page.locator('[name="follow"] a[data-type="follower"]').click();
        await page.locator('[name="follow"] .username').filter({hasText:'粉丝 B'}).waitFor();
        assert.equal(await page.locator('[name="follow"] .username').count(),1);
        await page.locator('a[href="#status"]').click(); await page.locator('[name="status"] .archive-summary').waitFor();
        await page.screenshot({path:join(output,'explorer-desktop.png'),fullPage:true});
    });
    await check('out-of-order archive reads cannot overwrite the current view', async () => {
        const result = await page.evaluate(async () => {
            const host = document.querySelector('[name="status"]'), panel = host._panel;
            const original = panel.load;
            let release; const gate = new Promise(resolve=>release=resolve);
            panel.load = async function() { if(this.phase==='old') await gate; this.container.textContent=this.phase; return 1; };
            panel.phase='old'; const oldRead=panel.refresh();
            panel.phase='new'; const newRead=panel.refresh(); await newRead; release(); await oldRead;
            const text=host.textContent; panel.load=original; await panel.refresh(); return text;
        });
        assert.match(result,/new/);assert(!result.includes('old'));
    });
    await check('album, nested photo, mail and doulist detail dialogs', async () => {
        for (const [tab,selector,text] of [['photo','.album-url','秋日照片'],['doumail','.doumail-url','问候消息'],['doulist','.title','片单条目']]) {
            await page.locator(`.page-tab-link[data-tab="${tab}"] a`).click();
            await page.locator(`[name="${tab}"] .archive-summary`).waitFor();
            await page.locator(`[name="${tab}"] ${selector}`).last().click();
            await page.locator('#minor-modal.is-active').waitFor();
            await page.locator('#minor-modal').getByText(text,{exact:false}).waitFor();
            if(tab==='photo') {
                await page.locator('#minor-modal .image img').click(); await page.locator('#picture-modal.is-active').waitFor();
                await page.keyboard.press('Escape');assert.equal(await page.locator('#minor-modal.is-active').count(),1);
            }
            await page.keyboard.press('Escape');assert.equal(await page.locator('#minor-modal.is-active').count(),0);
        }
    });
    await check('Excel export selection and real download', async () => {
        await page.locator('.navbar [name="export"]').click();
        await page.locator('#export-modal [name="export"]').click();
        await page.getByRole('alert').filter({hasText:'至少选择'}).waitFor();
        assert.equal(await page.locator('#export-modal.is-active').count(),1);
        await page.locator('#export-modal input[value="Note"]').check();
        const download = page.waitForEvent('download'); await page.locator('#export-modal [name="export"]').click();
        const result = await download; assert.match(result.suggestedFilename(),/\.xlsx$/);
        await result.saveAs(join(output,'fixture-export.xlsx'));
    });
    await check('paused backup prevents database deletion', async () => {
        await page.goto(base+'backup.html'); await page.locator('.account').first().waitFor();
        await worker.evaluate(() => { self.testService._currentJob={toJSON:()=>({tasks:[]})}; });
        page.once('dialog',dialog=>dialog.accept());
        await page.locator('.account .delete').first().click();
        await page.getByRole('alert').filter({hasText:'暂停的任务仍会使用'}).waitFor();
        assert.equal(await page.locator('.account').count(),2);
        await worker.evaluate(()=>{self.testService._currentJob=null;});
    });
    await check('database archive download strips sessions; partial restore reports results inline', async () => {
        await worker.evaluate(async () => {
            const storage=new self.testStorage();
            await storage.global.account.update(123,{cookies:{dbcl2:'TEST_SECRET_NEVER_EXPORT'}});storage.global.close();
        });
        const download=page.waitForEvent('download');await page.locator('#backup-db').click();
        const archive=await download;const path=join(output,'fixture-database.zip');await archive.saveAs(path);
        const data=unzipSync(new Uint8Array(await readFile(path)));
        assert(!strFromU8(data['tofu.json']).includes('TEST_SECRET_NEVER_EXPORT'));
        const restore=zipSync({
            'database.json':strToU8(JSON.stringify({global:{version:2},local:{version:5,files:['tofu[789]','tofu[790]']}})),
            'tofu.json':strToU8(JSON.stringify({account:[{userId:789,username:'恢复测试账号',userInfo:{},cookies:{dbcl2:'OLD_SECRET'}},{userId:790}],job:[]})),
            'tofu[789].json':strToU8('{}'),'tofu[790].json':strToU8('{broken'),
        });
        await page.locator('#restore-db').setInputFiles({name:'test-restore.zip',mimeType:'application/zip',buffer:Buffer.from(restore)});
        await page.locator('#restore-result').getByText('恢复完成：1 个成功，1 个未导入',{exact:true}).waitFor();
        assert.equal(await page.locator('.account').count(),3);
        assert.equal(await worker.evaluate(async()=>{const storage=new self.testStorage();const row=await storage.global.account.get(789);storage.global.close();return row.cookies;}),undefined);
    });
    await check('mobile layout and navigation', async () => {
        await page.setViewportSize({width:390,height:844}); await page.goto(base+'backup.html'); await page.locator('.account').first().waitFor();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.screenshot({path:join(output,'backup-mobile.png'),fullPage:true});
        await page.locator('.navbar-burger').click(); assert.equal(await page.locator('.navbar-burger').getAttribute('aria-expanded'),'true');
        await page.goto(base+'explorer.html?123#interest'); await page.locator('[name="interest"] .archive-summary').waitFor();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.screenshot({path:join(output,'explorer-mobile.png'),fullPage:true});
        await page.goto(base+'options.html#service'); await page.locator('.job tr').first().waitFor();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.screenshot({path:join(output,'service-mobile.png'),fullPage:true});
    });
    await page.setViewportSize({width:350,height:650}); await page.goto(base+'popup.html');
    await check('popup is keyboard accessible and reflects service status', async () => {
        await page.getByText('服务已停止',{exact:true}).waitFor();
        assert(await page.locator('[name="Stop"]').isDisabled()); assert(!await page.locator('[name="Start"]').isDisabled());
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.screenshot({path:join(output,'popup.png'),fullPage:true});
    });
    assert.deepEqual(errors,[], 'uncaught browser errors');
    await writeFile(join(output,'browser-report.json'),JSON.stringify({passed:checks,errors,isolatedProfile:true,externalRequests:'blocked'},null,2));
} catch(error) {
    await writeFile(join(output,'browser-report.json'),JSON.stringify({passed:checks,errors,failure:error.stack},null,2));
    throw error;
} finally { await context.close(); await rm(profile,{recursive:true,force:true}); }
